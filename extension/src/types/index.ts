/**
 * Shared types between Extension Host and Webview
 * Used for postMessage communication
 */

export interface SessionEvent {
  id: string;
  type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// Messages FROM Extension Host TO Webview
export type ExtensionToWebviewMessage =
  | { type: 'token'; payload: TokenData }
  | { type: 'auth-url'; payload: { url: string } }
  | { type: 'event'; payload: SessionEvent }
  | { type: 'chat-list'; payload: ChatListPayload }
  | { type: 'chat-opened'; payload: ChatOpenedPayload }
  | { type: 'error'; payload: string }
  | { type: 'cancel-stream'; payload: { sessionId: string } };

// Messages FROM Webview TO Extension Host
export type WebviewToExtensionMessage =
  | { type: 'request-auth-url' }
  | { type: 'open-browser' }
  | { type: 'copy-link' }
  | { type: 'request-token' }
  | { type: 'load-chat-list' }
  | { type: 'start-stream'; payload: StreamStartPayload }
  | { type: 'open-chat'; payload: OpenChatPayload }
  | { type: 'cancel-stream'; payload: StreamCancelPayload }
  | { type: 'reset-chat' }
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
  message: string;
}

export interface StreamCancelPayload {
  sessionId: string;
}

export interface ChatSummaryData {
  chatId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageData {
  messageId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatListPayload {
  chats: ChatSummaryData[];
  activeChatId: string | null;
}

export interface ChatOpenedPayload {
  chatId: string;
  messages: ChatMessageData[];
}

export interface OpenChatPayload {
  chatId: string;
}
