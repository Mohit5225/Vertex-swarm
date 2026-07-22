/**
 * Shared types between Extension Host and Webview
 * Used for postMessage communication
 */

export interface SessionEvent {
  id: string;
  type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result'
      | 'plan_permission_request' | 'plan_chunk' | 'plan_ready' | 'todo_init' | 'todo_update';
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

export interface RequestContextSelection {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface RequestContextFile {
  path: string;
  languageId?: string;
  selection?: RequestContextSelection;
}

export interface RequestContextTerminal {
  name: string;
  processId?: number | null;
  shell?: string;
  cwd?: string;
}

export interface RequestContextPayload {
  activeFile?: RequestContextFile;
  activeTerminal?: RequestContextTerminal;
  activeTerminals?: { name: string; purpose: string; isBusy: boolean }[];
  workspaceFolders?: string[];
}

export interface ToolResult {
  tool_name: string;
  tool_call_id: string;
  session_id: string;
  chat_id: string;
  message_id: string;
  request_id?: string;
  action?: string;
  status: 'success' | 'error' | 'timeout' | 'verification_needed' | 'running' | 'cancelled';
  content: string;
  summary?: string;
  data?: unknown;
  conflict?: Record<string, unknown> | null;
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
  | { type: 'stream-complete' }
  | { type: 'cancel-stream'; payload: { sessionId: string } }
  | { type: 'config-state'; payload: { snapshotRetentionDays: number } }
  | { type: 'message-id-assigned'; payload: { tempId: string; realId: string } }
  | { type: 'messages-truncated'; payload: { messageId: string; messageText: string } }
  | { type: 'auth-required' }
  | { type: 'config-missing'; payload?: { reason?: string } }
  | { type: 'config-ready'; payload: { llmBaseUrl?: string; llmModel?: string } }
  | { type: 'plan-ready'; payload: Record<string, never> }
  | {
      type: 'terminal-output'
      payload: {
        jobId: string
        content: string
        totalChars?: number
        status?: string
      }
    };

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
  | { type: 'show-terminal'; payload: { terminalName: string } }
  | { type: 'get-terminal-output'; payload: { jobId: string } }
  | { type: 'reset-chat' }
  | { type: 'logout' }
  | { type: 'log'; payload: string }
  | { type: 'undo-snapshot'; payload: { snapshotId: string; sessionId: string; messageId: string } }
  | { type: 'undo-snapshot-file'; payload: { snapshotId: string; sessionId: string; messageId: string; originalUri: string } }
  | { type: 'review-snapshot'; payload: { file: string; originalUri: string; snapshotPath?: string; operation?: string; isNewFile?: boolean; isDeleted?: boolean; isBinary?: boolean } }
  | { type: 'get-config' }
  | { type: 'set-config'; payload: { snapshotRetentionDays: number } }
  | { type: 'open-plan' }
  | { type: 'truncate-messages'; payload: { chatId: string; messageId: string; messageText: string } }
  | { type: 'save-config'; payload: { llmBaseUrl?: string, llmModel?: string, llmKey?: string, exaKey?: string } };

// Legacy union kept for backward compat
export type ExtensionMessage = ExtensionToWebviewMessage | WebviewToExtensionMessage;

export interface StreamStartPayload {
  message: string;
  ideContextEnabled: boolean;
  tempId?: string;
  requestContext?: RequestContextPayload;
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
  turn_duration_ms?: number;
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
