import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { getVsCodeApi } from '../lib/vscode'
import {
  ArrowUp,
  ListChecks,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react'

interface Props {
  disabled?: boolean
  queuedPrompt?: string
  ideContextEnabled: boolean
  onToggleIdeContext: (enabled: boolean) => void
  onQueuedPromptApplied?: () => void
  queuedEdit?: string
  onQueuedEditApplied?: () => void
}

const InputArea: React.FC<Props> = ({
  disabled = false,
  queuedPrompt,
  ideContextEnabled,
  onToggleIdeContext,
  onQueuedPromptApplied,
  queuedEdit,
  onQueuedEditApplied,
}) => {
  const [message, setMessage] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [showQuickActions, setShowQuickActions] = useState(false)
  const [showContextDismissButton, setShowContextDismissButton] = useState(false)
  const [isHoveringStop, setIsHoveringStop] = useState(false)
  const trimmedMessage = message.trim()
  const isRunning = disabled
  const isSendDisabled = !isRunning && !trimmedMessage
  const {
    addMessage,
    beginAssistantMessage,
    setError,
    setStreaming,
    currentChatId,
  } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const quickActionsRef = useRef<HTMLDivElement>(null)
  const contextBadgeRef = useRef<HTMLDivElement>(null)

  const resizeTextarea = () => {
    if (!textareaRef.current) {
      return
    }

    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = `${Math.min(
      textareaRef.current.scrollHeight,
      220
    )}px`
  }

  const handleSend = async () => {
    if (!trimmedMessage || disabled) {
      return
    }

    const userMessage = trimmedMessage
    setMessage('')

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    const tempId = `msg-${Date.now()}`
    addMessage({
      id: tempId,
      type: 'user',
      content: userMessage,
      timestamp: Date.now(),
    })
    beginAssistantMessage()
    setError(null)
    setStreaming(true)

    try {
      getVsCodeApi()?.postMessage({
        type: 'start-stream',
        payload: {
          message: userMessage,
          ideContextEnabled,
          tempId,
        },
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      setError('Unable to start the agent stream. Please try again.')
    }
  }

  const handleCancel = () => {
    if (!disabled) {
      return
    }

    // Add a cancellation system message so the UI matches the backend persistence
    const { addMessage } = useChatStore.getState()
    addMessage({
      id: `msg-cancel-${Date.now()}`,
      type: 'system',
      content: 'User cancelled the operation. Reason: user-requested',
      timestamp: Date.now(),
    })

    setError(null)
    setStreaming(false)

    try {
      getVsCodeApi()?.postMessage({
        type: 'cancel-stream',
        payload: {
          sessionId: currentChatId || '',
        },
      })
    } catch (error) {
      console.error('Failed to cancel stream:', error)
      setError('Unable to stop the agent stream.')
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(event.target.value)
  }

  useEffect(() => {
    resizeTextarea()
  }, [message])

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [disabled])

  useEffect(() => {
    if (!queuedPrompt) {
      return
    }

    setMessage(queuedPrompt)
    onQueuedPromptApplied?.()

    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(
        queuedPrompt.length,
        queuedPrompt.length
      )
    })
  }, [queuedPrompt, onQueuedPromptApplied])

  useEffect(() => {
    if (!queuedEdit) {
      return
    }

    setMessage(queuedEdit)
    onQueuedEditApplied?.()

    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(
        queuedEdit.length,
        queuedEdit.length
      )
    })
  }, [queuedEdit, onQueuedEditApplied])

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null

      if (
        showQuickActions &&
        quickActionsRef.current &&
        !quickActionsRef.current.contains(target)
      ) {
        setShowQuickActions(false)
      }

      if (
        showContextDismissButton &&
        contextBadgeRef.current &&
        !contextBadgeRef.current.contains(target)
      ) {
        setShowContextDismissButton(false)
      }
    }

    window.addEventListener('mousedown', handleOutsideClick)
    return () => window.removeEventListener('mousedown', handleOutsideClick)
  }, [showQuickActions, showContextDismissButton])

  useEffect(() => {
    if (!ideContextEnabled && showContextDismissButton) {
      setShowContextDismissButton(false)
    }
  }, [ideContextEnabled, showContextDismissButton])

  return (
    <div
      className={`composer-shell transition-all duration-200 ${isFocused ? 'ring-1 ring-[#8bd7ff]/20' : ''
        }`}
    >
      <div className="flex items-center px-4 pt-3 pb-0 text-[10px] font-semibold uppercase tracking-[0.18em]" />

      <div className="px-4 pt-1">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="Describe the task, files, constraints, and desired outcome."
          disabled={disabled}
          className="min-h-[72px] w-full resize-none bg-transparent text-[15px] leading-7 text-[#f4f7ff] placeholder:text-[#6e7f9d] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 max-[360px]:min-h-[60px]"
          rows={1}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/6 px-4 pb-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative" ref={quickActionsRef}>
            <button
              type="button"
              onClick={() => setShowQuickActions((value) => !value)}
              disabled={disabled}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${disabled
                  ? 'cursor-not-allowed border-transparent bg-transparent text-[#454e5e]'
                  : 'border-white/10 bg-white/[0.04] text-[#a4b4cb] hover:bg-white/[0.08] hover:text-white'
                }`}
              title="Quick actions"
            >
              <Plus className="h-5 w-5" />
            </button>

            {showQuickActions && (
              <div className="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-[16rem] rounded-xl border border-white/10 bg-[#12141c]/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.4)] backdrop-blur-md">
                <button
                  type="button"
                  disabled={disabled}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] text-[#e6ecfa] transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Paperclip className="h-4 w-4 text-[#d9d3a5]" />
                  <span>Add photos & files</span>
                </button>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleIdeContext(!ideContextEnabled)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] text-[#e6ecfa] transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center gap-3">
                    <Sparkles className="h-4 w-4 text-[#b57cff]" />
                    <span>Include IDE context</span>
                  </div>
                  <span
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${ideContextEnabled ? 'bg-[#4bb5df]' : 'bg-white/15'
                      }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-[#eef4ff] transition ${ideContextEnabled ? 'translate-x-5' : 'translate-x-1'
                        }`}
                    />
                  </span>
                </button>

                <button
                  type="button"
                  disabled
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] text-[#9ca8c2]"
                >
                  <ListChecks className="h-4 w-4" />
                  <span>Plan mode</span>
                </button>

                <button
                  type="button"
                  disabled
                  className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[15px] text-[#9ca8c2]"
                >
                  <div className="flex items-center gap-3">
                    <Zap className="h-4 w-4" />
                    <span>Speed</span>
                  </div>
                  <span className="text-lg leading-none">{'>'}</span>
                </button>
              </div>
            )}
          </div>

          <div className="min-w-0 text-[11px] text-[#7f91b4]">
            <span>{disabled ? 'Streaming response' : 'Enter to send'}</span>
            <span className="mx-2 hidden text-white/15 min-[390px]:inline">
              |
            </span>
            <span className="hidden min-[460px]:inline">
              Shift+Enter for newline
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={disabled ? handleCancel : handleSend}
            onMouseEnter={() => setIsHoveringStop(true)}
            onMouseLeave={() => setIsHoveringStop(false)}
            disabled={isSendDisabled}
            className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${isRunning
                ? 'bg-[#2a1b24] text-[#f43f5e] border border-[#f43f5e]/20 hover:bg-[#381e28]'
                : !trimmedMessage
                  ? 'cursor-not-allowed bg-white/[0.03] text-[#5e697e]'
                  : 'bg-[linear-gradient(180deg,#5e6ad2,#4b59c4)] text-white shadow-[0_2px_10px_rgba(75,89,196,0.2),inset_0_1px_0_rgba(255,255,255,0.15)] hover:bg-[linear-gradient(180deg,#6c79e8,#5a68d8)]'
              }`}
            title={isRunning ? 'Stop the running operation' : 'Send message'}
          >
            <span className="max-[360px]:hidden">
              {isRunning
                ? isHoveringStop ? 'Stop' : 'Running'
                : 'Send'}
            </span>
            {isRunning && isHoveringStop ? (
              <Square className="h-3.5 w-3.5" />
            ) : (
              <ArrowUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default InputArea
