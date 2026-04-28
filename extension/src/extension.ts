import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { VertexSwarmSidebarProvider } from './webview-provider';
import { VertexSwarmChatParticipant } from './chat-participant';

const BACKEND_URL = process.env.VERTEX_BACKEND_URL || 'http://localhost:8000';

async function revokeBackendRefreshToken(
  tokenManager: TokenManager,
  logAuthToOutput: (message: string) => void
): Promise<void> {
  try {
    const session = await tokenManager.getSession();
    if (session.status === 'missing' || !session.refreshToken) {
      return;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), 5000);

    try {
      const response = await fetch(`${BACKEND_URL}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal: abortController.signal,
      });

      logAuthToOutput(`[AuthRuntime] backend logout revoke status=${response.status}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAuthToOutput(`[AuthRuntime] backend logout revoke failed: ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Vertex Swarm extension activated');
  const outputChannel = vscode.window.createOutputChannel('Vertex Swarm');
  const authOutputChannel = vscode.window.createOutputChannel('Vertex Swarm Auth');
  outputChannel.appendLine(`[${new Date().toISOString()}] Extension activated`);
  authOutputChannel.appendLine(`[${new Date().toISOString()}] Auth logging initialized`);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(authOutputChannel);
  const logAuthToOutput = (message: string) => {
    authOutputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  const tokenManager = new TokenManager(context.secrets);
  const oauthHandler = new OAuthHandler(tokenManager, logAuthToOutput);

  const chatParticipantAdapter = new VertexSwarmChatParticipant(
    context,
    tokenManager,
    oauthHandler,
    outputChannel,
    logAuthToOutput
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
    outputChannel,
    logAuthToOutput
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
      await revokeBackendRefreshToken(tokenManager, logAuthToOutput);
      await tokenManager.clearToken();

      // Reset the sidebar locally without redirecting the user elsewhere.
      await sidebarProvider.handleLogout();
    })
  );
}

export function deactivate(): void {
  console.log('Vertex Swarm extension deactivated');
}
