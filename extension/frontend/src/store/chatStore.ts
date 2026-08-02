import { create } from 'zustand'
import { findLastAgentMessage, resolveStreamingAgentMessageId } from '../lib/liveAgentTurn'
import {
  mergeSessionEvents,
  shouldMergeSessionEvents,
} from '../lib/sessionEvents'
import type { ChatAttachment } from '../lib/attachments'

export interface SessionEvent {
  id: string
  type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result'
      | 'plan_permission_request' | 'plan_chunk' | 'plan_ready' | 'todo_init' | 'todo_update' | 'todo_clear'
      | 'hil_question' | 'hil_resolved'
      | 'deep_plan_started' | 'deep_plan_stage_status' | 'deep_plan_ready' | 'deep_plan_permission_request'
      | 'deep_plan_artifact_saved' | 'deep_plan_mode_active'
  content?: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface TodoItem {
  id: string
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface TodoState {
  items: TodoItem[]
  planId?: string
  sourceMessageId?: string
  lastUpdatedAt: number
}

export interface ChatMessage {
  id: string
  /** Real DB UUID — only set for user messages sent live (not loaded from history) */
  dbMessageId?: string
  type: 'user' | 'agent' | 'system'
  content: string
  attachments?: ChatAttachment[]
  events?: SessionEvent[]
  timestamp: number
  /** User message sent while deep plan composer mode was active */
  deepPlan?: boolean
  /** Persisted wall-clock duration for completed turns (reload-safe). */
  turnDurationMs?: number
}

export interface ChatSummary {
  chatId: string
  title: string | null
  createdAt: string
  updatedAt: string
  ideContextEnabled: boolean
}

interface ChatState {
  currentChatId: string | null
  currentIdeContextEnabled: boolean
  activeMessageId: string | null
  chats: ChatSummary[]
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  planReadyForMessageId: string | null
  deepPlanReadyForMessageId: string | null
  currentTodo: TodoState | null

  // Actions
  setCurrentChatId: (id: string | null) => void
  setChatList: (chats: ChatSummary[], activeChatId?: string | null) => void
  replaceMessages: (
    chatId: string,
    messages: ChatMessage[],
    
    ideContextEnabled?: boolean
  ) => void
  setCurrentIdeContextEnabled: (enabled: boolean) => void
  addMessage: (message: ChatMessage) => void
  beginAssistantMessage: () => void
  addEvent: (event: SessionEvent) => void
  enrichToolResultFileChanges: (payload: {
    tool_call_id: string
    file_changes: unknown[]
    snapshot_id?: string
    snapshot_session_id?: string
  }) => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  finishStreaming: () => void
  clearMessages: () => void
  patchMessageId: (tempId: string, realId: string) => void
  patchMessageAttachments: (tempId: string, attachments: ChatAttachment[]) => void
  truncateAfter: (messageId: string) => void
  rollbackOptimisticSend: (tempId: string, errorMessage: string) => void
  setPlanReadyForMessageId: (messageId: string | null) => void
  setDeepPlanReadyForMessageId: (messageId: string | null) => void
  clearTodo: () => void
  addContextNotice: (content: string) => void
}

const isTodoItem = (value: unknown): value is TodoItem => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.content === 'string' &&
    typeof item.activeForm === 'string' &&
    (item.status === 'pending' || item.status === 'in_progress' || item.status === 'done')
  )
}

const extractTodoStateFromEvent = (
  event: SessionEvent,
  sourceMessageId?: string
): TodoState | null => {
  if (event.type !== 'todo_init' && event.type !== 'todo_update') {
    return null
  }

  const rawItems = event.metadata?.items
  if (!Array.isArray(rawItems)) {
    return null
  }

  const items = rawItems.filter(isTodoItem)
  if (items.length === 0) {
    return null
  }

  return {
    items,
    planId:
      typeof event.metadata?.plan_id === 'string' ? event.metadata.plan_id : undefined,
    sourceMessageId,
    lastUpdatedAt: event.timestamp || Date.now(),
  }
}

const isGhostAgentMessage = (message: ChatMessage) => {
  if (message.type !== 'agent') {
    return false
  }

  if (message.content?.trim()) {
    return false
  }

  const events = message.events || []
  if (events.length === 0) {
    return true
  }

  return events.every(
    (event) =>
      event.type === 'status' &&
      !(event.content || '').trim()
  )
}

const pruneTrailingGhostAgents = (messages: ChatMessage[]) => {
  const result = [...messages]

  while (result.length > 0 && isGhostAgentMessage(result[result.length - 1])) {
    result.pop()
  }

  return result
}

const extractTodoStateFromMessages = (messages: ChatMessage[]): TodoState | null => {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    const events = message.events || []

    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      if (events[eventIndex].type === 'todo_clear') {
        return null
      }
      const todoState = extractTodoStateFromEvent(events[eventIndex], message.id)
      if (todoState) {
        return todoState
      }
    }
  }

  return null
}

const appendEventContent = (currentContent: string, event: SessionEvent): string => {
  if (!event.content) {
    return currentContent
  }

  const appendMode =
    typeof event.metadata?.appendMode === 'string'
      ? event.metadata.appendMode
      : undefined

  if (appendMode === 'token') {
    return `${currentContent}${event.content}`
  }
  // Thinking is rendered from dedicated events in the process timeline — not message.content.
  if (event.type === 'thinking') {
    return currentContent
  }

  if (event.type === 'output') {
    if (appendMode === 'block') {
      return currentContent
        ? `${currentContent}\n\n${event.content}`
        : event.content
    }

    return `${currentContent}${event.content}`
  }

  if (event.type === 'code') {
    return currentContent
      ? `${currentContent}\n\n${event.content}`
      : event.content
  }

  if (event.type === 'error' && !currentContent) {
    return event.content
  }

  return currentContent
}

const shouldMergeEvent = (previous: SessionEvent | undefined, next: SessionEvent) => {
  if (
    previous?.type === 'token' as SessionEvent['type'] &&
    next.type === 'token' as SessionEvent['type']
  ) {
    return true
  }

  return shouldMergeSessionEvents(previous, next)
}

const normalizeEventComparisonContent = (content?: string) =>
  typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : ''

const matchesAgentMessageId = (message: ChatMessage, id: string) =>
  message.type === 'agent' && (message.id === id || message.dbMessageId === id)

const resolveEventTargetIndex = (
  messages: ChatMessage[],
  event: SessionEvent,
  activeMessageId: string | null,
  isStreaming: boolean,
): number => {
  const eventMessageId =
    typeof event.metadata?.message_id === 'string' ? event.metadata.message_id : undefined

  if (eventMessageId) {
    const byBackendId = messages.findIndex((message) =>
      matchesAgentMessageId(message, eventMessageId),
    )
    if (byBackendId !== -1) {
      return byBackendId
    }
  }

  if (activeMessageId) {
    const byActive = messages.findIndex((message) => message.id === activeMessageId)
    if (byActive !== -1) {
      return byActive
    }
  }

  if (isStreaming) {
    const lastAgent = findLastAgentMessage(messages)
    if (lastAgent) {
      const idx = messages.findIndex((message) => message.id === lastAgent.id)
      if (idx !== -1) {
        return idx
      }
    }
  }

  const isNestedTrace =
    Boolean(event.metadata?.subagent_trace) || Boolean(event.metadata?.deep_plan_worker)
  if (isNestedTrace) {
    const lastAgent = findLastAgentMessage(messages)
    if (lastAgent) {
      return messages.findIndex((message) => message.id === lastAgent.id)
    }
  }

  return -1
}

const mergeEvent = (previous: SessionEvent, next: SessionEvent): SessionEvent => {
  const previousType = previous.type === ('token' as SessionEvent['type']) ? 'output' : previous.type
  const nextType = next.type === ('token' as SessionEvent['type']) ? 'output' : next.type

  if (previousType === 'output' && nextType === 'output') {
    return mergeSessionEvents(
      previousType === previous.type ? previous : { ...previous, type: 'output' },
      nextType === next.type ? next : { ...next, type: 'output' },
    )
  }

  return mergeSessionEvents(previous, next)
}

export const useChatStore = create<ChatState>((set) => ({
  currentChatId: null,
  currentIdeContextEnabled: false,
  activeMessageId: null,
  chats: [],
  messages: [],
  isStreaming: false,
  error: null,
  planReadyForMessageId: null,
  deepPlanReadyForMessageId: null,
  currentTodo: null,

  setCurrentChatId: (id: string | null) => {
    set((state) => {
      if (!id) {
        return {
          currentChatId: null,
          currentIdeContextEnabled: false,
        }
      }

      const matchingChat = state.chats.find((chat) => chat.chatId === id)
      return {
        currentChatId: id,
        currentIdeContextEnabled: matchingChat?.ideContextEnabled ?? false,
      }
    })
  },

  setChatList: (chats: ChatSummary[], activeChatId?: string | null) => {
    set((state) => ({
      chats,
      currentChatId:
        typeof activeChatId === 'undefined'
          ? state.currentChatId
          : activeChatId,
      currentIdeContextEnabled: (() => {
        const resolvedActiveChatId =
          typeof activeChatId === 'undefined'
            ? state.currentChatId
            : activeChatId

        if (!resolvedActiveChatId) {
          return state.currentIdeContextEnabled
        }

        const matchingChat = chats.find(
          (chat) => chat.chatId === resolvedActiveChatId
        )
        return matchingChat?.ideContextEnabled ?? state.currentIdeContextEnabled
      })(),
    }))
  },

  replaceMessages: (
    chatId: string,
    messages: ChatMessage[],
    ideContextEnabled = false
  ) => {
    const normalizedMessages = messages.map((message: any) => ({
      ...message,
      id: message.messageId || message.id,
      events: message.events || [],
    }))

    set({
      currentChatId: chatId,
      currentIdeContextEnabled: ideContextEnabled,
      activeMessageId: null,
      isStreaming: false,
      error: null,
      messages: normalizedMessages,
      currentTodo: extractTodoStateFromMessages(normalizedMessages),
    })
  },

  setCurrentIdeContextEnabled: (enabled: boolean) => {
    set((state) => ({
      currentIdeContextEnabled: enabled,
      chats: state.currentChatId
        ? state.chats.map((chat) =>
            chat.chatId === state.currentChatId
              ? { ...chat, ideContextEnabled: enabled }
              : chat
          )
        : state.chats,
    }))
  },

  addMessage: (message: ChatMessage) => {
    set((state) => ({
      currentTodo: state.currentTodo,
      messages: [
        ...state.messages,
        {
          ...message,
          events: message.events || [],
        },
      ],
    }))
  },

  beginAssistantMessage: () => {
    set((state) => {
      const assistantMessageId = `agent-${Date.now()}`
      return {
        activeMessageId: assistantMessageId,
        error: null,
        messages: [
          ...state.messages,
          {
            id: assistantMessageId,
            type: 'agent',
            content: '',
            events: [],
            timestamp: Date.now(),
          },
        ],
      }
    })
  },

  addEvent: (event: SessionEvent) => {
    set((state) => {
      // A terminal/cancelled turn is immutable. In particular, do not let a
      // late nested worker event resurrect a new assistant message.
      if (!state.isStreaming) {
        return state
      }

      const normalizedEvent = {
        ...event,
        timestamp: event.timestamp || Date.now(),
      }

      const messages = [...state.messages]
      let activeMessageId = resolveStreamingAgentMessageId(
        messages,
        state.activeMessageId,
        state.isStreaming,
      )

      let targetIndex = resolveEventTargetIndex(
        messages,
        normalizedEvent,
        activeMessageId,
        state.isStreaming,
      )

      if (targetIndex === -1) {
        activeMessageId = `agent-${Date.now()}`
        messages.push({
          id: activeMessageId,
          type: 'agent',
          content: '',
          events: [],
          timestamp: Date.now(),
        })
        targetIndex = messages.length - 1
      } else {
        activeMessageId = messages[targetIndex]?.id ?? activeMessageId
      }

      if (targetIndex === -1) {
        return state
      }

      const targetMessage = messages[targetIndex]
      const currentEvents = [...(targetMessage.events || [])]

      // Deduplicate: Check if event with this ID already exists
      const eventAlreadyExists = currentEvents.some(
        (e) => e.id === normalizedEvent.id
      )
      if (eventAlreadyExists) {
        return state // Skip duplicate
      }

      if (
        normalizedEvent.type === 'thinking' &&
        !(normalizedEvent.content || '').trim()
      ) {
        return state
      }

      // Additional semantic dedupe for providers that resend the same status/reasoning
      // with a different event id during retries/reconnect windows.
      const lastEvent = currentEvents[currentEvents.length - 1]
      const sameAsPrevious =
        Boolean(lastEvent) &&
        lastEvent?.type === normalizedEvent.type &&
        lastEvent?.type !== 'thinking' &&
        normalizedEvent.type !== 'thinking' &&
        lastEvent?.type !== 'todo_update' &&
        lastEvent?.type !== 'todo_init' &&
        lastEvent?.type !== 'plan_permission_request' &&
        normalizedEvent.type !== 'deep_plan_stage_status' &&
        normalizedEvent.type !== 'deep_plan_artifact_saved' &&
        !normalizedEvent.metadata?.deep_plan_worker &&
        !normalizedEvent.metadata?.subagent_trace &&
        normalizeEventComparisonContent(lastEvent?.content) ===
          normalizeEventComparisonContent(normalizedEvent.content)

      if (sameAsPrevious) {
        return state
      }

      // Heartbeats: keep one running status per stage so the event list stays small.
      let eventsForMerge = currentEvents
      if (
        normalizedEvent.type === 'deep_plan_stage_status' &&
        normalizedEvent.metadata?.status === 'running' &&
        typeof normalizedEvent.metadata?.stage_id === 'string'
      ) {
        const stageId = normalizedEvent.metadata.stage_id
        eventsForMerge = currentEvents.filter((event) => {
          if (event.type !== 'deep_plan_stage_status') {
            return true
          }
          return !(
            event.metadata?.stage_id === stageId &&
            event.metadata?.status === 'running'
          )
        })
      }

      const mergeBase = eventsForMerge[eventsForMerge.length - 1]
      const nextEvents = shouldMergeEvent(mergeBase, normalizedEvent)
        ? [
            ...eventsForMerge.slice(0, -1),
            mergeEvent(mergeBase as SessionEvent, normalizedEvent),
          ]
        : [...eventsForMerge, normalizedEvent]

      const isNestedTraceEvent =
        Boolean(normalizedEvent.metadata?.subagent_trace) ||
        Boolean(normalizedEvent.metadata?.deep_plan_worker)

      messages[targetIndex] = {
        ...targetMessage,
        content: isNestedTraceEvent
          ? targetMessage.content
          : appendEventContent(targetMessage.content, normalizedEvent),
        events: nextEvents,
      }

      const todoState = extractTodoStateFromEvent(normalizedEvent, targetMessage.id)

      return {
        messages,
        activeMessageId,
        currentTodo: normalizedEvent.type === 'todo_clear' ? null : (todoState ?? state.currentTodo),
      }
    })
  },

  enrichToolResultFileChanges: (payload) => {
    set((state) => ({
      messages: state.messages.map((message) => {
        if (!message.events?.length) {
          return message
        }

        const events = message.events.map((event) => {
          if (event.type !== 'tool_result') {
            return event
          }

          const metadata = event.metadata ?? {}
          if (metadata.tool_call_id !== payload.tool_call_id) {
            return event
          }

          const existingData =
            metadata.data && typeof metadata.data === 'object' && !Array.isArray(metadata.data)
              ? (metadata.data as Record<string, unknown>)
              : {}
          const enrichedData = {
            ...existingData,
            file_changes: payload.file_changes,
            snapshot_id: payload.snapshot_id ?? existingData.snapshot_id,
            snapshot_session_id:
              payload.snapshot_session_id ?? existingData.snapshot_session_id,
          }

          const debug =
            metadata.debug && typeof metadata.debug === 'object' && !Array.isArray(metadata.debug)
              ? (metadata.debug as Record<string, unknown>)
              : {}
          const resultDebug =
            debug.result && typeof debug.result === 'object' && !Array.isArray(debug.result)
              ? (debug.result as Record<string, unknown>)
              : {}

          return {
            ...event,
            metadata: {
              ...metadata,
              data: enrichedData,
              debug: {
                ...debug,
                result: {
                  ...resultDebug,
                  data: enrichedData,
                },
              },
            },
          }
        })

        return { ...message, events }
      }),
    }))
  },

  setStreaming: (streaming: boolean) => {
    set({ isStreaming: streaming })
  },

  setError: (error: string | null) => {
    if (error) {
      set({ error, isStreaming: false, activeMessageId: null })
      return
    }

    set({ error: null })
  },

  finishStreaming: () => {
    set((state) => ({
      isStreaming: false,
      activeMessageId: null,
      messages: pruneTrailingGhostAgents(state.messages),
    }))
  },

  patchMessageId: (tempId: string, realId: string) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === tempId ? { ...m, id: realId, dbMessageId: realId } : m
      ),
      activeMessageId: state.activeMessageId === tempId ? realId : state.activeMessageId,
      planReadyForMessageId: state.planReadyForMessageId === tempId ? realId : state.planReadyForMessageId,
      deepPlanReadyForMessageId:
        state.deepPlanReadyForMessageId === tempId ? realId : state.deepPlanReadyForMessageId,
      currentTodo:
        state.currentTodo?.sourceMessageId === tempId
          ? { ...state.currentTodo, sourceMessageId: realId }
          : state.currentTodo,
    }))
  },

  patchMessageAttachments: (tempId: string, attachments: ChatAttachment[]) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === tempId ? { ...m, attachments } : m
      ),
    }))
  },

  truncateAfter: (messageId: string) => {
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.id === messageId || m.dbMessageId === messageId
      )
      if (idx === -1) return state
      const messages = state.messages.slice(0, idx)
      return {
        messages,
        isStreaming: false,
        activeMessageId: null,
        error: null,
        currentTodo: extractTodoStateFromMessages(messages),
      }
    })
  },

  rollbackOptimisticSend: (tempId: string, errorMessage: string) => {
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.id === tempId || m.dbMessageId === tempId
      )
      if (idx === -1) {
        return {
          ...state,
          isStreaming: false,
          activeMessageId: null,
          error: errorMessage,
        }
      }

      const target = state.messages[idx]
      target.attachments?.forEach((attachment) => {
        if (attachment.uri.startsWith('blob:')) {
          URL.revokeObjectURL(attachment.uri)
        }
      })

      const messages = state.messages.slice(0, idx)
      return {
        messages,
        isStreaming: false,
        activeMessageId: null,
        error: errorMessage,
        currentTodo: extractTodoStateFromMessages(messages),
        planReadyForMessageId:
          state.planReadyForMessageId === tempId ? null : state.planReadyForMessageId,
        deepPlanReadyForMessageId:
          state.deepPlanReadyForMessageId === tempId
            ? null
            : state.deepPlanReadyForMessageId,
      }
    })
  },

  clearMessages: () => {
    set((state) => ({
      messages: [],
      currentChatId: null,
      currentIdeContextEnabled: false,
      activeMessageId: null,
      error: null,
      isStreaming: false,
      chats: state.chats,
      planReadyForMessageId: null,
      deepPlanReadyForMessageId: null,
      currentTodo: null,
    }))
  },

  setPlanReadyForMessageId: (messageId: string | null) => {
    set({ planReadyForMessageId: messageId })
  },

  setDeepPlanReadyForMessageId: (messageId: string | null) => {
    set({ deepPlanReadyForMessageId: messageId })
  },

  clearTodo: () => {
    set({ currentTodo: null })
  },

  addContextNotice: (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) {
      return
    }

    set((state) => {
      const notice: ChatMessage = {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'system',
        content: trimmed,
        timestamp: Date.now(),
      }

      if (state.isStreaming && state.messages.length > 0) {
        const last = state.messages[state.messages.length - 1]
        if (last?.type === 'agent') {
          return {
            messages: [...state.messages.slice(0, -1), notice, last],
          }
        }
      }

      return {
        messages: [...state.messages, notice],
      }
    })
  },
}))
