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

export interface ToolContext {
  tool_call_id: string;
  session_id: string;
  chat_id: string;
  message_id: string;
}

export interface ToolResult {
  tool_name: string;
  tool_call_id: string;
  session_id: string;
  chat_id: string;
  message_id: string;
  status: 'success' | 'error' | 'timeout';
  content: string;
  execution_time_ms: number;
  error_code?: string;
}

export interface ToolCallPayload {
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  session_id: string;
  chat_id: string;
  message_id: string;
}

export interface AuthenticatedSessionData {
  user: {
    id: string;
    email: string;
    provider: string;
  };
}

// Messages FROM Extension Host TO Webview
export type ExtensionToWebviewMessage =
  | { type: 'authenticated'; payload: AuthenticatedSessionData }
  | { type: 'logged-out'; payload: { reason?: string | null } }
  | { type: 'event'; payload: SessionEvent }
  | { type: 'chat-list'; payload: ChatListPayload }
  | { type: 'chat-opened'; payload: ChatOpenedPayload }
  | { type: 'error'; payload: string }
  | { type: 'cancel-stream'; payload: { sessionId: string } };

// Messages FROM Webview TO Extension Host
export type WebviewToExtensionMessage =
  | { type: 'request-session' }
  | { type: 'open-browser' }
  | { type: 'copy-link' }
  | { type: 'load-chat-list' }
  | { type: 'start-stream'; payload: StreamStartPayload }
  | { type: 'open-chat'; payload: OpenChatPayload }
  | { type: 'set-ide-context'; payload: SetIdeContextPayload }
  | { type: 'cancel-stream'; payload: StreamCancelPayload }
  | { type: 'tool_call'; payload: ToolCallPayload }
  | { type: 'reset-chat' }
  | { type: 'logout' };

// Legacy union kept for backward compat
export type ExtensionMessage = ExtensionToWebviewMessage | WebviewToExtensionMessage;

export interface StreamStartPayload {
  message: string;
  ideContextEnabled: boolean;
}

export interface StreamCancelPayload {
  sessionId: string;
}

export interface ChatSummaryData {
  chatId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  ideContextEnabled: boolean;
}

export interface ChatMessageData {
  messageId: string;
  role: string;
  content: string;
  events?: SessionEvent[];
  createdAt: string;
}

export interface ChatListPayload {
  chats: ChatSummaryData[];
  activeChatId: string | null;
}

export interface ChatOpenedPayload {
  chatId: string;
  ideContextEnabled: boolean;
  messages: ChatMessageData[];
}

export interface OpenChatPayload {
  chatId: string;
}

export interface SetIdeContextPayload {
  chatId: string;
  enabled: boolean;
}
