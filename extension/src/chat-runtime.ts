import * as vscode from 'vscode';
import { ConfigManager } from './config-manager';
import { VertexProcessManager } from './process-manager';
import { FileSystemService } from './tools/file-system-service';
import { ToolExecutor } from './tools/tool-executor';
import { WorkspaceStore } from './workspace-store';
import { DiskSnapshotManager } from './snapshot/snapshot-manager';
import { TerminalService } from './tools/terminal-service';
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
  private static readonly TOKEN_REFRESH_BUFFER_MS = 12 * 60 * 1000;
  private static readonly APP_TOKEN_ISSUER = process.env.VERTEX_APP_TOKEN_ISSUER || 'vertex-swarm-backend';

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

  private processManager: VertexProcessManager;
  private currentChatId: string | null = null;
  private streamCancellationRequested: boolean = false;
  private staticContext: { os: string; workspaceFolders: string[] } | null = null;
  private lastRegisteredRpcClient: any = null;

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
      (msg) => this.log(msg),
      (event) => this.post({ type: 'event', payload: event })
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
            if (check.exp * 1000 < Date.now() + 1 * 60 * 1000) {
              this.log('Token expiring within 5 minutes, refreshing...');
              const refreshed = await this.entitlementClient.refreshToken();
              if (refreshed) {
                token = refreshed;
                if (this.processManager.rpcClient) {
                  this.processManager.rpcClient.sendNotification('config/update_keys', { entitlementToken: token });
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
        await vscode.commands.executeCommand('vertex-swarm.logout');
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
        const payload = message.payload as any;
        this.log(`review requested for snapshot file ${payload?.file}`);
        if (payload?.originalUri && payload?.snapshotPath) {
          try {
            const liveUri = vscode.Uri.parse(payload.originalUri);
            const snapshotUri = vscode.Uri.parse(`vertex-snapshot:/${payload.file}?snapshotPath=${encodeURIComponent(payload.snapshotPath)}`);
            const title = `${payload.file} (Snapshot vs Live)`;

            await vscode.commands.executeCommand('vscode.diff', snapshotUri, liveUri, title);
          } catch (e) {
            this.log(`review failed: ${e}`);
          }
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

        // If backend is running, update it live
        if (this.processManager?.rpcClient) {
          this.log('sending config/update_keys to running backend');
          await this.processManager.rpcClient.sendNotification('config/update_keys', {
            llm_base_url: payload.llmBaseUrl,
            llm_model: payload.llmModel,
            llm_key: payload.llmKey?.trim(),
            exa_key: payload.exaKey?.trim()
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
    this.post({ type: 'logged-out', payload: { reason: reason || null } });
  }



  public async syncWebviewConfig(): Promise<boolean> {
    let token = await this.entitlementClient.getToken();

    if (token) {
      const check = await this.entitlementClient.checkEntitlement(token);
      if (check.exp * 1000 < Date.now() + 1 * 60 * 1000) {
        this.log('Session expiring, attempting automatic JWT refresh...');
        const refreshed = await this.entitlementClient.refreshToken();
        if (refreshed) {
          token = refreshed;
          if (this.processManager.rpcClient) {
            this.processManager.rpcClient.sendNotification('config/update_keys', { entitlementToken: token });
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

    // Pass mock user payload on successful auth check for now
    this.post({ type: 'authenticated', payload: { user: { id: 'jwt-user', email: 'user@vertex-swarm.com', provider: 'google' } } });

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
        this.log(`Failed to respawn backend: ${err.message}`);

        // Trap the explicit RS256 validation errors from the python backend
        if (err.code === -32000 || err.code === -32001) {
          this.post({ type: 'auth-required' });
        } else {
          this.post({ type: 'config-missing', payload: { reason: 'Backend process not running' } });
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
            this.post({ type: 'cancel-stream' });
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

    try {
      const startTime = Date.now();
      const result = await this.toolExecutor.handle(payload);
      const executionTime = Date.now() - startTime;

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
