import { create } from 'zustand'

export type DeepPlanTrigger = 'user_slash' | 'vertex_hil'
export type DeepPlanPhase =
  | 'off'
  | 'requirement_extraction'
  | 'pipeline_running'
  | 'awaiting_approval'

export interface DeepPlanUiState {
  active: boolean
  trigger: DeepPlanTrigger | null
  phase: DeepPlanPhase
  stageLabel: string
  pipelineId: string | null
}

const OFF_STATE: DeepPlanUiState = {
  active: false,
  trigger: null,
  phase: 'off',
  stageLabel: '',
  pipelineId: null,
}

interface DeepPlanStore extends DeepPlanUiState {
  activate: (trigger: DeepPlanTrigger, phase?: Exclude<DeepPlanPhase, 'off'>) => void
  deactivate: () => void
  setPhase: (phase: Exclude<DeepPlanPhase, 'off'>, stageLabel?: string) => void
  setPipelineId: (pipelineId: string | null) => void
  applyModeEvent: (metadata: Record<string, unknown>) => void
  applyStageStatus: (metadata: Record<string, unknown>) => void
  hydrateFromPipeline: (pipeline: Record<string, unknown> | null | undefined) => void
}

const phaseFromStage = (stageId: string): Exclude<DeepPlanPhase, 'off'> => {
  if (stageId === 'requirement_extraction') {
    return 'requirement_extraction'
  }
  if (stageId === 'assembly' || stageId === 'awaiting_approval') {
    return 'awaiting_approval'
  }
  return 'pipeline_running'
}

const hydrateSnapshotFromPipeline = (
  pipeline: Record<string, unknown>,
): Partial<DeepPlanUiState> | null => {
  const status = typeof pipeline.status === 'string' ? pipeline.status : ''
  const pipelineId =
    typeof pipeline.pipeline_id === 'string' ? pipeline.pipeline_id : null

  if (status === 'awaiting_approval') {
    return {
      active: true,
      trigger:
        pipeline.trigger === 'hil_confirmed_arch_shift' ? 'vertex_hil' : 'user_slash',
      phase: 'awaiting_approval',
      stageLabel: 'Awaiting approval',
      pipelineId,
    }
  }

  if (status === 'running') {
    const currentStage =
      typeof pipeline.current_stage === 'string' ? pipeline.current_stage : ''
    const stageLabel = currentStage
      ? currentStage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Pipeline running'
    return {
      active: true,
      trigger:
        pipeline.trigger === 'hil_confirmed_arch_shift' ? 'vertex_hil' : 'user_slash',
      phase: 'pipeline_running',
      stageLabel,
      pipelineId,
    }
  }

  return null
}

export const useDeepPlanStore = create<DeepPlanStore>((set, get) => ({
  ...OFF_STATE,

  activate: (trigger, phase = 'requirement_extraction') => {
    set({
      active: true,
      trigger,
      phase,
      stageLabel:
        phase === 'requirement_extraction'
          ? 'Requirement extraction'
          : get().stageLabel,
    })
  },

  deactivate: () => {
    set({ ...OFF_STATE })
  },

  setPhase: (phase, stageLabel) => {
    set((state) => ({
      active: true,
      phase,
      stageLabel: stageLabel ?? state.stageLabel,
    }))
  },

  setPipelineId: (pipelineId) => {
    set({ pipelineId })
  },

  applyModeEvent: (metadata) => {
    const trigger =
      metadata.trigger === 'vertex_hil' ? 'vertex_hil' : 'user_slash'
    const phase =
      metadata.phase === 'pipeline_running'
        ? 'pipeline_running'
        : metadata.phase === 'awaiting_approval'
          ? 'awaiting_approval'
          : 'requirement_extraction'
    const pipelineId =
      typeof metadata.pipeline_id === 'string' ? metadata.pipeline_id : null
    set({
      active: true,
      trigger,
      phase,
      pipelineId: pipelineId ?? get().pipelineId,
      stageLabel:
        typeof metadata.stage_label === 'string'
          ? metadata.stage_label
          : phase === 'requirement_extraction'
            ? 'Requirement extraction'
            : get().stageLabel,
    })
  },

  applyStageStatus: (metadata) => {
    const stageId = typeof metadata.stage_id === 'string' ? metadata.stage_id : ''
    const status = typeof metadata.status === 'string' ? metadata.status : ''
    const label =
      typeof metadata.label === 'string' ? metadata.label : stageId

    if (status === 'skipped' || status === 'completed') {
      if (stageId === 'requirement_extraction' && status === 'completed') {
        set({
          active: true,
          phase: 'pipeline_running',
          stageLabel: label || 'Pipeline running',
        })
        return
      }
      if (stageId === 'assembly' && status === 'completed') {
        set({ phase: 'awaiting_approval', stageLabel: 'Awaiting approval', active: true })
      }
      return
    }

    if (status === 'failed' && stageId) {
      if (stageId === 'requirement_extraction') {
        set({
          active: true,
          phase: 'requirement_extraction',
          stageLabel: label ? `${label} failed` : 'Requirement extraction failed',
        })
        return
      }
      // Pipeline hard-stop — unlock composer (reject/failure is chat-driven, not blocked).
      set({ ...OFF_STATE })
      return
    }

    if (status === 'running' && stageId) {
      set({
        active: true,
        phase: phaseFromStage(stageId),
        stageLabel: label,
      })
    }
  },

  hydrateFromPipeline: (pipeline) => {
    if (!pipeline || typeof pipeline !== 'object') {
      return
    }
    const snapshot = hydrateSnapshotFromPipeline(pipeline)
    if (!snapshot) {
      const status = typeof pipeline.status === 'string' ? pipeline.status : ''
      if (
        status === 'failed' ||
        status === 'aborted' ||
        status === 'rejected' ||
        status === 'approved'
      ) {
        set({ ...OFF_STATE })
      }
      return
    }
    set((state) => ({
      ...state,
      ...snapshot,
    }))
  },
}))

export function findDeepPlanReadyMessageId(
  messages: Array<{ messageId: string; events?: Array<Record<string, unknown>> }>,
  pipelineId: string | null,
): string | null {
  if (!pipelineId) {
    return null
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    const events = message.events ?? []
    for (const event of events) {
      if (event.type !== 'deep_plan_permission_request') {
        continue
      }
      const meta =
        event.metadata && typeof event.metadata === 'object'
          ? (event.metadata as Record<string, unknown>)
          : {}
      if (meta.pipeline_id === pipelineId) {
        return message.messageId
      }
    }
  }
  return null
}
