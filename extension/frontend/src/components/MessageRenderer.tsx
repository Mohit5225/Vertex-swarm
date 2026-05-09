import React, { useMemo } from 'react'
import { type ChatMessage } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'
import AgentTimeline from './AgentProcess'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { buildAgentRunBlocks } from '../lib/agentRunBlocks'
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

const StreamingCursor = () => (
  <span
    aria-hidden="true"
    className="ml-0.5 inline-block align-baseline text-[#8bd7ff] animate-pulse"
  >
    ▍
  </span>
)

const renderAssistantText = (content: string) => (
  <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {normalizeAssistantContent(content)}
    </ReactMarkdown>
  </div>
)

const MessageRenderer: React.FC<Props> = ({ message }) => {
  const isUser = message.type === 'user'
  const isSystem = message.type === 'system'
  const { activeMessageId, isStreaming } = useChatStore((state) => ({
    activeMessageId: state.activeMessageId,
    isStreaming: state.isStreaming,
  }))
  const isStreamingMessage =
    message.type === 'agent' && isStreaming && activeMessageId === message.id
  const pendingLabel = describePendingMessage(message)
  const shouldRenderProcess =
    message.type === 'agent' && Boolean(message.events?.length)
  const blocks = useMemo(
    () => (shouldRenderProcess ? buildAgentRunBlocks(message.events || [], message.content) : []),
    [message.events, message.content, shouldRenderProcess]
  )

  const renderedAssistantContent = message.content ? renderAssistantText(message.content) : null

  const renderedStreamingAssistantContent = isStreamingMessage && message.content ? (
    <div
      className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#edf3ff]"
      aria-live="polite"
    >
      <span>{message.content}</span>
      <StreamingCursor />
    </div>
  ) : null

  if (isSystem) {
    return (
      <div className="flex py-2 animate-fade-up">
        <div className="w-full">
          <div className="rounded-2xl bg-white/[0.03] px-3 py-2.5 text-[13px] leading-6 text-[#9fb0cd]">
            {message.content}
          </div>
        </div>
      </div>
    )
  }

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
          className={`mb-1.5 flex items-center gap-2 text-[11px] font-medium ${
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
            <div className="space-y-4">
              {blocks.map((block, index) => {
                if (block.kind === 'narrative') {
                  return (
                    <div
                      key={block.id}
                      className={`whitespace-pre-wrap break-words text-[15px] leading-7 ${
                        block.tone === 'code'
                          ? 'font-medium text-[#d9e6fb]'
                          : 'text-[#edf3ff]'
                      }`}
                    >
                      {renderAssistantText(block.text)}
                    </div>
                  )
                }

                if (block.kind === 'system') {
                  return (
                    <div
                      key={block.id}
                      className={`rounded-2xl px-3 py-2.5 text-[13px] leading-6 ${
                        block.tone === 'error'
                          ? 'bg-[#f27d75]/10 text-[#ffbeb8]'
                          : block.tone === 'warning'
                            ? 'bg-[#f1cb78]/10 text-[#f3d69a]'
                            : 'bg-white/[0.03] text-[#9fb0cd]'
                      }`}
                    >
                      {block.text}
                    </div>
                  )
                }

                if (block.kind === 'process') {
                  const isActiveBlock = index === blocks.length - 1
                  return (
                    <AgentTimeline
                      key={block.id}
                      block={block}
                      isStreamingMessage={isStreamingMessage}
                      isActiveBlock={isActiveBlock}
                    />
                  )
                }

                return null
              })}
            </div>
          ) : (
            <>
              {renderedStreamingAssistantContent ??
                (renderedAssistantContent &&
                  (isUser ? (
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#f4f7ff]">
                      {message.content}
                    </p>
                  ) : (
                    renderedAssistantContent
                  )))}
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
