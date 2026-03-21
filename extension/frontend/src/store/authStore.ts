import { create } from 'zustand'
import { getVsCodeApi } from '../lib/vscode'
import { useChatStore } from './chatStore'

interface User {
  id: string
  email: string
  provider: string
}

interface AuthState {
  isAuthenticated: boolean
  token: string | null
  user: User | null
  authUrl: string | null
  loading: boolean
  error: string | null

  // Actions
  setToken: (token: string) => void
  setUser: (user: User) => void
  setAuthUrl: (url: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  logout: () => void
  initializeExtensionBridge: () => void
}

let messageListenerRegistered = false
let restoreRetryTimeout: number | null = null
let restoreTimeout: number | null = null

const clearRestoreTimers = () => {
  if (restoreRetryTimeout !== null) {
    window.clearTimeout(restoreRetryTimeout)
    restoreRetryTimeout = null
  }

  if (restoreTimeout !== null) {
    window.clearTimeout(restoreTimeout)
    restoreTimeout = null
  }
}

const requestBridgeState = () => {
  const vscodeApi = getVsCodeApi()
  if (!vscodeApi) {
    throw new Error('VS Code API unavailable')
  }

  vscodeApi.postMessage({ type: 'request-auth-url' })
  vscodeApi.postMessage({ type: 'request-token' })
}

const startRestoreWatchdog = () => {
  clearRestoreTimers()

  restoreRetryTimeout = window.setTimeout(() => {
    const state = useAuthStore.getState()
    if (!state.loading) {
      return
    }

    try {
      requestBridgeState()
    } catch (error) {
      console.error('Failed to retry extension bridge handshake:', error)
    }
  }, 900)

  restoreTimeout = window.setTimeout(() => {
    const state = useAuthStore.getState()
    if (!state.loading) {
      return
    }

    useAuthStore.setState({
      loading: false,
      error: 'Extension session restore timed out. Reload the window or sign in again.',
    })
  }, 4000)
}

const handleExtensionMessage = (event: MessageEvent) => {
  const message = event.data

  switch (message?.type) {
    case 'auth-url':
      useAuthStore.setState({
        authUrl: message.payload.url,
      })
      break

    case 'token': {
      clearRestoreTimers()
      const { token, user } = message.payload
      useAuthStore.setState({
        token,
        user,
        isAuthenticated: true,
        loading: false,
        authUrl: null,
        error: null,
      })
      break
    }

    case 'logged-out':
      clearRestoreTimers()
      useChatStore.getState().clearMessages()
      useChatStore.getState().setChatList([], null)
      useAuthStore.setState({
        isAuthenticated: false,
        token: null,
        user: null,
        authUrl: message.payload?.authUrl || useAuthStore.getState().authUrl,
        loading: false,
        error: message.payload?.reason || null,
      })
      break

    case 'event':
      useChatStore.getState().addEvent(message.payload)
      break

    case 'chat-list': {
      const normalizedChats = message.payload.chats.map((chat: {
        chatId: string
        title: string | null
        createdAt: string
        updatedAt: string
        ideContextEnabled?: boolean
      }) => ({
        ...chat,
        ideContextEnabled: Boolean(chat.ideContextEnabled),
      }))
      useChatStore
        .getState()
        .setChatList(normalizedChats, message.payload.activeChatId)
      break
    }

    case 'chat-opened':
      useChatStore.getState().replaceMessages(
        message.payload.chatId,
        message.payload.messages.map((message: {
          messageId: string
          role: string
          content: string
          createdAt: string
          events?: Array<{
            id: string
            type: 'thinking' | 'code' | 'output' | 'error' | 'status' | 'tool_call' | 'tool_result'
            content: string
            timestamp: number
            metadata?: Record<string, unknown>
          }>
        }) => ({
          id: message.messageId,
          type: message.role === 'assistant' ? 'agent' : 'user',
          content: message.content,
          events: (Array.isArray(message.events) ? message.events : []).map((event, index) => ({
            id:
              typeof event.id === 'string' && event.id
                ? event.id
                : `${message.messageId}-evt-${index}`,
            type: event.type,
            content: event.content,
            timestamp:
              typeof event.timestamp === 'number'
                ? event.timestamp
                : Date.parse(message.createdAt) || Date.now(),
            metadata: event.metadata,
          })),
          timestamp: Date.parse(message.createdAt) || Date.now(),
        })),
        Boolean(message.payload.ideContextEnabled)
      )
      break

    case 'cancel-stream':
      useChatStore.getState().finishStreaming()
      break

    case 'error':
      clearRestoreTimers()
      if (
        useAuthStore.getState().isAuthenticated ||
        useChatStore.getState().isStreaming
      ) {
        useChatStore.getState().setError(message.payload)
      } else {
        useAuthStore.setState({
          error: message.payload,
          loading: false,
        })
      }
      break
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  token: null,
  user: null,
  authUrl: null,
  loading: true,
  error: null,

  setToken: (token: string) => {
    set({ token, isAuthenticated: true, loading: false })
  },

  setUser: (user: User) => {
    set({ user, isAuthenticated: true, loading: false })
  },

  setAuthUrl: (url: string) => {
    set({ authUrl: url, loading: false })
  },

  setLoading: (loading: boolean) => {
    set({ loading })
  },

  setError: (error: string | null) => {
    set({ error })
  },

  logout: () => {
    clearRestoreTimers()
    useChatStore.getState().clearMessages()
    useChatStore.getState().setChatList([], null)
    set({
      isAuthenticated: false,
      token: null,
      user: null,
      error: null,
      loading: false,
    })
  },

  initializeExtensionBridge: () => {
    try {
      const vscodeApi = getVsCodeApi()

      if (!vscodeApi) {
        throw new Error('VS Code API unavailable')
      }

      if (!messageListenerRegistered) {
        window.addEventListener('message', handleExtensionMessage)
        messageListenerRegistered = true
      }

      set({ loading: true, error: null })

      requestBridgeState()
      startRestoreWatchdog()
    } catch (err) {
      clearRestoreTimers()
      console.error('Failed to initialize extension bridge:', err)
      set({ error: 'Extension not available', loading: false })
    }
  },
}))
