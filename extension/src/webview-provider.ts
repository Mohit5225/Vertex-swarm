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

    // When webview finishes loading, check for existing token
    // and send auth-url immediately so login screen can render
    this.sendAuthUrl();
    this.checkAndSendExistingToken();
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
    const token = await this.tokenManager.getToken();
    const userMetadata = await this.tokenManager.getUserMetadata();

    if (token && userMetadata) {
      this.post({
        type: 'token',
        payload: {
          token,
          user: {
            id: (userMetadata.id as string) || '',
            email: (userMetadata.email as string) || '',
            provider: (userMetadata.provider as string) || 'neon-auth',
          },
        } as TokenData,
      });
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
        break;
      }

      case 'start-stream': {
        const payload = message.payload as StreamStartPayload;
        const token = await this.tokenManager.getToken();

        if (!token) {
          this.post({ type: 'error', payload: 'No auth token. Please sign in first.' });
          return;
        }

        this.streamClient = new SSEStreamClient(
          BACKEND_URL,
          token,
          (event: SessionEvent) => {
            this.post({ type: 'event', payload: event });
          },
          (error: string) => {
            this.post({ type: 'error', payload: error });
          },
          () => {
            this.post({ type: 'cancel-stream', payload: { sessionId: payload.sessionId } });
          }
        );

        await this.streamClient.openStream(payload.sessionId);
        break;
      }

      case 'cancel-stream': {
        const payload = message.payload as StreamCancelPayload;
        const token = await this.tokenManager.getToken();
        if (this.streamClient && token) {
          await this.streamClient.cancelStream(payload.sessionId);
        }
        break;
      }

      case 'logout': {
        await this.tokenManager.clearToken();
        // Reload webview back to login screen
        if (this.webviewView) {
          this.webviewView.webview.html = this.buildWebviewHTML(this.webviewView.webview);
          this.sendAuthUrl();
        }
        break;
      }

      default: {
        console.warn('VertexSwarm: unknown message type from webview');
      }
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
