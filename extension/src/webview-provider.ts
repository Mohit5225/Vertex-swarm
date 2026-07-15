import * as vscode from 'vscode';
import { ConfigManager } from './config-manager';
import { EntitlementClient } from './auth/entitlement-client';
import { VertexSwarmChatRuntime } from './chat-runtime';
import { PlanDocumentProvider } from './plan-document-provider';
import { VertexProcessManager } from './process-manager';

/**
 * VertexSwarmSidebarProvider
 * Registers as a WebviewView provider - renders the React UI inside the VS Code sidebar
 */
export class VertexSwarmSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vertex-swarm.sidebar';

  private webviewView: vscode.WebviewView | undefined;
  private readonly runtime: VertexSwarmChatRuntime;
  private readonly context: vscode.ExtensionContext;

  constructor(
    private readonly extensionUri: vscode.Uri,
    entitlementClient: EntitlementClient,
    configManager: ConfigManager,
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    authLog: ((message: string) => void) | undefined,
    planDocumentProvider: PlanDocumentProvider | undefined,
    processManager: VertexProcessManager
  ) {
    this.runtime = new VertexSwarmChatRuntime({
      entitlementClient,
      configManager,
      context,
      outputChannel,
      authLog,
      planDocumentProvider,
      postMessage: (message: object) => this.post(message),
      processManager,
    });
    this.context = context;
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

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist', 'assets'),
      ],
    };

    webviewView.webview.html = this.buildWebviewHTML(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.runtime.handleWebviewMessage(message as Parameters<VertexSwarmChatRuntime['handleWebviewMessage']>[0]);
      },
      undefined,
      this.context.subscriptions
    );
  }

  public async handleLogout(reason?: string): Promise<void> {
    await this.runtime.handleLogout(reason);
  }

  /**
   * Post message to webview
   */
  public postMessageToWebview(message: object): void {
    this.post(message);
  }

  private post(message: object): void {
    this.webviewView?.webview.postMessage(message);
  }

  /**
   * Build the HTML wrapper that loads the Vite-built React bundle
   */
  private buildWebviewHTML(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(this.extensionUri, 'frontend', 'dist');
    const assetsPath = vscode.Uri.joinPath(distPath, 'assets');

    let scriptFile = 'index.js';
    let styleFile = 'index.css';

    try {
      const path = require('path');
      const fs = require('fs');
      const indexHtmlPath = path.join(distPath.fsPath, 'index.html');
      const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

      const scriptMatch = indexHtml.match(/assets\/(index-[^"]+\.js)/);
      const styleMatch = indexHtml.match(/assets\/(index-[^"]+\.css)/);

      if (scriptMatch) scriptFile = scriptMatch[1];
      if (styleMatch) styleFile = styleMatch[1];
    } catch (err: any) {
      console.warn('VertexSwarm: could not read frontend dist/index.html — using defaults', err);
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
  <style>
    html, body, #root {
      width: 100%;
      height: 100%;
      margin: 0 !important;
      padding: 0 !important;
      border: 0;
      overflow: hidden;
      background: transparent;
    }

    body {
      box-sizing: border-box;
    }

    *, *::before, *::after {
      box-sizing: inherit;
    }
  </style>
  <link rel="stylesheet" href="${styleUri}" />
  <title>Vertex Swarm</title>
</head>
<body style="margin:0;padding:0;overflow:hidden;background:transparent;">
  <script nonce="${nonce}">
    window.addEventListener('error', (event) => {
      try {
        const vscode = acquireVsCodeApi();
        vscode.postMessage({ type: 'log', payload: 'WEBVIEW ERROR: ' + event.message + ' at ' + event.filename + ':' + event.lineno });
      } catch(e) {}
    });
  </script>
  <div id="root" style="width:100%;height:100%;"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }
}
