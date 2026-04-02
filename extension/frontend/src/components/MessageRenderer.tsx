import React from 'react'
import { type ChatMessage } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'
import AgentTimeline from './AgentTimeline'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describePendingMessage } from '../lib/trace'

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

const MessageRenderer: React.FC<Props> = ({ message }) => {
  const isUser = message.type === 'user'
  const { activeMessageId, isStreaming } = useChatStore((state) => ({
    activeMessageId: state.activeMessageId,
    isStreaming: state.isStreaming,
  }))
  const isStreamingMessage =
    !isUser && isStreaming && activeMessageId === message.id
  const pendingLabel = describePendingMessage(message)
  const shouldRenderProcess = !isUser && Boolean(message.events?.length)

  const renderedAssistantContent = message.content ? (
    isStreamingMessage ? (
      <div className="message-streaming">
        {normalizeAssistantContent(message.content)}
      </div>
    ) : (
      <div className="message-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {normalizeAssistantContent(message.content)}
        </ReactMarkdown>
      </div>
    )
  ) : null

  return (
    <div
      className={`flex py-2 pr-0 ${
        isUser ? 'justify-end' : 'justify-start'
      } animate-fade-up`}
    >
      <div
        className={`min-w-0 ${
          isUser
            ? 'ml-auto w-fit max-w-[78%]'
            : 'w-full max-w-none'
        }`}
      >
        <div
          className={`mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] ${
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

        <div
          className={isUser ? 'user-bubble inline-block max-w-full' : 'agent-thread w-full min-w-0'}
        >
          {shouldRenderProcess ? (
            <AgentTimeline
              events={message.events || []}
              isStreaming={isStreamingMessage}
              messageContent={message.content}
            />
          ) : (
            <>
              {renderedAssistantContent &&
                (isUser ? (
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#f4f7ff]">
                    {message.content}
                  </p>
                ) : (
                  renderedAssistantContent
                ))}
            </>
          )}

          {!message.content && !isUser && (!message.events || message.events.length === 0) && (
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
