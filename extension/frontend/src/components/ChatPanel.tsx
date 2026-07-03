import React, { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/authStore'
import { useChatStore } from '../store/chatStore'
import MessageRenderer from './MessageRenderer'
import InputArea from './InputArea'
import ConfirmDialog from './ConfirmDialog'
import { getVsCodeApi } from '../lib/vscode'
import { Package, FileSignature, Search } from 'lucide-react'

import { TOAST_STATUS_PHASES, buildAgentRunBlocks } from '../lib/agentRunBlocks'
import { getEventPhase } from '../lib/sessionEvents'

const FILE_ACTIONS = new Set([
  'edit_file',
  'create_file',
  'delete_path',
  'rename_path',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file'
])

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
  const [snapshotRetentionDays, setSnapshotRetentionDays] = useState(7)
  const [toolToast, setToolToast] = useState<string | null>(null)
  const toolToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sessionPanelRef = useRef<HTMLDivElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)



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

  // Watch for tool_context_loaded status events and show ephemeral toast
  useEffect(() => {
    const lastAgentMsg = [...messages].reverse().find((m) => m.type === 'agent')
    if (!lastAgentMsg?.events?.length) return
    const latestEvent = lastAgentMsg.events[lastAgentMsg.events.length - 1]
    if (!latestEvent) return
    const phase = getEventPhase(latestEvent)
    if (phase && TOAST_STATUS_PHASES.has(phase) && latestEvent.content) {
      setToolToast(String(latestEvent.content))
      if (toolToastTimerRef.current) clearTimeout(toolToastTimerRef.current)
      toolToastTimerRef.current = setTimeout(() => setToolToast(null), 3500)
    }
  }, [messages])

  useEffect(() => {
    return () => {
      if (toolToastTimerRef.current) clearTimeout(toolToastTimerRef.current)
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
      {/* Ephemeral tool-context toast */}
      {toolToast && (
        <div
          className="pointer-events-none fixed bottom-[4.5rem] right-3 z-50 flex items-center gap-1.5 rounded-full border border-[#8bd7ff]/20 bg-[#0d1827]/80 px-3 py-1.5 text-[11px] font-medium text-[#8bd7ff]/70 shadow-lg backdrop-blur-md animate-fade-up"
          aria-live="polite"
        >
          <Package className="h-3 w-3 shrink-0" />
          <span>{toolToast}</span>
        </div>
      )}

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
                <p>The backend JWT refreshes automatically while your Neon session stays valid.</p>
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
                  Sign out
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

          {/* Live file edit bar — shows during streaming (like Codex Image 2).
               Displays "N files changed +X -Y  Review" above the input area while agent is working.
               Disappears when streaming ends; replaced by the SnapshotCard inside the message. */}
          {isStreaming && (() => {
            const lastAgent = [...messages].reverse().find(m => m.type === 'agent')
            if (!lastAgent?.events?.length) return null
            const blocks = buildAgentRunBlocks(lastAgent.events, lastAgent.content)
            let fileCount = 0, totalAdds = 0, totalDels = 0
            let firstDiff: { file: string; originalUri: string; snapshotPath: string } | null = null
            for (const block of blocks) {
              if (block.kind !== 'process') continue
              for (const step of block.steps) {
                if (step.kind !== 'node') continue
                if (!FILE_ACTIONS.has(step.node.action ?? '')) continue
                const diffs: any[] = (step.node.resultDebug as any)?.data?.snapshot_diffs ?? []
                for (const d of diffs) {
                  totalAdds += d.additions ?? 0
                  totalDels += d.deletions ?? 0
                  fileCount++
                  if (!firstDiff) firstDiff = d
                }
                // Count running nodes too (no diffs yet)
                if (diffs.length === 0) fileCount++
              }
            }
            if (fileCount === 0) return null
            return (
              <div 
                className={`flex items-center justify-between border-t border-white/[0.05] bg-[#0a0d14]/80 px-4 py-2 ${firstDiff ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : ''}`}
                onClick={() => {
                  if (firstDiff) {
                    getVsCodeApi()?.postMessage({
                      type: 'review-snapshot',
                      payload: { file: firstDiff!.file, originalUri: firstDiff!.originalUri, snapshotPath: firstDiff!.snapshotPath }
                    })
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[#c6d2e7]">
                    {fileCount} file{fileCount !== 1 ? 's' : ''} changed
                  </span>
                  {(totalAdds > 0 || totalDels > 0) && (
                    <div className="flex items-center gap-1.5 font-mono text-[11px]">
                      <span className="text-[#2dd4bf]">+{totalAdds}</span>
                      <span className="text-[#f43f5e]">-{totalDels}</span>
                    </div>
                  )}
                </div>
                {firstDiff && (
                  <span className="text-[12px] font-medium text-[#c6d2e7] hover:text-white transition-colors">
                    Review
                  </span>
                )}
              </div>
            )
          })()}

          <div className="border-t chat-divider bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] px-3 pb-3 pt-2 sm:px-4">
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
