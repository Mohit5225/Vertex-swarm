import { type SessionEvent } from '../store/chatStore'
import {
  buildAgentTurnTimeline,
  summarizeLiveActivity,
} from './agentTurnTimeline'
import { getEventToolCallId } from './sessionEvents'

export type AgentPanelMode = 'subagent' | 'deep_plan_stage'

export interface AgentPanelTarget {
  messageId: string
  mode: AgentPanelMode
  title: string
  spawnToolCallId?: string
  deepPlanStageId?: string
}

export const isSubagentTraceEvent = (event: SessionEvent): boolean =>
  Boolean(event.metadata?.subagent_trace)

export const collectSubagentTraceEvents = (
  events: SessionEvent[],
  spawnToolCallId: string,
): SessionEvent[] =>
  events.filter((event) => {
    if (!isSubagentTraceEvent(event)) {
      return false
    }
    const spawnId = event.metadata?.subagent_spawn_tool_call_id
    return typeof spawnId === 'string' && spawnId === spawnToolCallId
  })

export const collectDeepPlanStageTraceEvents = (
  events: SessionEvent[],
  stageId: string,
): SessionEvent[] =>
  events.filter((event) => {
    const meta = event.metadata ?? {}
    return Boolean(meta.deep_plan_worker) && meta.deep_plan_stage_id === stageId
  })

export const collectAgentPanelEvents = (
  events: SessionEvent[],
  target: AgentPanelTarget,
): SessionEvent[] => {
  let collected: SessionEvent[] = []
  if (target.mode === 'subagent' && target.spawnToolCallId) {
    collected = collectSubagentTraceEvents(events, target.spawnToolCallId)
  } else if (target.mode === 'deep_plan_stage' && target.deepPlanStageId) {
    collected = collectDeepPlanStageTraceEvents(events, target.deepPlanStageId)
  }
  // Strip the trace-routing tags so agentTurnTimeline doesn't skip these events.
  // In the panel context they ARE the primary events, not nested overflow.
  return collected.map((event) => {
    const meta = event.metadata ?? {}
    const { subagent_trace, deep_plan_worker, ...rest } = meta as Record<string, unknown>
    return { ...event, metadata: rest }
  })
}

export const labelForSpawnSubagentCall = (
  events: SessionEvent[],
  spawnToolCallId: string,
): string => {
  const spawnCall = events.find(
    (event) =>
      event.type === 'tool_call' &&
      getEventToolCallId(event) === spawnToolCallId,
  )
  const args = spawnCall?.metadata?.args
  const taskType =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).task_type
      : spawnCall?.metadata?.subagent_task_type
  if (typeof taskType === 'string' && taskType.trim()) {
    return taskType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return 'Subagent'
}

/** Latest visible activity inside a spawn's nested trace (for row subtitles). */
export const summarizeSubagentTraceActivity = (
  events: SessionEvent[],
  spawnToolCallId: string,
): string | null => {
  const traces = collectSubagentTraceEvents(events, spawnToolCallId)
  if (traces.length === 0) {
    return null
  }
  const timeline = buildAgentTurnTimeline(traces, undefined, undefined, true)
  return summarizeLiveActivity(timeline.segments)
}

export const spawnSubagentCallIsLive = (
  events: SessionEvent[],
  spawnToolCallId: string,
  isTurnLive: boolean,
): boolean => {
  if (!isTurnLive) {
    return false
  }
  const spawnResult = events.find(
    (event) =>
      event.type === 'tool_result' &&
      getEventToolCallId(event) === spawnToolCallId,
  )
  return !spawnResult
}
