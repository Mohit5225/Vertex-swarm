import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { getVsCodeApi } from '../lib/vscode'
import { ArrowUp, Plus, Sparkles, Square } from 'lucide-react'

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
      className={`composer-shell ${isFocused ? 'composer-shell--focused' : ''}`}
    >
      <div className="px-4 pt-3">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="Describe the task, files, constraints, and desired outcome."
          disabled={disabled}
          className="min-h-[72px] w-full resize-none bg-transparent text-[15px] leading-7 text-[var(--vs-text-primary)] placeholder:text-[var(--vs-text-tertiary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 max-[360px]:min-h-[60px]"
          rows={1}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--vs-border-soft)] px-4 pb-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="relative" ref={quickActionsRef}>
            <button
              type="button"
              onClick={() => setShowQuickActions((value) => !value)}
              disabled={disabled}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${disabled
                  ? 'cursor-not-allowed border-transparent bg-transparent text-[var(--vs-text-tertiary)]'
                  : 'border-[var(--vs-border)] bg-white/[0.03] text-[var(--vs-text-secondary)] hover:bg-[var(--vs-accent-muted)] hover:text-[var(--vs-text-primary)]'
                }`}
              title="Quick actions"
            >
              <Plus className="h-5 w-5" />
            </button>

            {showQuickActions && (
              <div className="popover-panel popover-panel-padded absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-[16rem]">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleIdeContext(!ideContextEnabled)}
                  className="popover-row justify-between disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-center gap-3">
                    <Sparkles className="h-4 w-4 text-[var(--vs-accent)]" />
                    <span>Include IDE context</span>
                  </div>
                  <span
                    className={`toggle-track ${ideContextEnabled ? 'toggle-track--on' : ''}`}
                  >
                    <span
                      className={`toggle-thumb ${ideContextEnabled ? 'toggle-thumb--on' : 'toggle-thumb--off'}`}
                    />
                  </span>
                </button>
              </div>
            )}
          </div>

          <div className="min-w-0 text-[11px] text-[var(--vs-text-tertiary)]">
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
            className={`${isRunning
                ? 'send-btn send-btn--stop'
                : !trimmedMessage
                  ? 'send-btn send-btn--disabled'
                  : 'send-btn'
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
