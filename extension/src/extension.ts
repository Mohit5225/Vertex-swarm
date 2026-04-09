import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { VertexSwarmSidebarProvider } from './webview-provider';
import { VertexSwarmChatParticipant } from './chat-participant';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Vertex Swarm extension activated');
  const outputChannel = vscode.window.createOutputChannel('Vertex Swarm');
  outputChannel.appendLine(`[${new Date().toISOString()}] Extension activated`);
  context.subscriptions.push(outputChannel);
  const logToOutput = (message: string) => {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  const tokenManager = new TokenManager(context.secrets);
  const oauthHandler = new OAuthHandler(tokenManager, logToOutput);

  const chatParticipantAdapter = new VertexSwarmChatParticipant(
    context,
    tokenManager,
    oauthHandler,
    outputChannel
  );
  const chatParticipant = vscode.chat.createChatParticipant(
    VertexSwarmChatParticipant.participantId,
    (request, chatContext, stream, token) =>
      chatParticipantAdapter.handleRequest(request, chatContext, stream, token)
  );
  chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  context.subscriptions.push(chatParticipant);

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
