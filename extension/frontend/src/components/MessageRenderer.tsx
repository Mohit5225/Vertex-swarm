import React, { useMemo, useState } from 'react'
import { type ChatMessage } from '../store/chatStore'
import { useChatStore } from '../store/chatStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Edit2 } from 'lucide-react'
import { describePendingMessage } from '../lib/trace'
import { isLiveAgentTurn } from '../lib/liveAgentTurn'
import { getVsCodeApi } from '../lib/vscode'
import PlanCard from './PlanCard'
import DeepPlanCard from './DeepPlanCard'
import { FileChangesCard } from './FileChangesCard'
import { collectMessageFileChanges } from '../lib/messageDiffs'
import AgentTurnView from './AgentTurnView'
import AttachmentThumbnails from './AttachmentThumbnails'
import ImagePreviewModal from './ImagePreviewModal'

interface Props {
  message: ChatMessage
}

const normalizeAssistantContent = (content: string) => {
  return content.replace(/\r\n/g, '\n')
}

const renderAssistantText = (content: string) => (
  <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {normalizeAssistantContent(content)}
    </ReactMarkdown>
  </div>
)

const MessageRenderer: React.FC<Props> = ({ message }) => {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const isUser = message.type === 'user'
  const isSystem = message.type === 'system'
  const { activeMessageId, isStreaming, messages, currentChatId, planReadyForMessageId, deepPlanReadyForMessageId } =
    useChatStore((state) => ({
      activeMessageId: state.activeMessageId,
      isStreaming: state.isStreaming,
      messages: state.messages,
      currentChatId: state.currentChatId,
      planReadyForMessageId: state.planReadyForMessageId,
      deepPlanReadyForMessageId: state.deepPlanReadyForMessageId,
    }))
  const isStreamingMessage = isLiveAgentTurn(
    message,
    isStreaming,
    activeMessageId,
    messages,
  )
  const isHistorical = message.type === 'agent' && !isStreamingMessage
  const pendingLabel = describePendingMessage(message)
  const shouldRenderProcess =
    message.type === 'agent' && Boolean(message.events?.length)

  const turnChangeSummary = useMemo(
    () =>
      shouldRenderProcess
        ? collectMessageFileChanges(message.events || [], message.content)
        : { changes: [], snapshotId: '', sessionId: '', messageId: '' },
    [message.events, message.content, shouldRenderProcess]
  )

  const hasPlanPermissionRequest = useMemo(
    () => message.events?.some((e) => e.type === 'plan_permission_request'),
    [message.events]
  )

  const hasDeepPlanPermissionRequest = useMemo(
    () => message.events?.some((e) => e.type === 'deep_plan_permission_request'),
    [message.events]
  )

  const deepPlanMeta = useMemo(() => {
    const evt = message.events?.find((e) => e.type === 'deep_plan_permission_request')
    const meta = evt?.metadata
    return {
      pipelineId: typeof meta?.pipeline_id === 'string' ? meta.pipeline_id : '',
      title: typeof meta?.title === 'string' ? meta.title : undefined,
    }
  }, [message.events])

  const renderedAssistantContent = message.content ? renderAssistantText(message.content) : null
  const messageAttachments = message.attachments ?? []

  const renderedStreamingAssistantContent = isStreamingMessage && message.content ? (
    <div
      className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[var(--vs-text-primary)]"
      aria-live="polite"
    >
      <span>{message.content}</span>
    </div>
  ) : null

  const hasRenderableTurn =
    shouldRenderProcess &&
    (Boolean(message.events?.length) || Boolean(message.content?.trim()))

  if (isSystem) {
    return (
      <div className="flex py-2 animate-fade-up">
        <div className="w-full">
          <div className="rounded-2xl bg-white/[0.03] px-3 py-2.5 text-[13px] leading-6 text-[var(--vs-text-secondary)]">
            {message.content}
          </div>
        </div>
      </div>
    )
  }

  if (
    !isUser &&
    !isSystem &&
    !isStreamingMessage &&
    !message.content?.trim() &&
    !hasRenderableTurn &&
    !hasPlanPermissionRequest &&
    !hasDeepPlanPermissionRequest
  ) {
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
          className={isUser ? 'user-bubble inline-block max-w-full' : 'agent-thread w-full min-w-0'}
        >
          {shouldRenderProcess ? (
            <div className="flex flex-col gap-1.5">
              {hasRenderableTurn ? (
                <AgentTurnView
                  events={message.events || []}
                  content={message.content}
                  messageStartedAt={message.timestamp}
                  turnDurationMs={message.turnDurationMs}
                  isLive={isStreamingMessage}
                  messageId={message.id}
                />
              ) : null}

              {hasPlanPermissionRequest && (() => {
                let planStatus: 'generating' | 'ready' | 'executed' = 'generating';
                if (planReadyForMessageId === message.id) {
                  planStatus = 'ready';
                } else if (isHistorical) {
                  planStatus = 'executed';
                }
                return <PlanCard status={planStatus} />;
              })()}

              {hasDeepPlanPermissionRequest && deepPlanMeta.pipelineId && (() => {
                let deepStatus: 'running' | 'ready' | 'resolved' = 'running';
                if (deepPlanReadyForMessageId === message.id) {
                  deepStatus = 'ready';
                } else if (isHistorical) {
                  deepStatus = 'resolved';
                }
                return (
                  <DeepPlanCard
                    pipelineId={deepPlanMeta.pipelineId}
                    title={deepPlanMeta.title}
                    status={deepStatus}
                  />
                );
              })()}

              {!isStreamingMessage && turnChangeSummary.changes.length > 0 && (
                <FileChangesCard
                  changes={turnChangeSummary.changes}
                  snapshotId={turnChangeSummary.snapshotId}
                  sessionId={turnChangeSummary.sessionId}
                  messageId={turnChangeSummary.messageId}
                  isHistorical={isHistorical}
                />
              )}
            </div>
          ) : (
            <>
              {isUser && messageAttachments.length > 0 && (
                <AttachmentThumbnails
                  attachments={messageAttachments}
                  onPreview={setPreviewIndex}
                  size="message"
                />
              )}
              {renderedStreamingAssistantContent ??
                (renderedAssistantContent &&
                  (isUser ? (
                    <div className="relative">
                      {message.content ? (
                        <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#f4f7ff]">
                          {message.content}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    renderedAssistantContent
                  )))}
            </>
          )}

          {!message.content && !isUser && (!message.events || message.events.length === 0) && (
            <div className="flex items-center gap-2 text-sm leading-6 text-[var(--vs-text-tertiary)]">
              {isStreamingMessage && <span className="h-1.5 w-1.5 rounded-full bg-[var(--vs-accent)] animate-pulse" />}
              <p>{pendingLabel}</p>
            </div>
          )}

          {isUser && !message.content && messageAttachments.length > 0 && previewIndex === null && (
            <span className="sr-only">Image attachment</span>
          )}
        </div>

        {previewIndex !== null && messageAttachments.length > 0 && (
          <ImagePreviewModal
            attachments={messageAttachments}
            initialIndex={previewIndex}
            onClose={() => setPreviewIndex(null)}
          />
        )}

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
              className="p-1.5 rounded-md text-[var(--vs-text-tertiary)] hover:text-white hover:bg-white/[0.05] transition-colors"
              title="Edit Message (Removes subsequent agent responses)"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(message.content)}
              className="p-1.5 rounded-md text-[var(--vs-text-tertiary)] hover:text-white hover:bg-white/[0.05] transition-colors"
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
