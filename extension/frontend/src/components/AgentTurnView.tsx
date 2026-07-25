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
  getThoughtDurationMs,
  segmentIsAlwaysVisible,
  segmentIsLive,
  summarizeLiveActivity,
  summarizeTurnRollup,
  turnHasLiveWork,
} from '../lib/agentTurnTimeline'
import { type SessionEvent } from '../store/chatStore'
import CollapsibleWorkRow from './CollapsibleWorkRow'
import DeepPlanJobList from './DeepPlanJobList'
import { FileEditRow } from './FileEditRow'
import TerminalToolCard from './TerminalToolCard'
import HilQuestionCard from './HilQuestionCard'
import DeepPlanEntryGate from './DeepPlanEntryGate'
import SpawnSubagentRow from './SpawnSubagentRow'
import ToolCallDebugPanel from './ToolCallDebugPanel'

interface Props {
  events: SessionEvent[]
  content?: string
  messageStartedAt?: number
  turnDurationMs?: number
  isLive: boolean
  messageId?: string
  /** When true, never collapse trace segments — used by AgentTracePanel. */
  alwaysExpandTrace?: boolean
}

const normalizeAssistantContent = (content: string) => content.replace(/\r\n/g, '\n')

const renderAssistantText = (content: string) => (
  <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {normalizeAssistantContent(content)}
    </ReactMarkdown>
  </div>
)

const THOUGHT_PANEL_CLASS =
  'max-h-[min(42vh,14rem)] overflow-y-auto overscroll-contain rounded-md border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] leading-6 text-[var(--vs-text-secondary)] [scrollbar-width:thin] [scrollbar-color:rgba(143,163,196,0.45)_transparent]'

const AgentTurnView: React.FC<Props> = ({
  events,
  content,
  messageStartedAt,
  turnDurationMs: persistedTurnDurationMs,
  isLive,
  messageId,
  alwaysExpandTrace = false,
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
  const [traceExpanded, setTraceExpanded] = useState(isLive || alwaysExpandTrace)
  const wasLiveRef = useRef(isLive)

  useEffect(() => {
    if (alwaysExpandTrace) {
      setTraceExpanded(true)
      return
    }
    if (isLive) {
      setTraceExpanded(true)
    } else if (wasLiveRef.current) {
      setTraceExpanded(false)
    }
    wasLiveRef.current = isLive
  }, [isLive, alwaysExpandTrace])

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
  const liveActivity = isWorking
    ? summarizeLiveActivity(timeline.segments)
    : null
  const turnLabel = isWorking
    ? (liveActivity ?? 'Working…')
    : alwaysExpandTrace
      ? `Subagent ran ${formatDuration(turnDurationMs)}`
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
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--vs-accent)]" />
          ) : null}
          <span className="text-[12px] font-medium text-[var(--vs-text-tertiary)]">{turnLabel}</span>
          {rollup ? (
            <span className="text-[11px] font-medium text-[var(--vs-text-tertiary)]">{rollup}</span>
          ) : null}
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-[var(--vs-text-tertiary)] transition ${traceExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      ) : null}

      {isLive && !hasToolWork && !hasVisibleNarrative ? (
        <div className="flex items-center gap-2 px-1 py-1 text-[12px] text-[var(--vs-text-tertiary)]">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--vs-accent)]" />
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
                ? 'font-medium text-[var(--vs-text-primary)]'
                : 'text-[var(--vs-text-primary)]'
                }`}
            >
              {renderAssistantText(segment.text)}
            </div>
          )
        }

        if (
          !traceExpanded &&
          !alwaysExpandTrace &&
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
            <CollapsibleWorkRow
              key={segment.id}
              label={label}
              isLive={segment.isLive}
              expanded={isExpanded}
              onToggle={() => toggle(segment.id)}
            >
              <div className={`${THOUGHT_PANEL_CLASS} whitespace-pre-wrap`}>
                {segment.text}
              </div>
            </CollapsibleWorkRow>
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
            <CollapsibleWorkRow
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
                    <CollapsibleWorkRow
                      key={node.id}
                      label={node.summary}
                      isLive={node.state === 'running'}
                      expanded={nodeExpanded}
                      onToggle={() => toggle(`${segment.id}:${node.id}`)}
                    >
                      <ToolCallDebugPanel node={node} />
                    </CollapsibleWorkRow>
                  )
                })}
              </div>
            </CollapsibleWorkRow>
          )
        }

        if (segment.kind === 'context') {
          return (
            <p
              key={segment.id}
              className="px-1 text-[12px] leading-5 text-[var(--vs-text-tertiary)] whitespace-pre-line"
            >
              {segment.label}
            </p>
          )
        }

        if (segment.kind === 'hil') {
          const isPlanningGate = segment.card.context === 'planning_gate'
          return (
            <div key={segment.id} className="relative z-10">
              {isPlanningGate ? (
                <DeepPlanEntryGate card={segment.card} />
              ) : (
                <HilQuestionCard card={segment.card} />
              )}
            </div>
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
          return (
            <TerminalToolCard
              key={segment.id}
              node={segment.node}
              defaultExpanded
              isLive={segment.node.state === 'running'}
            />
          )
        }

        if (segment.kind === 'tool') {
          if (segment.node.toolName === 'spawn_subagent' && messageId) {
            return (
              <SpawnSubagentRow
                key={segment.id}
                node={segment.node}
                messageId={messageId}
                events={events}
                isTurnLive={isLive}
              />
            )
          }

          const isExpanded = expanded[segment.id] ?? false
          return (
            <CollapsibleWorkRow
              key={segment.id}
              label={segment.node.summary}
              isLive={segment.node.state === 'running'}
              expanded={isExpanded}
              onToggle={() => toggle(segment.id)}
            >
              <ToolCallDebugPanel node={segment.node} />
            </CollapsibleWorkRow>
          )
        }

        if (segment.kind === 'deep_plan_jobs') {
          return (
            <DeepPlanJobList
              key={segment.id}
              jobs={segment.jobs}
              pipelineError={segment.pipelineError}
              isLive={segment.isLive}
              messageId={messageId}
            />
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
                  : 'bg-white/[0.03] text-[var(--vs-text-secondary)]'
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
