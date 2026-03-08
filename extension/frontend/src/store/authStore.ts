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

let bridgeInitialized = false
let messageListenerRegistered = false

const handleExtensionMessage = (event: MessageEvent) => {
  const message = event.data

  switch (message?.type) {
    case 'auth-url':
      useAuthStore.setState({
        authUrl: message.payload.url,
        loading: false,
      })
      break

    case 'token': {
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

    case 'event':
      useChatStore.getState().addEvent(message.payload)
      break

    case 'chat-list':
      useChatStore
        .getState()
        .setChatList(message.payload.chats, message.payload.activeChatId)
      break

    case 'chat-opened':
      useChatStore.getState().replaceMessages(
        message.payload.chatId,
        message.payload.messages.map((message: {
          messageId: string
          role: string
          content: string
          createdAt: string
        }) => ({
          id: message.messageId,
          type: message.role === 'assistant' ? 'agent' : 'user',
          content: message.content,
          events: [],
          timestamp: Date.parse(message.createdAt) || Date.now(),
        }))
      )
      break

    case 'cancel-stream':
      useChatStore.getState().finishStreaming()
      break

    case 'error':
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
    useChatStore.getState().clearMessages()
    useChatStore.getState().setChatList([], null)
    set({
      isAuthenticated: false,
      token: null,
      user: null,
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

      if (!bridgeInitialized) {
        bridgeInitialized = true
        vscodeApi.postMessage({ type: 'request-auth-url' })
        vscodeApi.postMessage({ type: 'request-token' })
      }

      // Indicate we're ready
      set({ loading: false, error: null })
    } catch (err) {
      console.error('Failed to initialize extension bridge:', err)
      set({ error: 'Extension not available', loading: false })
    }
  },
}))
