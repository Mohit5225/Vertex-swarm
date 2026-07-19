import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useConfigStore } from '../store/configStore'
import { useChatStore, type ChatMessage } from '../store/chatStore'
import MessageRenderer from './MessageRenderer'
import InputArea from './InputArea'
import ConfirmDialog from './ConfirmDialog'
import { getVsCodeApi } from '../lib/vscode'
import { ChevronDown, Undo2 } from 'lucide-react'
import TodoWidget from './TodoWidget'

import { collectMessageFileChanges } from '../lib/messageDiffs'
import {
  canUndoChange,
  fileChangeDetail,
  shouldShowLineStats,
  summarizeFileChanges,
} from '../lib/fileChangeStats'
import type { FileChange } from '../lib/fileChangeTypes'
import { buildReviewPayload, canReviewChange } from '../lib/reviewPayload'

const starterPrompts = [
  {
    label: 'Scaffold project',
    prompt: 'Create a new project structure with a basic Express server and React frontend.',
  },
  {
    label: 'Find & fix bugs',
    prompt: 'Scan the currently open file for any bugs or anti-patterns and propose fixes.',
  },
  {
    label: 'Explain architecture',
    prompt: 'Analyze the workspace and explain how the core components interact.',
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

interface LiveChange extends FileChange {}

const LiveFileEditBar: React.FC<{ messages: ChatMessage[]; isStreaming: boolean }> = ({
  messages,
  isStreaming,
}) => {
  const [isExpanded, setIsExpanded] = useState(false)
  if (!isStreaming || messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage.type !== 'agent' || !lastMessage.events?.length) return null

  const lastAgent = lastMessage
  const { changes: mergedChanges, snapshotId: topSnapshotId, sessionId: topSessionId, messageId: topMessageId } =
    collectMessageFileChanges(lastAgent.events || [], lastAgent.content)

  const fileCount = mergedChanges.length
  const totalAdds = mergedChanges.reduce((s, d) => s + d.additions, 0)
  const totalDels = mergedChanges.reduce((s, d) => s + d.deletions, 0)
  const hasUndoableChanges = mergedChanges.some(canUndoChange)

  if (fileCount === 0) return null

  const handleUndoAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!topSnapshotId) return
    getVsCodeApi()?.postMessage({
      type: 'undo-snapshot',
      payload: { snapshotId: topSnapshotId, sessionId: topSessionId, messageId: topMessageId }
    })
  }

  const handleReviewFile = (e: React.MouseEvent, change: LiveChange) => {
    e.stopPropagation()
    const payload = buildReviewPayload(change)
    if (!payload) return
    getVsCodeApi()?.postMessage({
      type: 'review-snapshot',
      payload,
    })
  }

  const handleUndoFile = (e: React.MouseEvent, change: LiveChange) => {
    e.stopPropagation()
    if (!topSnapshotId || !change.undo?.originalUri || !canUndoChange(change)) return
    getVsCodeApi()?.postMessage({
      type: 'undo-snapshot-file',
      payload: {
        snapshotId: topSnapshotId,
        sessionId: topSessionId,
        messageId: topMessageId,
        originalUri: change.undo.originalUri,
      }
    })
  }

  return (
    <div className="flex flex-col border-t border-white/[0.05] bg-[#0a0d14]/80">
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-[#c6d2e7]">
            {summarizeFileChanges(mergedChanges)}
          </span>
          {(totalAdds > 0 || totalDels > 0) && (
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[#2dd4bf]">+{totalAdds}</span>
              <span className="text-[#f43f5e]">-{totalDels}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {topSnapshotId && hasUndoableChanges && (
            <button
              onClick={handleUndoAll}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-[#c6d2e7] hover:bg-white/[0.1] transition-colors"
              title="Undo all file edits in this turn"
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          )}
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[#6f81a1] transition ${isExpanded ? 'rotate-180' : ''
              }`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>

      {isExpanded && mergedChanges.length > 0 && (
        <div className="px-2 pb-2">
          {mergedChanges.map((change) => (
            <div
              key={change.changeId}
              className="flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors group"
            >
              <span
                className="text-[11px] text-[#91a0bb] font-mono truncate max-w-[200px] group-hover:text-[#c6d2e7] transition-colors cursor-pointer"
                onClick={(e) => handleReviewFile(e, change)}
                title={change.path}
              >
                {change.path}
              </span>
              <div className="flex items-center gap-2 opacity-70 group-hover:opacity-100 transition-opacity">
                {fileChangeDetail(change) ? (
                  <span className="text-[10px] font-medium text-[#9eb1ff]">{fileChangeDetail(change)}</span>
                ) : null}
                {shouldShowLineStats(change) ? (
                  <>
                    <span className="text-[10px] font-mono text-[#2dd4bf]">+{change.additions}</span>
                    <span className="text-[10px] font-mono text-[#f43f5e]">-{change.deletions}</span>
                  </>
                ) : null}
                {topSnapshotId && canUndoChange(change) && (
                  <button
                    onClick={(e) => handleUndoFile(e, change)}
                    className="flex items-center gap-0.5 text-[10px] font-medium text-[#c6d2e7] hover:text-white transition-colors ml-0.5"
                    title={`Undo changes to ${change.path}`}
                  >
                    <Undo2 className="h-2.5 w-2.5" />
                    Undo
                  </button>
                )}
                {canReviewChange(change) && (
                  <button
                    onClick={(e) => handleReviewFile(e, change)}
                    className="text-[10px] font-medium text-[#5e6ad2] hover:text-[#9eb1ff] transition-colors ml-0.5"
                  >
                    Review
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ChatPanel: React.FC = () => {
  const { config, logout } = useConfigStore()
  const { clearMessages, messages, isStreaming, error, chats, currentChatId, currentTodo, clearTodo } =
    useChatStore()
  const {
    currentIdeContextEnabled,
    setCurrentIdeContextEnabled,
  } = useChatStore((state) => ({
    currentIdeContextEnabled: state.currentIdeContextEnabled,
    setCurrentIdeContextEnabled: state.setCurrentIdeContextEnabled,
  }))
  const [queuedPrompt, setQueuedPrompt] = useState('')
  const [queuedEdit, setQueuedEdit] = useState('')
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showSessionPanel, setShowSessionPanel] = useState(false)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [snapshotRetentionDays, setSnapshotRetentionDays] = useState(7)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sessionPanelRef = useRef<HTMLDivElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)

  const sessionStateLabel = isStreaming
    ? 'Running'
    : messages.length > 0
      ? 'Ready'
      : 'Idle'

  const showTodoBar = useMemo(() => {
    if (!currentTodo?.items.length) {
      return false
    }

    if (isStreaming) {
      return true
    }

    return Date.now() - currentTodo.lastUpdatedAt < 1000 * 60 * 60
  }, [currentTodo, isStreaming])

  useEffect(() => {
    // Only smooth scroll if there are messages and we're not streaming super fast, 
    // or just let native scroll happen. But auto-scroll is crucial for chat UX.
    messagesEndRef.current?.scrollIntoView({
      behavior: isStreaming ? 'auto' : 'smooth', // 'auto' removes the laggy smooth-scroll animation during high-frequency tokens
    })
  }, [messages, isStreaming])

  useEffect(() => {
    getVsCodeApi()?.postMessage({ type: 'load-chat-list' })

    const handleQueuedEdit = (e: Event) => {
      const customEvent = e as CustomEvent<{ text: string }>
      setQueuedEdit(customEvent.detail.text)
    }
    window.addEventListener('vertex-queued-edit', handleQueuedEdit)
    return () => {
      window.removeEventListener('vertex-queued-edit', handleQueuedEdit)
    }
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

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'toggle-history':
          setShowHistoryPanel((prev) => !prev);
          setShowSessionPanel(false);
          break;
        case 'toggle-session':
          setShowSessionPanel((prev) => !prev);
          setShowHistoryPanel(false);
          break;
        case 'logout-confirm':
          setShowLogoutConfirm(true);
          break;
        case 'config-state':
          if (message.payload?.snapshotRetentionDays !== undefined) {
            setSnapshotRetentionDays(message.payload.snapshotRetentionDays);
          }
          break;
      }
    };
    window.addEventListener('message', handleMessage);

    // Request initial config
    getVsCodeApi()?.postMessage({ type: 'get-config' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleConfirmConfigReset = () => {
    setShowLogoutConfirm(false)
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
      <div className="flex h-full min-h-0 flex-col overflow-hidden relative">

        {showHistoryPanel && (
          <div
            ref={historyPanelRef}
            className="absolute right-2 top-2 z-20 w-[min(20rem,calc(100vw-1rem))] rounded-[22px] border border-white/10 bg-[#0c1220]/96 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl"
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
                      className={`w-full rounded-[16px] border px-3 py-3 text-left transition ${isActiveChat
                        ? 'border-[#8bd7ff]/30 bg-[#8bd7ff]/10'
                        : 'border-white/6 bg-white/[0.03] hover:bg-white/[0.06]'
                        } ${isStreaming ? 'cursor-not-allowed opacity-60' : ''
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
            className="absolute right-2 top-2 z-20 w-[min(17rem,calc(100vw-1rem))] rounded-[22px] border border-white/10 bg-[#0c1220]/96 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[13px] font-medium leading-none text-white">
                Provider Config
              </span>
              <span className="text-[11px] text-[#8f9cb7]">
                {sessionStateLabel}
              </span>
            </div>
            <p className="mt-3 truncate text-sm font-medium text-[#f3f6ff]">
              {config?.llmBaseUrl ? new URL(config.llmBaseUrl).hostname : 'Local Provider'}
            </p>
            <div className="mt-3 space-y-1 text-[12px] leading-5 text-[#95a2bd]">
              <p>Model: {config?.llmModel || 'Default Model'}</p>
              <p>Keys are stored securely in your OS keychain.</p>
            </div>

            <div className="mt-4 border-t border-white/10 pt-3">
              <label className="text-[11px] font-medium text-[#7d89a6] block mb-1">
                Snapshot Retention (Days)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="1"
                  max="7"
                  value={snapshotRetentionDays}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setSnapshotRetentionDays(val);
                    getVsCodeApi()?.postMessage({
                      type: 'set-config',
                      payload: { snapshotRetentionDays: val }
                    });
                  }}
                  className="flex-1 h-1.5 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#8bd7ff] cursor-pointer"
                />
                <span className="text-[12px] font-mono text-[#8bd7ff] min-w-[1.5rem] text-right">
                  {snapshotRetentionDays}
                </span>
              </div>
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
                Settings
              </button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto overflow-x-hidden">
              {messages.length === 0 ? (
                <div className="mx-auto flex h-full w-full max-w-[42rem] flex-col justify-end px-3 pb-8 pt-8">
                  <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#7082a4]">
                    Suggested starts
                  </p>
                  <p className="mt-2 max-w-[30rem] text-sm leading-7 text-[#8f9cb7]">
                    Start with a task, bug, review request, or file path and
                    the sidebar will stay clean while the agent works through it.
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
                <div className="space-y-2 pb-4 pl-4 pr-2 pt-3 sm:pl-5 sm:pr-3">
                  {messages.map((message) => (
                    <MessageRenderer key={message.id} message={message} />
                  ))}

                  {error && (
                    <div className="border-l-2 border-[#f27d75] pl-3 text-sm leading-6 text-[#ffbeb8]">
                      {error}
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Live file edit bar — shows changes from the active or most recent agent turn.
               Disappears when the user sends a new message. */}
          {showTodoBar && currentTodo && (
            <TodoWidget items={currentTodo.items} isStreaming={isStreaming} onClose={clearTodo} />
          )}
          <LiveFileEditBar messages={messages} isStreaming={isStreaming} />

          <div className="border-t chat-divider bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] px-3 pb-3 pt-2 sm:px-4">
            <InputArea
              disabled={isStreaming}
              queuedPrompt={queuedPrompt}
              queuedEdit={queuedEdit}
              ideContextEnabled={currentIdeContextEnabled}
              onToggleIdeContext={handleToggleIdeContext}
              onQueuedPromptApplied={() => setQueuedPrompt('')}
              onQueuedEditApplied={() => setQueuedEdit('')}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showLogoutConfirm}
        title="Reconfigure Provider?"
        description="This will return you to the settings screen. You will need to re-enter your configuration if you proceed."
        confirmLabel="Continue"
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={handleConfirmConfigReset}
      />
    </>
  )
}

export default ChatPanel
