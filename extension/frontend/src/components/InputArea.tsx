import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useDeepPlanStore } from '../store/deepPlanStore'
import { getVsCodeApi } from '../lib/vscode'
import {
  buildDeepPlanComposerLabel,
  findDeepPlanHandoffEvents,
} from '../lib/deepPlanJobTimeline'
import {
  DEEP_PLAN_COMMAND,
  filterSlashCommands,
  hasDeepPlanPrefix,
  isTypingSlashCommand,
  type SlashCommand,
} from '../lib/slashCommands'
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

const splitDeepPlanMessage = (text: string): { token: boolean; body: string } => {
  if (!hasDeepPlanPrefix(text)) {
    return { token: false, body: text }
  }
  const rest = text.trimStart().slice(DEEP_PLAN_COMMAND.length).trimStart()
  return { token: true, body: rest }
}

const composeMessage = (token: boolean, body: string): string => {
  const trimmedBody = body.trim()
  if (token) {
    return trimmedBody ? `${DEEP_PLAN_COMMAND} ${trimmedBody}` : DEEP_PLAN_COMMAND
  }
  return body
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
  const [body, setBody] = useState('')
  const [deepPlanToken, setDeepPlanToken] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [showQuickActions, setShowQuickActions] = useState(false)
  const [showContextDismissButton, setShowContextDismissButton] = useState(false)
  const [isHoveringStop, setIsHoveringStop] = useState(false)
  const [slashHighlight, setSlashHighlight] = useState(0)

  const deepPlanSessionActive = useDeepPlanStore((s) => s.active)
  const deepPlanPhase = useDeepPlanStore((s) => s.phase)
  const deepPlanStageLabel = useDeepPlanStore((s) => s.stageLabel)
  const deepPlanPipelineId = useDeepPlanStore((s) => s.pipelineId)
  const activateDeepPlan = useDeepPlanStore((s) => s.activate)
  const deactivateDeepPlan = useDeepPlanStore((s) => s.deactivate)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)

  const deepPlanComposerLabel = useMemo(() => {
    if (!deepPlanSessionActive || deepPlanPhase === 'off') {
      return deepPlanStageLabel
    }
    const handoffEvents = findDeepPlanHandoffEvents(messages, deepPlanPipelineId)
    return buildDeepPlanComposerLabel(
      handoffEvents,
      deepPlanStageLabel,
      isStreaming && deepPlanPhase === 'pipeline_running',
    )
  }, [
    deepPlanSessionActive,
    deepPlanPhase,
    deepPlanStageLabel,
    deepPlanPipelineId,
    messages,
    isStreaming,
  ])

  const showToken =
    deepPlanToken ||
    (deepPlanSessionActive && deepPlanPhase === 'requirement_extraction')
  const slashMenuOpen = !showToken && isTypingSlashCommand(body)
  const slashCommands = slashMenuOpen ? filterSlashCommands(body.trimStart()) : []
  const composed = composeMessage(showToken, body)
  const trimmedMessage = composed.trim()

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
  const slashMenuRef = useRef<HTMLDivElement>(null)

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

  const clearDeepPlanToken = () => {
    setDeepPlanToken(false)
    if (
      deepPlanSessionActive &&
      (deepPlanPhase === 'requirement_extraction' || deepPlanPhase === 'awaiting_approval')
    ) {
      deactivateDeepPlan()
      getVsCodeApi()?.postMessage({ type: 'exit-deep-plan-mode', payload: {} })
    }
  }

  const applySlashCommand = (cmd: SlashCommand) => {
    if (cmd.activatesDeepPlan) {
      setDeepPlanToken(true)
      setBody('')
    } else {
      setBody(cmd.insertPrefix)
    }
    setSlashHighlight(0)
    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
    })
  }

  const loadComposerText = (text: string) => {
    const parsed = splitDeepPlanMessage(text)
    setDeepPlanToken(parsed.token)
    setBody(parsed.body)
  }

  const handleSend = async () => {
    if (disabled || !trimmedMessage) {
      return
    }

    const userMessage = trimmedMessage
    const deepPlanRequested = showToken || deepPlanSessionActive

    if (deepPlanRequested && showToken) {
      activateDeepPlan('user_slash', 'requirement_extraction')
    }

    setBody('')
    setDeepPlanToken(false)

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    const tempId = `msg-${Date.now()}`
    addMessage({
      id: tempId,
      type: 'user',
      content: userMessage,
      deepPlan: deepPlanRequested,
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
          deepPlanRequested,
        },
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      setError('Unable to start the agent stream. Please try again.')
      setStreaming(false)
    }
  }

  const handleCancel = () => {
    if (!disabled) {
      return
    }

    const { addMessage, finishStreaming } = useChatStore.getState()
    addMessage({
      id: `msg-cancel-${Date.now()}`,
      type: 'system',
      content: 'User cancelled the operation. Reason: user-requested',
      timestamp: Date.now(),
    })

    setError(null)
    finishStreaming()

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
    if (showToken && event.key === 'Backspace' && body === '') {
      event.preventDefault()
      clearDeepPlanToken()
      return
    }

    if (slashMenuOpen && slashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashHighlight((i) => (i + 1) % slashCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashHighlight((i) => (i - 1 + slashCommands.length) % slashCommands.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        applySlashCommand(slashCommands[slashHighlight])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value

    if (!showToken && hasDeepPlanPrefix(value)) {
      const parsed = splitDeepPlanMessage(value)
      setDeepPlanToken(true)
      setBody(parsed.body)
      return
    }

    setBody(value)
    if (slashMenuOpen) {
      setSlashHighlight(0)
    }
  }

  useEffect(() => {
    resizeTextarea()
  }, [body, showToken])

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [disabled])

  useEffect(() => {
    if (deepPlanSessionActive && deepPlanPhase === 'requirement_extraction') {
      setDeepPlanToken(true)
    }
  }, [deepPlanSessionActive, deepPlanPhase])

  useEffect(() => {
    if (!queuedPrompt) {
      return
    }
    loadComposerText(queuedPrompt)
    onQueuedPromptApplied?.()
    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
    })
  }, [queuedPrompt, onQueuedPromptApplied])

  useEffect(() => {
    if (!queuedEdit) {
      return
    }
    loadComposerText(queuedEdit)
    onQueuedEditApplied?.()
    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
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

  const shellClass = [
    'composer-shell',
    isFocused ? 'composer-shell--focused' : '',
    showToken || deepPlanSessionActive ? 'composer-shell--deep-plan' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={shellClass}>
      <div className="relative px-4 pt-3">
        {slashMenuOpen && slashCommands.length > 0 && (
          <div
            ref={slashMenuRef}
            className="popover-panel popover-panel-padded slash-popover-panel absolute bottom-[calc(100%+0.35rem)] left-2 right-2 z-30"
          >
            <div className="slash-popover-header">Commands</div>
            {slashCommands.map((cmd, index) => (
              <button
                key={cmd.id}
                type="button"
                className={`slash-popover-row ${index === slashHighlight ? 'slash-popover-row--active' : ''}`}
                onMouseEnter={() => setSlashHighlight(index)}
                onClick={() => applySlashCommand(cmd)}
              >
                <span className="slash-popover-command">{cmd.command}</span>
                <span className="slash-popover-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        <div className="composer-input-row">
          {showToken && (
            <span
              className="slash-command-pill slash-command-token"
              contentEditable={false}
            >
              {DEEP_PLAN_COMMAND}
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={body}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={
              showToken
                ? 'Describe the change…'
                : 'Describe the task, files, constraints, and desired outcome.'
            }
            disabled={disabled || deepPlanPhase === 'pipeline_running'}
            className="min-h-[72px] min-w-[120px] flex-1 resize-none bg-transparent text-[15px] leading-7 text-[var(--vs-text-primary)] placeholder:text-[var(--vs-text-tertiary)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 max-[360px]:min-h-[60px]"
            rows={1}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--vs-border-soft)] px-4 pb-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          {deepPlanSessionActive && deepPlanComposerLabel && deepPlanPhase !== 'off' ? (
            <span className="truncate text-xs text-[var(--vs-text-tertiary)]">
              Deep plan: {deepPlanComposerLabel}
            </span>
          ) : null}
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
            <span className="mx-2 hidden text-white/15 min-[390px]:inline">|</span>
            <span className="hidden min-[460px]:inline">Shift+Enter for newline</span>
          </div>
        </div>

        <button
          type="button"
          onClick={disabled ? handleCancel : handleSend}
          onMouseEnter={() => setIsHoveringStop(true)}
          onMouseLeave={() => setIsHoveringStop(false)}
          disabled={isSendDisabled}
          className={`${isRunning
              ? 'send-btn send-btn--stop'
              : isSendDisabled
                ? 'send-btn send-btn--disabled'
                : 'send-btn'
            }`}
          title={isRunning ? 'Stop the running operation' : 'Send message'}
        >
          <span className="max-[360px]:hidden">
            {isRunning ? (isHoveringStop ? 'Stop' : 'Running') : 'Send'}
          </span>
          {isRunning && isHoveringStop ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}

export default InputArea
