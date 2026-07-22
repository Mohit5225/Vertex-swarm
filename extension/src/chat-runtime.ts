import * as vscode from 'vscode';
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
} from './types/index';


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
  private readonly inFlightToolCalls = new Map<string, ToolCallPayload>();

  private processManager: VertexProcessManager;
  private currentChatId: string | null = null;
  private streamCancellationRequested: boolean = false;
  private staticContext: { os: string; workspaceFolders: string[] } | null = null;
  private lastRegisteredRpcClient: any = null;
  private sessionMaintenanceInterval?: NodeJS.Timeout;

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
    this.processManager = options.processManager;

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
        this.log('Background session maintenance: token expiring soon, refreshing...');
        const refreshed = await this.entitlementClient.refreshToken();
        if (refreshed && this.processManager.rpcClient) {
          this.processManager.rpcClient.sendNotification('config/update_keys', { entitlement_token: refreshed });
        }
      }
    } catch (e) {
      this.log(`Background session maintenance failed: ${e}`);
    }
  }

  private log(message: string) {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] [ChatRuntime] ${message}`);
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
            return;
          }

          const ideContextEnabled = Boolean(payload.ideContextEnabled);
          const chatId = this.currentChatId ?? await this.createChat(ideContextEnabled);

          if (this.streamCancellationRequested) {
            this.log(`Stream cancelled before creation finished`);
            return;
          }

          this.log(
            `starting chat stream chat_id=${chatId ?? 'unknown'} ide_context_enabled=${ideContextEnabled}`
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
            return;
          }

          if (!this.processManager.rpcClient) {
            this.log('Backend not running during stream start, attempting respawn...');
            const success = await this.syncWebviewConfig();
            if (!success || !this.processManager.rpcClient) {
              // syncWebviewConfig already posts the appropriate auth-required or error UI
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

          this.processManager.rpcClient.sendNotification('session/start', {
            chat_id: chatId,
            message: payload.message,
            ide_context_enabled: ideContextEnabled,
            workspace_skeleton: workspaceSkeleton,
            request_context: requestContext
          });

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
          console.error('Failed to start stream:', errorMessage);
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
          console.error('Failed to open chat:', errorMessage);
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
          console.error('Failed to update IDE context state:', errorMessage);
          this.post({ type: 'error', payload: errorMessage });
        }
        break;
      }

      case 'cancel-stream': {
        this.streamCancellationRequested = true;
        const payload = message.payload as StreamCancelPayload;
        this.log(`cancel stream requested session_id=${payload.sessionId}`);
        if (payload.sessionId) {
          await this.terminalService.cancelJobsForChat(payload.sessionId);
          this.cancelInFlightTools(payload.sessionId);
          if (this.processManager.rpcClient) {
            this.processManager.rpcClient.sendNotification('session/cancel', {
              chat_id: payload.sessionId
            });
          }
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
        console.warn('VertexSwarm: unknown message type from webview');
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
      rpcClient.on('stream/event', (params: any) => {
        const isCurrentChat = params.chat_id === this.currentChatId;

        if (isCurrentChat) {
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
          if (params.event.type === 'done') {
            this.post({ type: 'stream-complete' });
            return;
          }
          this.post({ type: 'event', payload: params.event });
        }

        // Always execute tools, even for subagents running in the background
        if (params.event.type === 'tool_call') {
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
      console.error('Failed to load chat list:', errorMessage);
      this.post({ type: 'error', payload: errorMessage });
    }
  }

  private async openChat(chatId: string): Promise<void> {
    const messages = await this.chatStore.loadMessages(chatId);
    const ideContextEnabled = await this.chatStore.getIdeContextEnabled(chatId);

    this.currentChatId = chatId;
    this.log(`opened chat chat_id=${chatId} messages=${messages.length}`);

    this.post({
      type: 'chat-opened',
      payload: {
        chatId,
        ideContextEnabled,
        messages,
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

      if (this.streamCancellationRequested) {
        this.log(`skipping tool result for cancelled stream tool_call_id=${payload.tool_call_id}`);
        return;
      }

      if (this.processManager.rpcClient) {
        this.processManager.rpcClient.sendNotification('tool/result', {
          tool_name: payload.tool_name,
          tool_call_id: payload.tool_call_id,
          session_id: payload.session_id,
          chat_id: payload.chat_id,
          message_id: payload.message_id,
          status: result.status,
          content: result.content,
          data: result.data || {},
          execution_time_ms: executionTime,
          action: result.action,
          request_id: result.request_id,
          summary: result.summary,
          error_code: result.error_code,
          conflict: result.conflict
        });
      }
    } catch (error) {
      this.processedToolCallIds.delete(payload.tool_call_id);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', payload: `Tool execution failed: ${errorMessage}` });
    } finally {
      this.inFlightToolCalls.delete(payload.tool_call_id);
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
