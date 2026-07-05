import { create } from 'zustand'

export interface SessionEvent {
  id: string
  type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result'
      | 'plan_permission_request' | 'plan_chunk' | 'plan_ready' | 'todo_init' | 'todo_update'
  content?: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  /** Real DB UUID — only set for user messages sent live (not loaded from history) */
  dbMessageId?: string
  type: 'user' | 'agent' | 'system'
  content: string
  events?: SessionEvent[]
  timestamp: number
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
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  finishStreaming: () => void
  clearMessages: () => void
  patchMessageId: (tempId: string, realId: string) => void
  truncateAfter: (messageId: string) => void
  setPlanReadyForMessageId: (messageId: string | null) => void
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
  if (!previous) {
    return false
  }

  if (previous.type === 'thinking' && next.type === 'thinking') {
    return true
  }

  if (previous.type === 'output' && next.type === 'output') {
    return true
  }

  // Also handle raw backend type 'token' which Stream client normalizes to 'output'
  if (previous.type === 'token' as any && next.type === 'token' as any) {
     return true;
  }

  return false
}

const normalizeEventComparisonContent = (content?: string) =>
  typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : ''

const mergeStreamingText = (previousContent: string, nextContent: string) => {
  if (!previousContent) {
    return nextContent
  }

  if (!nextContent) {
    return previousContent
  }

  if (previousContent === nextContent) {
    return previousContent
  }

  if (nextContent.startsWith(previousContent)) {
    return nextContent
  }

  if (previousContent.endsWith(nextContent)) {
    return previousContent
  }

  const maxOverlap = Math.min(previousContent.length, nextContent.length)

  for (let overlapLength = maxOverlap; overlapLength > 0; overlapLength -= 1) {
    if (
      previousContent.slice(-overlapLength) ===
      nextContent.slice(0, overlapLength)
    ) {
      return `${previousContent}${nextContent.slice(overlapLength)}`
    }
  }

  return `${previousContent}${nextContent}`
}

const mergeEvent = (previous: SessionEvent, next: SessionEvent): SessionEvent => ({
  ...previous,
  content: mergeStreamingText(previous.content || '', next.content || ''),
  timestamp: next.timestamp,
  metadata: {
    ...(previous.metadata || {}),
    ...(next.metadata || {}),
  },
})

export const useChatStore = create<ChatState>((set) => ({
  currentChatId: null,
  currentIdeContextEnabled: false,
  activeMessageId: null,
  chats: [],
  messages: [],
  isStreaming: false,
  error: null,
  planReadyForMessageId: null,

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
    set({
      currentChatId: chatId,
      currentIdeContextEnabled: ideContextEnabled,
      activeMessageId: null,
      isStreaming: false,
      error: null,
      messages: messages.map((message: any) => ({
        ...message,
        id: message.messageId || message.id,
        events: message.events || [],
      })),
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
      const normalizedEvent = {
        ...event,
        timestamp: event.timestamp || Date.now(),
      }

      let activeMessageId = state.activeMessageId
      const messages = [...state.messages]

      if (!activeMessageId) {
        activeMessageId = `agent-${Date.now()}`
        messages.push({
          id: activeMessageId,
          type: 'agent',
          content: '',
          events: [],
          timestamp: Date.now(),
        })
      }

      const targetIndex = messages.findIndex(
        (message) => message.id === activeMessageId
      )

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

      // Additional semantic dedupe for providers that resend the same status/reasoning
      // with a different event id during retries/reconnect windows.
      const lastEvent = currentEvents[currentEvents.length - 1]
      const sameAsPrevious =
        Boolean(lastEvent) &&
        lastEvent?.type === normalizedEvent.type &&
        lastEvent?.type !== 'todo_update' &&
        lastEvent?.type !== 'todo_init' &&
        lastEvent?.type !== 'plan_permission_request' &&
        normalizeEventComparisonContent(lastEvent?.content) ===
          normalizeEventComparisonContent(normalizedEvent.content)

      if (sameAsPrevious) {
        return state
      }

      const previousEvent = currentEvents[currentEvents.length - 1]
      const nextEvents = shouldMergeEvent(previousEvent, normalizedEvent)
        ? [
            ...currentEvents.slice(0, -1),
            mergeEvent(previousEvent as SessionEvent, normalizedEvent),
          ]
        : [...currentEvents, normalizedEvent]

      messages[targetIndex] = {
        ...targetMessage,
        content: appendEventContent(targetMessage.content, normalizedEvent),
        events: nextEvents,
      }

      return {
        messages,
        activeMessageId,
      }
    })
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
    set({ isStreaming: false, activeMessageId: null })
  },

  patchMessageId: (tempId: string, realId: string) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === tempId ? { ...m, id: realId, dbMessageId: realId } : m
      ),
      activeMessageId: state.activeMessageId === tempId ? realId : state.activeMessageId,
      planReadyForMessageId: state.planReadyForMessageId === tempId ? realId : state.planReadyForMessageId,
    }))
  },

  truncateAfter: (messageId: string) => {
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.id === messageId || m.dbMessageId === messageId
      )
      if (idx === -1) return state
      return {
        messages: state.messages.slice(0, idx),
        isStreaming: false,
        activeMessageId: null,
        error: null,
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
    }))
  },

  setPlanReadyForMessageId: (messageId: string | null) => {
    set({ planReadyForMessageId: messageId })
  },
}))
