import React, { useMemo } from 'react'
import { type ChatMessage } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'
import AgentTimeline from './AgentProcess'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Edit2 } from 'lucide-react'
import { buildAgentRunBlocks } from '../lib/agentRunBlocks'
import { describePendingMessage } from '../lib/trace'
import { getVsCodeApi } from '../lib/vscode'
import PlanCard from './PlanCard'
import { SnapshotCard } from './SnapshotCard'
import { collectMessageDiffs } from '../lib/messageDiffs'

interface Props {
  message: ChatMessage
}

const normalizeAssistantContent = (content: string) => {
  return content.replace(/\r\n/g, '\n')
}

const StreamingCursor = () => (
  <span
    aria-hidden="true"
    className="ml-0.5 inline-block align-baseline text-[#5e6ad2] animate-pulse"
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
  const { activeMessageId, isStreaming, currentChatId, planReadyForMessageId } = useChatStore((state) => ({
    activeMessageId: state.activeMessageId,
    isStreaming: state.isStreaming,
    currentChatId: state.currentChatId,
    planReadyForMessageId: state.planReadyForMessageId,
  }))
  const isStreamingMessage =
    message.type === 'agent' && isStreaming && activeMessageId === message.id
  const isHistorical = message.type === 'agent' && !isStreamingMessage
  const pendingLabel = describePendingMessage(message)
  const shouldRenderProcess =
    message.type === 'agent' && Boolean(message.events?.length)
  const blocks = useMemo(
    () => (shouldRenderProcess ? buildAgentRunBlocks(message.events || [], message.content) : []),
    [message.events, message.content, shouldRenderProcess]
  )

  const turnDiffSummary = useMemo(
    () =>
      shouldRenderProcess
        ? collectMessageDiffs(message.events || [], message.content)
        : { diffs: [], snapshotId: '', sessionId: '', messageId: '' },
    [message.events, message.content, shouldRenderProcess]
  )

  const hasPlanPermissionRequest = useMemo(
    () => message.events?.some((e) => e.type === 'plan_permission_request'),
    [message.events]
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

  if (isHistorical && !message.content && blocks.length === 0 && !hasPlanPermissionRequest) {
    return null
  }

  return (
    <div
      className={`flex py-2 pr-0 ${isUser ? 'justify-end' : 'justify-start'
        } animate-fade-up`}
    >
      <div
        className={`min-w-0 ${isUser
          ? 'ml-auto w-fit max-w-[78%] group relative'
          : 'w-full max-w-none'
          }`}
      >
        <div
          className={`mb-1.5 flex items-center gap-2 text-[11px] font-medium ${isUser ? 'justify-end text-[#91a0bb]' : 'text-[#7f91b4]'
            }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${isUser ? 'bg-[#8b9ebf]' : 'bg-[#5e6ad2]'
              }`}
          />
          <span>{isUser ? 'You' : 'Agent'}</span>
        </div>

        <div
          className={isUser ? 'user-bubble inline-block max-w-full' : 'agent-thread w-full min-w-0'}
        >
          {shouldRenderProcess ? (
            <div className="flex flex-col gap-1.5">
              {blocks.map((block, index) => {
                if (block.kind === 'narrative') {
                  const isStreamingNarrative =
                    isStreamingMessage && index === blocks.length - 1
                  return (
                    <div
                      key={block.id}
                      className={`break-words text-[15px] leading-7 ${block.tone === 'code'
                        ? 'font-medium text-[#d9e6fb]'
                        : 'text-[#edf3ff]'
                        }`}
                    >
                      {renderAssistantText(block.text)}
                      {isStreamingNarrative ? <StreamingCursor /> : null}
                    </div>
                  )
                }

                if (block.kind === 'system') {
                  return (
                    <div
                      key={block.id}
                      className={`rounded-2xl px-3 py-2.5 text-[13px] leading-6 ${block.tone === 'error'
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
                  return (
                    <AgentTimeline
                      key={block.id}
                      block={block}
                      isStreamingMessage={isStreamingMessage}
                    />
                  )
                }

                return null
              })}

              {hasPlanPermissionRequest && (() => {
                let planStatus: 'generating' | 'ready' | 'executed' = 'generating';
                if (planReadyForMessageId === message.id) {
                  planStatus = 'ready';
                } else if (isHistorical) {
                  planStatus = 'executed';
                }
                return <PlanCard status={planStatus} />;
              })()}

              {!isStreamingMessage && turnDiffSummary.diffs.length > 0 && (
                <SnapshotCard
                  diffs={turnDiffSummary.diffs}
                  snapshotId={turnDiffSummary.snapshotId}
                  sessionId={turnDiffSummary.sessionId}
                  messageId={turnDiffSummary.messageId}
                  isHistorical={isHistorical}
                />
              )}
            </div>
          ) : (
            <>
              {renderedStreamingAssistantContent ??
                (renderedAssistantContent &&
                  (isUser ? (
                    <div className="relative">
                      <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#f4f7ff]">
                        {message.content}
                      </p>
                    </div>
                  ) : (
                    renderedAssistantContent
                  )))}
            </>
          )}

          {!message.content && !isUser && (!message.events || message.events.length === 0) && (
            <div className="flex items-center gap-2 text-sm leading-6 text-[#91a0bb]">
              {isStreamingMessage && <span className="h-1.5 w-1.5 rounded-full bg-[#5e6ad2] animate-pulse" />}
              <p>{pendingLabel}</p>
            </div>
          )}
        </div>

        {/* Action Buttons for User Messages */}
        {isUser && !isStreaming && (
          <div className="absolute -left-2 top-1/2 -translate-x-full -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 pr-2">
            <button
              onClick={() => {
                const messageId = message.dbMessageId || message.id
                if (!messageId || !currentChatId) return
                getVsCodeApi()?.postMessage({
                  type: 'truncate-messages',
                  payload: {
                    chatId: currentChatId,
                    messageId: messageId,
                    messageText: message.content
                  }
                })
              }}
              className="p-1.5 rounded-md text-[#91a0bb] hover:text-white hover:bg-white/[0.05] transition-colors"
              title="Edit Message (Removes subsequent agent responses)"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(message.content)}
              className="p-1.5 rounded-md text-[#91a0bb] hover:text-white hover:bg-white/[0.05] transition-colors"
              title="Copy Message"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageRenderer
