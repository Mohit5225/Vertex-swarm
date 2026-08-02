import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useConfigStore } from '../store/configStore'
import { useChatStore, type ChatMessage } from '../store/chatStore'
import MessageRenderer from './MessageRenderer'
import InputArea from './InputArea'
import ConfirmDialog from './ConfirmDialog'
import SessionPanel from './SessionPanel'
import { getVsCodeApi } from '../lib/vscode'
import { ChevronDown, Undo2 } from 'lucide-react'
import TodoWidget from './TodoWidget'
import AgentTracePanel from './AgentTracePanel'
import { useAgentPanelStore } from '../store/agentPanelStore'
import { useContextPolicyStore } from '../store/contextPolicyStore'
import type { ChatAttachment, QueuedEditPayload } from '../lib/attachments'
import type { ContextPolicyData } from '../lib/contextPolicyTypes'

import { collectMessageFileChanges } from '../lib/messageDiffs'
import {
  canUndoChange,
  fileChangeDetail,
  summarizeFileChanges,
} from '../lib/fileChangeStats'
import type { FileChange } from '../lib/fileChangeTypes'
import { buildReviewPayload, canReviewChange } from '../lib/reviewPayload'
import { ChangeStatBadges } from './ChangeStatBadges'

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
    <div className="flex flex-col border-t border-[var(--vs-border-soft)] bg-[var(--vs-ink)]/80">
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-[var(--vs-text-secondary)]">
            {summarizeFileChanges(mergedChanges)}
          </span>
          {(totalAdds > 0 || totalDels > 0) && (
            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[var(--vs-success)]">+{totalAdds}</span>
              <span className="text-[var(--vs-danger)]">-{totalDels}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {topSnapshotId && hasUndoableChanges && (
            <button
              onClick={handleUndoAll}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--vs-text-secondary)] hover:bg-[var(--vs-accent-muted)] transition-colors"
              title="Undo all file edits in this turn"
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          )}
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--vs-text-tertiary)] transition ${isExpanded ? 'rotate-180' : ''
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
                className="text-[11px] text-[var(--vs-text-tertiary)] font-mono truncate max-w-[200px] group-hover:text-[var(--vs-text-primary)] transition-colors cursor-pointer"
                onClick={(e) => handleReviewFile(e, change)}
                title={change.path}
              >
                {change.path}
              </span>
              <div className="flex items-center gap-2 opacity-70 group-hover:opacity-100 transition-opacity">
                {fileChangeDetail(change) ? (
                  <span className="text-[10px] font-medium text-[var(--vs-accent)]">{fileChangeDetail(change)}</span>
                ) : null}
                <ChangeStatBadges change={change} />
                {topSnapshotId && canUndoChange(change) && (
                  <button
                    onClick={(e) => handleUndoFile(e, change)}
                    className="flex items-center gap-0.5 text-[10px] font-medium text-[var(--vs-text-secondary)] hover:text-[var(--vs-text-primary)] transition-colors ml-0.5"
                    title={`Undo changes to ${change.path}`}
                  >
                    <Undo2 className="h-2.5 w-2.5" />
                    Undo
                  </button>
                )}
                {canReviewChange(change) && (
                  <button
                    onClick={(e) => handleReviewFile(e, change)}
                    className="text-[10px] font-medium text-[var(--vs-accent)] hover:text-[var(--vs-accent-bright)] transition-colors ml-0.5"
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
  const { config, logout, openProviderSettings, user } = useConfigStore()
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
  const [queuedEdit, setQueuedEdit] = useState<QueuedEditPayload | null>(null)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showSessionPanel, setShowSessionPanel] = useState(false)
  const [showHistoryPanel, setShowHistoryPanel] = useState(false)
  const [snapshotRetentionDays, setSnapshotRetentionDays] = useState(7)
  const contextPolicy = useContextPolicyStore((state) => state.policy)
  const setContextPolicy = useContextPolicyStore((state) => state.setPolicy)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const wasStreamingRef = useRef(false)
  const sessionPanelRef = useRef<HTMLDivElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)
  const agentPanelOpen = useAgentPanelStore((s) => s.open)

  const SCROLL_STICK_THRESHOLD_PX = 96

  const isNearBottom = (container: HTMLElement) => {
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    return distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX
  }

  const handleMessagesScroll = () => {
    const container = messagesScrollRef.current
    if (!container) {
      return
    }

    stickToBottomRef.current = isNearBottom(container)
  }

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
    if (isStreaming && !wasStreamingRef.current) {
      stickToBottomRef.current = true
    }

    wasStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return
    }

    const container = messagesScrollRef.current
    if (!container) {
      return
    }

    if (isStreaming) {
      container.scrollTop = container.scrollHeight
      return
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    })
  }, [messages, isStreaming])

  useEffect(() => {
    getVsCodeApi()?.postMessage({ type: 'load-chat-list' })

    const handleQueuedEdit = (e: Event) => {
      const customEvent = e as CustomEvent<QueuedEditPayload>
      setQueuedEdit({
        text: customEvent.detail.text ?? '',
        attachments: customEvent.detail.attachments ?? [],
      })
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
        case 'context-policy-state':
          if (message.payload) {
            setContextPolicy(message.payload as ContextPolicyData);
          }
          break;
      }
    };
    window.addEventListener('message', handleMessage);

    // Request initial config
    getVsCodeApi()?.postMessage({ type: 'get-config' });
    getVsCodeApi()?.postMessage({ type: 'get-context-policy' });

    return () => window.removeEventListener('message', handleMessage);
  }, [setContextPolicy]);

  const handleContextPolicyChange = (policy: ContextPolicyData) => {
    setContextPolicy(policy)
    getVsCodeApi()?.postMessage({
      type: 'set-context-policy',
      payload: policy,
    })
  }

  const handleConfirmLogout = () => {
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
            className="popover-panel popover-panel-padded absolute right-2 top-2 z-20 w-[min(18rem,calc(100vw-1rem))]"
          >
            <div className="popover-header">
              <p className="popover-eyebrow">History</p>
              <span className="status-chip">{chats.length}</span>
            </div>

            <div className="popover-divider" />

            {chats.length === 0 ? (
              <p className="popover-section text-[15px] leading-6 text-[var(--vs-text-secondary)]">
                No saved chats yet.
              </p>
            ) : (
              <div className="popover-list">
                {chats.map((chat) => {
                  const isActiveChat = currentChatId === chat.chatId
                  const chatTitle = chat.title?.trim() || 'Untitled chat'

                  return (
                    <button
                      key={chat.chatId}
                      type="button"
                      onClick={() => handleOpenChat(chat.chatId)}
                      disabled={isStreaming}
                      className={`popover-list-item ${isActiveChat ? 'popover-list-item--active' : ''}`}
                    >
                      <div className="truncate text-[15px] text-[var(--vs-text-primary)]">
                        {chatTitle}
                      </div>
                      <div className="mt-0.5 text-[12px] leading-5 text-[var(--vs-text-secondary)]">
                        {formatRelativeTime(chat.updatedAt)}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {showSessionPanel && (
          <SessionPanel
            panelRef={sessionPanelRef}
            config={config}
            isStreaming={isStreaming}
            hasMessages={messages.length > 0}
            snapshotRetentionDays={snapshotRetentionDays}
            contextPolicy={contextPolicy}
            onSnapshotRetentionChange={(days) => {
              setSnapshotRetentionDays(days)
              getVsCodeApi()?.postMessage({
                type: 'set-config',
                payload: { snapshotRetentionDays: days },
              })
            }}
            onContextPolicyChange={handleContextPolicyChange}
            onNewTask={handleStartFresh}
            onReconfigure={() => {
              setShowSessionPanel(false)
              openProviderSettings()
            }}
            onSignOut={() => {
              setShowSessionPanel(false)
              setShowLogoutConfirm(true)
            }}
          />
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
            <div
              ref={messagesScrollRef}
              onScroll={handleMessagesScroll}
              className="h-full overflow-y-auto overflow-x-hidden"
            >
              {messages.length === 0 ? (
                <div className="mx-auto flex h-full w-full max-w-[42rem] flex-col justify-end px-3 pb-8 pt-8">
                  <p className="surface-label">Suggested starts</p>
                  <p className="mt-2 max-w-[30rem] text-sm leading-7 text-[var(--vs-text-secondary)]">
                    Start with a task, bug, review request, or file path and
                    the sidebar will stay clean while the agent works through it.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {starterPrompts.map((prompt) => (
                      <button
                        key={prompt.label}
                        type="button"
                        onClick={() => setQueuedPrompt(prompt.prompt)}
                        className="starter-chip"
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
                    <div className="error-banner">
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

          <div className="border-t chat-divider px-3 pb-3 pt-2 sm:px-4">
            <InputArea
              disabled={isStreaming}
              queuedPrompt={queuedPrompt}
              queuedEdit={queuedEdit}
              ideContextEnabled={currentIdeContextEnabled}
              onToggleIdeContext={handleToggleIdeContext}
              onQueuedPromptApplied={() => setQueuedPrompt('')}
              onQueuedEditApplied={() => setQueuedEdit(null)}
            />
          </div>
          </div>
          {agentPanelOpen ? <AgentTracePanel /> : null}
        </div>
      </div>

      <ConfirmDialog
        open={showLogoutConfirm}
        title="Sign out?"
        description="This will end your Vertex Swarm session on this machine. You can sign in again at any time."
        confirmLabel="Sign out"
        userEmail={user?.email}
        onCancel={() => setShowLogoutConfirm(false)}
        onConfirm={handleConfirmLogout}
      />
    </>
  )
}

export default ChatPanel
