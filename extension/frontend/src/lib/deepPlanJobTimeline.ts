import { type SessionEvent } from '../store/chatStore'
import {
  applyToolResultToNode,
  createToolNodeFromCall,
  createToolNodeFromResult,
  type ToolExecutionNode,
} from './agentRunBlocks'
import { getEventToolCallId, getEventStatus, normalizeEventText } from './sessionEvents'

export type DeepPlanJobStatus = 'running' | 'completed' | 'skipped' | 'failed'

export interface DeepPlanJobRow {
  stageId: string
  label: string
  status: DeepPlanJobStatus
  reason?: string
  artifactPath?: string
  updatedAt?: number
  workerNodes?: ToolExecutionNode[]
  workerPreview?: string
  workerTraceCount?: number
}

/** Mirrors backend `STAGE_LABELS` in harness.py — fallback when event omits label. */
export const DEFAULT_DEEP_PLAN_STAGE_LABELS: Record<string, string> = {
  requirement_extraction: 'Requirement extraction',
  system_plan: 'System plan',
  frontend_plan: 'Frontend plan',
  frontend_plan_a: 'Frontend plan (variant A)',
  frontend_plan_b: 'Frontend plan (variant B)',
  frontend_merge: 'Frontend merge',
  sdk_practices_audit: 'SDK practices audit',
  code_practices_audit: 'Code practices audit',
  performance_planning: 'Performance planning',
  security_audit: 'Security audit',
  correction: 'Plan coherence pass',
  assembly: 'Assembly',
}

const TERMINAL_JOB_STATUSES = new Set<DeepPlanJobStatus>([
  'completed',
  'skipped',
  'failed',
])

const formatStageId = (stageId: string) =>
  stageId.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

export const labelForDeepPlanStage = (
  stageId: string,
  eventLabel?: string | null,
): string => {
  if (eventLabel?.trim()) {
    return eventLabel.trim()
  }
  return DEFAULT_DEEP_PLAN_STAGE_LABELS[stageId] ?? formatStageId(stageId)
}

const countWorkerTraceEvents = (events: SessionEvent[], stageId: string): number =>
  events.filter((event) => {
    const meta = event.metadata ?? {}
    return Boolean(meta.deep_plan_worker) && meta.deep_plan_stage_id === stageId
  }).length

export const buildWorkerToolNodesForStage = (
  events: SessionEvent[],
  stageId: string,
): ToolExecutionNode[] => {
  const openNodes = new Map<string, ToolExecutionNode>()
  const nodes: ToolExecutionNode[] = []

  for (const event of events) {
    const meta = event.metadata ?? {}
    if (!meta.deep_plan_worker || meta.deep_plan_stage_id !== stageId) {
      continue
    }

    if (event.type === 'tool_call') {
      const node = createToolNodeFromCall(event)
      if (node.toolName === 'hil_tool') {
        continue
      }
      if (node.toolCallId) {
        openNodes.set(node.toolCallId, node)
      }
      nodes.push(node)
      continue
    }

    if (event.type === 'tool_result') {
      const toolCallId = getEventToolCallId(event)
      const matching = toolCallId ? openNodes.get(toolCallId) : undefined
      if (matching) {
        applyToolResultToNode(matching, event)
        openNodes.delete(toolCallId as string)
      } else if (toolCallId) {
        nodes.push(createToolNodeFromResult(event))
      }
    }
  }

  return nodes
}

const appendWorkerPreview = (
  jobMap: Map<string, DeepPlanJobRow>,
  stageId: string,
  chunk: string,
) => {
  const previous = jobMap.get(stageId)
  if (!previous) {
    return
  }

  const combined = `${previous.workerPreview ?? ''}${chunk}`
  jobMap.set(stageId, {
    ...previous,
    workerPreview: combined.slice(-4000),
  })
}

export const buildDeepPlanJobsFromEvents = (
  events: SessionEvent[],
): { pipelineId: string | null; jobs: DeepPlanJobRow[] } => {
  const jobMap = new Map<string, DeepPlanJobRow>()
  const order: string[] = []
  let pipelineId: string | null = null

  for (const event of events) {
    const meta = event.metadata ?? {}

    if (event.type === 'deep_plan_stage_status') {
      const stageId = typeof meta.stage_id === 'string' ? meta.stage_id : ''
      const statusRaw = typeof meta.status === 'string' ? meta.status : ''
      if (!stageId || !isDeepPlanJobStatus(statusRaw)) {
        continue
      }

      if (typeof meta.pipeline_id === 'string') {
        pipelineId = meta.pipeline_id
      }

      const label = labelForDeepPlanStage(
        stageId,
        typeof meta.label === 'string' ? meta.label : undefined,
      )
      const reason = typeof meta.reason === 'string' ? meta.reason : undefined
      const previous = jobMap.get(stageId)

      if (!previous) {
        order.push(stageId)
      }

      jobMap.set(stageId, {
        stageId,
        label,
        status: statusRaw,
        reason,
        artifactPath: previous?.artifactPath,
        workerPreview: previous?.workerPreview,
        updatedAt: event.timestamp,
      })
      continue
    }

    if (
      (event.type === 'output' || event.type === 'thinking') &&
      meta.deep_plan_worker &&
      typeof meta.deep_plan_stage_id === 'string'
    ) {
      const text = normalizeEventText(event.content)
      if (text.trim()) {
        appendWorkerPreview(jobMap, meta.deep_plan_stage_id, text)
      }
      continue
    }

    if (event.type === 'deep_plan_artifact_saved') {
      const stageId = typeof meta.stage_id === 'string' ? meta.stage_id : ''
      const path = typeof meta.path === 'string' ? meta.path : undefined
      if (!stageId) {
        continue
      }

      if (typeof meta.pipeline_id === 'string') {
        pipelineId = meta.pipeline_id
      }

      const previous = jobMap.get(stageId)
      if (previous) {
        jobMap.set(stageId, {
          ...previous,
          artifactPath: path ?? previous.artifactPath,
          updatedAt: event.timestamp,
        })
      } else {
        order.push(stageId)
        jobMap.set(stageId, {
          stageId,
          label: labelForDeepPlanStage(stageId),
          status: 'completed',
          artifactPath: path,
          updatedAt: event.timestamp,
        })
      }
    }
  }

  const jobs = order
    .map((stageId) => jobMap.get(stageId))
    .filter((job): job is DeepPlanJobRow => job !== undefined)
    .map((job) => ({
      ...job,
      workerNodes: buildWorkerToolNodesForStage(events, job.stageId),
      workerTraceCount: countWorkerTraceEvents(events, job.stageId),
    }))

  return { pipelineId, jobs }
}

const isDeepPlanJobStatus = (value: string): value is DeepPlanJobStatus =>
  value === 'running' ||
  value === 'completed' ||
  value === 'skipped' ||
  value === 'failed'

export const formatDeepPlanJobRowLabel = (job: DeepPlanJobRow, isLive = false): string => {
  if (job.status === 'running' && isLive) {
    if (job.label.includes('generating') || job.label.includes('—')) {
      return job.label
    }
    return `${job.label}…`
  }
  if (job.status === 'skipped') {
    return `${job.label} (skipped)`
  }
  if (job.status === 'failed') {
    return `${job.label} failed`
  }
  return job.label
}

export const formatDeepPlanJobsSummary = (
  jobs: DeepPlanJobRow[],
  isLive = false,
): string => {
  if (jobs.length === 0) {
    return 'Deep plan pipeline'
  }

  const done = jobs.filter((job) => TERMINAL_JOB_STATUSES.has(job.status)).length
  const running = jobs.find((job) => job.status === 'running')

  if (isLive && running) {
    if (running.label.includes('generating') || running.label.includes('—')) {
      return running.label
    }
    return `${running.label}…`
  }

  return `${done} of ${jobs.length} jobs`
}

export const deepPlanJobsSegmentIsLive = (
  jobs: DeepPlanJobRow[],
  isTurnLive: boolean,
): boolean => {
  if (!isTurnLive) {
    return false
  }
  return jobs.some((job) => job.status === 'running')
}

/** Tool names replaced by structured deep-plan job rows on the handoff message. */
export const DEEP_PLAN_TOOL_NAMES = new Set(['run_planning_stage', 'deep_plan_tool'])

const isDeepPlanHandoffEvent = (event: SessionEvent): boolean => {
  if (
    event.type === 'deep_plan_stage_status' ||
    event.type === 'deep_plan_artifact_saved'
  ) {
    return true
  }
  const toolName = event.metadata?.tool_name
  return (
    (event.type === 'tool_call' || event.type === 'tool_result') &&
    typeof toolName === 'string' &&
    DEEP_PLAN_TOOL_NAMES.has(toolName)
  )
}

/** Last agent message on the trace that carries deep-plan pipeline events. */
export const findDeepPlanHandoffEvents = (
  messages: Array<{ type: string; events?: SessionEvent[] }>,
  pipelineId?: string | null,
): SessionEvent[] | null => {
  let fallback: SessionEvent[] | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== 'agent') {
      continue
    }
    const events = message.events ?? []
    if (!events.some(isDeepPlanHandoffEvent)) {
      continue
    }
    if (!pipelineId) {
      return events
    }
    fallback = fallback ?? events
    const matchesPipeline = events.some((event) => {
      const pid = event.metadata?.pipeline_id
      return typeof pid === 'string' && pid === pipelineId
    })
    if (matchesPipeline) {
      return events
    }
  }
  return fallback
}

/** Error text when `deep_plan_tool` returns before any stage row exists. */
export const extractDeepPlanToolFailure = (events: SessionEvent[]): string | null => {
  for (const event of events) {
    if (event.type !== 'tool_result') {
      continue
    }
    const toolName = event.metadata?.tool_name
    if (toolName !== 'deep_plan_tool') {
      continue
    }
    const metaStatus = event.metadata?.status
    const resultStatus = getEventStatus(event)
    if (resultStatus === 'error' || metaStatus === 'error') {
      const text = typeof event.content === 'string' ? event.content.trim() : ''
      return text || 'Deep plan pipeline failed'
    }
  }
  return null
}

export const buildDeepPlanComposerLabel = (
  events: SessionEvent[] | null,
  fallbackLabel: string,
  isPipelineLive = false,
): string => {
  if (!events) {
    return fallbackLabel
  }
  const { jobs } = buildDeepPlanJobsFromEvents(events)
  if (jobs.length > 0) {
    return formatDeepPlanJobsSummary(jobs, isPipelineLive)
  }
  const failure = extractDeepPlanToolFailure(events)
  if (failure) {
    return failure
  }
  return fallbackLabel
}
