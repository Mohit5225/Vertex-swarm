import * as vscode from 'vscode';
import { TokenManager, type StoredSession } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { SSEStreamClient } from './sse-client/stream';
import { FileSystemService } from './tools/file-system-service';
import { ToolExecutor } from './tools/tool-executor';
import { WorkspaceStore } from './workspace-store';
import type {
  WebviewToExtensionMessage,
  SessionEvent,
  TokenData,
  StreamStartPayload,
  StreamCancelPayload,
  OpenChatPayload,
  SetIdeContextPayload,
  ChatSummaryData,
  ChatMessageData,
  ToolCallPayload,
} from './types/index';

const BACKEND_URL = process.env.VERTEX_BACKEND_URL || 'http://localhost:8000';

interface ChatMessagesResponse {
  chatId: string;
  ideContextEnabled: boolean;
  messages: ChatMessageData[];
}

/**
 * VertexSwarmSidebarProvider
 * Registers as a WebviewView provider - renders the React UI inside the VS Code sidebar
 */
export class VertexSwarmSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vertex-swarm.sidebar';
  private static readonly MAX_PROCESSED_TOOL_CALL_IDS = 10_000;
  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  private webviewView: vscode.WebviewView | undefined;
  private streamClient: SSEStreamClient | undefined;
  private currentChatId: string | undefined;
  private authResetInProgress = false;
  private refreshInFlight: Promise<StoredSession> | null = null;
  private readonly fileSystemService: FileSystemService;
  private readonly workspaceStore: WorkspaceStore;
  private readonly toolExecutor: ToolExecutor;
  private readonly processedToolCallIds = new Set<string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tokenManager: TokenManager,
    private readonly oauthHandler: OAuthHandler,
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.fileSystemService = new FileSystemService();
    this.workspaceStore = new WorkspaceStore();
    this.context.subscriptions.push(this.workspaceStore);
    this.toolExecutor = new ToolExecutor(
      this.fileSystemService,
      BACKEND_URL,
      (options) => this.getValidToken(options),
      (message: string) => this.log(message)
    );
  }

  /**
   * Called by VS Code when the sidebar panel becomes visible
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;
    this.log('sidebar webview resolved');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist', 'assets'),
      ],
    };

    webviewView.webview.html = this.buildWebviewHTML(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleWebviewMessage(message),
      undefined,
      this.context.subscriptions
    );

    // Send OAuth URL to webview so login screen can render
    this.sendAuthUrl();
    void this.primeWebviewSession();
  }

  /**
   * Post message to webview
   */
  private post(message: object): void {
    this.webviewView?.webview.postMessage(message);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /**
   * Send OAuth URL to webview on load so login screen can render buttons
   */
  private sendAuthUrl(): void {
    this.log('sending auth URL to webview');
    this.post({
      type: 'auth-url',
      payload: { url: this.oauthHandler.getAuthUrl() },
    });
  }

  private postLoggedOut(reason?: string): void {
    this.log(`posting logged-out state${reason ? ` reason="${reason}"` : ''}`);
    this.post({
      type: 'logged-out',
      payload: {
        reason: reason ?? null,
        authUrl: this.oauthHandler.getAuthUrl(),
      },
    });
  }

  private async primeWebviewSession(): Promise<void> {
    try {
      const hasValidSession = await this.checkAndSendExistingToken();
      if (hasValidSession) {
        await this.sendChatList();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`initial webview session prime failed: ${errorMessage}`);
    }
  }

  /**
   * If a token already exists, send it to webview immediately
   */
  private async checkAndSendExistingToken(): Promise<boolean> {
    const session = await this.getRestoredSession();
    this.log(`session lookup completed status=${session.status}`);

    if (session.status === 'expired') {
      await vscode.window.showInformationMessage(
        'Vertex Swarm session expired. Please sign in again.'
      );
      await this.handleLogout('Vertex Swarm session expired. Please sign in again.');
      return false;
    }

    if (session.status !== 'valid') {
      this.postLoggedOut();
      return false;
    }

    this.post({
      type: 'token',
      payload: {
        token: session.token,
        user: {
          id: (session.userMetadata.id as string) || '',
          email: (session.userMetadata.email as string) || '',
          provider: (session.userMetadata.provider as string) || 'neon-auth',
        },
      } as TokenData,
    });
    return true;
  }

  private async getValidToken(options: { forceRefresh?: boolean } = {}): Promise<string | undefined> {
    const session = await this.getRestoredSession(options);

    if (session.status === 'valid') {
      return session.token;
    }

    if (session.status === 'expired') {
      await vscode.window.showInformationMessage(
        'Vertex Swarm session expired. Please sign in again.'
      );
    }

    await this.handleLogout(
      session.status === 'expired'
        ? 'Vertex Swarm session expired. Please sign in again.'
        : undefined
    );
    return undefined;
  }

  private async getRestoredSession(
    options: { forceRefresh?: boolean } = {}
  ): Promise<StoredSession> {
    const session = await this.tokenManager.getSession();
    return this.refreshSessionIfNeeded(session, options);
  }

  private async refreshSessionIfNeeded(
    session: StoredSession,
    options: { forceRefresh?: boolean } = {}
  ): Promise<StoredSession> {
    if (!this.shouldRefreshSession(session, options.forceRefresh)) {
      return session;
    }

    const reason = options.forceRefresh
      ? 'forced refresh'
      : session.status === 'expired'
        ? 'expired JWT'
        : 'expiring JWT';

    if (this.refreshInFlight) {
      this.log(`joining in-flight silent refresh (${reason})`);
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshSessionWithStoredToken(session, reason)
      .finally(() => {
        this.refreshInFlight = null;
      });

    return this.refreshInFlight;
  }

  private shouldRefreshSession(
    session: StoredSession,
    forceRefresh = false
  ): session is Exclude<StoredSession, { status: 'missing' }> {
    if (session.status === 'missing' || !session.sessionToken) {
      return false;
    }

    if (forceRefresh || session.status === 'expired') {
      return true;
    }

    return (
      typeof session.expiresAt === 'number'
      && session.expiresAt - Date.now() <= VertexSwarmSidebarProvider.TOKEN_REFRESH_BUFFER_MS
    );
  }

  private async refreshSessionWithStoredToken(
    session: Exclude<StoredSession, { status: 'missing' }>,
    reason: string
  ): Promise<StoredSession> {
    const refreshedSession = await this.silentRefreshWithSessionToken(
      session.sessionToken ?? '',
      session.userMetadata,
      reason
    );
    if (!refreshedSession) {
      return session;
    }

    return refreshedSession;
  }

  private async silentRefreshFromStorage(reason: string): Promise<string | undefined> {
    const session = await this.tokenManager.getSession();
    if (session.status === 'missing' || !session.sessionToken) {
      this.log(`forced silent refresh unavailable (${reason})`);
      return undefined;
    }

    const refreshedSession = await this.refreshSessionIfNeeded(session, { forceRefresh: true });
    if (refreshedSession.status !== 'valid') {
      this.log(`forced silent refresh failed (${reason}) status=${refreshedSession.status}`);
      return undefined;
    }

    if (session.status === 'valid' && refreshedSession.token === session.token) {
      this.log(`forced silent refresh produced no replacement JWT (${reason})`);
      return undefined;
    }

    return refreshedSession.token;
  }

  private async silentRefreshWithSessionToken(
    sessionToken: string,
    userMetadata: Record<string, unknown>,
    reason: string
  ): Promise<StoredSession | undefined> {
    this.log(`attempting silent JWT refresh from stored Neon session (${reason})`);
    const refreshedToken = await this.oauthHandler.refreshAccessToken(sessionToken);
    if (!refreshedToken) {
      this.log(`silent refresh did not return a replacement JWT (${reason})`);
      return undefined;
    }

    await this.tokenManager.setToken(
      refreshedToken.token,
      userMetadata,
      refreshedToken.sessionToken ?? sessionToken
    );

    const refreshedSession = await this.tokenManager.getSession();
    this.log(`silent refresh completed status=${refreshedSession.status} (${reason})`);
    if (refreshedSession.status === 'valid') {
      this.post({
        type: 'token',
        payload: {
          token: refreshedSession.token,
          user: {
            id: (refreshedSession.userMetadata.id as string) || '',
            email: (refreshedSession.userMetadata.email as string) || '',
            provider: (refreshedSession.userMetadata.provider as string) || 'neon-auth',
          },
        } as TokenData,
      });
    }

    return refreshedSession;
  }

  /**
   * Create a new backend chat for multi-turn conversation state.
   */
  private async createChat(token: string, ideContextEnabled: boolean): Promise<string | null> {
    try {
      this.log(`creating backend chat ide_context_enabled=${ideContextEnabled}`);
      const data = await this.requestJson<{ chatId: string }>(
        '/api/v1/chats',
        token,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ide_context_enabled: ideContextEnabled,
          }),
        }
      );
      
      if (!data.chatId) {
        throw new Error('No chatId in response');
      }

      return data.chatId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to create chat:', errorMessage);
      throw error;
    }
  }

  private async fetchChatList(token: string): Promise<ChatSummaryData[]> {
    return this.requestJson<ChatSummaryData[]>(
      '/api/v1/chats',
      token,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );
  }

  private async fetchChatMessages(token: string, chatId: string): Promise<ChatMessagesResponse> {
    return this.requestJson<ChatMessagesResponse>(
      `/api/v1/chats/${chatId}/messages`,
      token,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      }
    );
  }

  private async updateChatIdeContext(token: string, chatId: string, enabled: boolean): Promise<void> {
    await this.requestJson<{ chatId: string; ideContextEnabled: boolean }>(
      `/api/v1/chats/${chatId}/ide-context`,
      token,
      {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled }),
      }
    );
  }

  private async sendChatList(token?: string): Promise<void> {
    const validToken = token ?? await this.getValidToken();

    if (!validToken) {
      return;
    }

    try {
      const chats = await this.fetchChatList(validToken);
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
      if (!this.isUnauthorizedError(errorMessage)) {
        console.error('Failed to load chat list:', errorMessage);
        this.post({ type: 'error', payload: errorMessage });
      }
    }
  }

  private async openChat(token: string, chatId: string): Promise<void> {
    const chatState = await this.fetchChatMessages(token, chatId);
    this.currentChatId = chatId;
    this.log(`opened chat chat_id=${chatId} messages=${chatState.messages.length}`);

    this.post({
      type: 'chat-opened',
      payload: {
        chatId,
        ideContextEnabled: chatState.ideContextEnabled,
        messages: chatState.messages,
      },
    });

    await this.sendChatList(token);
  }

  private async requestJson<T>(
    path: string,
    token: string,
    init: RequestInit,
    allowRetry = true
  ): Promise<T> {
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    };
    const response = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      if (allowRetry) {
        const refreshedToken = await this.silentRefreshFromStorage(`backend 401 for ${path}`);
        if (refreshedToken) {
          this.log(`retrying request after backend 401 path=${path}`);
          return this.requestJson<T>(path, refreshedToken, init, false);
        }
      }

      await this.handleUnauthorized();
      throw new Error('Authentication expired. Please sign in again.');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(
        () => ({ detail: response.statusText })
      ) as { detail?: string };
      throw new Error(`${response.status} ${errorData.detail || response.statusText}`.trim());
    }

    return await response.json() as T;
  }

  private isUnauthorizedError(errorMessage: string): boolean {
    return /(^|\s)401(\s|$)|expired|unauthorized/i.test(errorMessage);
  }

  private async handleUnauthorized(): Promise<void> {
    if (this.authResetInProgress) {
      return;
    }

    const refreshedToken = await this.silentRefreshFromStorage('backend rejected request');
    if (refreshedToken) {
      this.log('recovered from backend 401 via silent refresh');
      return;
    }

    this.authResetInProgress = true;
    this.log('backend returned 401; clearing local session');
    await this.tokenManager.clearToken();
    try {
      await vscode.window.showWarningMessage(
        'Vertex Swarm session expired. Please sign in again.'
      );
      await this.handleLogout(
        'Backend rejected the session token. Please sign in again.'
      );
    } finally {
      this.authResetInProgress = false;
    }
  }

  /**
   * Handle all incoming messages from the webview
   */
  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'request-auth-url': {
        this.sendAuthUrl();
        break;
      }

      case 'open-browser': {
        this.log('starting OAuth browser flow');
        const success = await this.oauthHandler.startAuthFlow();
        if (success) {
          this.log('OAuth flow completed successfully');
          await this.checkAndSendExistingToken();
        }
        break;
      }

      case 'copy-link': {
        const authUrl = this.oauthHandler.getAuthUrl();
        await vscode.env.clipboard.writeText(authUrl);
        await vscode.window.showInformationMessage('Vertex Swarm: Neon sign-in page copied to clipboard');
        break;
      }

      case 'request-token': {
        this.log('webview requested current token');
        const hasValidSession = await this.checkAndSendExistingToken();
        if (hasValidSession) {
          await this.sendChatList();
        }
        break;
      }

      case 'load-chat-list': {
        this.log('webview requested chat list');
        await this.sendChatList();
        break;
      }

      case 'start-stream': {
        const payload = message.payload as StreamStartPayload;
        const token = await this.getValidToken();

        if (!token) {
          return;
        }

        try {
          const ideContextEnabled = Boolean(payload.ideContextEnabled);
          const chatId = this.currentChatId ?? await this.createChat(token, ideContextEnabled);
          this.log(
            `starting chat stream chat_id=${chatId ?? 'unknown'} ide_context_enabled=${ideContextEnabled}`
          );

          if (!chatId) {
            this.post({ type: 'error', payload: 'Failed to create chat' });
            return;
          }

          this.currentChatId = chatId;
          await this.sendChatList(token);

          const workspaceSkeleton = ideContextEnabled
            ? await this.workspaceStore.getSkeleton()
            : undefined;

          this.streamClient = new SSEStreamClient(
            BACKEND_URL,
            token,
            (event: SessionEvent) => {
              this.log(this.describeEvent(event));
              this.post({ type: 'event', payload: event });
              if (event.type === 'tool_call') {
                void this.handleToolCallEvent(event);
              }
            },
            (error: string) => {
              this.log(`stream error ${error}`);
              if (this.isUnauthorizedError(error)) {
                void this.handleUnauthorized();
                return;
              }

              this.post({ type: 'error', payload: error });
            },
            () => {
              this.log(`stream closed chat_id=${chatId}`);
              this.post({ type: 'cancel-stream', payload: { sessionId: chatId } });
            }
          );

          await this.streamClient.openChatStream(
            chatId,
            payload.message,
            workspaceSkeleton,
            ideContextEnabled
          );
          if (this.currentChatId === chatId) {
            await this.sendChatList(token);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('Failed to start stream:', errorMessage);
          if (!this.isUnauthorizedError(errorMessage)) {
            this.post({ type: 'error', payload: errorMessage });
          }
        }
        break;
      }

      case 'open-chat': {
        const payload = message.payload as OpenChatPayload;
        const token = await this.getValidToken();

        if (!token) {
          return;
        }

        try {
          this.log(`webview requested open chat chat_id=${payload.chatId}`);
          await this.openChat(token, payload.chatId);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('Failed to open chat:', errorMessage);
          if (!this.isUnauthorizedError(errorMessage)) {
            this.post({ type: 'error', payload: errorMessage });
          }
        }
        break;
      }

      case 'set-ide-context': {
        const payload = message.payload as SetIdeContextPayload;
        const token = await this.getValidToken();

        if (!token) {
          return;
        }

        try {
          this.log(`updating IDE context chat_id=${payload.chatId} enabled=${payload.enabled}`);
          await this.updateChatIdeContext(token, payload.chatId, payload.enabled);
          await this.sendChatList(token);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          if (!this.isUnauthorizedError(errorMessage)) {
            console.error('Failed to update IDE context state:', errorMessage);
            this.post({ type: 'error', payload: errorMessage });
          }
        }
        break;
      }

      case 'cancel-stream': {
        const payload = message.payload as StreamCancelPayload;
        this.log(`cancel stream requested session_id=${payload.sessionId}`);
        if (this.streamClient) {
          await this.streamClient.cancelStream(payload.sessionId);
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
        this.currentChatId = undefined;
        this.streamClient = undefined;
        await this.sendChatList();
        break;
      }

      case 'logout': {
        this.log('logout requested from webview');
        this.currentChatId = undefined;
        await vscode.commands.executeCommand('vertex-swarm.logout');
        break;
      }

      default: {
        console.warn('VertexSwarm: unknown message type from webview');
      }
    }
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

    const tool_call_id = this.metadataString(metadata, 'tool_call_id');
    const tool_name = this.metadataString(metadata, 'tool_name')
      || this.metadataString(metadata, 'toolName');
    const session_id = this.metadataString(metadata, 'session_id');
    const chat_id = this.metadataString(metadata, 'chat_id') || this.currentChatId;
    const message_id = this.metadataString(metadata, 'message_id');
    const args = this.metadataObject(metadata, 'args') ?? {};

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
      >= VertexSwarmSidebarProvider.MAX_PROCESSED_TOOL_CALL_IDS
    ) {
      const firstToolCallId = this.processedToolCallIds.values().next().value;
      if (typeof firstToolCallId === 'string') {
        this.processedToolCallIds.delete(firstToolCallId);
      }
    }

    this.processedToolCallIds.add(payload.tool_call_id);

    try {
      await this.toolExecutor.handle(payload);
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

  /**
   * Public method for extension to trigger logout
   */
  public async handleLogout(reason?: string): Promise<void> {
    this.log(`handling logout${reason ? ` reason="${reason}"` : ''}`);
    const activeChatId = this.currentChatId;
    this.currentChatId = undefined;
    if (this.streamClient) {
      await this.streamClient.cancelStream(activeChatId ?? '');
      this.streamClient = undefined;
    }
    this.postLoggedOut(reason);
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

  /**
   * Build the HTML wrapper that loads the Vite-built React bundle
   */
  private buildWebviewHTML(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist');
    const assetsPath = vscode.Uri.joinPath(distPath, 'assets');

    // Read the built index.html to extract asset filenames
    let scriptFile = 'index.js';
    let styleFile = 'index.css';

    try {
      // Use require() dynamically to keep Node.js context (avoids Vite's browser externalization)
      const path = require('path');
      const fs = require('fs');
      const indexHtmlPath = path.join(distPath.fsPath, 'index.html');
      const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

      const scriptMatch = indexHtml.match(/assets\/(index-[^"]+\.js)/);
      const styleMatch = indexHtml.match(/assets\/(index-[^"]+\.css)/);

      if (scriptMatch) scriptFile = scriptMatch[1];
      if (styleMatch) styleFile = styleMatch[1];
    } catch {
      console.warn('VertexSwarm: could not read frontend dist/index.html — using defaults');
    }

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsPath, scriptFile));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsPath, styleFile));

    const nonce = this.generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 img-src ${webview.cspSource} data:;
                 font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Vertex Swarm</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
}
