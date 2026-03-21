import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { VertexSwarmSidebarProvider } from './webview-provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Vertex Swarm extension activated');
  const outputChannel = vscode.window.createOutputChannel('Vertex Swarm');
  outputChannel.appendLine(`[${new Date().toISOString()}] Extension activated`);
  context.subscriptions.push(outputChannel);

  const tokenManager = new TokenManager(context.secrets);
  const oauthHandler = new OAuthHandler(tokenManager, context);

  // Register the sidebar WebviewView provider
  const sidebarProvider = new VertexSwarmSidebarProvider(
    context.extensionUri,
    tokenManager,
    oauthHandler,
    context,
    outputChannel
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VertexSwarmSidebarProvider.viewId,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Logout command
  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.logout', async () => {
      await tokenManager.clearToken();

      // Reset the sidebar locally without redirecting the user elsewhere.
      await sidebarProvider.handleLogout();
    })
  );
}

export function deactivate(): void {
  console.log('Vertex Swarm extension deactivated');
}

