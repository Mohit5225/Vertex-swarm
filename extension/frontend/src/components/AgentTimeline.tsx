import React, { useState } from 'react'
import { type SessionEvent } from '../store/chatStore'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Play,
  Wrench,
} from 'lucide-react'
import { getTraceEventSummary } from '../lib/trace'

interface Props {
  events: SessionEvent[]
}

const getEventMeta = (event: SessionEvent) => {
  switch (event.type) {
    case 'thinking':
      return {
        label: 'Reasoning',
        accent: 'bg-[#7f91b4]',
        icon: <Cpu className="h-4 w-4" />,
      }
    case 'code':
      return {
        label: 'Code Activity',
        accent: 'bg-[#87d8ff]',
        icon: <Play className="h-4 w-4" />,
      }
    case 'tool_call':
      return {
        label: 'Tool Call',
        accent: 'bg-[#f2c56f]',
        icon: <Wrench className="h-4 w-4" />,
      }
    case 'tool_result':
      return {
        label: 'Tool Result',
        accent: 'bg-[#63d1ff]',
        icon: <CheckCircle className="h-4 w-4" />,
      }
    case 'error':
      return {
        label: 'Issue',
        accent: 'bg-[#f27d75]',
        icon: <AlertCircle className="h-4 w-4" />,
      }
    case 'status':
      return {
        label: 'Status',
        accent: 'bg-[#48d2b4]',
        icon: <CheckCircle className="h-4 w-4" />,
      }
    default:
      return {
        label: 'Event',
        accent: 'bg-[#f2c56f]',
        icon: <CheckCircle className="h-4 w-4" />,
      }
  }
}

const AgentTimeline: React.FC<Props> = ({ events }) => {
  const [isExpanded, setIsExpanded] = useState(true)
  const [expandedEventIds, setExpandedEventIds] = useState<
    Record<string, boolean>
  >({})

  if (events.length === 0) return null

  const toggleEvent = (eventId: string) => {
    setExpandedEventIds((current) => ({
      ...current,
      [eventId]: !current[eventId],
    }))
  }

  const normalizeEventContent = (content?: string) =>
    typeof content === 'string' ? content.replace(/\r\n/g, '\n').trim() : ''

  const hasExpandableDetail = (event: SessionEvent, summary: string) => {
    const content = normalizeEventContent(event.content)

    if (!content || event.type === 'status') {
      return false
    }

    return content.includes('\n') || content.length > summary.length
  }

  return (
    <div className="mb-3 w-full">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between rounded-[16px] py-2 text-left transition-colors hover:bg-white/[0.025]"
      >
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#8bd7ff]/80 shadow-[0_0_0_6px_rgba(139,215,255,0.08)]" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#c3d1ea]">
              Agent Execution
            </span>
            <span className="text-[10px] font-medium text-[#7b8aa3]">
              {events.length} step{events.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <div className="text-[#6b7a91] transition-transform duration-200">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="mt-2">
          <div className="space-y-1">
            {events.map((event, index) => {
              const meta = getEventMeta(event)
              const summary = getTraceEventSummary(event)
              const isLast = index === events.length - 1
              const eventContent = normalizeEventContent(event.content)
              const canExpand = hasExpandableDetail(event, summary)
              const isEventExpanded =
                canExpand && Boolean(expandedEventIds[event.id])
              const showSummary = !isEventExpanded || !canExpand

              return (
                <div key={event.id} className="relative pl-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (canExpand) {
                        toggleEvent(event.id)
                      }
                    }}
                    className={`flex w-full items-start gap-3 rounded-[18px] px-1.5 py-2 text-left transition-colors ${
                      canExpand ? 'hover:bg-white/[0.03]' : ''
                    }`}
                  >
                    <div className="absolute left-0 top-2.5 flex h-full flex-col items-center">
                      <div
                        className={`h-2.5 w-2.5 rounded-full ring-[5px] ring-[#0b101a] ${meta.accent}`}
                      />
                      {!isLast && (
                        <div className="mt-2.5 w-px flex-1 bg-gradient-to-b from-[#41506a] via-[#2d394d] to-transparent" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {meta.icon}
                            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#e7eefc]">
                              {meta.label}
                            </span>
                          </div>
                          {showSummary && (
                            <p className="mt-1 truncate text-[13px] text-[#93a3c0]">
                              {summary}
                            </p>
                          )}
                        </div>

                        {canExpand && (
                          <div className="flex-shrink-0 pt-1 text-[#6b7a91]">
                            {isEventExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>

                  {isEventExpanded && (
                    <div className="pb-2 pl-3 pr-1">
                      <div className="whitespace-pre-wrap break-words border-l border-white/[0.06] pl-3 text-[13px] leading-6 text-[#91a0bb]">
                        {eventContent}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default AgentTimeline
