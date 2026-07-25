import React, { useMemo } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { type ToolExecutionNode } from '../lib/agentRunBlocks'
import {
  collectSubagentTraceEvents,
  labelForSpawnSubagentCall,
  spawnSubagentCallIsLive,
  summarizeSubagentTraceActivity,
} from '../lib/subagentTrace'
import { type SessionEvent } from '../store/chatStore'
import { useAgentPanelStore } from '../store/agentPanelStore'

interface Props {
  node: ToolExecutionNode
  messageId: string
  events: SessionEvent[]
  isTurnLive: boolean
}

const SpawnSubagentRow: React.FC<Props> = ({
  node,
  messageId,
  events,
  isTurnLive,
}) => {
  const openPanel = useAgentPanelStore((s) => s.openPanel)
  const panelOpen = useAgentPanelStore((s) => s.open)
  const panelTarget = useAgentPanelStore((s) => s.target)

  const spawnToolCallId = node.toolCallId
  const label = spawnToolCallId
    ? labelForSpawnSubagentCall(events, spawnToolCallId)
    : node.summary
  const isLive =
    spawnToolCallId
      ? spawnSubagentCallIsLive(events, spawnToolCallId, isTurnLive)
      : node.state === 'running'
  const traceCount = spawnToolCallId
    ? collectSubagentTraceEvents(events, spawnToolCallId).length
    : 0
  const liveActivity = useMemo(() => {
    if (!spawnToolCallId || !isLive) {
      return null
    }
    return summarizeSubagentTraceActivity(events, spawnToolCallId)
  }, [events, isLive, spawnToolCallId])

  const isPanelActive =
    panelOpen &&
    panelTarget?.mode === 'subagent' &&
    panelTarget.messageId === messageId &&
    panelTarget.spawnToolCallId === spawnToolCallId

  const handleOpen = () => {
    if (!spawnToolCallId) {
      return
    }
    openPanel({
      messageId,
      mode: 'subagent',
      spawnToolCallId,
      title: label,
    })
  }

  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      {isLive ? (
        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-[var(--vs-accent)]" />
      ) : (
        <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full bg-[#7dcea0]/80" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12px] leading-5 text-[var(--vs-text-secondary)]">
            {isLive ? `${label}…` : label}
          </p>
          <button
            type="button"
            onClick={handleOpen}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition ${
              isPanelActive
                ? 'border-[var(--vs-accent)] bg-[var(--vs-accent-muted)] text-[var(--vs-accent)]'
                : 'border-white/10 bg-white/[0.03] text-[var(--vs-text-tertiary)] hover:bg-white/[0.06] hover:text-[var(--vs-text-secondary)]'
            }`}
          >
            <ExternalLink className="h-3 w-3" />
            {isPanelActive ? 'Agent trace open' : 'Open agent trace'}
          </button>
        </div>
        <p className="text-[11px] leading-4 text-[var(--vs-text-tertiary)]">
          {isLive
            ? (liveActivity ?? (traceCount > 0 ? 'Running…' : 'Spawning…'))
            : traceCount > 0
              ? `${traceCount} trace events`
              : 'No nested trace captured'}
        </p>
      </div>
    </div>
  )
}

export default SpawnSubagentRow
