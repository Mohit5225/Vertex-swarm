import * as vscode from 'vscode';
import { VertexConfig } from './config-manager';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs';
import { RpcClient } from './rpc-client';

export class VertexProcessManager implements vscode.Disposable {
  private natsProcess: cp.ChildProcess | null = null;
  public backendProcess: cp.ChildProcess | null = null;
  public rpcClient: RpcClient | null = null;
  private basePath: string;

  constructor() {
    this.basePath = path.join(os.homedir(), '.vertex-swarm');
  }

  async start(
    context: vscode.ExtensionContext, 
    outputChannel: vscode.OutputChannel, 
    config: VertexConfig,
    entitlementToken: string
  ): Promise<void> {
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

    // Spawn NATS if not already running
    if (!this.natsProcess || this.natsProcess.exitCode !== null) {
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
    } else {
      outputChannel.appendLine(`[ProcessManager] NATS is already running.`);
    }

    // Spawn the Python worker
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      outputChannel.appendLine(`[ProcessManager] Spawning Python Worker (Development Mode)...`);
      const devPythonExe = platform === 'win32' 
        ? path.join(context.extensionUri.fsPath, '..', 'backend', 'venv', 'Scripts', 'python.exe')
        : path.join(context.extensionUri.fsPath, '..', 'backend', 'venv', 'bin', 'python');
      
      const devWorkerPath = path.join(context.extensionUri.fsPath, '..', 'backend', 'app', 'main_worker.py');

      if (!fs.existsSync(devPythonExe)) {
        vscode.window.showErrorMessage(`Local virtual environment not found at: ${devPythonExe}`);
        outputChannel.appendLine(`[ProcessManager] Error: Local virtual environment not found at ${devPythonExe}`);
        throw new Error(`Python virtual environment not found at ${devPythonExe}`);
      } else {
        outputChannel.appendLine(`[ProcessManager] Python Executable: ${devPythonExe}`);
        outputChannel.appendLine(`[ProcessManager] Worker Module: app.main_worker`);
        const backendDir = path.join(context.extensionUri.fsPath, '..', 'backend');
        this.backendProcess = cp.spawn(devPythonExe, ['-m', 'app.main_worker'], { 
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: backendDir,
          env: { ...process.env, PYTHONPATH: backendDir }
        });
      }
    } else {
      outputChannel.appendLine(`[ProcessManager] Spawning Python Worker (Production Mode)...`);
      this.backendProcess = cp.spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    if (this.backendProcess) {
      this.backendProcess.stderr?.on('data', (data) => {
        outputChannel.appendLine(`[Worker Error] ${data.toString().trim()}`);
      });
      this.backendProcess.on('error', (err) => {
        outputChannel.appendLine(`[ProcessManager] Worker spawn error: ${err.message}`);
      });
      this.backendProcess.on('exit', (code) => {
        outputChannel.appendLine(`[ProcessManager] Worker exited with code ${code}`);
        this.rpcClient = null;
        this.backendProcess = null;
      });

      this.rpcClient = new RpcClient(this.backendProcess);
      
      // Perform handshake (30s timeout)
      try {
        outputChannel.appendLine(`[ProcessManager] Sending initialize JSON-RPC handshake...`);
        const timeoutMs = 30_000;
        const initResult = await Promise.race([
          this.rpcClient.sendRequest('initialize', {
            protocol_version: '1.0',
            base_path: this.basePath,
            llm_key: config.llmKey,
            exa_key: config.exaKey,
            llm_base_url: config.llmBaseUrl,
            llm_model: config.llmModel,
            entitlement_token: entitlementToken,
            platform: platform
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Worker handshake timed out after ${timeoutMs / 1000}s`)), timeoutMs)
          )
        ]);
        
        if (initResult.status === 'ready') {
            outputChannel.appendLine(`[ProcessManager] Handshake complete. Backend is ready!`);
        } else {
            outputChannel.appendLine(`[ProcessManager] Warning: Unexpected handshake result: ${JSON.stringify(initResult)}`);
        }
      } catch (err: any) {
        outputChannel.appendLine(`[ProcessManager] Handshake failed: ${err.message || err.code || err}`);
        throw new Error(`Worker initialization failed: ${err.message || err.code || err}`);
      }
    }
    
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

  public dispose() {
    if (this.rpcClient) {
      this.rpcClient.dispose();
    }
    if (this.backendProcess) {
      this.backendProcess.kill();
    }
    if (this.natsProcess) {
      this.natsProcess.kill();
    }
  }
}
