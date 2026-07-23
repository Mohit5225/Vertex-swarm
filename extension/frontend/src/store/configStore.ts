import { create } from "zustand";
import { getVsCodeApi } from "../lib/vscode";
import { useChatStore } from "./chatStore";
import { normalizeSessionEvent, compactSessionEvents } from "../lib/sessionEvents";

export interface VertexConfig {
  llmBaseUrl: string;
  llmModel: string;
}

interface User {
  id: string;
  email: string;
  provider: string;
}

interface ConfigState {
  hasConfig: boolean;
  config: VertexConfig | null;
  isAuthenticated: boolean;
  isEditingProvider: boolean;
  user: User | null;
  loading: boolean;
  error: string | null;

  // Actions
  logout: () => void;
  initializeExtensionBridge: () => void;
  resetConfig: () => void;
  openProviderSettings: () => void;
  closeProviderSettings: () => void;
}

let messageListenerRegistered = false;
let restoreRetryTimeout: number | null = null;
let restoreTimeout: number | null = null;

const clearRestoreTimers = () => {
  if (restoreRetryTimeout !== null) {
    window.clearTimeout(restoreRetryTimeout);
    restoreRetryTimeout = null;
  }

  if (restoreTimeout !== null) {
    window.clearTimeout(restoreTimeout);
    restoreTimeout = null;
  }
};

const requestBridgeState = () => {
  const vscodeApi = getVsCodeApi();
  if (!vscodeApi) {
    throw new Error("VS Code API unavailable");
  }

  vscodeApi.postMessage({ type: "request-session" });
};

const startRestoreWatchdog = () => {
  clearRestoreTimers();

  restoreRetryTimeout = window.setTimeout(() => {
    const state = useConfigStore.getState();
    if (!state.loading) {
      return;
    }

    try {
      requestBridgeState();
    } catch (error) {
      console.error("Failed to retry extension bridge handshake:", error);
    }
  }, 900);

  restoreTimeout = window.setTimeout(() => {
    const state = useConfigStore.getState();
    if (!state.loading) {
      return;
    }

    useConfigStore.setState({
      loading: false,
      error: "Extension session restore timed out. Reload the window.",
    });
  }, 30000);
};

const handleExtensionMessage = (event: MessageEvent) => {
  const message = event.data;

  switch (message?.type) {
    case "authenticated": {
      const { user } = message.payload;
      // Keep loading:true so the UI stays on "Checking Configuration..." while
      // syncWebviewConfig() finishes its async work before sending config-ready
      // or config-missing. Without this, the Configure Provider screen flashes
      // briefly on every sign-in (isAuthenticated=true, hasConfig=false, loading=false).
      useConfigStore.setState({
        user,
        isAuthenticated: true,
        loading: true,
        error: null,
      });
      break;
    }

    case "logged-out":
    case "auth-required":
      clearRestoreTimers();
      useChatStore.getState().clearMessages();
      useChatStore.getState().setChatList([], null);
      useConfigStore.setState({
        isAuthenticated: false,
        user: null,
        hasConfig: false,
        config: null,
        loading: false,
        error: message.payload?.reason || null,
      });
      break;

    case "config-ready": {
      clearRestoreTimers();
      useConfigStore.setState({
        config: message.payload,
        hasConfig: true,
        isAuthenticated: true, // If config is ready, we are authenticated
        isEditingProvider: false,
        loading: false,
        error: null,
      });
      break;
    }

    case "config-missing":
      clearRestoreTimers();
      useChatStore.getState().clearMessages();
      useChatStore.getState().setChatList([], null);
      useConfigStore.setState({
        hasConfig: false,
        config: null,
        isAuthenticated: true, // Auth exists but no config
        loading: false,
        error: message.payload?.reason || null,
      });
      break;

    case "event": {
      if (message.payload?.type === "done") {
        useChatStore.getState().finishStreaming();
        break;
      }

      useChatStore.getState().addEvent(normalizeSessionEvent(message.payload));
      break;
    }

    case "stream-complete":
      useChatStore.getState().finishStreaming();
      break;

    case "chat-list": {
      const normalizedChats = message.payload.chats.map(
        (chat: {
          chatId: string;
          title: string | null;
          createdAt: string;
          updatedAt: string;
          ideContextEnabled?: boolean;
        }) => ({
          ...chat,
          ideContextEnabled: Boolean(chat.ideContextEnabled),
        }),
      );
      useChatStore
        .getState()
        .setChatList(normalizedChats, message.payload.activeChatId);
      break;
    }

    case "chat-opened":
      useChatStore.getState().replaceMessages(
        message.payload.chatId,
        message.payload.messages.map(
          (message: {
            messageId: string;
            role: string;
            content: string;
            createdAt: string;
            turn_duration_ms?: number;
            events?: Array<Record<string, unknown>>;
          }) => ({
            id: message.messageId,
            type:
              message.role === "assistant"
                ? "agent"
                : message.role === "system"
                  ? "system"
                  : "user",
            content: message.content,
            turnDurationMs:
              typeof message.turn_duration_ms === "number"
                ? message.turn_duration_ms
                : undefined,
            events: compactSessionEvents(
              (Array.isArray(message.events) ? message.events : []).map(
                (event, index) => ({
                  ...normalizeSessionEvent(event, {
                    id: `${message.messageId}-evt-${index}`,
                  }),
                }),
              ),
            ),
            timestamp: Date.parse(message.createdAt) || Date.now(),
          }),
        ),
        Boolean(message.payload.ideContextEnabled),
      );
      break;

    case "message-id-assigned":
      useChatStore
        .getState()
        .patchMessageId(message.payload.tempId, message.payload.realId);
      break;

    case "messages-truncated":
      useChatStore.getState().truncateAfter(message.payload.messageId);
      // We also need to emit a custom event on window so ChatPanel can pick up the queuedEdit text
      window.dispatchEvent(
        new CustomEvent("vertex-queued-edit", {
          detail: { text: message.payload.messageText },
        }),
      );
      break;

    case "cancel-stream":
      useChatStore.getState().finishStreaming();
      break;

    case "plan-ready":
      // The plan tab is now open in the editor. Associate it with the active
      // message so the PlanCard can show the "Proceed" button.
      useChatStore
        .getState()
        .setPlanReadyForMessageId(useChatStore.getState().activeMessageId);
      break;

    case "deep-plan-ready":
      useChatStore
        .getState()
        .setDeepPlanReadyForMessageId(useChatStore.getState().activeMessageId);
      break;

    case "error":
      clearRestoreTimers();
      if (
        useConfigStore.getState().hasConfig ||
        useChatStore.getState().isStreaming
      ) {
        useChatStore.getState().setError(message.payload);
      } else {
        useConfigStore.setState({
          error: message.payload,
          loading: false,
        });
      }
      break;
  }
};

if (!messageListenerRegistered) {
  window.addEventListener("message", handleExtensionMessage);
  messageListenerRegistered = true;
}

export const useConfigStore = create<ConfigState>((set) => ({
  hasConfig: false,
  config: null,
  isAuthenticated: false,
  isEditingProvider: false,
  user: null,
  loading: true,
  error: null,

  logout: () => {
    clearRestoreTimers();
    useChatStore.getState().clearMessages();
    useChatStore.getState().setChatList([], null);
    const vscodeApi = getVsCodeApi();
    if (vscodeApi) {
      vscodeApi.postMessage({ type: "logout" });
    }
    set({
      isAuthenticated: false,
      user: null,
      hasConfig: false,
      config: null,
      isEditingProvider: false,
      error: null,
      loading: false,
    });
  },

  initializeExtensionBridge: () => {
    set({ loading: true, error: null });
    startRestoreWatchdog();
    try {
      requestBridgeState();
    } catch (error) {
      set({
        loading: false,
        error:
          "Cannot connect to VS Code extension host. Are you running in a webview?",
      });
    }
  },

  resetConfig: () => {
    clearRestoreTimers();
    useChatStore.getState().clearMessages();
    useChatStore.getState().setChatList([], null);
    set({
      hasConfig: false,
      config: null,
      isEditingProvider: false,
      error: null,
      loading: false,
    });
  },

  openProviderSettings: () => {
    set({ isEditingProvider: true, error: null });
  },

  closeProviderSettings: () => {
    set({ isEditingProvider: false, error: null });
  },
}));
