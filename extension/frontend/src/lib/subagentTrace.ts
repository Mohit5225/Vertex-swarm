import { type SessionEvent } from '../store/chatStore'
import {
  buildAgentTurnTimeline,
  summarizeLiveActivity,
} from './agentTurnTimeline'
import { labelForDeepPlanStage } from './deepPlanJobTimeline'
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

export const isSpawnRowToolName = (toolName: string | undefined): boolean =>
  toolName === 'spawn_subagent' || toolName === 'run_planning_stage'

/** run_planning_stage tool_call id for a deep-plan stage, if Vertex spawned it. */
export const findPlanningStageSpawnToolCallId = (
  events: SessionEvent[],
  stageId: string,
): string | undefined => {
  for (const event of events) {
    if (event.type !== 'tool_call') {
      continue
    }
    const toolName = event.metadata?.tool_name
    if (toolName !== 'run_planning_stage') {
      continue
    }
    const args = event.metadata?.args
    const argStageId =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>).stage_id
        : undefined
    if (argStageId === stageId) {
      const toolCallId = getEventToolCallId(event)
      if (toolCallId) {
        return toolCallId
      }
    }
  }
  return undefined
}

export const collectSubagentTraceEvents = (
  events: SessionEvent[],
  spawnToolCallId: string,
): SessionEvent[] =>
  events.filter((event) => {
    if (isSubagentTraceEvent(event)) {
      const spawnId = event.metadata?.subagent_spawn_tool_call_id
      return typeof spawnId === 'string' && spawnId === spawnToolCallId
    }
    const meta = event.metadata ?? {}
    return (
      Boolean(meta.deep_plan_worker) &&
      meta.subagent_spawn_tool_call_id === spawnToolCallId
    )
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
    const spawnToolCallId = findPlanningStageSpawnToolCallId(
      events,
      target.deepPlanStageId,
    )
    if (spawnToolCallId) {
      collected = collectSubagentTraceEvents(events, spawnToolCallId)
    } else {
      collected = collectDeepPlanStageTraceEvents(events, target.deepPlanStageId)
    }
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
  const toolName =
    typeof spawnCall?.metadata?.tool_name === 'string'
      ? spawnCall.metadata.tool_name
      : undefined
  const args = spawnCall?.metadata?.args
  if (toolName === 'run_planning_stage') {
    const stageId =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>).stage_id
        : undefined
    if (typeof stageId === 'string' && stageId.trim()) {
      return labelForDeepPlanStage(stageId)
    }
    return 'Planning stage'
  }
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

/** Wall-clock from spawn tool_call → tool_result on the parent message. */
export const spawnWallClockDurationMs = (
  events: SessionEvent[],
  spawnToolCallId: string,
): number | undefined => {
  const spawnCall = events.find(
    (event) =>
      event.type === 'tool_call' &&
      getEventToolCallId(event) === spawnToolCallId,
  )
  const spawnResult = events.find(
    (event) =>
      event.type === 'tool_result' &&
      getEventToolCallId(event) === spawnToolCallId,
  )
  const start = spawnCall?.timestamp
  const end = spawnResult?.timestamp
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined
  }
  return Math.max(0, end - start)
}
