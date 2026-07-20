import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, Loader2 } from 'lucide-react'
import {
  buildAgentTurnTimeline,
  finalizeAgentTurnTimeline,
  formatDuration,
  formatExploreSummary,
  formatThoughtSummary,
  getNodeDurationMs,
  getThoughtDurationMs,
  segmentIsAlwaysVisible,
  segmentIsLive,
  summarizeTurnRollup,
  turnHasLiveWork,
  type TurnSegment,
} from '../lib/agentTurnTimeline'
import { type SessionEvent } from '../store/chatStore'
import { FileEditRow, TerminalCard } from './AgentProcess'
import ToolCallDebugPanel from './ToolCallDebugPanel'

interface Props {
  events: SessionEvent[]
  content?: string
  messageStartedAt?: number
  turnDurationMs?: number
  isLive: boolean
}

const normalizeAssistantContent = (content: string) => content.replace(/\r\n/g, '\n')

const renderAssistantText = (content: string) => (
  <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {normalizeAssistantContent(content)}
    </ReactMarkdown>
  </div>
)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const truncateCommand = (command: string, maxLength = 72) => {
  const trimmed = command.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }
  return `${trimmed.slice(0, maxLength - 1)}…`
}

const formatTerminalSummary = (segment: Extract<TurnSegment, { kind: 'terminal' }>) => {
  const { node } = segment
  const data = asRecord(asRecord(node.resultDebug)?.data)
  const payload = asRecord(asRecord(node.requestDebug)?.args)?.payload
  const payloadRecord = asRecord(payload)
  const command = truncateCommand(
    (typeof data?.command === 'string' && data.command) ||
      (typeof payloadRecord?.command === 'string' && payloadRecord.command) ||
      node.summary
  )

  const exitCode = data?.exit_code
  const durationMs = getNodeDurationMs(node)

  if (node.state === 'running') {
    return `Running \`${command}\``
  }

  const exitLabel =
    exitCode !== undefined && exitCode !== null ? `exit ${exitCode}` : undefined
  const durationLabel = durationMs ? formatDuration(durationMs) : undefined
  const tail = [exitLabel, durationLabel].filter(Boolean).join(' · ')
  return tail ? `Ran \`${command}\` · ${tail}` : `Ran \`${command}\``
}

const THOUGHT_PANEL_CLASS =
  'max-h-[min(42vh,14rem)] overflow-y-auto overscroll-contain rounded-md border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] leading-6 text-[#b4c4de] [scrollbar-width:thin] [scrollbar-color:rgba(143,163,196,0.45)_transparent]'

const WorkReceipt: React.FC<{
  label: string
  isLive?: boolean
  expanded: boolean
  onToggle: () => void
  children?: React.ReactNode
}> = ({ label, isLive, expanded, onToggle, children }) => (
  <div className="py-0.5">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition hover:bg-white/[0.03]"
    >
      {isLive ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#5e6ad2]" />
      ) : null}
      <span className="text-[12px] font-medium text-[#7384a3]">{label}</span>
      {children ? (
        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[#6f81a1]">
          <ChevronDown className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
        </span>
      ) : null}
    </button>
    {children && expanded ? <div className="mt-1 pl-5">{children}</div> : null}
  </div>
)

const AgentTurnView: React.FC<Props> = ({
  events,
  content,
  messageStartedAt,
  turnDurationMs: persistedTurnDurationMs,
  isLive,
}) => {
  const timeline = useMemo(() => {
    const built = buildAgentTurnTimeline(
      events,
      content,
      messageStartedAt,
      isLive,
      persistedTurnDurationMs
    )
    return finalizeAgentTurnTimeline(built, isLive)
  }, [content, events, isLive, messageStartedAt, persistedTurnDurationMs])

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [traceExpanded, setTraceExpanded] = useState(isLive)
  const wasLiveRef = useRef(isLive)

  useEffect(() => {
    if (isLive) {
      setTraceExpanded(true)
    } else if (wasLiveRef.current) {
      setTraceExpanded(false)
    }
    wasLiveRef.current = isLive
  }, [isLive])

  const hasToolWork = timeline.hasToolWork
  const hasVisibleNarrative = useMemo(
    () =>
      timeline.segments.some(
        (segment) => segment.kind === 'narrative' && segment.text.trim().length > 0
      ),
    [timeline.segments]
  )

  const isWorking =
    isLive &&
    (hasToolWork
      ? turnHasLiveWork(timeline.segments, isLive)
      : !hasVisibleNarrative)
  const turnDurationMs = timeline.durationMs
  const rollup = useMemo(
    () => (!isWorking ? summarizeTurnRollup(timeline.segments) : null),
    [isWorking, timeline.segments]
  )
  const turnLabel = isWorking
    ? 'Working…'
    : `Worked for ${formatDuration(turnDurationMs)}`

  const toggle = (id: string) => {
    setExpanded((current) => ({ ...current, [id]: !current[id] }))
  }

  return (
    <div className="flex flex-col gap-1">
      {hasToolWork ? (
        <button
          type="button"
          onClick={() => setTraceExpanded((value) => !value)}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition hover:bg-white/[0.03]"
        >
          {isWorking ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#5e6ad2]" />
          ) : null}
          <span className="text-[12px] font-medium text-[#7384a3]">{turnLabel}</span>
          {rollup ? (
            <span className="text-[11px] font-medium text-[#6f81a1]">{rollup}</span>
          ) : null}
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-[#6f81a1] transition ${traceExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      ) : null}

      {isLive && !hasToolWork && !hasVisibleNarrative ? (
        <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-[#7384a3]">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#5e6ad2]" />
          <span>Working…</span>
        </div>
      ) : null}

      {timeline.segments.map((segment) => {
        if (segment.kind === 'narrative') {
          if (!segment.text.trim()) {
            return null
          }

          return (
            <div
              key={segment.id}
              className={`break-words text-[15px] leading-7 ${segment.tone === 'code'
                ? 'font-medium text-[#d9e6fb]'
                : 'text-[#edf3ff]'
                }`}
            >
              {renderAssistantText(segment.text)}
            </div>
          )
        }

        if (
          !traceExpanded &&
          !segmentIsAlwaysVisible(segment) &&
          !segmentIsLive(segment, isLive)
        ) {
          return null
        }

        if (segment.kind === 'thought') {
          if (!hasToolWork) {
            return null
          }

          const durationMs = getThoughtDurationMs(segment)
          const label = formatThoughtSummary(durationMs, segment.isLive)
          const isExpanded = expanded[segment.id] ?? false
          return (
            <WorkReceipt
              key={segment.id}
              label={label}
              isLive={segment.isLive}
              expanded={isExpanded}
              onToggle={() => toggle(segment.id)}
            >
              <div className={`${THOUGHT_PANEL_CLASS} whitespace-pre-wrap`}>
                {segment.text}
              </div>
            </WorkReceipt>
          )
        }

        if (segment.kind === 'explore') {
          const label = formatExploreSummary(
            {
              filesRead: segment.filesRead,
              searches: segment.searches,
              lists: segment.lists,
            },
            segment.isLive
          )
          const isExpanded = expanded[segment.id] ?? false
          return (
            <WorkReceipt
              key={segment.id}
              label={label}
              isLive={segment.isLive}
              expanded={isExpanded}
              onToggle={() => toggle(segment.id)}
            >
              <div className="space-y-1">
                {segment.nodes.map((node) => {
                  const nodeExpanded = expanded[`${segment.id}:${node.id}`] ?? false
                  return (
                    <WorkReceipt
                      key={node.id}
                      label={node.summary}
                      isLive={node.state === 'running'}
                      expanded={nodeExpanded}
                      onToggle={() => toggle(`${segment.id}:${node.id}`)}
                    >
                      <ToolCallDebugPanel node={node} />
                    </WorkReceipt>
                  )
                })}
              </div>
            </WorkReceipt>
          )
        }

        if (segment.kind === 'context') {
          return (
            <p key={segment.id} className="px-1 text-[12px] leading-5 text-[#7384a3]">
              {segment.label}
            </p>
          )
        }

        if (segment.kind === 'edit') {
          return (
            <FileEditRow
              key={segment.id}
              node={segment.node}
              expanded={expanded[segment.id] ?? false}
              onToggle={() => toggle(segment.id)}
            />
          )
        }

        if (segment.kind === 'terminal') {
          const isExpanded = expanded[segment.id] ?? false
          return (
            <div key={segment.id}>
              <WorkReceipt
                label={formatTerminalSummary(segment)}
                isLive={segment.node.state === 'running'}
                expanded={isExpanded}
                onToggle={() => toggle(segment.id)}
              >
                <TerminalCard node={segment.node} expanded />
              </WorkReceipt>
            </div>
          )
        }

        if (segment.kind === 'tool') {
          const isExpanded = expanded[segment.id] ?? false
          return (
            <WorkReceipt
              key={segment.id}
              label={segment.node.summary}
              isLive={segment.node.state === 'running'}
              expanded={isExpanded}
              onToggle={() => toggle(segment.id)}
            >
              <ToolCallDebugPanel node={segment.node} />
            </WorkReceipt>
          )
        }

        if (segment.kind === 'system') {
          return (
            <div
              key={segment.id}
              className={`rounded-2xl px-3 py-2.5 text-[13px] leading-6 ${segment.tone === 'error'
                ? 'bg-[#f27d75]/10 text-[#ffbeb8]'
                : segment.tone === 'warning'
                  ? 'bg-[#f1cb78]/10 text-[#f3d69a]'
                  : 'bg-white/[0.03] text-[#9fb0cd]'
                }`}
            >
              {segment.text}
            </div>
          )
        }

        return null
      })}
    </div>
  )
}

export default AgentTurnView
