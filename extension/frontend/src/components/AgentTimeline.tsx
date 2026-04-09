import React, { useEffect, useMemo, useState } from 'react'
import { type SessionEvent } from '../store/chatStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Play,
  Sparkles,
  Wrench,
} from 'lucide-react'
import {
  getTraceEventDetail,
  getTraceEventSummary,
  getTraceEventTitle,
} from '../lib/trace'

interface Props {
  events: SessionEvent[]
  isStreaming?: boolean
  messageContent?: string
}

type EventDisplayItem = {
  kind: 'event'
  id: string
  event: SessionEvent
  detail: string
  summary: string
  title: string
  stepNumber: number
  hasDetail: boolean
}

type ResponseDisplayItem = {
  kind: 'response'
  id: string
  text: string
  isFallback: boolean
  hasLaterItems: boolean
  isPartial: boolean
}

type DisplayItem = EventDisplayItem | ResponseDisplayItem

type EventBatchSegment = {
  kind: 'event-batch'
  id: string
  items: EventDisplayItem[]
  tucked: boolean
}

type ResponseSegment = {
  kind: 'response'
  id: string
  item: ResponseDisplayItem
}

type DisplaySegment = EventBatchSegment | ResponseSegment

const normalizeText = (value?: string) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''

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
    segments.length >= 4 &&
    averageSegmentLength > 0 &&
    averageSegmentLength < 28

  if (!looksFragmented) {
    return normalized.replace(/(?<!\n)\n(?!\n)/g, ' ')
  }

  return segments.join(' ').replace(/\s+([,.;:!?])/g, '$1')
}

const typeLabel = (event: SessionEvent) => {
  if (event.type === 'thinking') {
    return null
  }

  return event.type.replace(/_/g, ' ')
}

const getEventMeta = (event: SessionEvent) => {
  switch (event.type) {
    case 'thinking':
      return {
        accent: 'text-[#b8c3ff]',
        nodeBorder: 'border-[#91a0ff]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(145,160,255,0.12)]',
        icon: <Cpu className="h-4 w-4" />,
      }
    case 'code':
      return {
        accent: 'text-[#9ad8ff]',
        nodeBorder: 'border-[#73cfff]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(115,207,255,0.12)]',
        icon: <Play className="h-4 w-4" />,
      }
    case 'tool_call':
      return {
        accent: 'text-[#f1cb78]',
        nodeBorder: 'border-[#f1cb78]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(241,203,120,0.12)]',
        icon: <Wrench className="h-4 w-4" />,
      }
    case 'tool_result':
      return {
        accent: 'text-[#8fd2ff]',
        nodeBorder: 'border-[#8fd2ff]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(143,210,255,0.12)]',
        icon: <CheckCircle2 className="h-4 w-4" />,
      }
    case 'error':
      return {
        accent: 'text-[#ff9d97]',
        nodeBorder: 'border-[#ff9d97]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(255,157,151,0.14)]',
        icon: <AlertCircle className="h-4 w-4" />,
      }
    case 'status':
      return {
        accent: 'text-[#7ddcc5]',
        nodeBorder: 'border-[#7ddcc5]/25',
        nodeGlow:
          'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(125,220,197,0.12)]',
        icon: <Sparkles className="h-4 w-4" />,
      }
    default:
      return {
        accent: 'text-[#c5d2ee]',
        nodeBorder: 'border-[#c5d2ee]/20',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98)]',
        icon: <CheckCircle2 className="h-4 w-4" />,
      }
  }
}

const renderChevron = (expanded: boolean) => (
  <span
    className={`inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-[#8191b0] transition ${
      expanded ? 'rotate-180' : ''
    }`}
  >
    <ChevronDown className="h-4 w-4" />
  </span>
)

const AgentTimeline: React.FC<Props> = ({
  events,
  isStreaming = false,
  messageContent,
}) => {
  const [expandedOverrides, setExpandedOverrides] = useState<
    Record<string, boolean>
  >({})
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>(
    {}
  )

  const displayItems = useMemo(() => {
    const items: DisplayItem[] = []
    let stepNumber = 0
    let bufferedOutput = ''
    let bufferedOutputId = ''

    const flushOutput = (hasLaterItems: boolean) => {
      if (!bufferedOutput) {
        return
      }

      items.push({
        kind: 'response',
        id: bufferedOutputId || `response-${items.length + 1}`,
        text: bufferedOutput,
        isFallback: false,
        hasLaterItems,
        isPartial: false,
      })
      bufferedOutput = ''
      bufferedOutputId = ''
    }

    events.forEach((event, index) => {
      const isCompletedStatus =
        event.type === 'status' &&
        (event.metadata?.phase === 'completed' ||
          normalizeText(event.content).toLowerCase() === 'final answer ready.')

      if (isCompletedStatus) {
        return
      }

      if (event.type === 'output') {
        if (!bufferedOutputId) {
          bufferedOutputId = event.id
        }
        bufferedOutput += event.content || ''
        return
      }

      flushOutput(true)
      stepNumber += 1
      items.push({
        kind: 'event',
        id: event.id,
        event,
        detail: normalizeText(getTraceEventDetail(event)),
        summary: getTraceEventSummary(event),
        title: getTraceEventTitle(event),
        stepNumber,
        hasDetail: Boolean(normalizeText(getTraceEventDetail(event))),
      })

      if (index === events.length - 1) {
        flushOutput(false)
      }
    })

    flushOutput(false)

    const hasResponseFromEvents = items.some((item) => item.kind === 'response')
    const normalizedMessageContent = normalizeText(messageContent)
    const lastNonOutputEvent = [...events]
      .reverse()
      .find((event) => event.type !== 'output')

    if (!hasResponseFromEvents && normalizedMessageContent) {
      items.push({
        kind: 'response',
        id: 'fallback-response',
        text: normalizedMessageContent,
        isFallback: true,
        hasLaterItems: false,
        isPartial: lastNonOutputEvent?.type === 'error',
      })
    }

    return items
  }, [events, messageContent])

  const displaySegments = useMemo(() => {
    const segments: DisplaySegment[] = []
    let currentBatch: EventDisplayItem[] = []
    let hasSeenResponse = false

    const flushBatch = () => {
      if (currentBatch.length === 0) {
        return
      }

      segments.push({
        kind: 'event-batch',
        id: `batch-${currentBatch[0].id}-${currentBatch[currentBatch.length - 1].id}`,
        items: currentBatch,
        tucked: hasSeenResponse,
      })
      currentBatch = []
    }

    displayItems.forEach((item) => {
      if (item.kind === 'event') {
        currentBatch.push(item)
        return
      }

      flushBatch()
      segments.push({
        kind: 'response',
        id: item.id,
        item,
      })
      hasSeenResponse = true
    })

    flushBatch()

    return segments
  }, [displayItems])

  useEffect(() => {
    setExpandedOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([itemId]) =>
          displayItems.some((item) => item.id === itemId && item.kind === 'event')
        )
      )
    )
    setExpandedBatches((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([batchId]) =>
          displaySegments.some(
            (segment) => segment.kind === 'event-batch' && segment.id === batchId
          )
        )
      )
    )
  }, [displayItems, displaySegments])

  const activeItemId = isStreaming
    ? displayItems[displayItems.length - 1]?.id ?? null
    : null

  const toggleStep = (itemId: string) => {
    setExpandedOverrides((current) => ({
      ...current,
      [itemId]: !(current[itemId] ?? false),
    }))
  }

  const toggleBatch = (batchId: string) => {
    setExpandedBatches((current) => ({
      ...current,
      [batchId]: !(current[batchId] ?? false),
    }))
  }

  const summarizeBatch = (items: EventDisplayItem[]) => {
    const titles = Array.from(new Set(items.map((item) => item.title))).slice(0, 3)
    const preview = titles.join(' · ')

    return {
      title:
        items.length === 1
          ? '1 process step tucked away'
          : `${items.length} process steps tucked away`,
      preview,
    }
  }

  const renderCollapsedEvent = (
    item: EventDisplayItem,
    showConnector: boolean
  ) => {
    const meta = getEventMeta(item.event)
    const content = (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
            <span className={meta.accent}>{item.title}</span>
            <span className="text-[#667694]">Step {item.stepNumber}</span>
            {typeLabel(item.event) ? (
              <span className="text-[#576682]">{typeLabel(item.event)}</span>
            ) : null}
          </div>
          <p className="mt-2.5 max-w-[58rem] text-[13px] leading-7 text-[#96a5c2]">
            {item.summary}
          </p>
        </div>
        {item.hasDetail ? renderChevron(false) : null}
      </div>
    )

    return (
      <div key={item.id} className="relative pl-[3.65rem]">
        <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
          <div
            className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-[#101722] text-[#eaf1ff] ${meta.nodeBorder} ${meta.nodeGlow}`}
          >
            <Check className="h-4 w-4" />
          </div>
          {showConnector ? (
            <div className="mt-2 w-px flex-1 bg-gradient-to-b from-white/[0.08] via-white/[0.04] to-transparent" />
          ) : null}
        </div>

        {item.hasDetail ? (
          <button
            type="button"
            onClick={() => toggleStep(item.id)}
            className="w-full text-left"
          >
            {content}
          </button>
        ) : (
          content
        )}
      </div>
    )
  }

  const renderExpandedEvent = (
    item: EventDisplayItem,
    showConnector: boolean,
    isActive: boolean
  ) => {
    const meta = getEventMeta(item.event)

    return (
      <div key={item.id} className="relative pl-[3.65rem]">
        <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
          <div
            className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border bg-[#101722] text-[#eaf1ff] ${meta.nodeBorder} ${meta.nodeGlow}`}
          >
            {isActive || item.event.type === 'error' ? meta.icon : <Check className="h-4 w-4" />}
          </div>
          {showConnector ? (
            <div className="mt-2 w-px flex-1 bg-gradient-to-b from-white/[0.08] via-white/[0.04] to-transparent" />
          ) : null}
        </div>

        <div className="rounded-[30px] border border-[#d5e3ff]/18 bg-[linear-gradient(180deg,rgba(24,31,47,0.96),rgba(17,23,36,0.98))] px-6 py-5 shadow-[0_18px_36px_rgba(0,0,0,0.26)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
                <span className={meta.accent}>{item.title}</span>
                <span className="text-[#7282a2]">Step {item.stepNumber}</span>
                {typeLabel(item.event) ? (
                  <span className="text-[#5d6c89]">{typeLabel(item.event)}</span>
                ) : null}
              </div>
              <p className="mt-2.5 max-w-[56rem] text-[14px] font-medium leading-8 text-[#edf3ff]">
                {item.summary}
              </p>
            </div>

            {item.hasDetail ? (
              <button
                type="button"
                onClick={() => toggleStep(item.id)}
                className="shrink-0"
              >
                {renderChevron(true)}
              </button>
            ) : null}
          </div>

          {item.detail ? (
            <div className="mt-5 overflow-hidden rounded-[24px] border border-white/[0.05] bg-[#0d1320]/88">
              <div className="border-b border-white/[0.04] px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#7382a0]">
                Detail
              </div>
              <div className="max-h-[22rem] overflow-y-auto px-5 py-5 text-[13px] leading-8 text-[#a6b5d1] whitespace-pre-wrap break-words">
                {item.detail}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const renderResponseItem = (
    item: ResponseDisplayItem,
    showConnector: boolean,
    isActive: boolean
  ) => {
    const isDraft = isActive || item.hasLaterItems
    const normalizedText = normalizeAssistantContent(item.text)
    const shouldRenderMarkdown = !isDraft && !item.isPartial

    return (
      <div key={item.id} className="relative pl-[3.65rem]">
        <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
          <div className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border border-[#d9c6ff]/20 bg-[#151220] text-[#d9c6ff] shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(217,198,255,0.1)]">
            {isDraft ? (
              <Sparkles className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </div>
          {showConnector ? (
            <div className="mt-2 w-px flex-1 bg-gradient-to-b from-white/[0.08] via-white/[0.04] to-transparent" />
          ) : null}
        </div>

        <div className="rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(25,31,43,0.96),rgba(17,22,31,0.98))] px-6 py-5 shadow-[0_18px_36px_rgba(0,0,0,0.24)]">
          <div>
            {shouldRenderMarkdown ? (
              <div className="message-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {normalizedText}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="message-streaming">{normalizedText}</div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderTuckedBatch = (
    segment: EventBatchSegment,
    showConnector: boolean
  ) => {
    const isExpanded = expandedBatches[segment.id] ?? false
    const summary = summarizeBatch(segment.items)

    return (
      <div key={segment.id} className="relative pl-[3.65rem]">
        <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
          <div className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-[#101722] text-[#eaf1ff] shadow-[0_0_0_6px_rgba(10,14,22,0.98)]">
            <Check className="h-4 w-4" />
          </div>
          {showConnector ? (
            <div className="mt-2 w-px flex-1 bg-gradient-to-b from-white/[0.08] via-white/[0.04] to-transparent" />
          ) : null}
        </div>

        <div className="rounded-[24px] border border-white/[0.05] bg-white/[0.02] px-5 py-4">
          <button
            type="button"
            onClick={() => toggleBatch(segment.id)}
            className="flex w-full items-start justify-between gap-4 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#d8e2f4]">
                {summary.title}
              </div>
              <p className="mt-2 text-[13px] leading-7 text-[#8494b3]">
                {summary.preview || 'Open to inspect the hidden execution steps.'}
              </p>
            </div>
            {renderChevron(isExpanded)}
          </button>

          {isExpanded ? (
            <div className="mt-5 space-y-5 border-t border-white/[0.05] pt-5">
              {segment.items.map((item, index) => {
                const isActive = item.id === activeItemId
                const itemExpanded =
                  item.hasDetail && (expandedOverrides[item.id] ?? isActive)
                const innerShowConnector = index < segment.items.length - 1

                return itemExpanded
                  ? renderExpandedEvent(item, innerShowConnector, isActive)
                  : renderCollapsedEvent(item, innerShowConnector)
              })}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-5">
      {displaySegments.map((segment, index) => {
        const showConnector = index < displaySegments.length - 1

        if (segment.kind === 'response') {
          return renderResponseItem(
            segment.item,
            showConnector,
            segment.item.id === activeItemId
          )
        }

        if (segment.tucked) {
          return renderTuckedBatch(segment, showConnector)
        }

        return segment.items.map((item, itemIndex) => {
          const isActive = item.id === activeItemId
          const isExpanded =
            item.hasDetail && (expandedOverrides[item.id] ?? isActive)
          const innerShowConnector =
            itemIndex < segment.items.length - 1 || showConnector

          return isExpanded
            ? renderExpandedEvent(item, innerShowConnector, isActive)
            : renderCollapsedEvent(item, innerShowConnector)
        })
      })}
    </div>
  )
}

export default AgentTimeline
