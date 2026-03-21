import React, { useState, useRef, useEffect } from 'react'
import { type ChatMessage, type SessionEvent } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Cpu, ChevronDown, ChevronRight, Play, CheckCircle, Wrench } from 'lucide-react'
import { describePendingMessage, getTraceEventSummary } from '../lib/trace'

interface Props {
  message: ChatMessage
}

const looksLikeMarkdown = (content: string) =>
  /(^|\n)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|`[^`]+`|\|.+\|)/m.test(content)

const normalizeAssistantContent = (content: string) => {
  const normalized = content.replace(/\r\n/g, '\n')

  if (looksLikeMarkdown(normalized)) {
    return normalized
  }

  const segments = normalized
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const averageSegmentLength =
    segments.length > 0
      ? segments.reduce((total, segment) => total + segment.length, 0) /
        segments.length
      : 0
  const looksFragmented =
    segments.length >= 4 && averageSegmentLength > 0 && averageSegmentLength < 28

  if (!looksFragmented) {
    return normalized.replace(/(?<!\n)\n(?!\n)/g, ' ')
  }

  return segments.join(' ').replace(/\s+([,.;:!?])/g, '$1')
}

const getEventMeta = (event: SessionEvent) => {
  switch (event.type) {
    case 'thinking':
      return {
        label: 'Reasoning',
        accent: 'bg-[#7f91b4]',
        icon: <Cpu className="h-3.5 w-3.5" />,
      }
    case 'code':
      return {
        label: 'Code activity',
        accent: 'bg-[#87d8ff]',
        icon: <Play className="h-3.5 w-3.5" />,
      }
    case 'tool_call':
      return {
        label: 'Tool call',
        accent: 'bg-[#f2c56f]',
        icon: <Wrench className="h-3.5 w-3.5" />,
      }
    case 'tool_result':
      return {
        label: 'Tool result',
        accent: 'bg-[#63d1ff]',
        icon: <CheckCircle className="h-3.5 w-3.5" />,
      }
    case 'output':
      return {
        label: 'Output',
        accent: 'bg-[#48d2b4]',
        icon: <CheckCircle className="h-3.5 w-3.5" />,
      }
    case 'error':
      return {
        label: 'Issue detected',
        accent: 'bg-[#f27d75]',
        icon: <Play className="h-3.5 w-3.5" />,
      }
    default:
      return {
        label: 'Status',
        accent: 'bg-[#f2c56f]',
        icon: <CheckCircle className="h-3.5 w-3.5" />,
      }
  }
}

const ToolEvent: React.FC<{ event: SessionEvent }> = ({ event }) => {
  const [open, setOpen] = useState(event.type !== 'thinking')
  const meta = getEventMeta(event)
  const summary = getTraceEventSummary(event)
  const scrollRef = useRef<HTMLPreElement>(null)

  // Ensure scroll stays at the bottom when new thinking text streams in,
  // but keep all history accessible via scrolling up.
  useEffect(() => {
    if (scrollRef.current && event.type === 'thinking' && open) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [event.content, event.type, open])

  return (
    <div className="trace-item">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.accent}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[#e7eefc]">
                {meta.icon}
                <span className="text-[11px] font-medium uppercase tracking-[0.18em]">
                  {meta.label}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-[#91a0bb] max-[360px]:hidden">
                {summary}
              </p>
            </div>
          </div>

        <span className="text-[#91a0bb] transition-transform duration-200">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
      </button>

      {open && event.content && (
        <div className="trace-panel pb-3 pr-3 pt-1">
          <pre 
            ref={scrollRef}
            className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[#91a0bb] max-h-64 overflow-y-auto custom-scrollbar"
          >
            {event.content}
          </pre>
        </div>
      )}
    </div>
  )
}

const MessageRenderer: React.FC<Props> = ({ message }) => {
  const isUser = message.type === 'user'
  const { activeMessageId, isStreaming } = useChatStore((state) => ({
    activeMessageId: state.activeMessageId,
    isStreaming: state.isStreaming,
  }))
  const isStreamingMessage =
    !isUser && isStreaming && activeMessageId === message.id
  const traceEvents = message.events?.filter((event) => event.type !== 'output')
  const pendingLabel = describePendingMessage(message)

  return (
    <div
      className={`flex py-3 ${
        isUser ? 'justify-end' : 'justify-start'
      } animate-fade-up`}
    >
      <div
        className={`w-full ${
          isUser ? 'max-w-[90%] min-[480px]:max-w-[78%]' : 'max-w-none'
        }`}
      >
        <div
          className={`mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] ${
            isUser ? 'justify-end text-[#91a0bb]' : 'text-[#7f91b4]'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isUser ? 'bg-[#f3f0dd]/70' : 'bg-[#8bd7ff]/70'
            }`}
          />
          <span>{isUser ? 'You' : 'Agent'}</span>
        </div>

        <div className={isUser ? 'user-bubble' : 'agent-thread w-full min-w-0'}>
          {!isUser && traceEvents && traceEvents.length > 0 && (
            <div className="mb-4 space-y-2">
              {traceEvents.map((event) => (
                <ToolEvent key={event.id} event={event} />
              ))}
            </div>
          )}

          {message.content &&
            (isUser ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-7 text-[#f4f7ff]">
                {message.content}
              </p>
            ) : (
              <>
                {isStreamingMessage ? (
                  <div className="message-streaming">
                    {normalizeAssistantContent(message.content)}
                  </div>
                ) : (
                  <div className="message-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {normalizeAssistantContent(message.content)}
                    </ReactMarkdown>
                  </div>
                )}
              </>
            ))}

          {!message.content && !isUser && (
            <p className="text-sm leading-6 text-[#91a0bb]">
              {pendingLabel}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default MessageRenderer
