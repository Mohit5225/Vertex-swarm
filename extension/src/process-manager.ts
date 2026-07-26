import * as vscode from 'vscode';
import { VertexConfig } from './config-manager';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as fs from 'fs';
import { RpcClient } from './rpc-client';
import { validateProtocolVersion } from './utils/protocol-validator';
import { getHostedAuthUrl } from './auth/hosted-auth-url';
import { debugLog } from './debug-log';

export class VertexProcessManager implements vscode.Disposable {
  private natsProcess: cp.ChildProcess | null = null;
  private _backendProcess: cp.ChildProcess | null = null;
  private _rpcClient: RpcClient | null = null;
  private basePath: string;
  private natsPort: number = 4222;
  private hasRegisteredExitHandler: boolean = false;
  private startPromise: Promise<void> | null = null;
  private startToken: string = '';
  private backendDiedHandler: ((reason: string) => void) | null = null;
  private outputChannel: vscode.OutputChannel | null = null;
  private isDisposing = false;

  public get backendProcess() { return this._backendProcess; }
  public get rpcClient() { return this._rpcClient; }

  constructor() {
    this.basePath = path.join(os.homedir(), '.vertex-swarm');
  }

  public onBackendDied(handler: (reason: string) => void): void {
    this.backendDiedHandler = handler;
  }

  private pmLog(message: string): void {
    debugLog('ProcessManager', message);
  }

  async start(
    context: vscode.ExtensionContext, 
    outputChannel: vscode.OutputChannel, 
    config: VertexConfig,
    entitlementToken: string
  ): Promise<void> {
    if (this.startPromise && this.startToken === entitlementToken) {
      return this.startPromise;
    }
    
    this.startToken = entitlementToken;
    this.startPromise = this._start(context, outputChannel, config, entitlementToken).finally(() => {
      if (this.startToken === entitlementToken) {
        this.startPromise = null;
      }
    });
    
    return this.startPromise;
  }

  private async _start(
    context: vscode.ExtensionContext, 
    outputChannel: vscode.OutputChannel, 
    config: VertexConfig,
    entitlementToken: string
  ): Promise<void> {
    this.outputChannel = outputChannel;
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
      // Prefer 4222 only when nothing is already accepting connections there.
      // An orphan nats-server (e.g. from another VS Code/Cursor host) holding
      // 4222 used to make getFreePort(127.0.0.1) succeed, waitForNats connect to
      // the orphan, then our child die with "bind: Only one usage..." → exit 1.
      this.natsPort = await this.allocateNatsPort(4222);
      
      const natsDataDir = path.join(this.basePath, `nats-data-${this.natsPort}`);
      
      this.pmLog(`Selected NATS port: ${this.natsPort}`);
      this.pmLog(`Spawning NATS: ${natsPath}`);
      this.natsProcess = cp.spawn(natsPath, [
        '--jetstream', 
        '--store_dir', natsDataDir, 
        '--port', this.natsPort.toString()
      ], { stdio: 'pipe' });

      this.natsProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          this.pmLog(`NATS: ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`);
        }
      });

      this.natsProcess.on('error', (err) => {
        this.pmLog(`NATS spawn error: ${err.message}`);
      });

      this.natsProcess.on('exit', (code) => {
        this.pmLog(`NATS exited with code ${code}`);
        this.natsProcess = null;
        if (!this.isDisposing) {
          this.tearDownBackend(`NATS exited with code ${code}`);
        }
      });

      // Wait for NATS to be ready
      await this.waitForNats(this.natsPort);
      this.pmLog(`NATS is listening on ${this.natsPort}`);
    } else {
      this.pmLog('NATS is already running.');
    }

    // Spawn the Python worker
    if (context.extensionMode === vscode.ExtensionMode.Development) {
      this.pmLog('Spawning Python Worker (Development Mode)...');
      const devPythonExe = platform === 'win32' 
        ? path.join(context.extensionUri.fsPath, '..', 'backend', 'venv', 'Scripts', 'python.exe')
        : path.join(context.extensionUri.fsPath, '..', 'backend', 'venv', 'bin', 'python');
      
      const devWorkerPath = path.join(context.extensionUri.fsPath, '..', 'backend', 'app', 'main_worker.py');

      if (!fs.existsSync(devPythonExe)) {
        vscode.window.showErrorMessage(`Local virtual environment not found at: ${devPythonExe}`);
        this.pmLog(`Error: Local virtual environment not found at ${devPythonExe}`);
        throw new Error(`Python virtual environment not found at ${devPythonExe}`);
      } else {
        this.pmLog(`Python Executable: ${devPythonExe}`);
        this.pmLog('Worker Module: app.main_worker');
        const backendDir = path.join(context.extensionUri.fsPath, '..', 'backend');
        this._backendProcess = cp.spawn(devPythonExe, ['-m', 'app.main_worker'], { 
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: backendDir,
          env: { ...process.env, PYTHONPATH: backendDir }
        });
      }
    } else {
      this.pmLog('Spawning Python Worker (Production Mode)...');
      this._backendProcess = cp.spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    if (this._backendProcess) {
      // ONLY pipe stderr. stdout is the JSON-RPC channel (RpcClient owns it).
      // Logging stdout blocks the extension host on huge RPC payloads and
      // backpressures the worker until the agent loop freezes after tool results.
      const pipeWorkerStderr = (data: Buffer) => {
        const text = data.toString();
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }
          const clipped = line.length > 2000 ? `${line.slice(0, 2000)}…[truncated]` : line;
          debugLog('Worker', clipped);
        }
      };
      this._backendProcess.stderr?.on('data', pipeWorkerStderr);
      this._backendProcess.on('error', (err) => {
        this.pmLog(`Worker spawn error: ${err.message}`);
      });
      this._backendProcess.on('exit', (code) => {
        this.pmLog(`Worker exited with code ${code}`);
        const hadClient = this._rpcClient !== null;
        this._rpcClient = null;
        this._backendProcess = null;
        if (hadClient) {
          this.backendDiedHandler?.(`Worker exited with code ${code}`);
        }
      });

      this._rpcClient = new RpcClient(this._backendProcess);
      
      // Perform handshake (90s: Render free-tier JWKS cold starts often exceed 30s)
      try {
        this.pmLog('Sending initialize JSON-RPC handshake...');
        const timeoutMs = 90_000;
        const authBaseUrl = getHostedAuthUrl();
        const authJwksUrl = `${authBaseUrl}/.well-known/jwks.json`;
        this.pmLog(`Auth JWKS URL: ${authJwksUrl}`);

        const initResult = await Promise.race([
          this._rpcClient.sendRequest('initialize', {
            protocol_version: '1.0',
            base_path: this.basePath,
            llm_key: config.llmKey,
            exa_key: config.exaKey,
            llm_base_url: config.llmBaseUrl,
            llm_model: config.llmModel,
            llm_reasoning_enabled: config.llmReasoningEnabled,
            llm_reasoning_effort: config.llmReasoningEffort,
            entitlement_token: entitlementToken,
            platform: platform,
            nats_port: this.natsPort,
            auth_jwks_url: authJwksUrl,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Worker handshake timed out after ${timeoutMs / 1000}s`)), timeoutMs)
          )
        ]);
        
        const protocolCheck = validateProtocolVersion('1.0', initResult.protocol_version);
        if (!protocolCheck.valid) {
            const errorMsg = `Protocol validation failed: ${protocolCheck.error}`;
            this.pmLog(`Error: ${errorMsg}`);
            this.dispose();
            throw new Error(errorMsg);
        }
        if (protocolCheck.warning) {
            this.pmLog(`Warning: ${protocolCheck.warning}`);
        }

        if (initResult.status === 'ready') {
            this.pmLog(`Handshake complete. Backend is ready! (NATS URL: ${initResult.nats_url || 'unknown'})`);
        } else {
            const errorMsg = `Unexpected handshake result: ${JSON.stringify(initResult)}`;
            this.pmLog(`Error: ${errorMsg}`);
            this.dispose();
            throw new Error(errorMsg);
        }
      } catch (err: any) {
        this.pmLog(`Handshake failed: ${err.message || err.code || err}`);
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
      const spawned = this.natsProcess;

      const tryConnect = () => {
        if (!this.natsProcess || this.natsProcess !== spawned || this.natsProcess.exitCode !== null) {
          reject(new Error('NATS server process exited before port was ready'));
          return;
        }

        const socket = new net.Socket();
        socket.once('connect', () => {
          socket.destroy();
          // Re-check: an orphan can accept the probe while our child is still dying.
          if (!this.natsProcess || this.natsProcess !== spawned || this.natsProcess.exitCode !== null) {
            reject(new Error('NATS server process exited before port was ready'));
            return;
          }
          resolve();
        });
        socket.once('error', () => {
          socket.destroy();
          retries++;
          if (retries >= maxRetries) {
            reject(new Error(`NATS server failed to start on port ${port} within 15 seconds`));
          } else {
            setTimeout(tryConnect, 100);
          }
        });
        socket.connect(port, '127.0.0.1');
      };

      tryConnect();
    });
  }

  /** True if something already accepts TCP connections on this port. */
  private async isPortAcceptingConnections(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (inUse: boolean) => {
        socket.destroy();
        resolve(inUse);
      };
      socket.setTimeout(250, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.connect(port, '127.0.0.1');
    });
  }

  private async bindEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', (err) => reject(err));
      // Bind all interfaces so we don't miss an IPv6/0.0.0.0 occupant the way
      // a 127.0.0.1-only probe can on Windows.
      server.listen(0, '0.0.0.0', () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  private async allocateNatsPort(preferredPort: number): Promise<number> {
    if (await this.isPortAcceptingConnections(preferredPort)) {
      this.pmLog(`Port ${preferredPort} already in use; allocating an ephemeral NATS port`);
      return this.bindEphemeralPort();
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.pmLog(`Port ${preferredPort} bind race; allocating an ephemeral NATS port`);
          this.bindEphemeralPort().then(resolve, reject);
          return;
        }
        reject(err);
      });
      server.listen(preferredPort, '0.0.0.0', () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  public dispose() {
    this.isDisposing = true;
    this.tearDownBackend('Process manager disposed', /* notify */ false);
    if (this.natsProcess) {
      this.natsProcess.kill();
      this.natsProcess = null;
    }
  }

  private tearDownBackend(reason: string, notify = true): void {
    const hadLiveBackend = this._rpcClient !== null || this._backendProcess !== null;
    if (this._rpcClient) {
      this._rpcClient.dispose();
      this._rpcClient = null;
    }
    if (this._backendProcess) {
      this._backendProcess.kill();
      this._backendProcess = null;
    }
    this.startPromise = null;
    this.startToken = '';
    debugLog('ProcessManager', `Backend torn down: ${reason}`);
    if (notify && hadLiveBackend) {
      this.backendDiedHandler?.(reason);
    }
  }
}
