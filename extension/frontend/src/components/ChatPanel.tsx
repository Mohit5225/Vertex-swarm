import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useChatStore } from '../store/chatStore'
import MessageRenderer from './MessageRenderer'
import InputArea from './InputArea'
import ConfirmDialog from './ConfirmDialog'
import { getVsCodeApi } from '../lib/vscode'
import { ArrowLeft, History, LogOut, RefreshCw, Settings } from 'lucide-react'
import { describeStreamState } from '../lib/trace'

const starterPrompts = [
  {
    label: 'Review auth',
    prompt: 'Review the auth lifecycle and call out the biggest risks.',
  },
  {
    label: 'Improve UX',
    prompt: 'Inspect the workspace and propose a better agent UX.',
  },
  {
    label: 'Trace frontend',
    prompt: 'Trace the frontend state flow and find the bugs.',
  },
]

const formatRelativeTime = (isoTimestamp: string) => {
  const timestamp = Date.parse(isoTimestamp)
  if (!Number.isFinite(timestamp)) {
    return 'Unknown activity'
  }

  const diffMs = Date.now() - timestamp
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000))

  if (diffMinutes < 60) {
    return `${diffMinutes} min${diffMinutes === 1 ? '' : 's'} ago`
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`
  }

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
}

const ChatPanel: React.FC = () => {
  const { user, logout } = useAuthStore()
  const { clearMessages, messages, isStreaming, error, chats, currentChatId } =
    useChatStore()
  const {
    currentIdeContextEnabled,
    setCurrentIdeContextEnabled,
  } = useChatStore((state) => ({
    currentIdeContextEnabled: state.currentIdeContextEnabled,
    setCurrentIdeContextEnabled: state.setCurrentIdeContextEnabled,
  }))
  const [queuedPrompt, setQueuedPrompt] = useState('')
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showSessionPanel, setShowSessionPanel] = useState(false)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sessionPanelRef = useRef<HTMLDivElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)

  const chatTitle = useMemo(() => {
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.type === 'user')

    if (!latestUserMessage) {
      return 'Chat'
    }

    return latestUserMessage.content.length > 68
      ? `${latestUserMessage.content.slice(0, 68)}...`
      : latestUserMessage.content
  }, [messages])

  const streamStateDescription = useMemo(
    () => describeStreamState(messages, isStreaming),
    [messages, isStreaming]
  )

  const sessionStateLabel = isStreaming
    ? 'Running'
    : messages.length > 0
      ? 'Ready'
      : 'Idle'

  useEffect(() => {
    // Only smooth scroll if there are messages and we're not streaming super fast, 
    // or just let native scroll happen. But auto-scroll is crucial for chat UX.
    messagesEndRef.current?.scrollIntoView({
      behavior: isStreaming ? 'auto' : 'smooth', // 'auto' removes the laggy smooth-scroll animation during high-frequency tokens
    })
  }, [messages, isStreaming])

  useEffect(() => {
    getVsCodeApi()?.postMessage({ type: 'load-chat-list' })
  }, [])

  useEffect(() => {
    if (!showSessionPanel) {
      if (!showHistoryPanel) {
        return
      }
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null

      if (
        sessionPanelRef.current?.contains(target) ||
        historyPanelRef.current?.contains(target) ||
        target?.closest('[data-session-toggle="true"]') ||
        target?.closest('[data-history-toggle="true"]')
      ) {
        return
      }

      setShowSessionPanel(false)
      setShowHistoryPanel(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSessionPanel(false)
        setShowHistoryPanel(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [showHistoryPanel, showSessionPanel])

  const handleConfirmLogout = () => {
    setShowLogoutConfirm(false)
    getVsCodeApi()?.postMessage({ type: 'logout' })
    logout()
  }

  const handleStartFresh = () => {
    getVsCodeApi()?.postMessage({ type: 'reset-chat' })
    clearMessages()
    setCurrentIdeContextEnabled(false)
    setShowSessionPanel(false)
    setShowHistoryPanel(false)
  }

  const handleToggleIdeContext = (enabled: boolean) => {
    setCurrentIdeContextEnabled(enabled)

    if (!currentChatId) {
      return
    }

    getVsCodeApi()?.postMessage({
      type: 'set-ide-context',
      payload: {
        chatId: currentChatId,
        enabled,
      },
    })
  }

  const handleOpenChat = (chatId: string) => {
    if (isStreaming) {
      return
    }

    getVsCodeApi()?.postMessage({
      type: 'open-chat',
      payload: { chatId },
    })
    setShowHistoryPanel(false)
    setShowSessionPanel(false)
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative border-b border-white/6 px-3 py-3 md:px-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={handleStartFresh}
                  className="icon-btn"
                  title="Start a fresh task"
                  disabled={isStreaming}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isStreaming
                        ? 'bg-[#48d2b4]'
                        : messages.length > 0
                          ? 'bg-[#8bd7ff]'
                          : 'bg-[#7f91b4]'
                    }`}
                  />
                  <h2
                    className="truncate text-sm font-medium text-[#f3f6ff]"
                    title={chatTitle}
                  >
                    {chatTitle}
                  </h2>
                </div>
                <p className="mt-1 hidden text-[11px] leading-5 text-[#7d89a6] min-[460px]:block">
                  {streamStateDescription}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#8f9cb7]">
                  IDE context: {currentIdeContextEnabled ? 'On' : 'Off'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowHistoryPanel((value) => !value)
                  setShowSessionPanel(false)
                }}
                className="icon-btn"
                title="Recent chats"
                data-history-toggle="true"
              >
                <History className="h-4 w-4" />
              </button>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={handleStartFresh}
                  className="hidden min-[420px]:inline-flex icon-btn"
                  title="New task"
                  disabled={isStreaming}
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSessionPanel((value) => !value)
                  setShowHistoryPanel(false)
                }}
                className="icon-btn"
                title="Session"
                data-session-toggle="true"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(true)}
                className="icon-btn"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>

          {showHistoryPanel && (
            <div
              ref={historyPanelRef}
              className="absolute left-3 top-[calc(100%+0.5rem)] z-20 w-[min(20rem,calc(100vw-1.5rem))] rounded-[20px] border border-white/8 bg-[#0b1221]/96 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl md:left-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#7d89a6]">
                  Recent chats
                </p>
                <span className="text-[11px] text-[#8f9cb7]">
                  {chats.length}
                </span>
              </div>

              {chats.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-[#95a2bd]">
                  No saved chats yet.
                </p>
              ) : (
                <div className="mt-3 max-h-[22rem] space-y-2 overflow-y-auto pr-1">
                  {chats.map((chat) => {
                    const isActiveChat = currentChatId === chat.chatId
                    const chatTitle =
                      chat.title?.trim() || 'Untitled chat'

                    return (
                      <button
                        key={chat.chatId}
                        type="button"
                        onClick={() => handleOpenChat(chat.chatId)}
                        disabled={isStreaming}
                        className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${
                          isActiveChat
                            ? 'border-[#8bd7ff]/30 bg-[#8bd7ff]/10'
                            : 'border-white/6 bg-white/[0.03] hover:bg-white/[0.06]'
                        } ${
                          isStreaming ? 'cursor-not-allowed opacity-60' : ''
                        }`}
                      >
                        <div className="truncate text-sm font-medium text-[#f3f6ff]">
                          {chatTitle}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-[#8f9cb7]">
                          <span>{formatRelativeTime(chat.updatedAt)}</span>
                          <span className="mx-2 text-white/15">|</span>
                          <span>{new Date(chat.updatedAt).toLocaleString()}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {showSessionPanel && (
            <div
              ref={sessionPanelRef}
              className="absolute right-3 top-[calc(100%+0.5rem)] z-20 w-[min(17rem,calc(100vw-1.5rem))] rounded-[20px] border border-white/8 bg-[#0b1221]/96 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl md:right-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#7d89a6]">
                  Session
                </p>
                <span className="text-[11px] text-[#8f9cb7]">
                  {sessionStateLabel}
                </span>
              </div>
              <p className="mt-3 truncate text-sm font-medium text-[#f3f6ff]">
                {user?.email || 'Signed in locally'}
              </p>
              <div className="mt-3 space-y-1 text-[12px] leading-5 text-[#95a2bd]">
                <p>Stored locally inside the extension.</p>
                <p>Re-auth is required when the backend JWT expires.</p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={handleStartFresh}
                    disabled={isStreaming}
                    className="ghost-btn !rounded-xl !px-3 !py-2"
                  >
                    New task
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowSessionPanel(false)
                    setShowLogoutConfirm(true)
                  }}
                  className="ghost-btn !rounded-xl !px-3 !py-2"
                >
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-3 pb-3 pt-4 md:px-4">
            {messages.length === 0 ? (
              <div className="mx-auto flex h-full w-full max-w-xl flex-col justify-end pb-6">
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#7082a4]">
                  Suggested starts
                </p>
                <p className="mt-2 max-w-[30rem] text-sm leading-6 text-[#8f9cb7]">
                  Start with a task, file path, bug, or review request.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {starterPrompts.map((prompt) => (
                    <button
                      key={prompt.label}
                      type="button"
                      onClick={() => setQueuedPrompt(prompt.prompt)}
                      className="rounded-full bg-white/[0.04] px-3 py-1.5 text-[13px] text-[#dbe5f8] transition hover:bg-white/[0.08]"
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2 pb-2">
                {messages.map((message) => (
                  <MessageRenderer key={message.id} message={message} />
                ))}

                {isStreaming && (
                  <div className="flex items-center gap-2 px-1 py-2 text-sm text-[#95a2bd] animate-fade-up">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#48d2b4] animate-pulse" />
                    <span>{streamStateDescription}</span>
                  </div>
                )}

                {error && (
                  <div className="border-l-2 border-[#f27d75] pl-3 text-sm leading-6 text-[#ffbeb8]">
                    {error}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="border-t border-white/6 px-3 pb-4 pt-3 md:px-4">
            <InputArea
              disabled={isStreaming}
              queuedPrompt={queuedPrompt}
              ideContextEnabled={currentIdeContextEnabled}
              onToggleIdeContext={handleToggleIdeContext}
              onQueuedPromptApplied={() => setQueuedPrompt('')}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showLogoutConfirm}
        title="Sign out of Vertex Swarm?"
        description="This clears the local extension session and returns the sidebar to the login screen."
        confirmLabel="Sign out"
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={handleConfirmLogout}
      />
    </>
  )
}

export default ChatPanel
