import * as vscode from 'vscode';
import { TokenManager, type StoredSession } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { SSEStreamClient } from './sse-client/stream';
import { FileSystemService } from './tools/file-system-service';
import { ToolExecutor } from './tools/tool-executor';
import { WorkspaceStore } from './workspace-store';
import { TerminalService } from './tools/terminal-service';
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

const BACKEND_URL = process.env.VERTEX_BACKEND_URL || 'http://localhost:8000';

interface ChatMessagesResponse {
  chatId: string;
  ideContextEnabled: boolean;
  messages: ChatMessageData[];
}

interface BackendAuthUser {
  id: string;
  email?: string;
  role?: string;
}

interface BackendAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: string;
  user?: BackendAuthUser;
}

export interface VertexSwarmChatRuntimeOptions {
  tokenManager: TokenManager;
  oauthHandler: OAuthHandler;
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  authLog?: (message: string) => void;
  postMessage: (message: object) => void;
  backendUrl?: string;
}

export class VertexSwarmChatRuntime {
  private static readonly MAX_PROCESSED_TOOL_CALL_IDS = 10_000;
  private static readonly TOKEN_REFRESH_BUFFER_MS = 12 * 60 * 1000;
  private static readonly APP_TOKEN_ISSUER = process.env.VERTEX_APP_TOKEN_ISSUER || 'vertex-swarm-backend';

  private readonly backendUrl: string;
  private readonly tokenManager: TokenManager;
  private readonly oauthHandler: OAuthHandler;
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly authLog?: (message: string) => void;
  private readonly postMessage: (message: object) => void;
  private readonly fileSystemService: FileSystemService;
  private readonly terminalService: TerminalService;
  private readonly workspaceStore: WorkspaceStore;
  private readonly toolExecutor: ToolExecutor;
  private readonly processedToolCallIds = new Set<string>();

  private streamClient: SSEStreamClient | undefined;
  private currentChatId: string | undefined;
  private authResetInProgress = false;
  private refreshInFlight: Promise<StoredSession> | null = null;

  constructor(options: VertexSwarmChatRuntimeOptions) {
    this.backendUrl = options.backendUrl || BACKEND_URL;
    this.tokenManager = options.tokenManager;
    this.oauthHandler = options.oauthHandler;
    this.context = options.context;
    this.outputChannel = options.outputChannel;
    this.authLog = options.authLog;
    this.postMessage = options.postMessage;
    this.fileSystemService = new FileSystemService();
    this.terminalService = new TerminalService(
      (msg) => this.log(msg),
      (event) => this.post({ type: 'event', payload: event })
    );
    this.workspaceStore = new WorkspaceStore();
    this.context.subscriptions.push(this.workspaceStore);
    this.toolExecutor = new ToolExecutor(
      this.fileSystemService,
      this.terminalService,
      this.backendUrl,
      (tokenOptions) => this.getValidToken(tokenOptions),
      (message: string) => this.log(message)
    );
  }

  public async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    if ('type' in message && message.type === 'log') {
      this.log(`[WebView Log] ${message.payload}`);
      return;
    }
    switch (message.type) {
      case 'open-browser': {
        this.log('starting OAuth browser flow');
        const success = await this.oauthHandler.startAuthFlow(true);
        if (success) {
          this.log('OAuth flow completed successfully');
          const hasValidSession = await this.syncWebviewSession();
          if (hasValidSession) {
            await this.sendChatList();
          }
        }
        break;
      }

      case 'copy-link': {
        this.log('starting OAuth clipboard flow');
        const success = await this.oauthHandler.startAuthFlow(false);
        if (success) {
          this.log('OAuth flow completed successfully via clipboard');
          const hasValidSession = await this.syncWebviewSession();
          if (hasValidSession) {
            await this.sendChatList();
          }
        }
        break;
      }

      case 'request-session': {
        this.log('webview requested current session');
        const hasValidSession = await this.syncWebviewSession();
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
            this.backendUrl,
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
            ideContextEnabled,
            payload.requestContext
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

        // Notify backend that stream was cancelled so LLM context is aware
        try {
          const token = await this.getValidToken();
          if (token && payload.sessionId) {
            const response = await fetch(
              `${this.backendUrl}/api/v1/chats/${payload.sessionId}/cancel`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
              }
            );
            if (!response.ok) {
              this.log(`failed to notify backend of cancellation status=${response.status}`);
            } else {
              this.log(`backend acknowledged cancellation chat_id=${payload.sessionId}`);
            }
          }
        } catch (error) {
          this.log(`error notifying backend of cancellation: ${error instanceof Error ? error.message : String(error)}`);
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

  private post(message: object): void {
    this.postMessage(message);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private logAuth(message: string): void {
    this.authLog?.(`[AuthRuntime] ${message}`);
  }

  private postLoggedOut(reason?: string): void {
    this.log(`posting logged-out state${reason ? ` reason="${reason}"` : ''}`);
    this.post({
      type: 'logged-out',
      payload: { reason: reason ?? null },
    });
  }

  private buildAuthenticatedSessionData(
    userMetadata: Record<string, unknown>
  ): AuthenticatedSessionData {
    return {
      user: {
        id: (userMetadata.id as string) || '',
        email: (userMetadata.email as string) || '',
        provider: (userMetadata.provider as string) || 'neon-auth',
      },
    };
  }

  private postAuthenticated(session: Extract<StoredSession, { status: 'valid' }>): void {
    this.post({
      type: 'authenticated',
      payload: this.buildAuthenticatedSessionData(session.userMetadata),
    });
  }

  private async syncWebviewSession(): Promise<boolean> {
    const session = await this.getRestoredSession();
    this.log(`session lookup completed status=${session.status}`);
    this.logAuth(`session lookup completed status=${session.status}`);

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

    this.postAuthenticated(session);
    return true;
  }

  private async getValidToken(
    options: { forceRefresh?: boolean; previousToken?: string } = {}
  ): Promise<string | undefined> {
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
    options: { forceRefresh?: boolean; previousToken?: string } = {}
  ): Promise<StoredSession> {
    const session = await this.tokenManager.getSession();
    const backendSession = await this.ensureBackendSession(session);
    return this.refreshSessionIfNeeded(backendSession, options);
  }

  private async ensureBackendSession(session: StoredSession): Promise<StoredSession> {
    if (session.status !== 'valid') {
      return session;
    }

    if (this.isBackendAccessToken(session.token)) {
      return session;
    }

    this.log('exchanging Neon JWT for backend extension session');
    this.logAuth('exchanging Neon JWT for backend extension session');

    const exchanged = await this.exchangeTokenWithBackend(session.token);
    if (!exchanged?.access_token || !exchanged.refresh_token) {
      await this.tokenManager.clearToken();
      return { status: 'missing' };
    }

    const mergedUserMetadata = {
      ...session.userMetadata,
      id: exchanged.user?.id || (session.userMetadata.id as string) || '',
      email: exchanged.user?.email || (session.userMetadata.email as string) || '',
      role: exchanged.user?.role || (session.userMetadata.role as string) || 'authenticated',
      provider: 'vertex-swarm-backend',
    };

    await this.tokenManager.setToken(
      exchanged.access_token,
      mergedUserMetadata,
      exchanged.refresh_token
    );

    const restored = await this.tokenManager.getSession();
    if (restored.status === 'valid') {
      this.logAuth('backend session exchange completed successfully');
      this.postAuthenticated(restored);
    }

    return restored;
  }

  private async exchangeTokenWithBackend(neonToken: string): Promise<BackendAuthTokenResponse | undefined> {
    try {
      const response = await fetch(`${this.backendUrl}/api/v1/auth/exchange`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${neonToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log(`backend auth exchange failed status=${response.status} body=${errorText.slice(0, 300)}`);
        this.logAuth(`backend auth exchange failed status=${response.status}`);
        return undefined;
      }

      return await response.json() as BackendAuthTokenResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`backend auth exchange error: ${message}`);
      this.logAuth(`backend auth exchange error: ${message}`);
      return undefined;
    }
  }

  private async refreshSessionIfNeeded(
    session: StoredSession,
    options: { forceRefresh?: boolean; previousToken?: string } = {}
  ): Promise<StoredSession> {
    if (!this.shouldRefreshSession(session, options.forceRefresh)) {
      const reason = this.getRefreshSkipReason(session, options.forceRefresh) ?? 'not eligible for refresh';
      this.log(`silent refresh skipped (${reason})`);
      this.logAuth(`silent refresh skipped (${reason})`);
      return session;
    }

    const reason = options.forceRefresh
      ? 'forced refresh'
      : session.status === 'expired'
        ? 'expired JWT'
        : 'expiring JWT';

    if (this.refreshInFlight) {
      this.log(`joining in-flight silent refresh (${reason})`);
      this.logAuth(`joining in-flight silent refresh (${reason})`);
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
    if (session.status === 'missing' || !session.refreshToken) {
      return false;
    }

    if (!this.isBackendRefreshToken(session.refreshToken)) {
      return false;
    }

    if (forceRefresh || session.status === 'expired') {
      return true;
    }

    return (
      typeof session.expiresAt === 'number'
      && session.expiresAt - Date.now() <= VertexSwarmChatRuntime.TOKEN_REFRESH_BUFFER_MS
    );
  }

  private getRefreshSkipReason(
    session: StoredSession,
    forceRefresh = false
  ): string | null {
    if (session.status === 'missing') {
      return 'no stored session';
    }

    if (!session.refreshToken) {
      return `refresh token missing (status=${session.status})`;
    }

    if (!this.isBackendRefreshToken(session.refreshToken)) {
      return 'stored refresh token is not a backend token';
    }

    if (forceRefresh || session.status === 'expired') {
      return null;
    }

    if (typeof session.expiresAt !== 'number') {
      return 'session expiration unavailable';
    }

    const remainingMs = session.expiresAt - Date.now();
    if (remainingMs > VertexSwarmChatRuntime.TOKEN_REFRESH_BUFFER_MS) {
      const remainingMinutes = Math.max(0, Math.floor(remainingMs / (60 * 1000)));
      return `token still healthy for ${remainingMinutes}m`;
    }

    return null;
  }

  private async refreshSessionWithStoredToken(
    session: Exclude<StoredSession, { status: 'missing' }>,
    reason: string
  ): Promise<StoredSession> {
    const refreshedSession = await this.silentRefreshWithBackendToken(
      session.refreshToken ?? '',
      session.userMetadata,
      reason
    );
    if (!refreshedSession) {
      return session;
    }

    return refreshedSession;
  }

  private async silentRefreshFromStorage(
    reason: string,
    previousToken?: string
  ): Promise<string | undefined> {
    const storedSession = await this.tokenManager.getSession();
    const session = await this.ensureBackendSession(storedSession);

    if (session.status === 'valid' && previousToken && session.token !== previousToken) {
      this.log(`using newer stored access token without backend refresh (${reason})`);
      this.logAuth(`using newer stored access token without backend refresh (${reason})`);
      return session.token;
    }

    if (session.status === 'missing' || !session.refreshToken) {
      this.log(`forced silent refresh unavailable (${reason})`);
      this.logAuth(`forced silent refresh unavailable (${reason})`);
      return undefined;
    }

    const refreshedSession = await this.refreshSessionIfNeeded(session, { forceRefresh: true });
    if (refreshedSession.status !== 'valid') {
      this.log(`forced silent refresh failed (${reason}) status=${refreshedSession.status}`);
      this.logAuth(`forced silent refresh failed (${reason}) status=${refreshedSession.status}`);
      return undefined;
    }

    if (session.status === 'valid' && refreshedSession.token === session.token) {
      if (!previousToken || refreshedSession.token !== previousToken) {
        this.log(`using stored access token after refresh attempt (${reason})`);
        this.logAuth(`using stored access token after refresh attempt (${reason})`);
        return refreshedSession.token;
      }

      this.log(`forced silent refresh produced no replacement JWT (${reason})`);
      this.logAuth(`forced silent refresh produced no replacement JWT (${reason})`);
      return undefined;
    }

    return refreshedSession.token;
  }

  private async silentRefreshWithBackendToken(
    refreshToken: string,
    userMetadata: Record<string, unknown>,
    reason: string
  ): Promise<StoredSession | undefined> {
    this.log(`attempting backend access token refresh (${reason})`);
    this.logAuth(`attempting backend access token refresh (${reason})`);

    const refreshedToken = await this.requestBackendTokenRefresh(refreshToken);
    if (!refreshedToken?.access_token || !refreshedToken.refresh_token) {
      this.log(`backend refresh did not return replacement tokens (${reason})`);
      this.logAuth(`backend refresh did not return replacement tokens (${reason})`);
      return undefined;
    }

    const mergedUserMetadata = {
      ...userMetadata,
      id: refreshedToken.user?.id || (userMetadata.id as string) || '',
      email: refreshedToken.user?.email || (userMetadata.email as string) || '',
      role: refreshedToken.user?.role || (userMetadata.role as string) || 'authenticated',
      provider: 'vertex-swarm-backend',
    };

    await this.tokenManager.setToken(
      refreshedToken.access_token,
      mergedUserMetadata,
      refreshedToken.refresh_token
    );

    const refreshedSession = await this.tokenManager.getSession();
    this.log(`backend refresh completed status=${refreshedSession.status} (${reason})`);
    this.logAuth(`backend refresh completed status=${refreshedSession.status} (${reason})`);
    if (refreshedSession.status === 'valid') {
      this.postAuthenticated(refreshedSession);
    }

    return refreshedSession;
  }

  private async requestBackendTokenRefresh(refreshToken: string): Promise<BackendAuthTokenResponse | undefined> {
    try {
      const response = await fetch(`${this.backendUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log(`backend refresh request failed status=${response.status} body=${errorText.slice(0, 300)}`);
        this.logAuth(`backend refresh request failed status=${response.status}`);
        return undefined;
      }

      return await response.json() as BackendAuthTokenResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`backend refresh request error: ${message}`);
      this.logAuth(`backend refresh request error: ${message}`);
      return undefined;
    }
  }

  private isBackendAccessToken(token: string): boolean {
    try {
      const payloadPart = token.split('.')[1];
      if (!payloadPart) {
        return false;
      }

      const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const payload = JSON.parse(
        Buffer.from(padded, 'base64').toString('utf-8')
      ) as { iss?: string; token_type?: string };

      return (
        payload.iss === VertexSwarmChatRuntime.APP_TOKEN_ISSUER
        && payload.token_type === 'access'
      );
    } catch {
      return false;
    }
  }

  private isBackendRefreshToken(token: string): boolean {
    try {
      const payloadPart = token.split('.')[1];
      if (!payloadPart) {
        return false;
      }

      const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const payload = JSON.parse(
        Buffer.from(padded, 'base64').toString('utf-8')
      ) as { iss?: string; token_type?: string };

      return (
        payload.iss === VertexSwarmChatRuntime.APP_TOKEN_ISSUER
        && payload.token_type === 'refresh'
      );
    } catch {
      return false;
    }
  }

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
    const response = await fetch(`${this.backendUrl}${path}`, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      if (allowRetry) {
        const refreshedToken = await this.silentRefreshFromStorage(
          `backend 401 for ${path}`,
          token
        );
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
    this.logAuth('backend returned 401; clearing local session');
    await this.revokeStoredRefreshToken('forced unauthorized logout');
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

  private async revokeStoredRefreshToken(reason: string): Promise<void> {
    try {
      const session = await this.tokenManager.getSession();
      if (session.status === 'missing' || !session.refreshToken) {
        return;
      }

      if (!this.isBackendRefreshToken(session.refreshToken)) {
        return;
      }

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), 5000);

      try {
        const response = await fetch(`${this.backendUrl}/api/v1/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ refresh_token: session.refreshToken }),
          signal: abortController.signal,
        });

        this.log(`backend refresh revoke during ${reason} status=${response.status}`);
        this.logAuth(`backend refresh revoke during ${reason} status=${response.status}`);
      } finally {
        clearTimeout(timeoutHandle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`backend refresh revoke failed during ${reason}: ${message}`);
      this.logAuth(`backend refresh revoke failed during ${reason}: ${message}`);
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
      >= VertexSwarmChatRuntime.MAX_PROCESSED_TOOL_CALL_IDS
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
