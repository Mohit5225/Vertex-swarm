import * as vscode from 'vscode';
import * as cp from 'child_process';
import { EventEmitter } from 'events';

export class RpcClient extends EventEmitter implements vscode.Disposable {
  private child: cp.ChildProcess;
  private buffer: Buffer = Buffer.alloc(0);
  private nextMessageId = 1;
  private pendingRequests: Map<number, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();

  constructor(child: cp.ChildProcess) {
    super();
    this.child = child;

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error("Child process must be spawned with stdio: ['pipe', 'pipe', 'pipe']");
    }

    this.child.stdout.on('data', this.handleData.bind(this));
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code) => this.emit('exit', code));
  }

  private handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer() {
    while (true) {
      // Find the end of the headers
      const headerEndIndex = this.buffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) {
        break; // Not enough data for headers
      }

      const headersRaw = this.buffer.toString('utf8', 0, headerEndIndex);
      let contentLength = -1;

      for (const line of headersRaw.split('\r\n')) {
        const lowerLine = line.toLowerCase();
        if (lowerLine.startsWith('content-length:')) {
          contentLength = parseInt(lowerLine.split(':')[1].trim(), 10);
        }
      }

      if (contentLength === -1) {
        throw new Error('Missing Content-Length header');
      }

      const messageStartIndex = headerEndIndex + 4;
      if (this.buffer.length < messageStartIndex + contentLength) {
        break; // Not enough data for the full message body
      }

      const bodyRaw = this.buffer.toString('utf8', messageStartIndex, messageStartIndex + contentLength);
      this.buffer = this.buffer.subarray(messageStartIndex + contentLength);

      try {
        const message = JSON.parse(bodyRaw);
        this.handleMessage(message);
      } catch (err) {
        console.error('Failed to parse JSON-RPC message:', err);
      }
    }
  }

  private handleMessage(msg: any) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // It's a response to a request we sent
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(msg.error);
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      // It's a notification or request from the backend
      this.emit('notification', msg.method, msg.params);
      if (msg.method === 'stream/event') {
        this.emit('stream/event', msg.params);
      }
    }
  }

  public async sendRequest(method: string, params: any = {}): Promise<any> {
    const id = this.nextMessageId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.send(payload);
    return promise;
  }

  public sendNotification(method: string, params: any = {}): void {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(payload);
  }

  private send(payload: any): void {
    const bodyStr = JSON.stringify(payload);
    const bodyBuffer = Buffer.from(bodyStr, 'utf8');
    const headerStr = `Content-Length: ${bodyBuffer.length}\r\n\r\n`;
    
    if (this.child.stdin && !this.child.killed) {
      this.child.stdin.write(headerStr, 'utf8');
      this.child.stdin.write(bodyBuffer);
    }
  }

  public dispose() {
    this.removeAllListeners();
    this.pendingRequests.clear();
  }
}
