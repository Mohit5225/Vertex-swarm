import * as vscode from 'vscode';
import { EntitlementClient } from './auth/entitlement-client';
import { ConfigManager } from './config-manager';
import { VertexSwarmSidebarProvider } from './webview-provider';
import { VertexSwarmChatParticipant } from './chat-participant';
import { SnapshotContentProvider, SNAPSHOT_SCHEME } from './snapshot/snapshot-content-provider';
import { SnapshotGarbageCollector } from './snapshot/garbage-collector';
import { PlanDocumentProvider } from './plan-document-provider';
import { VertexProcessManager } from './process-manager';
import { debugLog, getDebugLogPath, initDebugLog, showDebugLog } from './debug-log';
import * as path from 'path';
import * as os from 'os';



export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Vertex Swarm extension activated');
  const outputChannel = vscode.window.createOutputChannel('Vertex Swarm');
  const authOutputChannel = vscode.window.createOutputChannel('Vertex Swarm Auth');
  initDebugLog(outputChannel);
  debugLog('Extension', `activated — file log: ${getDebugLogPath()}`);
  authOutputChannel.appendLine(`[${new Date().toISOString()}] Auth logging initialized`);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(authOutputChannel);
  const logAuthToOutput = (message: string) => {
    authOutputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  const entitlementClient = new EntitlementClient(context.secrets, logAuthToOutput);
  const configManager = new ConfigManager(context);
  
  const processManager = new VertexProcessManager();
  context.subscriptions.push(processManager);

  // Initialize backend asynchronously so we don't block extension activation
  configManager.getConfig().then(async (config) => {
    try {
      const token = await entitlementClient.getToken();
      if (!token) return; // Let chat-runtime handle lazy start upon login
      await processManager.start(context, outputChannel, config, token);
      debugLog('Extension', 'backend process manager started');
    } catch (err: any) {
      debugLog('Extension', `Failed to start process manager: ${err.message}`);
      vscode.window.showErrorMessage(`Failed to start Vertex Swarm backend: ${err.message}`);
    }
  });

  const chatParticipantAdapter = new VertexSwarmChatParticipant(
    context,
    entitlementClient,
    configManager,
    outputChannel,
    logAuthToOutput,
    processManager
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
    entitlementClient,
    configManager,
    context,
    outputChannel,
    logAuthToOutput,
    planDocumentProvider,
    processManager
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
      await sidebarProvider.handleLogout('User initiated logout');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vertex-swarm.showLogs', async () => {
      await showDebugLog();
    })
  );

  const logsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  logsStatusBar.text = '$(output) Vertex Swarm Logs';
  logsStatusBar.tooltip = `Open debug log (${getDebugLogPath()})`;
  logsStatusBar.command = 'vertex-swarm.showLogs';
  logsStatusBar.show();
  context.subscriptions.push(logsStatusBar);
}

export function deactivate(): void {
  console.log('Vertex Swarm extension deactivated');
}
