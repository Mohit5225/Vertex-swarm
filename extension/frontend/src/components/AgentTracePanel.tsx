import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import AgentTurnView from './AgentTurnView'
import { collectAgentPanelEvents, spawnSubagentCallIsLive } from '../lib/subagentTrace'
import { getEventToolCallId } from '../lib/sessionEvents'
import { useChatStore } from '../store/chatStore'
import { useAgentPanelStore } from '../store/agentPanelStore'

const AgentTracePanel: React.FC = () => {
  const target = useAgentPanelStore((s) => s.target)
  const closePanel = useAgentPanelStore((s) => s.closePanel)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const activeMessageId = useChatStore((s) => s.activeMessageId)

  const message = useMemo(
    () => messages.find((entry) => entry.id === target?.messageId),
    [messages, target?.messageId],
  )

  const traceEvents = useMemo(() => {
    if (!target || !message?.events) {
      return []
    }
    return collectAgentPanelEvents(message.events, target)
  }, [message?.events, target])

  const isLive = useMemo(() => {
    if (!target || !message?.events) {
      return false
    }
    if (target.mode === 'subagent' && target.spawnToolCallId) {
      const turnLive =
        isStreaming && (activeMessageId === target.messageId || message.id === activeMessageId)
      return spawnSubagentCallIsLive(
        message.events,
        target.spawnToolCallId,
        turnLive,
      )
    }
    if (target.mode === 'deep_plan_stage' && target.deepPlanStageId) {
      const turnLive =
        isStreaming && (activeMessageId === target.messageId || message.id === target.messageId)
      if (!turnLive) {
        return false
      }
      const openIds = new Set<string>()
      for (const event of traceEvents) {
        if (event.type === 'tool_call') {
          const id = getEventToolCallId(event)
          if (id) {
            openIds.add(id)
          }
        }
        if (event.type === 'tool_result') {
          const id = getEventToolCallId(event)
          if (id) {
            openIds.delete(id)
          }
        }
      }
      return openIds.size > 0
    }
    return false
  }, [
    activeMessageId,
    isStreaming,
    message,
    target,
    traceEvents,
  ])

  if (!target) {
    return null
  }

  return (
    <div className="flex h-full min-h-0 w-[min(100%,22rem)] shrink-0 flex-col border-l border-[var(--vs-border-soft)] bg-[var(--vs-surface)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--vs-border-soft)] px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-[var(--vs-text-primary)]">
            {target.title}
          </p>
          <p className="text-[10px] text-[var(--vs-text-tertiary)]">
            {target.mode === 'subagent' ? 'Subagent trace' : 'Worker trace'}
            {isLive ? ' · live' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={closePanel}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--vs-text-tertiary)] transition hover:bg-white/[0.06] hover:text-[var(--vs-text-primary)]"
          aria-label="Close agent trace"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {traceEvents.length === 0 ? (
          <p className="text-[12px] leading-5 text-[var(--vs-text-tertiary)]">
            {isLive
              ? 'Waiting for subagent activity…'
              : 'No trace events for this agent.'}
          </p>
        ) : (
          <AgentTurnView
            events={traceEvents}
            isLive={isLive}
            messageId={target.messageId}
            alwaysExpandTrace
          />
        )}
      </div>
    </div>
  )
}

export default AgentTracePanel
