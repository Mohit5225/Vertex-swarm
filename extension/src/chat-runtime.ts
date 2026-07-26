import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './config-manager';
import { VertexProcessManager } from './process-manager';
import { FileSystemService } from './tools/file-system-service';
import { ToolExecutor } from './tools/tool-executor';
import { WorkspaceStore } from './workspace-store';
import { DiskSnapshotManager } from './snapshot/snapshot-manager';
import { TerminalService, JobCompletionEvent } from './tools/terminal-service';
import { createRequestContext } from './request-context';
import { PlanDocumentProvider } from './plan-document-provider';
import { LocalChatStore } from './local-chat-store';
import { EntitlementClient } from './auth/entitlement-client';
import type {
  WebviewToExtensionMessage,
  SessionEvent,
  AuthenticatedSessionData,
  StreamStartPayload,
  StreamCancelPayload,
  OpenChatPayload,
  SetIdeContextPayload,
  ChatSummaryData,
  ChatMessageData,
  ToolCallPayload,
  ToolResult,
} from './types/index';
import { debugLog } from './debug-log';


export interface VertexSwarmChatRuntimeOptions {
  entitlementClient: EntitlementClient;
  configManager: ConfigManager;
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  authLog?: (message: string) => void;
  postMessage: (message: object) => void;
  planDocumentProvider?: PlanDocumentProvider;
  processManager: VertexProcessManager;
}

export class VertexSwarmChatRuntime {
  private static readonly MAX_PROCESSED_TOOL_CALL_IDS = 10_000;
  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  /** Strip `/deep-plan` prefix; opens gate A on the backend session. */
  private static parseDeepPlanCommand(message: string): { message: string; deepPlanRequested: boolean } {
    const trimmed = message.trimStart();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith('/deep-plan')) {
      return { message, deepPlanRequested: false };
    }
    const rest = trimmed.slice('/deep-plan'.length).trimStart();
    return {
      message: rest.length > 0 ? rest : 'Run deep planning for this task.',
      deepPlanRequested: true,
    };
  }

  private readonly chatStore = new LocalChatStore();
  private readonly entitlementClient: EntitlementClient;
  private readonly configManager: ConfigManager;
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly authLog?: (message: string) => void;
  private readonly postMessage: (message: object) => void;
  private readonly planDocumentProvider?: PlanDocumentProvider;
  private readonly fileSystemService: FileSystemService;
  private readonly terminalService: TerminalService;
  private readonly workspaceStore: WorkspaceStore;
  private readonly snapshotManager: DiskSnapshotManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly processedToolCallIds = new Set<string>();
  private readonly abortedToolCallIds = new Set<string>();
  private readonly inFlightToolCalls = new Map<string, ToolCallPayload>();

  private processManager: VertexProcessManager;
  private currentChatId: string | null = null;
  private streamCancellationRequested: boolean = false;
  private staticContext: { os: string; workspaceFolders: string[] } | null = null;
  private lastRegisteredRpcClient: any = null;
  private sessionMaintenanceInterval?: NodeJS.Timeout;
  private streamStallTimer?: NodeJS.Timeout;
  private streamStallChatId: string | null = null;
  private lastStreamEventAt = 0;
  private lastStallUiPostAt = 0;
  /** Batch nested worker/subagent token streams so the webview is not flooded. */
  private nestedTraceBuffer: SessionEvent | null = null;
  private nestedTraceFlushTimer?: NodeJS.Timeout;
  private static readonly NESTED_TRACE_FLUSH_MS = 120;

  constructor(options: VertexSwarmChatRuntimeOptions) {
    this.entitlementClient = options.entitlementClient;
    this.configManager = options.configManager;
    this.context = options.context;
    this.outputChannel = options.outputChannel;
    this.authLog = options.authLog;
    this.postMessage = options.postMessage;
    this.planDocumentProvider = options.planDocumentProvider;
    this.fileSystemService = new FileSystemService();
    this.terminalService = new TerminalService(
      options.context,
      (msg) => this.log(msg),
      (event) => this.post({ type: 'event', payload: event }),
      (event: JobCompletionEvent) => {
        if (this.processManager.rpcClient) {
          this.processManager.rpcClient.sendNotification('background/event', {
            job_id: event.job_id,
            chat_id: event.chat_id,
            exit_code: event.exit_code,
            output_tail: event.output_tail,
            command: event.command,
            status_message: event.status_message,
            job_status: event.job_status,
          });
        }
      }
    );
    this.workspaceStore = new WorkspaceStore();
    this.context.subscriptions.push(this.workspaceStore);
    this.snapshotManager = new DiskSnapshotManager();
    this.toolExecutor = new ToolExecutor(
      this.fileSystemService,
      this.terminalService,
      this.snapshotManager,
      (message: string) => this.log(message)
    );
    this.toolExecutor.setAbortChecker(
      (toolCallId) =>
        this.streamCancellationRequested || this.abortedToolCallIds.has(toolCallId)
    );
    this.processManager = options.processManager;
    this.processManager.onBackendDied((reason) => {
      this.log(`Backend died under us: ${reason}`);
      this.lastRegisteredRpcClient = null;
      this.streamCancellationRequested = true;
      this.clearStreamStallWatch();
      this.post({
        type: 'error',
        payload: `Backend disconnected (${reason}). Send your message again to reconnect.`,
      });
      this.post({ type: 'stream-complete' });
    });

    // Actively maintain session in the background (runs every 45 seconds)
    this.sessionMaintenanceInterval = setInterval(() => {
      this.maintainSession();
    }, 45 * 1000);
  }

  private async maintainSession(): Promise<void> {
    try {
      const token = await this.entitlementClient.getToken();
      if (!token) return;

      const check = await this.entitlementClient.checkEntitlement(token);
      if (!check.valid && check.exp === 0) {
        this.log('Session token failed local issuer/format checks.');
        return;
      }
      // Refresh if it expires within the buffer
      if (check.exp * 1000 < Date.now() + VertexSwarmChatRuntime.TOKEN_REFRESH_BUFFER_MS) {
        const refreshed = await this.entitlementClient.refreshToken();
        if (refreshed) {
          this.log('Background session maintenance: token refreshed');
          if (this.processManager.rpcClient) {
            this.processManager.rpcClient.sendNotification('config/update_keys', { entitlement_token: refreshed });
          }
        }
      }
    } catch (e) {
      this.log(`Background session maintenance failed: ${e}`);
    }
  }

  private log(message: string) {
    debugLog('ChatRuntime', message);
  }

  private clearStreamStallWatch(): void {
    if (this.streamStallTimer) {
      clearInterval(this.streamStallTimer);
      this.streamStallTimer = undefined;
    }
    this.streamStallChatId = null;
    this.lastStreamEventAt = 0;
    this.lastStallUiPostAt = 0;
  }

  private startStreamStallWatch(chatId: string): void {
    this.clearStreamStallWatch();
    this.streamStallChatId = chatId;
    this.lastStreamEventAt = Date.now();
    this.streamStallTimer = setInterval(() => {
      if (!this.streamStallChatId) {
        return;
      }
      const silentMs = Date.now() - this.lastStreamEventAt;
      if (silentMs < 45_000) {
        return;
      }
      const workerAlive = Boolean(this.processManager.rpcClient);
      const seconds = Math.round(silentMs / 1000);
      this.log(
        `STALL: no stream events for ${seconds}s chat_id=${this.streamStallChatId} worker_rpc=${workerAlive ? 'up' : 'down'}`,
      );
      if (Date.now() - this.lastStallUiPostAt >= 60_000) {
        this.lastStallUiPostAt = Date.now();
        this.post({
          type: 'event',
          payload: {
            type: 'status',
            content: workerAlive
              ? `Backend silent for ${seconds}s (worker still up — likely LLM hang). Open Vertex Swarm Logs.`
              : `Backend silent for ${seconds}s (worker RPC down). Open Vertex Swarm Logs.`,
            metadata: { phase: 'stall_watchdog' },
          },
        });
      }
    }, 15_000);
  }

  private markStreamActivity(chatId: string): void {
    if (this.streamStallChatId === chatId) {
      this.lastStreamEventAt = Date.now();
    }
  }

  private flushNestedTraceBuffer(): void {
    if (this.nestedTraceFlushTimer) {
      clearTimeout(this.nestedTraceFlushTimer);
      this.nestedTraceFlushTimer = undefined;
    }
    const buffered = this.nestedTraceBuffer;
    this.nestedTraceBuffer = null;
    if (buffered) {
      this.post({ type: 'event', payload: buffered });
    }
  }

  /** Post stream events to the webview, coalescing nested thinking/output floods. */
  private postStreamEvent(event: SessionEvent): void {
    const meta = event.metadata ?? {};
    const isNested =
      Boolean(meta.deep_plan_worker) || Boolean(meta.subagent_trace);
    const canCoalesce =
      isNested && (event.type === 'thinking' || event.type === 'output');

    if (!canCoalesce) {
      this.flushNestedTraceBuffer();
      this.post({ type: 'event', payload: event });
      return;
    }

    const buffered = this.nestedTraceBuffer;
    if (buffered) {
      const prevMeta = buffered.metadata ?? {};
      const sameStream =
        buffered.type === event.type &&
        prevMeta.deep_plan_stage_id === meta.deep_plan_stage_id &&
        prevMeta.subagent_spawn_tool_call_id === meta.subagent_spawn_tool_call_id;
      if (sameStream) {
        this.nestedTraceBuffer = {
          ...buffered,
          content: `${buffered.content || ''}${event.content || ''}`,
          timestamp: event.timestamp || Date.now(),
          metadata: { ...prevMeta, ...meta },
        };
        return;
      }
      this.flushNestedTraceBuffer();
    }

    this.nestedTraceBuffer = event;
    this.nestedTraceFlushTimer = setTimeout(() => {
      this.flushNestedTraceBuffer();
    }, VertexSwarmChatRuntime.NESTED_TRACE_FLUSH_MS);
  }

  private post(message: object) {
    this.postMessage(message);
  }
  private getStaticContext(): { os: string; workspaceFolders: string[] } {
    if (!this.staticContext) {
      this.staticContext = {
        os: process.platform,
        workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      };
    }
    return this.staticContext;
  }

  public async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    if ('type' in message && message.type === 'log') {
      this.log(`[WebView Log] ${message.payload}`);
      return;
    }
    switch (message.type) {
      case 'open-browser': {
        this.log('open-browser requested');
        try {
          await this.entitlementClient.startAuthFlow();
          await this.syncWebviewConfig();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`Failed to complete OAuth flow: ${message}`);
          this.post({ type: 'error', payload: `Login failed: ${message}` });
        }
        break;
      }

      case 'copy-link': {
        this.log('copy-link requested');
        try {
          await this.entitlementClient.startAuthFlow();
          await this.syncWebviewConfig();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`Failed to generate sign-in link: ${message}`);
          vscode.window.showErrorMessage('Failed to generate sign-in link.');
        }
        break;
      }

      case 'request-session': {
        this.log('webview requested current session');
        const hasValidSession = await this.syncWebviewConfig();
        if (hasValidSession) {
          await this.sendChatList();
        }
        break;
      }

      case 'open-plan': {
        if (this.currentChatId) {
          void this.planDocumentProvider?.openPlanTab(this.currentChatId);
        }
        break;
      }

      case 'open-deep-plan-folder': {
        if (!this.currentChatId) {
          break;
        }
        const planDir = path.join(
          os.homedir(),
          '.vertex-swarm',
          'chats',
          this.currentChatId,
          'plan_pipeline',
        );
        const indexUri = vscode.Uri.file(path.join(planDir, 'index.md'));
        void vscode.commands.executeCommand('revealInExplorer', indexUri);
        break;
      }

      case 'hil-respond': {
        const payload = message.payload as { hil_session_id?: string; answers?: unknown[] };
        if (!payload?.hil_session_id || !Array.isArray(payload.answers)) {
          this.log('hil-respond rejected: missing hil_session_id or answers');
          break;
        }
        if (!this.processManager.rpcClient) {
          this.log('hil-respond failed: backend RPC client unavailable');
          break;
        }
        // Answers go to session/hil_respond — not a new chat message.
        this.processManager.rpcClient.sendNotification('session/hil_respond', {
          hil_session_id: payload.hil_session_id,
          answers: payload.answers,
        });
        break;
      }

      case 'planning-approve': {
        const payload = message.payload as { pipeline_id?: string };
        if (!payload?.pipeline_id) {
          this.log('planning-approve rejected: missing pipeline_id');
          break;
        }
        if (!this.processManager.rpcClient) {
          this.log('planning-approve failed: backend RPC client unavailable');
          break;
        }
        this.processManager.rpcClient.sendNotification('session/planning_approve', {
          pipeline_id: payload.pipeline_id,
        });
        break;
      }

      case 'planning-reject': {
        const payload = message.payload as { pipeline_id?: string; rejection_feedback?: string };
        if (!payload?.pipeline_id) {
          this.log('planning-reject rejected: missing pipeline_id');
          break;
        }
        if (!this.processManager.rpcClient) {
          this.log('planning-reject failed: backend RPC client unavailable');
          break;
        }
        this.processManager.rpcClient.sendNotification('session/planning_reject', {
          pipeline_id: payload.pipeline_id,
          rejection_feedback: payload.rejection_feedback ?? '',
        });
        break;
      }

      case 'exit-deep-plan-mode': {
        if (!this.currentChatId) {
          break;
        }
        if (!this.processManager.rpcClient) {
          this.post({
            type: 'deep-plan-mode',
            payload: { active: false },
          });
          break;
        }
        this.processManager.rpcClient.sendNotification('session/abort_deep_plan', {
          chat_id: this.currentChatId,
        });
        this.post({
          type: 'deep-plan-mode',
          payload: { active: false },
        });
        break;
      }

      case 'load-chat-list': {
        this.log('webview requested chat list');
        await this.sendChatList();
        break;
      }

      case 'start-stream': {
        this.streamCancellationRequested = false;
        const payload = message.payload as StreamStartPayload;

        try {
          let token = await this.entitlementClient.getToken();
          if (token) {
            const check = await this.entitlementClient.checkEntitlement(token);
            if (!check.valid && check.exp === 0) {
              token = undefined;
            } else if (check.exp * 1000 < Date.now() + VertexSwarmChatRuntime.TOKEN_REFRESH_BUFFER_MS) {
              this.log('Token expiring within 5 minutes, refreshing...');
              const refreshed = await this.entitlementClient.refreshToken();
              if (refreshed) {
                token = refreshed;
                if (this.processManager.rpcClient) {
                  this.processManager.rpcClient.sendNotification('config/update_keys', { entitlement_token: token });
                }
              } else if (check.exp * 1000 < Date.now()) {
                token = undefined; // Force auth-required if strictly expired and refresh failed
              }
            }
          }

          if (!token) {
            this.post({ type: 'auth-required' });
            this.post({ type: 'stream-complete' });
            return;
          }

          const ideContextEnabled = Boolean(payload.ideContextEnabled);
          const parsed = VertexSwarmChatRuntime.parseDeepPlanCommand(payload.message);
          const deepPlanRequested =
            Boolean((payload as { deepPlanRequested?: boolean }).deepPlanRequested) ||
            parsed.deepPlanRequested;
          const streamMessage = parsed.message;
          const chatId = this.currentChatId ?? await this.createChat(ideContextEnabled);

          if (this.streamCancellationRequested) {
            this.log(`Stream cancelled before creation finished`);
            this.post({ type: 'stream-complete' });
            return;
          }

          this.log(
            `starting chat stream chat_id=${chatId ?? 'unknown'} ide_context_enabled=${ideContextEnabled} deep_plan=${deepPlanRequested}`
          );

          if (!chatId) {
            this.post({ type: 'error', payload: 'Failed to create chat' });
            return;
          }

          this.currentChatId = chatId;
          await this.sendChatList();

          const workspaceSkeleton = ideContextEnabled
            ? await this.workspaceStore.getSkeleton()
            : undefined;

          if (this.streamCancellationRequested) {
            this.log(`Stream cancelled while fetching skeleton`);
            this.post({ type: 'stream-complete' });
            return;
          }

          if (!this.processManager.rpcClient) {
            this.log('Backend not running during stream start, attempting respawn...');
            const success = await this.syncWebviewConfig();
            if (!success || !this.processManager.rpcClient) {
              // syncWebviewConfig already posts the appropriate auth-required or error UI
              this.log('stream start aborted: backend unavailable after respawn attempt');
              this.post({ type: 'stream-complete' });
              return;
            }
          }

          const activeEditor = vscode.window.activeTextEditor;
          const requestContext = createRequestContext({
            ...this.getStaticContext(),
            activeFile: activeEditor ? {
              path: activeEditor.document.uri.fsPath,
              languageId: activeEditor.document.languageId,
              selection: (() => {
                const sel = activeEditor.selection;
                if (!sel || sel.isEmpty) { return undefined; }
                const text = activeEditor.document.getText(sel);
                if (!text?.trim()) { return undefined; }
                return {
                  startLine: sel.start.line + 1,
                  startColumn: sel.start.character + 1,
                  endLine: sel.end.line + 1,
                  endColumn: sel.end.character + 1,
                  text,
                };
              })(),
            } : undefined,
            activeTerminal: vscode.window.activeTerminal ? {
              name: vscode.window.activeTerminal.name,
              shell: vscode.env.shell,
            } : undefined,
            activeTerminals: this.terminalService.getActiveTerminalContexts(),
          });

          if (deepPlanRequested) {
            this.post({
              type: 'deep-plan-mode',
              payload: {
                active: true,
                trigger: 'user_slash',
                phase: 'requirement_extraction',
                stage_label: 'Requirement extraction',
              },
            });
          }

          this.processManager.rpcClient.sendNotification('session/start', {
            chat_id: chatId,
            message: streamMessage,
            ide_context_enabled: ideContextEnabled,
            workspace_skeleton: workspaceSkeleton,
            request_context: requestContext,
            deep_plan_requested: deepPlanRequested,
          });
          this.log(`session/start sent chat_id=${chatId} message_len=${streamMessage.length}`);
          this.startStreamStallWatch(chatId);

          // Forward the real DB message_id so the webview can patch the temp local id
          // For local architecture, we might just assume tempId is sufficient for now
          // or have the backend send a specific message_id assignment event.
          if (payload.tempId) {
            this.post({
              type: 'message-id-assigned',
              payload: { tempId: payload.tempId as string, realId: payload.tempId as string },
            });
          }
          if (this.currentChatId === chatId) {
            await this.sendChatList();
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.log(`Failed to start stream: ${errorMessage}`);
          this.post({ type: 'error', payload: errorMessage });
        }
        break;
      }

      case 'open-chat': {
        const payload = message.payload as OpenChatPayload;
        try {
          this.log(`webview requested open chat chat_id=${payload.chatId}`);
          await this.openChat(payload.chatId);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.log(`Failed to open chat: ${errorMessage}`);
          this.post({ type: 'error', payload: errorMessage });
        }
        break;
      }

      case 'set-ide-context': {
        const payload = message.payload as SetIdeContextPayload;
        try {
          this.log(`updating IDE context chat_id=${payload.chatId} enabled=${payload.enabled}`);
          await this.updateChatIdeContext(payload.chatId, payload.enabled);
          await this.sendChatList();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.log(`Failed to update IDE context state: ${errorMessage}`);
          this.post({ type: 'error', payload: errorMessage });
        }
        break;
      }

      case 'cancel-stream': {
        this.streamCancellationRequested = true;
        const payload = message.payload as StreamCancelPayload;
        const chatId = payload.sessionId || this.currentChatId;
        this.log(`cancel stream requested session_id=${chatId ?? 'unknown'}`);
        if (chatId) {
          await this.terminalService.cancelJobsForChat(chatId);
          this.cancelInFlightTools(chatId);
          if (this.processManager.rpcClient) {
            if (payload.abortDeepPlan) {
              this.log(`aborting deep plan pipeline chat_id=${chatId}`);
              this.processManager.rpcClient.sendNotification('session/abort_deep_plan', {
                chat_id: chatId,
              });
            }
            this.processManager.rpcClient.sendNotification('session/cancel', {
              chat_id: chatId,
            });
          }
        }
        this.post({
          type: 'deep-plan-mode',
          payload: { active: false },
        });
        this.clearStreamStallWatch();
        this.post({ type: 'stream-complete' });
        break;
      }

      case 'cancel-agent-run': {
        const runId = message.payload.runId;
        if (runId && this.processManager.rpcClient) {
          this.log(`targeted agent cancellation requested run_id=${runId}`);
          this.processManager.rpcClient.sendNotification('session/cancel_run', {
            run_id: runId,
          });
        }
        break;
      }

      case 'tool_call': {
        this.log(`webview sent tool_call tool_call_id=${message.payload.tool_call_id}`);
        await this.executeToolCall(message.payload as ToolCallPayload);
        break;
      }

      case 'reset-chat': {
        this.log('resetting active chat state');
        this.currentChatId = null;
        await this.sendChatList();
        break;
      }

      case 'logout': {
        this.log('logout requested from webview');
        this.currentChatId = null;
        await this.handleLogout('User initiated logout');
        break;
      }

      case 'show-terminal': {
        const terminalName = (message.payload as { terminalName: string }).terminalName;
        const target = vscode.window.terminals.find(t => t.name === terminalName);
        if (target) {
          target.show();
        } else {
          this.log(`show-terminal: terminal "${terminalName}" not found`);
        }
        break;
      }

      case 'get-terminal-output': {
        const jobId = (message.payload as { jobId: string }).jobId;
        if (!jobId) {
          break;
        }
        const result = await this.terminalService.readJobOutput(jobId);
        this.post({
          type: 'terminal-output',
          payload: {
            jobId,
            content: result.content,
            totalChars: result.total_chars_buffered,
            status: result.status,
          },
        });
        break;
      }

      case 'undo-snapshot': {
        const payload = message.payload as any;
        this.log(`undo requested for snapshot ${payload?.snapshotId}`);
        if (payload?.snapshotId && payload?.sessionId && payload?.messageId) {
          try {
            await this.snapshotManager.restoreSnapshot({
              snapshotId: payload.snapshotId,
              sessionId: payload.sessionId,
              messageId: payload.messageId
            });
            this.post({ type: 'event', payload: { type: 'output', content: 'Undo successful.' } });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            this.log(`undo failed: ${err}`);
            this.post({ type: 'error', payload: `Undo failed: ${err}` });
          }
        } else {
          this.log('undo failed: missing snapshot details');
        }
        break;
      }

      case 'undo-snapshot-file': {
        const payload = message.payload as any;
        this.log(`undo requested for snapshot ${payload?.snapshotId} file ${payload?.originalUri}`);
        if (payload?.snapshotId && payload?.sessionId && payload?.messageId && payload?.originalUri) {
          try {
            await this.snapshotManager.restoreSnapshotFile({
              snapshotId: payload.snapshotId,
              sessionId: payload.sessionId,
              messageId: payload.messageId
            }, payload.originalUri);
            this.post({ type: 'event', payload: { type: 'output', content: `Undo successful for ${vscode.Uri.parse(payload.originalUri).fsPath.split(/[\\/]/).pop()}.` } });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            this.log(`undo file failed: ${err}`);
            this.post({ type: 'error', payload: `Undo file failed: ${err}` });
          }
        } else {
          this.log('undo file failed: missing snapshot details');
        }
        break;
      }

      case 'review-snapshot': {
        const payload = message.payload as {
          file?: string;
          originalUri?: string;
          snapshotPath?: string;
          isNewFile?: boolean;
          isDeleted?: boolean;
          isBinary?: boolean;
        };
        this.log(`review requested for snapshot file ${payload?.file}`);
        if (!payload?.originalUri) {
          break;
        }

        try {
          const liveUri = vscode.Uri.parse(payload.originalUri);
          const isNewFile = payload.isNewFile === true;
          const isDeleted = payload.isDeleted === true;
          const isBinary = payload.isBinary === true;

          if (isBinary && !isDeleted) {
            await vscode.commands.executeCommand('vscode.open', liveUri);
            break;
          }

          const leftQuery = isNewFile
            ? 'newFile=true'
            : `snapshotPath=${encodeURIComponent(payload.snapshotPath ?? '')}${isBinary ? '&isBinary=true' : ''}`;

          const snapshotUri = vscode.Uri.parse(`vertex-snapshot:/${payload.file ?? 'file'}?${leftQuery}`);

          const rightQuery = isDeleted ? 'deletedFile=true' : '';
          const rightUri = isDeleted
            ? vscode.Uri.parse(`vertex-snapshot:/${payload.file ?? 'file'}?${rightQuery}`)
            : liveUri;

          const title = isDeleted
            ? `${payload.file} (Before delete)`
            : isNewFile
              ? `${payload.file} (Created)`
              : `${payload.file} (Before vs After)`;

          await vscode.commands.executeCommand('vscode.diff', snapshotUri, rightUri, title);
        } catch (e) {
          this.log(`review failed: ${e}`);
        }
        break;
      }

      case 'get-config': {
        const config = vscode.workspace.getConfiguration('vertexSwarm');
        const snapshotRetentionDays = config.get<number>('snapshotRetentionDays', 7);
        this.post({ type: 'config-state', payload: { snapshotRetentionDays } });
        break;
      }

      case 'set-config': {
        const payload = message.payload as { snapshotRetentionDays?: number };
        const config = vscode.workspace.getConfiguration('vertexSwarm');
        if (payload.snapshotRetentionDays !== undefined) {
          // ensure between 1 and 7
          const val = Math.max(1, Math.min(7, payload.snapshotRetentionDays));
          await config.update('snapshotRetentionDays', val, vscode.ConfigurationTarget.Global);
          this.post({ type: 'config-state', payload: { snapshotRetentionDays: val } });
        }
        break;
      }

      case 'save-config': {
        const payload = message.payload as { llmBaseUrl?: string, llmModel?: string, llmKey?: string, exaKey?: string };
        await this.configManager.updateConfig(payload);
        const fullConfig = await this.configManager.getConfig();

        // If backend is running, update it live
        if (this.processManager?.rpcClient) {
          this.log('sending config/update_keys to running backend');
          await this.processManager.rpcClient.sendNotification('config/update_keys', {
            llm_base_url: payload.llmBaseUrl ?? fullConfig.llmBaseUrl,
            llm_model: payload.llmModel ?? fullConfig.llmModel,
            llm_key: payload.llmKey?.trim() || fullConfig.llmKey,
            exa_key: payload.exaKey?.trim() || fullConfig.exaKey,
          });
        }

        // Notify frontend
        const hasConfig = await this.configManager.hasValidConfig();
        if (hasConfig) {
          await this.syncWebviewConfig();
        }
        break;
      }

      case 'truncate-messages': {
        const payload = message.payload as any;
        const { chatId, messageId, messageText } = payload;
        this.log(`truncate-messages requested chat_id=${chatId} message_id=${messageId}`);

        if (!chatId || !messageId) {
          this.log('truncate-messages: missing ids');
          break;
        }
        try {
          const result = await this.chatStore.truncateMessages(chatId, messageId);
          this.log(`truncate-messages: deleted ${result.deletedCount} messages session_id=${result.sessionId}`);

          // Restore snapshot for this turn (graceful if none exists)
          try {
            await this.snapshotManager.restoreSnapshot({
              snapshotId: messageId,
              sessionId: result.sessionId,
              messageId,
            });
            this.log(`truncate-messages: snapshot restored for message_id=${messageId}`);
          } catch (snapErr) {
            this.log(`truncate-messages: no snapshot to restore (${snapErr}) — continuing`);
          }

          // Tell webview to drop the messages and pre-fill input
          this.post({
            type: 'messages-truncated',
            payload: { messageId, messageText: messageText ?? '' },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`truncate-messages failed: ${msg}`);
          this.post({ type: 'error', payload: `Edit failed: ${msg}` });
        }
        break;
      }

      default: {
        this.log('unknown message type from webview');
      }
    }
  }

  public async handleLogout(reason?: string): Promise<void> {
    await this.entitlementClient.logout();
    this.processManager.dispose();
    this.post({ type: 'logged-out', payload: { reason: reason || null } });
  }



  public async syncWebviewConfig(): Promise<boolean> {
    let token = await this.entitlementClient.getToken();
    if (token) {
      const check = await this.entitlementClient.checkEntitlement(token);
      if (!check.valid && check.exp === 0) {
        token = undefined;
      } else if (check.exp * 1000 < Date.now() + VertexSwarmChatRuntime.TOKEN_REFRESH_BUFFER_MS) {
        this.log('Session expiring, attempting automatic JWT refresh...');
        const refreshed = await this.entitlementClient.refreshToken();
        if (refreshed) {
          token = refreshed;
          if (this.processManager.rpcClient) {
            this.processManager.rpcClient.sendNotification('config/update_keys', { entitlement_token: token });
          }
        } else if (check.exp * 1000 < Date.now()) {
          token = undefined;
        }
      }
    }

    if (!token) {
      this.post({ type: 'auth-required' });
      return false;
    }

    // Decode the token to read the actual user identity for the webview.
    // Client-side decode only — the local backend does the authoritative RS256 check.
    const tokenClaims = await this.entitlementClient.checkEntitlement(token);
    this.post({
      type: 'authenticated',
      payload: {
        user: {
          id: tokenClaims.sub || 'unknown',
          email: tokenClaims.email || '',
          provider: 'google',
          role: tokenClaims.role || 'authenticated',
        }
      }
    });

    const hasConfig = await this.configManager.hasValidConfig();
    if (!hasConfig) {
      this.post({ type: 'config-missing' });
      return false;
    }

    if (!this.processManager.rpcClient) {
      this.log('Backend not running, attempting lazy respawn...');
      try {
        const config = await this.configManager.getConfig();
        const sessionToken = token;
        await this.processManager.start(this.context, this.outputChannel, config, sessionToken);
      } catch (err: any) {
        const message = String(err.message || '');
        this.log(`Failed to respawn backend: code=${err.code} message=${message}`);
        // Only wipe the session on definitive token rejection. Transient failures
        // (JWKS cold-start, network, generic init) used to call logout() and look
        // like "signed in then immediately signed out" after a successful OAuth.
        const definitiveAuthFailure =
          err.code === -32000 &&
          /invalid_entitlement|invalid_token_type|no_entitlement/.test(message);
        if (err.code === -32001 || definitiveAuthFailure) {
          if (definitiveAuthFailure) {
            await this.entitlementClient.logout();
          }
          this.post({
            type: 'auth-required',
            payload: {
              reason: `Session rejected by backend (code ${err.code}): ${message}`,
            },
          });
        } else {
          this.post({
            type: 'error',
            payload: `Backend process failed to start: ${message}. Your sign-in was kept — retry in a moment if the auth service was waking up.`,
          });
        }
        return false;
      }
    }

    const rpcClient = this.processManager.rpcClient;
    if (rpcClient && rpcClient !== this.lastRegisteredRpcClient) {
      this.lastRegisteredRpcClient = rpcClient;
      rpcClient.on('notification', (method: string, params: any) => {
        if (method === 'tool/abort' && typeof params?.session_id === 'string') {
          this.abortInFlightToolsBySession(params.session_id);
        }
      });
      rpcClient.on('stream/event', (params: any) => {
        const isCurrentChat = params.chat_id === this.currentChatId;

        if (isCurrentChat && this.streamCancellationRequested) {
          this.log(
            `dropped late stream event after cancellation chat_id=${params.chat_id ?? 'unknown'} type=${params.event?.type ?? 'unknown'}`
          );
          return;
        }

        if (!isCurrentChat) {
          this.log(
            `dropped stream event for chat_id=${params.chat_id ?? 'unknown'} (active=${this.currentChatId ?? 'none'}) type=${params.event?.type ?? 'unknown'}`
          );
        }

        if (isCurrentChat) {
          this.markStreamActivity(params.chat_id);
          this.log(this.describeEvent(params.event));
          if (params.event.type === 'plan_chunk') {
            this.planDocumentProvider?.appendPlanChunk(params.chat_id, params.event.content);
            return;
          }
          if (params.event.type === 'plan_ready') {
            void this.planDocumentProvider?.openPlanTab(params.chat_id);
            this.post({ type: 'plan-ready', payload: {} });
            return;
          }
          if (params.event.type === 'deep_plan_ready') {
            this.post({ type: 'deep-plan-ready', payload: {} });
            return;
          }
          if (params.event.type === 'done') {
            this.flushNestedTraceBuffer();
            this.clearStreamStallWatch();
            this.post({ type: 'stream-complete' });
            return;
          }
          if (params.event.type === 'error') {
            this.log(`stream error: ${this.preview(params.event.content)}`);
          }
          this.postStreamEvent(params.event);
        }

        // Always execute tools, even for subagents running in the background
        if (params.event.type === 'tool_call') {
          if (params.event.metadata?.extension_execute === false) {
            return;
          }
          if (!isCurrentChat) {
            this.log(`subagent tool_call intercepted: ${params.event.metadata?.tool_name || params.event.metadata?.toolName || 'unknown'}`);
          }
          void this.handleToolCallEvent(params.event);
        }
      });
    }

    const config = await this.configManager.getConfig();
    this.post({
      type: 'config-ready',
      payload: { llmBaseUrl: config.llmBaseUrl, llmModel: config.llmModel }
    });

    const vscodeConfig = vscode.workspace.getConfiguration('vertexSwarm');
    this.post({
      type: 'config-state',
      payload: { snapshotRetentionDays: vscodeConfig.get<number>('snapshotRetentionDays') || 30 },
    });

    return true;
  }

  private async createChat(ideContextEnabled: boolean): Promise<string> {
    this.log(`creating local chat ide_context_enabled=${ideContextEnabled}`);
    return await this.chatStore.createChat(ideContextEnabled);
  }

  private async updateChatIdeContext(chatId: string, enabled: boolean): Promise<void> {
    await this.chatStore.updateIdeContext(chatId, enabled);
  }

  private async sendChatList(): Promise<void> {
    try {
      const chats = await this.chatStore.listChats();
      this.log(`loaded chat list count=${chats.length}`);
      this.post({
        type: 'chat-list',
        payload: {
          chats,
          activeChatId: this.currentChatId ?? null,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to load chat list: ${errorMessage}`);
      this.post({ type: 'error', payload: errorMessage });
    }
  }

  private async openChat(chatId: string): Promise<void> {
    const messages = await this.chatStore.loadMessages(chatId);
    const ideContextEnabled = await this.chatStore.getIdeContextEnabled(chatId);
    const session = await this.chatStore.loadSession(chatId);
    const workingMemory =
      session && typeof session.working_memory === 'object' && session.working_memory !== null
        ? (session.working_memory as Record<string, unknown>)
        : null;
    const deepPlanPipeline = workingMemory?.deep_plan_pipeline ?? null;
    const deepPlanPhase = workingMemory?.deep_plan_phase ?? null;
    const deepPlanRequested = Boolean(workingMemory?.deep_plan_requested);
    const deepPlanConfirmed = Boolean(workingMemory?.deep_plan_confirmed);

    this.currentChatId = chatId;
    this.log(`opened chat chat_id=${chatId} messages=${messages.length}`);

    this.post({
      type: 'chat-opened',
      payload: {
        chatId,
        ideContextEnabled,
        messages,
        deepPlanPipeline,
        deepPlanPhase,
        deepPlanRequested,
        deepPlanConfirmed,
      },
    });

    await this.sendChatList();
  }


  private async handleToolCallEvent(event: SessionEvent): Promise<void> {
    const payload = this.extractToolCallPayload(event);
    if (!payload) {
      this.log('received malformed tool_call event without required metadata');
      this.post({
        type: 'error',
        payload: 'Received tool_call event without required metadata.',
      });
      return;
    }

    await this.executeToolCall(payload);
  }

  private extractToolCallPayload(event: SessionEvent): ToolCallPayload | null {
    const metadata = event.metadata ?? {};
    const root = event as any;

    const tool_call_id = this.metadataString(metadata, 'tool_call_id') || this.metadataString(root, 'tool_call_id');
    const tool_name = this.metadataString(metadata, 'tool_name')
      || this.metadataString(metadata, 'toolName')
      || this.metadataString(root, 'tool_name')
      || this.metadataString(root, 'toolName');
    const session_id = this.metadataString(metadata, 'session_id') || this.metadataString(root, 'session_id');
    const chat_id = this.metadataString(metadata, 'chat_id') || this.metadataString(root, 'chat_id') || this.currentChatId;
    const message_id = this.metadataString(metadata, 'message_id') || this.metadataString(root, 'message_id');
    const args = this.metadataObject(metadata, 'args') ?? this.metadataObject(root, 'args') ?? {};

    if (!tool_call_id || !tool_name || !session_id || !chat_id || !message_id) {
      return null;
    }

    return {
      tool_call_id,
      tool_name,
      args,
      session_id,
      chat_id,
      message_id,
    };
  }

  private async executeToolCall(payload: ToolCallPayload): Promise<void> {
    if (this.processedToolCallIds.has(payload.tool_call_id)) {
      this.log(`skipping duplicate tool_call tool_call_id=${payload.tool_call_id}`);
      return;
    }

    if (
      this.processedToolCallIds.size
      >= VertexSwarmChatRuntime.MAX_PROCESSED_TOOL_CALL_IDS
    ) {
      const firstToolCallId = this.processedToolCallIds.values().next().value;
      if (typeof firstToolCallId === 'string') {
        this.processedToolCallIds.delete(firstToolCallId);
      }
    }

    this.processedToolCallIds.add(payload.tool_call_id);
    this.inFlightToolCalls.set(payload.tool_call_id, payload);

    try {
      const startTime = Date.now();
      const result = await this.toolExecutor.handle(payload);
      const executionTime = Date.now() - startTime;

      const wasCancelled =
        this.streamCancellationRequested || this.abortedToolCallIds.has(payload.tool_call_id);

      if (wasCancelled) {
        this.log(
          `tool finished after cancel/abort tool_call_id=${payload.tool_call_id}; sending cancelled result`
        );
        this.toolExecutor.cancelChangeCapture(payload.tool_call_id);
        this.markToolCallAborted(payload.tool_call_id);
        if (this.processManager.rpcClient) {
          this.processManager.rpcClient.sendNotification('tool/result', {
            tool_name: payload.tool_name,
            tool_call_id: payload.tool_call_id,
            session_id: payload.session_id,
            chat_id: payload.chat_id,
            message_id: payload.message_id,
            status: 'error',
            content: 'Tool execution cancelled.',
            data: {},
            execution_time_ms: executionTime,
            error_code: 'cancelled',
          });
        }
        return;
      }

      if (this.processManager.rpcClient) {
        this.log(
          `tool finish name=${payload.tool_name} tool_call_id=${payload.tool_call_id} status=${result.status} execution_time_ms=${executionTime}`
        );
        this.processManager.rpcClient.sendNotification('tool/result', {
          tool_name: payload.tool_name,
          tool_call_id: payload.tool_call_id,
          session_id: payload.session_id,
          chat_id: payload.chat_id,
          message_id: payload.message_id,
          status: result.status,
          content: result.content,
          data: this.buildRpcToolResultData(result.data),
          execution_time_ms: executionTime,
          action: result.action,
          request_id: result.request_id,
          summary: result.summary,
          error_code: result.error_code,
          conflict: result.conflict
        });
      } else {
        this.log(
          `tool result dropped — no rpc client tool_call_id=${payload.tool_call_id}`
        );
      }

      void this.deferFileChangeEnrichment(payload);
    } catch (error) {
      this.processedToolCallIds.delete(payload.tool_call_id);
      this.toolExecutor.cancelChangeCapture(payload.tool_call_id);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', payload: `Tool execution failed: ${errorMessage}` });
    } finally {
      this.inFlightToolCalls.delete(payload.tool_call_id);
    }
  }

  private buildRpcToolResultData(data: ToolResult['data']): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {};
    }

    const record = data as Record<string, unknown>;
    const { file_changes: _ignored, ...rest } = record;
    return rest;
  }

  private async deferFileChangeEnrichment(payload: ToolCallPayload): Promise<void> {
    if (this.abortedToolCallIds.has(payload.tool_call_id)) {
      return;
    }

    const fileChanges = await this.toolExecutor.finishChangeCapture(
      payload.tool_call_id,
      {
        tool_call_id: payload.tool_call_id,
        session_id: payload.session_id,
        chat_id: payload.chat_id,
        message_id: payload.message_id,
      },
    );

    if (!fileChanges?.length) {
      return;
    }

    if (this.processManager.rpcClient) {
      this.processManager.rpcClient.sendNotification('tool/result_enrichment', {
        tool_call_id: payload.tool_call_id,
        chat_id: payload.chat_id,
        session_id: payload.session_id,
        message_id: payload.message_id,
        file_changes: fileChanges,
        snapshot_id: payload.message_id,
        snapshot_session_id: payload.session_id,
      });
    }

    this.post({
      type: 'file-changes-enrichment',
      payload: {
        tool_call_id: payload.tool_call_id,
        message_id: payload.message_id,
        file_changes: fileChanges,
        snapshot_id: payload.message_id,
        snapshot_session_id: payload.session_id,
      },
    });
  }

  private markToolCallAborted(toolCallId: string): void {
    this.abortedToolCallIds.add(toolCallId);
    this.toolExecutor.cancelChangeCapture(toolCallId);
    if (this.abortedToolCallIds.size > VertexSwarmChatRuntime.MAX_PROCESSED_TOOL_CALL_IDS) {
      const first = this.abortedToolCallIds.values().next().value;
      if (typeof first === 'string') {
        this.abortedToolCallIds.delete(first);
      }
    }
  }

  private cancelInFlightTools(chatId: string): void {
    for (const [toolCallId, payload] of this.inFlightToolCalls.entries()) {
      if (payload.chat_id !== chatId) {
        continue;
      }

      if (this.processManager.rpcClient) {
        this.processManager.rpcClient.sendNotification('tool/result', {
          tool_name: payload.tool_name,
          tool_call_id: payload.tool_call_id,
          session_id: payload.session_id,
          chat_id: payload.chat_id,
          message_id: payload.message_id,
          status: 'error',
          content: 'Tool execution cancelled by user.',
          data: {},
          execution_time_ms: 0,
          error_code: 'cancelled',
        });
      }

      this.inFlightToolCalls.delete(toolCallId);
      this.processedToolCallIds.delete(toolCallId);
      this.markToolCallAborted(toolCallId);
    }
  }

  private abortInFlightToolsBySession(sessionId: string): void {
    for (const [toolCallId, payload] of this.inFlightToolCalls.entries()) {
      if (payload.session_id !== sessionId) {
        continue;
      }

      this.log(`aborting in-flight tool for session_id=${sessionId} tool_call_id=${toolCallId}`);

      if (this.processManager.rpcClient) {
        this.processManager.rpcClient.sendNotification('tool/result', {
          tool_name: payload.tool_name,
          tool_call_id: payload.tool_call_id,
          session_id: payload.session_id,
          chat_id: payload.chat_id,
          message_id: payload.message_id,
          status: 'error',
          content: 'Tool execution aborted (parent session ended or timed out).',
          data: {},
          execution_time_ms: 0,
          error_code: 'aborted',
        });
      }

      this.inFlightToolCalls.delete(toolCallId);
      this.processedToolCallIds.delete(toolCallId);
      this.markToolCallAborted(toolCallId);
    }
  }

  private metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
    const value = metadata[key];
    return typeof value === 'string' ? value : undefined;
  }

  private metadataObject(
    metadata: Record<string, unknown>,
    key: string
  ): Record<string, unknown> | undefined {
    const value = metadata[key];
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  private describeEvent(event: SessionEvent): string {
    const metadata = event.metadata ?? {};
    switch (event.type) {
      case 'thinking':
        return `event thinking ${this.preview(event.content)}`;
      case 'tool_call':
        return `event tool_call tool_name=${this.metadataString(metadata, 'tool_name') || this.metadataString(metadata, 'toolName') || 'unknown'} tool_call_id=${this.metadataString(metadata, 'tool_call_id') || 'unknown'}`;
      case 'tool_result':
        return `event tool_result tool_name=${this.metadataString(metadata, 'tool_name') || this.metadataString(metadata, 'toolName') || 'unknown'} status=${String(metadata.status ?? 'unknown')}`;
      case 'status':
        return `event status ${this.preview(event.content)}`;
      case 'deep_plan_started':
        return `event deep_plan_started pipeline_id=${this.metadataString(metadata, 'pipeline_id') || 'unknown'}`;
      case 'deep_plan_stage_status':
        return `event deep_plan_stage_status stage=${this.metadataString(metadata, 'stage_id') || 'unknown'} status=${this.metadataString(metadata, 'status') || 'unknown'} ${this.preview(event.content)}`;
      case 'deep_plan_mode_active':
        return `event deep_plan_mode_active phase=${this.metadataString(metadata, 'phase') || 'unknown'}`;
      case 'deep_plan_artifact_saved':
        return `event deep_plan_artifact_saved path=${this.metadataString(metadata, 'path') || 'unknown'}`;
      case 'error':
        return `event error ${this.preview(event.content)}`;
      case 'output':
        return `event output chunk_len=${event.content.length}`;
      default:
        return `event ${event.type} ${this.preview(event.content)}`;
    }
  }

  private preview(value: string | undefined): string {
    if (!value) {
      return '';
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }
}
