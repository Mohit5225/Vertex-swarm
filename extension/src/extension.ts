import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { ConfigManager } from './config-manager';
import { VertexSwarmSidebarProvider } from './webview-provider';
import { VertexSwarmChatParticipant } from './chat-participant';
import { SnapshotContentProvider, SNAPSHOT_SCHEME } from './snapshot/snapshot-content-provider';
import { SnapshotGarbageCollector } from './snapshot/garbage-collector';
import { PlanDocumentProvider } from './plan-document-provider';
import * as path from 'path';
import * as os from 'os';

const BACKEND_URL = process.env.VERTEX_BACKEND_URL || 'http://127.0.0.1:8000';

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
  const configManager = new ConfigManager(context);

  const chatParticipantAdapter = new VertexSwarmChatParticipant(
    context,
    tokenManager,
    oauthHandler,
    configManager,
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

  // Register the plan document provider
  const planDocumentProvider = new PlanDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PlanDocumentProvider.scheme, planDocumentProvider)
  );

  // Register the sidebar WebviewView provider
  const sidebarProvider = new VertexSwarmSidebarProvider(
    context.extensionUri,
    tokenManager,
    oauthHandler,
    configManager,
    context,
    outputChannel,
    logAuthToOutput,
    planDocumentProvider
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

  // Sidebar toggle commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.toggleHistory', () => {
      sidebarProvider.postMessageToWebview({ type: 'toggle-history' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.toggleSession', () => {
      sidebarProvider.postMessageToWebview({ type: 'toggle-session' });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.requestLogout', () => {
      sidebarProvider.postMessageToWebview({ type: 'logout-confirm' });
    })
  );

  // Register the snapshot content provider for diff views
  const snapshotContentProvider = new SnapshotContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotContentProvider)
  );

  // Start Snapshot Garbage Collector
  const snapshotsRootDir = path.join(os.homedir(), '.vertex-swarm', 'snapshots');
  const garbageCollector = new SnapshotGarbageCollector(snapshotsRootDir);
  garbageCollector.start();
  context.subscriptions.push(garbageCollector);

  // Logout command (executes actual logout)
  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.logout', async () => {
      await revokeBackendRefreshToken(tokenManager, logAuthToOutput);
      await tokenManager.clearToken();

      // Reset the sidebar locally without redirecting the user elsewhere.
      // Deprecated in favor of the frontend component's logout calling chat-runtime.
    })
  );
}

export function deactivate(): void {
  console.log('Vertex Swarm extension deactivated');
}
