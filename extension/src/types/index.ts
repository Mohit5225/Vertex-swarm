/**
 * Shared types between Extension Host and Webview
 * Used for postMessage communication
 */

export interface SessionEvent {
  id: string;
  type: 'thinking' | 'code' | 'output' | 'error' | 'status';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// Messages FROM Extension Host TO Webview
export type ExtensionToWebviewMessage =
  | { type: 'token'; payload: TokenData }
  | { type: 'auth-url'; payload: { url: string } }
  | { type: 'event'; payload: SessionEvent }
  | { type: 'error'; payload: string }
  | { type: 'cancel-stream'; payload: { sessionId: string } };

// Messages FROM Webview TO Extension Host
export type WebviewToExtensionMessage =
  | { type: 'request-auth-url' }
  | { type: 'open-browser' }
  | { type: 'copy-link' }
  | { type: 'request-token' }
  | { type: 'start-stream'; payload: StreamStartPayload }
  | { type: 'cancel-stream'; payload: StreamCancelPayload }
  | { type: 'logout' };

// Legacy union kept for backward compat
export type ExtensionMessage = ExtensionToWebviewMessage | WebviewToExtensionMessage;

export interface TokenData {
  token: string;
  user: {
    id: string;
    email: string;
    provider: string;
  };
}

export interface StreamStartPayload {
  sessionId: string;
}

export interface StreamCancelPayload {
  sessionId: string;
}
