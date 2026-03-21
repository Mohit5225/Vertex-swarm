import { create } from 'zustand'

export interface SessionEvent {
  id: string
  type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result'
  content?: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface ChatMessage {
  id: string
  type: 'user' | 'agent'
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

  return previous.type === 'thinking' && next.type === 'thinking'
}

const mergeEvent = (previous: SessionEvent, next: SessionEvent): SessionEvent => ({
  ...previous,
  content: `${previous.content || ''}${next.content || ''}`,
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
      messages: messages.map((message) => ({
        ...message,
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

  clearMessages: () => {
    set((state) => ({
      messages: [],
      currentChatId: null,
      currentIdeContextEnabled: false,
      activeMessageId: null,
      error: null,
      isStreaming: false,
      chats: state.chats,
    }))
  },
}))
