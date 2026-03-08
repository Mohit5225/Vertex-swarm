import * as vscode from 'vscode';
import * as http from 'http';
import { TokenManager } from './token-manager';

interface AuthenticatedUserPayload {
  id?: string;
  email?: string;
  name?: string;
  image?: string;
}

interface CallbackAuthResult {
  token: string;
  user: AuthenticatedUserPayload;
}

/**
 * OAuthHandler: Manages the full Neon Auth / Google social sign-in flow
 * for the VS Code extension.
 *
 * Flow:
 * 1. Extension starts a local HTTP server on a random port.
 * 2. Extension opens the browser to http://localhost:{port}/start.
 * 3. /start POSTs to Neon Auth /sign-in/social using browser cookies.
 * 4. Browser follows Neon's returned init URL to Google and back.
 * 5. Neon Auth redirects to http://localhost:{port}/callback with a verifier.
 * 6. /callback exchanges the verifier for a session.
 * 7. A JWT for backend API auth + user info are POSTed back to the local server.
 * 8. Extension stores the token and completes the flow.
 */
export class OAuthHandler {
  private readonly neonAuthUrl: string;
  private readonly provider = 'google';

  private localServer: http.Server | null = null;
  private allocatedPort: number | null = null;
  private pendingAuthResult: CallbackAuthResult | null = null;
  private pendingAuthError: string | null = null;

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly context: vscode.ExtensionContext
  ) {
    this.neonAuthUrl = import.meta.env.VITE_NEON_AUTH_BASE_URL || 'http://localhost:8000';
  }

  /**
   * MUST use localhost. Neon Auth trusts localhost origins but rejects 127.0.0.1.
   */
  private getCallbackUrl(): string {
    return `http://localhost:${this.allocatedPort}/callback`;
  }

  private getStartUrl(): string {
    return `http://localhost:${this.allocatedPort}/start`;
  }

  getAuthUrl(): string {
    return `${this.neonAuthUrl}/sign-in`;
  }

  async startAuthFlow(): Promise<boolean> {
    try {
      await this.startCallbackServer();
      await vscode.env.openExternal(vscode.Uri.parse(this.getStartUrl()));

      const authResult = await this.waitForCallback(120_000);
      if (!authResult) {
        throw new Error('Authentication timed out after 120 seconds. Please try again.');
      }

      await this.tokenManager.setToken(authResult.token, {
        id: authResult.user.id || '',
        email: authResult.user.email || '',
        provider: this.provider,
      });

      return true;
    } catch (error) {
      console.error('[OAuthHandler] Flow failed:', error);
      await vscode.window.showErrorMessage(
        `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return false;
    } finally {
      await this.stopCallbackServer();
    }
  }

  private async startCallbackServer(): Promise<void> {
    if (this.localServer && this.allocatedPort) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.pendingAuthResult = null;
      this.pendingAuthError = null;

      const server = http.createServer((req, res) => void this.handleRequest(req, res));
      this.localServer = server;

      server.listen(0, '0.0.0.0', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Could not determine server port'));
          return;
        }
        this.allocatedPort = addr.port;
        console.log(`[OAuthHandler] Listening on port ${this.allocatedPort}`);
        resolve();
      });

      server.on('error', (err) => {
        console.error('[OAuthHandler] Server error:', err);
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
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://localhost:${this.allocatedPort}`);

      if (req.method === 'GET' && url.pathname === '/start') {
        this.serveHtml(res, this.buildStartPage());
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/callback' || url.pathname === '/')) {
        this.serveHtml(res, this.buildCallbackPage(url));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/complete') {
        const body = await this.readBody(req);
        const data = JSON.parse(body) as CallbackAuthResult;
        if (!data.token) {
          throw new Error('Missing token in /complete payload');
        }
        this.pendingAuthResult = data;
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/error') {
        const body = await this.readBody(req);
        const data = JSON.parse(body) as { error?: string };
        this.pendingAuthError = data.error || 'Unknown error from browser';
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error('[OAuthHandler] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }

  private waitForCallback(timeoutMs: number): Promise<CallbackAuthResult | null> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (this.pendingAuthResult) {
          clearInterval(timer);
          resolve(this.pendingAuthResult);
        } else if (this.pendingAuthError) {
          clearInterval(timer);
          reject(new Error(this.pendingAuthError));
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 200);
    });
  }

  private buildStartPage(): string {
    const AUTH_URL = JSON.stringify(this.neonAuthUrl);
    const CALLBACK_URL = JSON.stringify(this.getCallbackUrl());

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Vertex Swarm - Sign In</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:14px/1.6 "Segoe UI",system-ui,sans-serif}
    .card{width:min(480px,calc(100vw - 32px));padding:28px;border-radius:16px;background:rgba(30,41,59,.96);border:1px solid rgba(148,163,184,.18);box-shadow:0 20px 50px rgba(0,0,0,.35)}
    h1{margin:0 0 4px;font-size:22px;font-weight:600}
    .sub{color:#94a3b8;margin:0 0 16px}
    #status{padding:12px;border-radius:8px;background:rgba(15,23,42,.6);font-size:13px;min-height:42px}
    .ok{color:#34d399} .err{color:#fca5a5} .info{color:#94a3b8}
    #log{margin-top:14px;font:11px/1.5 "Cascadia Code","Fira Code",monospace;color:#475569;max-height:180px;overflow-y:auto;white-space:pre-wrap;padding:8px;border-radius:6px;background:rgba(0,0,0,.25)}
    .retry-btn{display:inline-block;margin-top:12px;padding:9px 22px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer;text-decoration:none}
    .retry-btn:hover{background:#1d4ed8}
  </style>
</head>
<body>
<div class="card">
  <h1>Vertex Swarm</h1>
  <p class="sub">Authenticating with Google via Neon Auth</p>
  <div id="status" class="info">Initializing...</div>
  <div id="log"></div>
</div>
<script>
(function(){
  var AUTH_URL  = ${AUTH_URL};
  var CALLBACK  = ${CALLBACK_URL};
  var elStatus  = document.getElementById('status');
  var elLog     = document.getElementById('log');

  function log(msg){ elLog.textContent += msg + '\\n'; }
  function setStatus(msg, cls){ elStatus.textContent = msg; elStatus.className = cls || 'info'; }

  function forceGoogleAccountSelection(urlString){
    try {
      var url = new URL(urlString);
      if (url.hostname === 'accounts.google.com' || url.hostname.endsWith('.accounts.google.com')) {
        url.searchParams.set('prompt', 'select_account');
      }
      return url.toString();
    } catch (e) {
      log('Could not rewrite OAuth URL: ' + (e && e.message ? e.message : String(e)));
      return urlString;
    }
  }

  function reportError(msg){
    return fetch('/error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:msg})}).catch(function(){});
  }

  async function begin(){
    log('Neon Auth: ' + AUTH_URL);
    log('Callback:  ' + CALLBACK);
    setStatus('Clearing previous session...', 'info');

    try {
      log('POST /sign-out (clearing Neon Auth session)');
      await fetch(AUTH_URL + '/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      }).catch(function(e){ log('Neon Auth sign-out: ' + e.message); });

      setStatus('Contacting Neon Auth...', 'info');
      log('POST /sign-in/social');
      var resp = await fetch(AUTH_URL + '/sign-in/social', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: CALLBACK,
          disableRedirect: true
        })
      });

      log('Status: ' + resp.status);
      var data = await resp.json().catch(function(){ return null; });
      log('Body: ' + JSON.stringify(data));

      if (!resp.ok) {
        var errMsg = (data && (data.message || data.error)) || ('HTTP ' + resp.status);
        throw new Error('Neon Auth rejected request: ' + errMsg);
      }

      if (!data || !data.url) {
        throw new Error('No redirect URL in response: ' + JSON.stringify(data));
      }

      var redirectUrl = forceGoogleAccountSelection(data.url);
      log('Redirecting to Google...');
      setStatus('Redirecting to Google sign-in...', 'ok');
      window.location.href = redirectUrl;

    } catch(err) {
      var msg = err instanceof Error ? err.message : String(err);
      log('FAILED: ' + msg);
      setStatus(msg, 'err');
      elStatus.innerHTML += '<br><a class="retry-btn" href="/start">Retry</a>';
      await reportError(msg);
    }
  }

  begin();
})();
</script>
</body>
</html>`;
  }

  private buildCallbackPage(requestUrl: URL): string {
    const verifier = requestUrl.searchParams.get('neon_auth_session_verifier') || '';
    const upstreamError = requestUrl.searchParams.get('error_description')
      || requestUrl.searchParams.get('error')
      || '';

    const AUTH_URL = JSON.stringify(this.neonAuthUrl);
    const VERIFIER = JSON.stringify(verifier);
    const UPSTREAM_ERROR = JSON.stringify(upstreamError);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Vertex Swarm - Completing Sign-In</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:14px/1.6 "Segoe UI",system-ui,sans-serif}
    .card{width:min(480px,calc(100vw - 32px));padding:28px;border-radius:16px;background:rgba(30,41,59,.96);border:1px solid rgba(148,163,184,.18);box-shadow:0 20px 50px rgba(0,0,0,.35)}
    h1{margin:0 0 4px;font-size:22px;font-weight:600}
    .sub{color:#94a3b8;margin:0 0 16px}
    #status{padding:12px;border-radius:8px;background:rgba(15,23,42,.6);font-size:13px;min-height:42px}
    .ok{color:#34d399} .err{color:#fca5a5} .info{color:#94a3b8}
    #log{margin-top:14px;font:11px/1.5 "Cascadia Code","Fira Code",monospace;color:#475569;max-height:180px;overflow-y:auto;white-space:pre-wrap;padding:8px;border-radius:6px;background:rgba(0,0,0,.25)}
  </style>
</head>
<body>
<div class="card">
  <h1>Vertex Swarm</h1>
  <p class="sub">Completing sign-in...</p>
  <div id="status" class="info">Exchanging Neon session for API JWT...</div>
  <div id="log"></div>
</div>
<script>
(function(){
  var AUTH_URL       = ${AUTH_URL};
  var VERIFIER       = ${VERIFIER};
  var UPSTREAM_ERROR = ${UPSTREAM_ERROR};
  var elStatus = document.getElementById('status');
  var elLog    = document.getElementById('log');

  function log(msg){ elLog.textContent += msg + '\\n'; }
  function setStatus(msg, cls){ elStatus.textContent = msg; elStatus.className = cls || 'info'; }

  function reportError(msg){
    return fetch('/error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({error:msg})}).catch(function(){});
  }

  function reportSuccess(token, user){
    return fetch('/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,user:user})}).catch(function(){});
  }

  async function finalize(){
    log('URL: ' + window.location.href);
    log('Verifier: ' + (VERIFIER ? VERIFIER.substring(0,16) + '...' : '(none)'));

    if (UPSTREAM_ERROR) {
      log('Upstream error: ' + UPSTREAM_ERROR);
      setStatus('Authentication failed: ' + UPSTREAM_ERROR, 'err');
      await reportError('Upstream: ' + UPSTREAM_ERROR);
      return;
    }

    if (!VERIFIER) {
      var msg = 'No session verifier received. The Google sign-in may not have completed.';
      log(msg);
      log('Full URL: ' + window.location.href);
      setStatus(msg, 'err');
      await reportError(msg);
      return;
    }

    try {
      var sessionUrl = AUTH_URL + '/get-session?neon_auth_session_verifier=' + encodeURIComponent(VERIFIER);
      log('GET ' + sessionUrl.substring(0, 80) + '...');
      setStatus('Exchanging verifier for session...', 'info');

      var resp = await fetch(sessionUrl, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      log('Status: ' + resp.status);
      var text = await resp.text();
      log('Body: ' + text.substring(0, 300));

      if (!resp.ok) {
        throw new Error('Session exchange failed (HTTP ' + resp.status + '): ' + text.substring(0, 200));
      }

      var jwtFromHeader = resp.headers.get('set-auth-jwt');
      var data = JSON.parse(text);
      var sessionToken = (data && data.session && data.session.token) || (data && data.token) || '';
      var user  = (data && data.user) || (data && data.session && data.session.user) || {};
      var token = jwtFromHeader || '';

      if (!token) {
        log('JWT header missing, requesting /token...');
        var tokenHeaders = { 'Accept': 'application/json' };
        if (sessionToken) {
          tokenHeaders['Authorization'] = 'Bearer ' + sessionToken;
        }

        var tokenResp = await fetch(AUTH_URL + '/token', {
          credentials: 'include',
          headers: tokenHeaders
        });

        log('Token status: ' + tokenResp.status);
        var tokenText = await tokenResp.text();
        log('Token body: ' + tokenText.substring(0, 300));

        if (tokenResp.ok) {
          var tokenData = JSON.parse(tokenText);
          token = (tokenData && tokenData.token) || '';
        }
      }

      if (!token) {
        throw new Error('No JWT token returned by Neon Auth. Body: ' + text.substring(0, 200));
      }

      if (token.split('.').length !== 3) {
        throw new Error('Neon Auth returned a non-JWT token for backend auth');
      }

      log('JWT: ' + token.substring(0, 16) + '...');
      log('User: ' + JSON.stringify(user));
      setStatus('Signed in as ' + (user.email || user.name || user.id || 'user') + '. You can close this tab and return to VS Code.', 'ok');
      await reportSuccess(token, user);

    } catch(err) {
      var msg = err instanceof Error ? err.message : String(err);
      log('FAILED: ' + msg);
      setStatus(msg, 'err');
      await reportError(msg);
    }
  }

  finalize();
})();
</script>
</body>
</html>`;
  }

  private serveHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
