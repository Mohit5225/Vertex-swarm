import { create } from "zustand";
import { getVsCodeApi } from "../lib/vscode";
import { useChatStore } from "./chatStore";
import { useDeepPlanStore, findDeepPlanReadyMessageId } from "./deepPlanStore";
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
      const prev = useConfigStore.getState();
      // Keep loading:true only during first-time bootstrap (before config-ready).
      // syncWebviewConfig() re-sends authenticated when respawning the backend
      // mid-chat (e.g. start-stream); flipping loading there replaces ChatPanel
      // with the full-screen logo instead of the in-chat "Preparing..." state.
      useConfigStore.setState({
        user,
        isAuthenticated: true,
        loading: !prev.hasConfig,
        error: null,
      });
      break;
    }

    case "logged-out":
    case "auth-required":
      clearRestoreTimers();
      useChatStore.getState().clearMessages();
      useChatStore.getState().setChatList([], null);
      useDeepPlanStore.getState().deactivate();
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
      useDeepPlanStore.getState().deactivate();
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

      const eventType = message.payload?.type;
      const metadata = message.payload?.metadata ?? {};

      if (eventType === "status") {
        const phase = metadata.phase;
        if (
          phase === "cancelled" ||
          phase === "deep_plan_aborted" ||
          phase === "preempted"
        ) {
          useDeepPlanStore.getState().releaseComposerLock();
        }
        if (phase === "context_policy") {
          const notice = typeof message.payload?.content === "string"
            ? message.payload.content.trim()
            : "";
          if (notice) {
            useChatStore.getState().addContextNotice(notice);
          }
        }
      }

      if (eventType === "deep_plan_mode_active" || eventType === "deep_plan_started") {
        useDeepPlanStore.getState().applyModeEvent(metadata);
        if (typeof metadata.pipeline_id === "string") {
          useDeepPlanStore.getState().setPipelineId(metadata.pipeline_id);
        }
      } else if (eventType === "deep_plan_stage_status") {
        useDeepPlanStore.getState().applyStageStatus(metadata);
        if (typeof metadata.pipeline_id === "string") {
          useDeepPlanStore.getState().setPipelineId(metadata.pipeline_id);
        }
      } else if (eventType === "deep_plan_ready") {
        useDeepPlanStore.getState().setPhase("awaiting_approval", "Awaiting approval");
      }

      useChatStore.getState().addEvent(normalizeSessionEvent(message.payload));
      break;
    }

    case "file-changes-enrichment":
      useChatStore.getState().enrichToolResultFileChanges(message.payload);
      break;

    case "stream-complete":
      useChatStore.getState().finishStreaming();
      useDeepPlanStore.getState().releaseComposerLock();
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

    case "chat-opened": {
      const payload = message.payload as {
        chatId: string;
        ideContextEnabled?: boolean;
        deepPlanPipeline?: Record<string, unknown> | null;
        deepPlanPhase?: string | null;
        deepPlanRequested?: boolean;
        deepPlanConfirmed?: boolean;
        messages: Array<{
          messageId: string;
          role: string;
          content: string;
          createdAt: string;
          turn_duration_ms?: number;
          events?: Array<Record<string, unknown>>;
          attachments?: Array<{
            id: string;
            filename: string;
            mimeType: string;
            size: number;
            relativePath: string;
            uri?: string;
          }>;
        }>;
      };
      useChatStore.getState().replaceMessages(
        payload.chatId,
        payload.messages.map(
          (message) => ({
            id: message.messageId,
            type:
              message.role === "assistant"
                ? "agent"
                : message.role === "system"
                  ? "system"
                  : "user",
            content: message.content,
            attachments: Array.isArray(message.attachments)
              ? message.attachments
                  .filter((attachment) => attachment.uri)
                  .map((attachment) => ({
                    id: attachment.id,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    uri: attachment.uri as string,
                    relativePath: attachment.relativePath,
                  }))
              : undefined,
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
        Boolean(payload.ideContextEnabled),
      );
      useDeepPlanStore.getState().hydrateFromPipeline(payload.deepPlanPipeline);
      if (
        !useDeepPlanStore.getState().active &&
        payload.deepPlanPhase === "req" &&
        (payload.deepPlanRequested || payload.deepPlanConfirmed)
      ) {
        useDeepPlanStore
          .getState()
          .activate(
            payload.deepPlanConfirmed ? "vertex_hil" : "user_slash",
            "requirement_extraction",
          );
      }
      const pipelineId =
        payload.deepPlanPipeline &&
        typeof payload.deepPlanPipeline.pipeline_id === "string"
          ? payload.deepPlanPipeline.pipeline_id
          : null;
      const readyMessageId = findDeepPlanReadyMessageId(
        payload.messages,
        pipelineId,
      );
      if (
        readyMessageId &&
        payload.deepPlanPipeline?.status === "awaiting_approval"
      ) {
        useChatStore.getState().setDeepPlanReadyForMessageId(readyMessageId);
      }
      break;
    }

    case "message-id-assigned":
      useChatStore
        .getState()
        .patchMessageId(message.payload.tempId, message.payload.realId);
      break;

    case "attachments-resolved": {
      const tempId = message.payload.tempId
      const existing = useChatStore
        .getState()
        .messages.find((entry) => entry.id === tempId)
      existing?.attachments?.forEach((attachment) => {
        if (attachment.uri.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.uri)
        }
      })
      useChatStore
        .getState()
        .patchMessageAttachments(
          tempId,
          message.payload.attachments.map((attachment: {
            id: string;
            filename: string;
            mimeType: string;
            size: number;
            uri?: string;
            relativePath?: string;
          }) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            uri: attachment.uri ?? "",
            relativePath: attachment.relativePath,
          })),
        );
      break;
    }

    case "messages-truncated": {
      const payload = message.payload as {
        messageId: string;
        messageText: string;
        attachments?: Array<{
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          uri?: string;
          relativePath?: string;
        }>;
      };
      const existing = useChatStore
        .getState()
        .messages.find(
          (entry) =>
            entry.id === payload.messageId ||
            entry.dbMessageId === payload.messageId,
        );
      const fallbackAttachments = existing?.attachments ?? [];

      useChatStore.getState().truncateAfter(payload.messageId);

      const restoredSource =
        payload.attachments && payload.attachments.length > 0
          ? payload.attachments
          : fallbackAttachments;

      window.dispatchEvent(
        new CustomEvent("vertex-queued-edit", {
          detail: {
            text: payload.messageText,
            attachments: restoredSource.map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              size: attachment.size,
              uri: attachment.uri ?? "",
              relativePath: attachment.relativePath,
            })),
          },
        }),
      );
      break;
    }

    case "cancel-stream":
      useChatStore.getState().finishStreaming();
      useDeepPlanStore.getState().releaseComposerLock();
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
      useDeepPlanStore.getState().setPhase("awaiting_approval", "Awaiting approval");
      break;

    case "deep-plan-mode": {
      const p = message.payload ?? {};
      if (p.active) {
        useDeepPlanStore.getState().applyModeEvent({
          trigger: p.trigger,
          phase: p.phase,
          stage_label: p.stage_label,
        });
      } else {
        useDeepPlanStore.getState().deactivate();
      }
      break;
    }

    case "stream-start-failed": {
      clearRestoreTimers();
      const failureMessage =
        typeof message.payload?.message === "string"
          ? message.payload.message
          : "Unable to start the agent stream. Please try again.";
      const tempId =
        typeof message.payload?.tempId === "string"
          ? message.payload.tempId
          : undefined;
      if (tempId) {
        useChatStore.getState().rollbackOptimisticSend(tempId, failureMessage);
      } else {
        useChatStore.getState().setError(failureMessage);
        useChatStore.getState().finishStreaming();
      }
      useDeepPlanStore.getState().releaseComposerLock();
      break;
    }

    case "error":
      clearRestoreTimers();
      if (
        useConfigStore.getState().hasConfig ||
        useChatStore.getState().isStreaming
      ) {
        useChatStore.getState().setError(message.payload);
        useDeepPlanStore.getState().releaseComposerLock();
        if (useConfigStore.getState().hasConfig) {
          useConfigStore.setState({ loading: false });
        }
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
