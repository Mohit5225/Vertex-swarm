import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { getHostedAuthUrl } from './hosted-auth-url';

export interface EntitlementResult {
  valid: boolean;
  /** The token's role claim (e.g. 'authenticated', 'admin'). */
  role: string;
  /** The subject (user ID) from the JWT sub claim. */
  sub: string;
  /** The user's email from the JWT email claim. */
  email: string;
  exp: number;
}

export class EntitlementClient {
  private static readonly AUTH_TIMEOUT_MS = 5 * 60 * 1000;
  private static readonly FETCH_TIMEOUT_MS = 60_000;
  private static readonly FETCH_RETRIES = 3;
  private readonly authApiUrl: string;
  private localServer: http.Server | null = null;
  private allocatedPort: number | null = null;
  private pendingAuthorizationCode: string | null = null;
  private pendingState: string | null = null;
  private pendingCodeVerifier: string | null = null;
  private pendingRedirectUri: string | null = null;
  private refreshPromise: Promise<string | undefined> | null = null;
  private pendingError: string | null = null;

  constructor(
    private readonly secretStorage: vscode.SecretStorage,
    private readonly logMessage?: (message: string) => void
  ) {
    const configuredUrl = getHostedAuthUrl();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(configuredUrl);
    } catch {
      throw new Error('VERTEX_HOSTED_AUTH_URL must be a valid absolute URL');
    }
    const isLocalHttp = parsedUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !isLocalHttp) {
      throw new Error('Hosted auth must use HTTPS outside localhost development');
    }
    this.authApiUrl = parsedUrl.toString().replace(/\/$/, '');
    this.log(`Using hosted auth URL: ${this.authApiUrl}`);
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
  async checkEntitlement(token: string): Promise<EntitlementResult> {
    const empty: EntitlementResult = { valid: false, role: 'none', sub: '', email: '', exp: 0 };
    try {
      const payloadBase64 = token.split('.')[1];
      if (!payloadBase64) {
        return empty;
      }

      // JWTs are base64url; plain 'base64' drops '-' / '_' and can corrupt exp/iss.
      const payloadStr = Buffer.from(payloadBase64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadStr);

      if (payload.iss !== 'vertex-swarm-backend') {
        this.warn(`Invalid or missing issuer: ${String(payload.iss)}`);
        return empty;
      }

      const exp = typeof payload.exp === 'number' ? payload.exp : 0;
      const valid = Number.isFinite(exp) && exp * 1000 > Date.now();
      const role = typeof payload.role === 'string' && payload.role ? payload.role : 'authenticated';
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const email = typeof payload.email === 'string' ? payload.email : '';

      return { valid, role, sub, email, exp };
    } catch (err) {
      this.warn(`Failed to parse JWT: ${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  /**
   * Refreshes the token against the Hosted Auth API using the current JWT.
   */
  async refreshToken(): Promise<string | undefined> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshTokenInternal().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshTokenInternal(): Promise<string | undefined> {
    const refreshToken = await this.secretStorage.get('vertex_refresh_jwt');
    if (!refreshToken) {
      this.warn('No refresh token found in storage.');
      return undefined;
    }

    const url = this.authEndpoint('/oauth/refresh');
    let lastError: unknown;

    for (let attempt = 1; attempt <= EntitlementClient.FETCH_RETRIES; attempt++) {
      try {
        this.log(`Refreshing tokens (attempt ${attempt}/${EntitlementClient.FETCH_RETRIES}) via ${url}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(EntitlementClient.FETCH_TIMEOUT_MS),
        });

        if (response.ok) {
          const data = await response.json() as { access_token?: unknown; refresh_token?: unknown };
          if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
            throw new Error('Refresh response missing access_token/refresh_token');
          }
          await this.secretStorage.store('vertex_access_jwt', data.access_token);
          await this.secretStorage.store('vertex_refresh_jwt', data.refresh_token);
          this.log('Tokens successfully refreshed in background.');
          return data.access_token;
        }

        const detail = await response.text().catch(() => '');
        // 401 means the refresh token is dead — retries will not help.
        if (response.status === 401 || response.status === 403) {
          this.warn(
            `Failed to refresh token: status ${response.status}${detail ? ` (${detail.slice(0, 200)})` : ''}`
          );
          return undefined;
        }

        throw new Error(
          `Refresh failed: status ${response.status}${detail ? ` (${detail.slice(0, 200)})` : ''}`
        );
      } catch (err) {
        lastError = err;
        const detail = this.formatFetchError(err, url);
        this.warn(detail);
        if (attempt < EntitlementClient.FETCH_RETRIES && this.isRetryableFetchError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
          continue;
        }
        if (attempt < EntitlementClient.FETCH_RETRIES) {
          // Non-network 5xx / transient server errors — still retry a couple times.
          const message = err instanceof Error ? err.message : String(err);
          if (/status 5\d\d/.test(message) || /Refresh failed/.test(message)) {
            await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
            continue;
          }
        }
        break;
      }
    }

    this.warn(
      `Failed to refresh token after retries: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
    return undefined;
  }

  /** Triggers an authorization-code flow using PKCE and a loopback callback. */
  async startAuthFlow(): Promise<string> {
    try {
      await this.startCallbackServer();
      if (!this.allocatedPort) {
        throw new Error('OAuth callback server did not allocate a port');
      }

      const state = crypto.randomBytes(32).toString('base64url');
      const codeVerifier = crypto.randomBytes(64).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const redirectUri = `http://127.0.0.1:${this.allocatedPort}/callback`;
      this.pendingState = state;
      this.pendingCodeVerifier = codeVerifier;
      this.pendingRedirectUri = redirectUri;

      const authUrl = new URL(this.authEndpoint('/oauth/start'));
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

      const code = await this.waitForCallback(EntitlementClient.AUTH_TIMEOUT_MS);
      if (!code || !this.pendingCodeVerifier || !this.pendingRedirectUri) {
        throw new Error('Authentication timed out. Please try again.');
      }

      const tokens = await this.exchangeAuthorizationCode(code, this.pendingCodeVerifier, this.pendingRedirectUri);

      await this.secretStorage.store('vertex_access_jwt', tokens.accessToken);
      await this.secretStorage.store('vertex_refresh_jwt', tokens.refreshToken);
      this.log('Sign-in completed and JWTs stored securely.');
      return tokens.accessToken;

    } catch (error) {
      this.warn(`Flow failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      await this.stopCallbackServer();
      this.clearPendingAuthorization();
    }
  }

  async logout(): Promise<void> {
    const refreshToken = await this.secretStorage.get('vertex_refresh_jwt');
    if (refreshToken) {
      try {
        await fetch(this.authEndpoint('/oauth/logout'), {
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
      this.pendingAuthorizationCode = null;
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
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${this.allocatedPort}`);

      if (req.method === 'GET' && url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (!this.stateMatches(state)) {
          this.pendingError = 'Invalid OAuth state. Please start sign-in again.';
          this.serveHtml(res, this.buildErrorPage(this.pendingError));
        } else if (url.searchParams.has('access_token') || url.searchParams.has('refresh_token')) {
          this.pendingError = 'Token callbacks are not accepted.';
          this.serveHtml(res, this.buildErrorPage(this.pendingError));
        } else if (code) {
          this.pendingAuthorizationCode = code;
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

  private async waitForCallback(timeoutMs: number): Promise<string | null> {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.pendingAuthorizationCode) {
          clearInterval(interval);
          resolve(this.pendingAuthorizationCode);
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

  private authEndpoint(path: string): string {
    return new URL(path, `${this.authApiUrl}/`).toString();
  }

  private stateMatches(state: string | null): boolean {
    if (!state || !this.pendingState) {
      return false;
    }
    const expected = Buffer.from(this.pendingState, 'utf8');
    const actual = Buffer.from(state, 'utf8');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const url = this.authEndpoint('/oauth/token');
    const body = JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri });
    let lastError: unknown;

    for (let attempt = 1; attempt <= EntitlementClient.FETCH_RETRIES; attempt++) {
      try {
        this.log(`Exchanging authorization code (attempt ${attempt}/${EntitlementClient.FETCH_RETRIES}) via ${url}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(EntitlementClient.FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `Authorization-code exchange failed: status ${response.status}${detail ? ` (${detail.slice(0, 200)})` : ''}`
          );
        }
        const data = await response.json() as { access_token?: unknown; refresh_token?: unknown };
        if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
          throw new Error('Authorization-code exchange returned an invalid token response');
        }
        return { accessToken: data.access_token, refreshToken: data.refresh_token };
      } catch (err) {
        lastError = err;
        const detail = this.formatFetchError(err, url);
        this.warn(detail);
        if (attempt < EntitlementClient.FETCH_RETRIES && this.isRetryableFetchError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
          continue;
        }
        throw new Error(detail);
      }
    }

    throw new Error(this.formatFetchError(lastError, url));
  }

  private isRetryableFetchError(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }
    const message = err.message.toLowerCase();
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const causeCode = cause?.code?.toLowerCase() ?? '';
    const causeMessage = (cause?.message ?? '').toLowerCase();
    return (
      message.includes('fetch failed') ||
      message.includes('timeout') ||
      message.includes('aborted') ||
      message.includes('status 5') ||
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      causeCode.includes('econn') ||
      causeCode.includes('etimedout') ||
      causeCode.includes('enotfound') ||
      causeMessage.includes('timeout')
    );
  }

  private formatFetchError(err: unknown, url: string): string {
    if (!(err instanceof Error)) {
      return `Auth request to ${url} failed: ${String(err)}`;
    }
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    const causePart = cause
      ? ` (${cause.code || 'error'}: ${cause.message || 'unknown'})`
      : '';
    if (err.message === 'fetch failed' || err.name === 'TimeoutError' || err.message.includes('aborted')) {
      return `Could not reach auth service at ${url}${causePart}. If the service was sleeping, wait a few seconds and try again.`;
    }
    return `${err.message}${causePart}`;
  }

  private clearPendingAuthorization(): void {
    this.pendingAuthorizationCode = null;
    this.pendingState = null;
    this.pendingCodeVerifier = null;
    this.pendingRedirectUri = null;
    this.pendingError = null;
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
    const safeError = error.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character] || character);
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
              <div class="error">${safeError}</div>
              <p>You can close this tab and try again in VS Code.</p>
          </div>
      </body>
      </html>
    `;
  }
}
