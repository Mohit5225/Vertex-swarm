import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

export class VertexProcessManager implements vscode.Disposable {
  private natsProcess: cp.ChildProcess | null = null;
  public backendProcess: cp.ChildProcess | null = null; // Public so we can access stdin/stdout in future
  private basePath: string;

  constructor() {
    this.basePath = path.join(os.homedir(), '.vertex-swarm');
  }

  async start(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): Promise<void> {
    const platform = os.platform();
    let binPlatform = platform;
    if (platform === 'win32') binPlatform = 'win32';
    else if (platform === 'darwin') binPlatform = 'darwin';
    else if (platform === 'linux') binPlatform = 'linux';
    
    const natsExe = platform === 'win32' ? 'nats-server.exe' : 'nats-server';
    const workerExe = platform === 'win32' ? 'python-worker.exe' : 'python-worker';

    const natsPath = vscode.Uri.joinPath(context.extensionUri, 'bin', binPlatform, natsExe).fsPath;
    const workerPath = vscode.Uri.joinPath(context.extensionUri, 'bin', binPlatform, workerExe).fsPath;

    const natsDataDir = path.join(this.basePath, 'nats-data');

    // Spawn NATS
    outputChannel.appendLine(`[ProcessManager] Spawning NATS: ${natsPath}`);
    this.natsProcess = cp.spawn(natsPath, [
      '--jetstream', 
      '--store_dir', natsDataDir, 
      '--port', '4222'
    ], { stdio: 'pipe' });

    this.natsProcess.on('error', (err) => {
      outputChannel.appendLine(`[ProcessManager] NATS spawn error: ${err.message}`);
    });

    this.natsProcess.on('exit', (code) => {
      outputChannel.appendLine(`[ProcessManager] NATS exited with code ${code}`);
    });

    // Wait for NATS to be ready
    await this.waitForNats();
    outputChannel.appendLine(`[ProcessManager] NATS is listening on 4222`);

    // In a future phase, we will spawn the python worker here.
    // this.backendProcess = cp.spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    // Register exit handlers to clean up if the parent process dies abruptly
    process.on('exit', () => this.dispose());
  }

  private async waitForNats(): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxRetries = 50; // 5s (50 * 100ms)
      let retries = 0;

      const tryConnect = () => {
        if (!this.natsProcess || this.natsProcess.exitCode !== null) {
          reject(new Error('NATS server process exited before port was ready'));
          return;
        }

        const socket = new net.Socket();
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', (err) => {
          socket.destroy();
          retries++;
          if (retries >= maxRetries) {
            reject(new Error('NATS server failed to start on port 4222 within 5 seconds'));
          } else {
            setTimeout(tryConnect, 100);
          }
        });
        socket.connect(4222, '127.0.0.1');
      };

      tryConnect();
    });
  }

  dispose(): void {
    if (this.natsProcess) {
      this.natsProcess.kill();
      this.natsProcess = null;
    }
    if (this.backendProcess) {
      this.backendProcess.kill();
      this.backendProcess = null;
    }
  }
}
