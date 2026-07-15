import * as vscode from 'vscode';
import * as http from 'http';

export interface EntitlementResult {
  valid: boolean;
  tier: 'free' | 'pro' | 'team' | 'none';
  exp: number;
}

export class EntitlementClient {
  private static readonly AUTH_TIMEOUT_MS = 5 * 60 * 1000;
  private readonly authApiUrl: string;
  private localServer: http.Server | null = null;
  private allocatedPort: number | null = null;
  private pendingAccessToken: string | null = null;
  private pendingRefreshToken: string | null = null;
  private pendingError: string | null = null;

  constructor(
    private readonly secretStorage: vscode.SecretStorage,
    private readonly logMessage?: (message: string) => void
  ) {
    // URL for the Hosted Auth API (Phase 7)
    // Defaulting to a local mock address for development
    this.authApiUrl = process.env.VERTEX_HOSTED_AUTH_URL || 'http://localhost:8080';
  }

  private log(message: string): void {
    if (this.logMessage) {
      this.logMessage(`[EntitlementClient] ${message}`);
    } else {
      console.log(`[EntitlementClient] ${message}`);
    }
  }

  private warn(message: string): void {
    if (this.logMessage) {
      this.logMessage(`[EntitlementClient WARN] ${message}`);
    } else {
      console.warn(`[EntitlementClient] ${message}`);
    }
  }

  /**
   * Reads the current JWT from SecretStorage.
   */
  async getToken(): Promise<string | undefined> {
    return this.secretStorage.get('vertex_access_jwt');
  }

  /**
   * The local backend handles strict cryptographic validation of the token via RS256.
   * The extension only needs to decode the unverified payload to check the expiration time
   * so it knows when to silently request a refresh from the cloud.
   */
  async checkEntitlement(jwt: string): Promise<EntitlementResult> {
    try {
      const payloadBase64 = jwt.split('.')[1];
      if (!payloadBase64) {
        return { valid: false, tier: 'none', exp: 0 };
      }

      const payloadStr = Buffer.from(payloadBase64, 'base64').toString('utf8');
      const payload = JSON.parse(payloadStr);

      const exp = payload.exp || 0;
      const valid = exp * 1000 > Date.now();

      return { valid, tier: payload.tier || 'free', exp };
    } catch (err) {
      this.warn(`Failed to parse JWT: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, tier: 'none', exp: 0 };
    }
  }

  /**
   * Refreshes the token against the Hosted Auth API using the current JWT.
   */
  async refreshToken(): Promise<string | undefined> {
    try {
      const refreshToken = await this.secretStorage.get('vertex_refresh_jwt');
      if (!refreshToken) {
        this.warn('No refresh token found in storage.');
        return undefined;
      }

      const response = await fetch(`${this.authApiUrl}/oauth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      });

      if (response.ok) {
        const data = await response.json() as { access_token: string, refresh_token: string };
        await this.secretStorage.store('vertex_access_jwt', data.access_token);
        await this.secretStorage.store('vertex_refresh_jwt', data.refresh_token);
        this.log('Tokens successfully refreshed in background.');
        return data.access_token;
      }
      this.warn(`Failed to refresh token: status ${response.status}`);
      return undefined;
    } catch (err) {
      this.warn(`Failed to refresh token network error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Triggers the full OAuth flow.
   * Spawns a local HTTP server on an ephemeral port, opens browser to hosted auth.
   */
  async startAuthFlow(): Promise<string> {
    try {
      await this.startCallbackServer();
      const callbackUrl = encodeURIComponent(`http://localhost:${this.allocatedPort}/callback`);
      const authUrl = `${this.authApiUrl}/oauth/start?callback=${callbackUrl}`;

      await vscode.env.openExternal(vscode.Uri.parse(authUrl));

      const tokens = await this.waitForCallback(EntitlementClient.AUTH_TIMEOUT_MS);
      if (!tokens) {
        throw new Error('Authentication timed out. Please try again.');
      }

      await this.secretStorage.store('vertex_access_jwt', tokens.accessToken);
      await this.secretStorage.store('vertex_refresh_jwt', tokens.refreshToken);
      this.log('Sign-in completed and JWTs stored securely.');
      return tokens.accessToken;

    } catch (error) {
      this.warn(`Flow failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await this.stopCallbackServer();
    }
  }

  async logout(): Promise<void> {
    const refreshToken = await this.secretStorage.get('vertex_refresh_jwt');
    if (refreshToken) {
      try {
        await fetch(`${this.authApiUrl}/oauth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        this.log('Logout notification sent to backend.');
      } catch (err) {
        this.log(`Failed to notify backend of logout: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.secretStorage.delete('vertex_access_jwt');
    await this.secretStorage.delete('vertex_refresh_jwt');
    this.log('JWTs removed from SecretStorage.');
  }

  private async startCallbackServer(): Promise<void> {
    if (this.localServer && this.allocatedPort) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.pendingAccessToken = null;
      this.pendingRefreshToken = null;
      this.pendingError = null;

      const server = http.createServer((req, res) => void this.handleRequest(req, res));
      this.localServer = server;

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Could not determine server port'));
          return;
        }
        this.allocatedPort = addr.port;
        this.log(`Listening for OAuth callback on port ${this.allocatedPort}`);
        resolve();
      });

      server.on('error', (err) => {
        this.warn(`Server error: ${err instanceof Error ? err.message : String(err)}`);
        this.localServer = null;
        this.allocatedPort = null;
        reject(err);
      });
    });
  }

  private async stopCallbackServer(): Promise<void> {
    if (!this.localServer) {
      return;
    }
    return new Promise<void>((resolve) => {
      const server = this.localServer;
      const timeout = setTimeout(() => {
        server?.closeAllConnections?.();
      }, 5000);

      server?.close(() => {
        clearTimeout(timeout);
        this.localServer = null;
        this.allocatedPort = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://localhost:${this.allocatedPort}`);

      if (req.method === 'GET' && url.pathname === '/callback') {
        const accessToken = url.searchParams.get('access_token');
        const refreshToken = url.searchParams.get('refresh_token');
        const error = url.searchParams.get('error');

        if (accessToken && refreshToken) {
          this.pendingAccessToken = accessToken;
          this.pendingRefreshToken = refreshToken;
          this.serveHtml(res, this.buildSuccessPage());
        } else if (error) {
          this.pendingError = error;
          this.serveHtml(res, this.buildErrorPage(error));
        } else {
          this.serveHtml(res, this.buildErrorPage('Missing token in callback'));
        }
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      this.warn(`Request error: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  private async waitForCallback(timeoutMs: number): Promise<{ accessToken: string, refreshToken: string } | null> {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.pendingAccessToken && this.pendingRefreshToken) {
          clearInterval(interval);
          resolve({ accessToken: this.pendingAccessToken, refreshToken: this.pendingRefreshToken });
        } else if (this.pendingError) {
          clearInterval(interval);
          reject(new Error(this.pendingError));
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(null);
        }
      }, 500);
    });
  }

  private serveHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private buildSuccessPage(): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <title>Authentication Successful</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #0d1117; color: #c9d1d9; margin: 0; }
              .container { text-align: center; padding: 2rem; border-radius: 8px; background-color: #161b22; border: 1px solid #30363d; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
              h1 { color: #58a6ff; margin-bottom: 1rem; }
              p { margin-bottom: 1.5rem; color: #8b949e; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Authentication Successful!</h1>
              <p>You can close this tab and return to VS Code.</p>
              <script>setTimeout(() => window.close(), 3000);</script>
          </div>
      </body>
      </html>
    `;
  }

  private buildErrorPage(error: string): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <title>Authentication Failed</title>
          <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #0d1117; color: #c9d1d9; margin: 0; }
              .container { text-align: center; padding: 2rem; border-radius: 8px; background-color: #161b22; border: 1px solid #30363d; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
              h1 { color: #f85149; margin-bottom: 1rem; }
              p { margin-bottom: 1.5rem; color: #8b949e; }
              .error { font-family: monospace; background: #0d1117; padding: 1rem; border-radius: 6px; text-align: left; overflow-x: auto; border: 1px solid #30363d; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Authentication Failed</h1>
              <p>There was a problem signing you in.</p>
              <div class="error">${error}</div>
              <p>You can close this tab and try again in VS Code.</p>
          </div>
      </body>
      </html>
    `;
  }
}
