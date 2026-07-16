import * as vscode from 'vscode';
import { VertexConfig } from './config-manager';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs';
import { RpcClient } from './rpc-client';
import { validateProtocolVersion } from './utils/protocol-validator';

export class VertexProcessManager implements vscode.Disposable {
  private natsProcess: cp.ChildProcess | null = null;
  private _backendProcess: cp.ChildProcess | null = null;
  private _rpcClient: RpcClient | null = null;
  private basePath: string;
  private natsPort: number = 4222;
  private hasRegisteredExitHandler: boolean = false;
  private startPromise: Promise<void> | null = null;

  public get backendProcess() { return this._backendProcess; }
  public get rpcClient() { return this._rpcClient; }

  constructor() {
    this.basePath = path.join(os.homedir(), '.vertex-swarm');
  }

  async start(
    context: vscode.ExtensionContext, 
    outputChannel: vscode.OutputChannel, 
    config: VertexConfig,
    entitlementToken: string
  ): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    
    this.startPromise = this._start(context, outputChannel, config, entitlementToken).finally(() => {
      this.startPromise = null;
    });
    
    return this.startPromise;
  }

  private async _start(
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

    // Spawn NATS if not already running
    if (!this.natsProcess || this.natsProcess.exitCode !== null) {
      this.natsPort = await this.getFreePort(4222);
      
      const natsDataDir = path.join(this.basePath, `nats-data-${this.natsPort}`);
      
      outputChannel.appendLine(`[ProcessManager] Selected NATS port: ${this.natsPort}`);
      outputChannel.appendLine(`[ProcessManager] Spawning NATS: ${natsPath}`);
      this.natsProcess = cp.spawn(natsPath, [
        '--jetstream', 
        '--store_dir', natsDataDir, 
        '--port', this.natsPort.toString()
      ], { stdio: 'pipe' });

      this.natsProcess.on('error', (err) => {
        outputChannel.appendLine(`[ProcessManager] NATS spawn error: ${err.message}`);
      });

      this.natsProcess.on('exit', (code) => {
        outputChannel.appendLine(`[ProcessManager] NATS exited with code ${code}`);
      });

      // Wait for NATS to be ready
      await this.waitForNats(this.natsPort);
      outputChannel.appendLine(`[ProcessManager] NATS is listening on ${this.natsPort}`);
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
        this._backendProcess = cp.spawn(devPythonExe, ['-m', 'app.main_worker'], { 
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: backendDir,
          env: { ...process.env, PYTHONPATH: backendDir }
        });
      }
    } else {
      outputChannel.appendLine(`[ProcessManager] Spawning Python Worker (Production Mode)...`);
      this._backendProcess = cp.spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    if (this._backendProcess) {
      this._backendProcess.stderr?.on('data', (data) => {
        outputChannel.appendLine(`[Worker Error] ${data.toString().trim()}`);
      });
      this._backendProcess.on('error', (err) => {
        outputChannel.appendLine(`[ProcessManager] Worker spawn error: ${err.message}`);
      });
      this._backendProcess.on('exit', (code) => {
        outputChannel.appendLine(`[ProcessManager] Worker exited with code ${code}`);
        this._rpcClient = null;
        this._backendProcess = null;
      });

      this._rpcClient = new RpcClient(this._backendProcess);
      
      // Perform handshake (30s timeout)
      try {
        outputChannel.appendLine(`[ProcessManager] Sending initialize JSON-RPC handshake...`);
        const timeoutMs = 30_000;
        const initResult = await Promise.race([
          this._rpcClient.sendRequest('initialize', {
            protocol_version: '1.0',
            base_path: this.basePath,
            llm_key: config.llmKey,
            exa_key: config.exaKey,
            llm_base_url: config.llmBaseUrl,
            llm_model: config.llmModel,
            entitlement_token: entitlementToken,
            platform: platform,
            nats_port: this.natsPort
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Worker handshake timed out after ${timeoutMs / 1000}s`)), timeoutMs)
          )
        ]);
        
        const protocolCheck = validateProtocolVersion('1.0', initResult.protocol_version);
        if (!protocolCheck.valid) {
            const errorMsg = `Protocol validation failed: ${protocolCheck.error}`;
            outputChannel.appendLine(`[ProcessManager] Error: ${errorMsg}`);
            this.dispose();
            throw new Error(errorMsg);
        }
        if (protocolCheck.warning) {
            outputChannel.appendLine(`[ProcessManager] Warning: ${protocolCheck.warning}`);
        }

        if (initResult.status === 'ready') {
            outputChannel.appendLine(`[ProcessManager] Handshake complete. Backend is ready! (NATS URL: ${initResult.nats_url || 'unknown'})`);
        } else {
            const errorMsg = `Unexpected handshake result: ${JSON.stringify(initResult)}`;
            outputChannel.appendLine(`[ProcessManager] Error: ${errorMsg}`);
            this.dispose();
            throw new Error(errorMsg);
        }
      } catch (err: any) {
        outputChannel.appendLine(`[ProcessManager] Handshake failed: ${err.message || err.code || err}`);
        this.dispose();
        const customErr = new Error(`Worker initialization failed: ${err.message || err.code || err}`);
        (customErr as any).code = err.code;
        throw customErr;
      }
    }
    
    // Register exit handlers to clean up if the parent process dies abruptly
    if (!this.hasRegisteredExitHandler) {
      process.on('exit', () => this.dispose());
      this.hasRegisteredExitHandler = true;
    }
  }

  private async waitForNats(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxRetries = 150; // 15s (150 * 100ms)
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
            reject(new Error(`NATS server failed to start on port ${port} within 5 seconds`));
          } else {
            setTimeout(tryConnect, 100);
          }
        });
        socket.connect(port, '127.0.0.1');
      };

      tryConnect();
    });
  }

  private async getFreePort(startPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          const randomServer = net.createServer();
          randomServer.on('error', (randomErr) => reject(randomErr));
          randomServer.listen(0, '127.0.0.1', () => {
            const port = (randomServer.address() as net.AddressInfo).port;
            randomServer.close(() => resolve(port));
          });
        } else {
          reject(err);
        }
      });

      server.listen(startPort, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  public dispose() {
    if (this._rpcClient) {
      this._rpcClient.dispose();
      this._rpcClient = null;
    }
    if (this._backendProcess) {
      this._backendProcess.kill();
      this._backendProcess = null;
    }
    if (this.natsProcess) {
      this.natsProcess.kill();
      this.natsProcess = null;
    }
  }
}
