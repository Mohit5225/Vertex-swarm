import React, { useEffect, useMemo, useState } from 'react'
import { type SessionEvent } from '../store/chatStore'
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
  response?: React.ReactNode
}

const typeLabel = (event: SessionEvent) => {
  if (event.type === 'thinking') {
    return null
  }

  return event.type.replace(/_/g, ' ')
}

const normalizeText = (value?: string) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''

const getEventMeta = (event: SessionEvent) => {
  switch (event.type) {
    case 'thinking':
      return {
        accent: 'text-[#b8c3ff]',
        nodeBorder: 'border-[#91a0ff]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(145,160,255,0.12)]',
        icon: <Cpu className="h-4 w-4" />,
      }
    case 'code':
      return {
        accent: 'text-[#9ad8ff]',
        nodeBorder: 'border-[#73cfff]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(115,207,255,0.12)]',
        icon: <Play className="h-4 w-4" />,
      }
    case 'tool_call':
      return {
        accent: 'text-[#f1cb78]',
        nodeBorder: 'border-[#f1cb78]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(241,203,120,0.12)]',
        icon: <Wrench className="h-4 w-4" />,
      }
    case 'tool_result':
      return {
        accent: 'text-[#8fd2ff]',
        nodeBorder: 'border-[#8fd2ff]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(143,210,255,0.12)]',
        icon: <CheckCircle2 className="h-4 w-4" />,
      }
    case 'error':
      return {
        accent: 'text-[#ff9d97]',
        nodeBorder: 'border-[#ff9d97]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(255,157,151,0.14)]',
        icon: <AlertCircle className="h-4 w-4" />,
      }
    case 'status':
      return {
        accent: 'text-[#7ddcc5]',
        nodeBorder: 'border-[#7ddcc5]/25',
        nodeGlow: 'shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(125,220,197,0.12)]',
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

const AgentTimeline: React.FC<Props> = ({
  events,
  isStreaming = false,
  response,
}) => {
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setExpandedOverrides((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([eventId]) =>
          events.some((event) => event.id === eventId)
        )
      )
    )
  }, [events])

  const activeIndex = isStreaming && events.length > 0 ? events.length - 1 : -1
  const hasResponse = Boolean(response)

  const steps = useMemo(
    () =>
      events.map((event, index) => {
        const detail = normalizeText(getTraceEventDetail(event))
        const summary = getTraceEventSummary(event)
        const hasDetail = Boolean(detail)
        const isActive = index === activeIndex

        return {
          event,
          detail,
          summary,
          title: getTraceEventTitle(event),
          meta: getEventMeta(event),
          hasDetail,
          isActive,
          isExpanded: expandedOverrides[event.id] ?? (hasDetail && isActive),
          stepNumber: index + 1,
          showConnector: index < events.length - 1 || hasResponse,
        }
      }),
    [activeIndex, events, expandedOverrides, hasResponse]
  )

  const toggleStep = (eventId: string) => {
    setExpandedOverrides((current) => ({
      ...current,
      [eventId]: !(current[eventId] ?? false),
    }))
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

  const renderCollapsedStep = ({
    event,
    title,
    summary,
    meta,
    stepNumber,
    hasDetail,
  }: (typeof steps)[number]) => {
    const content = (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
            <span className={meta.accent}>{title}</span>
            <span className="text-[#667694]">Step {stepNumber}</span>
            {typeLabel(event) ? (
              <span className="text-[#576682]">{typeLabel(event)}</span>
            ) : null}
          </div>
          <p className="mt-2.5 max-w-[58rem] text-[13px] leading-7 text-[#96a5c2]">
            {summary}
          </p>
        </div>
        {hasDetail ? renderChevron(false) : null}
      </div>
    )

    if (!hasDetail) {
      return content
    }

    return (
      <button
        type="button"
        onClick={() => toggleStep(event.id)}
        className="w-full text-left transition hover:opacity-100"
      >
        {content}
      </button>
    )
  }

  const renderExpandedStep = ({
    event,
    title,
    summary,
    detail,
    meta,
    stepNumber,
    hasDetail,
  }: (typeof steps)[number]) => (
    <div className="rounded-[30px] border border-[#d5e3ff]/18 bg-[linear-gradient(180deg,rgba(24,31,47,0.96),rgba(17,23,36,0.98))] px-6 py-5 shadow-[0_18px_36px_rgba(0,0,0,0.26)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
            <span className={meta.accent}>{title}</span>
            <span className="text-[#7282a2]">Step {stepNumber}</span>
            {typeLabel(event) ? (
              <span className="text-[#5d6c89]">{typeLabel(event)}</span>
            ) : null}
          </div>
          <p className="mt-2.5 max-w-[56rem] text-[14px] font-medium leading-8 text-[#edf3ff]">
            {summary}
          </p>
        </div>

        {hasDetail ? (
          <button
            type="button"
            onClick={() => toggleStep(event.id)}
            className="shrink-0"
          >
            {renderChevron(true)}
          </button>
        ) : null}
      </div>

      {hasDetail && detail && (
        <div className="mt-5 overflow-hidden rounded-[24px] border border-white/[0.05] bg-[#0d1320]/88">
          <div className="border-b border-white/[0.04] px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#7382a0]">
            Detail
          </div>
          <div className="max-h-[22rem] overflow-y-auto px-5 py-5 text-[13px] leading-8 text-[#a6b5d1] whitespace-pre-wrap break-words">
            {detail}
          </div>
        </div>
      )}
    </div>
  )

  const renderEventRow = (step: (typeof steps)[number]) => {
    const isExpanded = step.isExpanded && step.hasDetail
    const nodeIcon =
      isExpanded || step.isActive || step.event.type === 'error'
        ? step.meta.icon
        : <Check className="h-4 w-4" />

    return (
      <div key={step.event.id} className="relative pl-[3.65rem]">
        <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
          <div
            className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-[#101722] text-[#eaf1ff] ${step.meta.nodeBorder} ${step.meta.nodeGlow} border`}
          >
            {nodeIcon}
          </div>
          {step.showConnector && (
            <div className="mt-2 w-px flex-1 bg-gradient-to-b from-white/[0.08] via-white/[0.04] to-transparent" />
          )}
        </div>

        {isExpanded ? renderExpandedStep(step) : renderCollapsedStep(step)}
      </div>
    )
  }

  return (
    <div className="w-full space-y-5">
      {steps.map(renderEventRow)}

      {response ? (
        <div className="relative pl-[3.65rem]">
          <div className="absolute left-0 top-0 flex h-full w-10 flex-col items-center">
            <div className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border border-[#d9c6ff]/20 bg-[#151220] text-[#d9c6ff] shadow-[0_0_0_6px_rgba(10,14,22,0.98),0_0_22px_rgba(217,198,255,0.1)]">
              {isStreaming ? (
                <Sparkles className="h-4 w-4" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </div>
          </div>

          <div className="rounded-[30px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(25,31,43,0.96),rgba(17,22,31,0.98))] px-6 py-5 shadow-[0_18px_36px_rgba(0,0,0,0.24)]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
              <span className="text-[#f2f0df]">
                {isStreaming ? 'Drafting Response' : 'Final Answer'}
              </span>
              <span className="text-[#6f7e99]">
                {isStreaming ? 'Official text is still forming' : 'Ready to read'}
              </span>
            </div>

            <div className="mt-4">{response}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default AgentTimeline
