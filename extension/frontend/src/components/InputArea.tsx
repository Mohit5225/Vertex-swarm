import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { getVsCodeApi } from '../lib/vscode'
import { ArrowUp } from 'lucide-react'

interface Props {
  disabled?: boolean
  queuedPrompt?: string
  onQueuedPromptApplied?: () => void
}

const InputArea: React.FC<Props> = ({
  disabled = false,
  queuedPrompt,
  onQueuedPromptApplied,
}) => {
  const [message, setMessage] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const trimmedMessage = message.trim()
  const {
    addMessage,
    beginAssistantMessage,
    setError,
    setStreaming,
  } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

    addMessage({
      id: `msg-${Date.now()}`,
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
          sessionId: '', // Extension will create the actual session
          message: userMessage,
        },
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      setError('Unable to start the agent stream. Please try again.')
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

  return (
    <div
      className={`composer-shell transition-all duration-200 ${
        isFocused ? 'ring-1 ring-white/12' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3 text-[10px] font-medium uppercase tracking-[0.18em] text-[#7385a7]">
        <span className="truncate">
          {disabled ? 'Agent running' : 'New message'}
        </span>
        <span className="hidden text-[#60718f] min-[420px]:block">
          {trimmedMessage ? `${trimmedMessage.length} chars` : 'Ask anything'}
        </span>
      </div>

      <div className="px-4">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder="Describe the task, files, constraints, and desired outcome."
          disabled={disabled}
          className="min-h-[96px] w-full resize-none bg-transparent text-[15px] leading-7 text-[#f4f7ff] placeholder:text-[#6e7f9d] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 max-[360px]:min-h-[76px]"
          rows={1}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-white/6 px-4 pb-3 pt-2">
        <div className="min-w-0 text-[11px] text-[#7f91b4]">
          <span>{disabled ? 'Streaming response' : 'Enter to send'}</span>
          <span className="mx-2 hidden text-white/15 min-[390px]:inline">
            |
          </span>
          <span className="hidden min-[460px]:inline">
            Shift+Enter for newline
          </span>
        </div>

        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !trimmedMessage}
          className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition ${
            disabled || !trimmedMessage
              ? 'cursor-not-allowed bg-white/[0.04] text-[#7383a1]'
              : 'bg-[#f3f0dd] text-[#08101e] shadow-[0_10px_30px_rgba(243,240,221,0.16)] hover:-translate-y-[1px]'
          }`}
        >
          <span className="max-[360px]:hidden">
            {disabled ? 'Running' : 'Send'}
          </span>
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default InputArea
