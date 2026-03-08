import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { SSEStreamClient } from './sse-client/stream';
import type {
  WebviewToExtensionMessage,
  SessionEvent,
  TokenData,
  StreamStartPayload,
  StreamCancelPayload,
  OpenChatPayload,
  ChatSummaryData,
  ChatMessageData,
} from './types/index';

const BACKEND_URL = process.env.VERTEX_BACKEND_URL || 'http://localhost:8000';

/**
 * VertexSwarmSidebarProvider
 * Registers as a WebviewView provider - renders the React UI inside the VS Code sidebar
 */
export class VertexSwarmSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vertex-swarm.sidebar';

  private webviewView: vscode.WebviewView | undefined;
  private streamClient: SSEStreamClient | undefined;
  private currentChatId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tokenManager: TokenManager,
    private readonly oauthHandler: OAuthHandler,
    private readonly context: vscode.ExtensionContext
  ) {}

  /**
   * Called by VS Code when the sidebar panel becomes visible
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

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
  }

  /**
   * Post message to webview
   */
  private post(message: object): void {
    this.webviewView?.webview.postMessage(message);
  }

  /**
   * Send OAuth URL to webview on load so login screen can render buttons
   */
  private sendAuthUrl(): void {
    this.post({
      type: 'auth-url',
      payload: { url: this.oauthHandler.getAuthUrl() },
    });
  }

  /**
   * If a token already exists, send it to webview immediately
   */
  private async checkAndSendExistingToken(): Promise<void> {
    const session = await this.tokenManager.getSession();

    if (session.status === 'expired') {
      await vscode.window.showInformationMessage(
        'Vertex Swarm session expired. Please sign in again.'
      );
      await this.handleLogout();
      return;
    }

    if (session.status !== 'valid') {
      return;
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
  }

  private async getValidToken(): Promise<string | undefined> {
    const session = await this.tokenManager.getSession();

    if (session.status === 'valid') {
      return session.token;
    }

    if (session.status === 'expired') {
      await vscode.window.showInformationMessage(
        'Vertex Swarm session expired. Please sign in again.'
      );
    }

    await this.handleLogout();
    return undefined;
  }

  /**
   * Create a new backend chat for multi-turn conversation state.
   */
  private async createChat(token: string): Promise<string | null> {
    try {
      const data = await this.requestJson<{ chatId: string }>(
        '/api/v1/chats',
        token,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
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

  private async fetchChatMessages(token: string, chatId: string): Promise<ChatMessageData[]> {
    return this.requestJson<ChatMessageData[]>(
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

  private async sendChatList(token?: string): Promise<void> {
    const validToken = token ?? await this.getValidToken();

    if (!validToken) {
      return;
    }

    try {
      const chats = await this.fetchChatList(validToken);
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
    const messages = await this.fetchChatMessages(token, chatId);
    this.currentChatId = chatId;

    this.post({
      type: 'chat-opened',
      payload: {
        chatId,
        messages,
      },
    });

    await this.sendChatList(token);
  }

  private async requestJson<T>(
    path: string,
    token: string,
    init: RequestInit
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
    await this.tokenManager.clearToken();
    this.currentChatId = undefined;
    this.streamClient = undefined;
    await vscode.window.showWarningMessage(
      'Vertex Swarm session expired. Please sign in again.'
    );
    await this.handleLogout();
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
        const success = await this.oauthHandler.startAuthFlow();
        if (success) {
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
        await this.checkAndSendExistingToken();
        await this.sendChatList();
        break;
      }

      case 'load-chat-list': {
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
          const chatId = this.currentChatId ?? await this.createChat(token);

          if (!chatId) {
            this.post({ type: 'error', payload: 'Failed to create chat' });
            return;
          }

          this.currentChatId = chatId;
          await this.sendChatList(token);

          this.streamClient = new SSEStreamClient(
            BACKEND_URL,
            token,
            (event: SessionEvent) => {
              this.post({ type: 'event', payload: event });
            },
            (error: string) => {
              if (this.isUnauthorizedError(error)) {
                void this.handleUnauthorized();
                return;
              }

              this.post({ type: 'error', payload: error });
            },
            () => {
              this.post({ type: 'cancel-stream', payload: { sessionId: chatId } });
            }
          );

          await this.streamClient.openChatStream(chatId, payload.message);
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

      case 'cancel-stream': {
        const payload = message.payload as StreamCancelPayload;
        if (this.streamClient) {
          await this.streamClient.cancelStream(payload.sessionId);
        }
        break;
      }

      case 'reset-chat': {
        this.currentChatId = undefined;
        this.streamClient = undefined;
        await this.sendChatList();
        break;
      }

      case 'logout': {
        this.currentChatId = undefined;
        await vscode.commands.executeCommand('vertex-swarm.logout');
        break;
      }

      default: {
        console.warn('VertexSwarm: unknown message type from webview');
      }
    }
  }

  /**
   * Public method for extension to trigger logout
   */
  public async handleLogout(): Promise<void> {
    this.currentChatId = undefined;
    this.streamClient = undefined;
    if (this.webviewView) {
      // Rebuild HTML to clear all React state
      this.webviewView.webview.html = this.buildWebviewHTML(this.webviewView.webview);
      this.sendAuthUrl();
    }
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
