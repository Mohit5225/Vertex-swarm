import React, { useEffect, useState } from 'react'
import { Check, Loader2, Minus, X } from 'lucide-react'
import {
  type DeepPlanJobRow,
  formatDeepPlanJobRowLabel,
  formatDeepPlanJobsSummary,
} from '../lib/deepPlanJobTimeline'
import { useAgentPanelStore } from '../store/agentPanelStore'
import CollapsibleWorkRow from './CollapsibleWorkRow'
import ToolCallDebugPanel from './ToolCallDebugPanel'
import { type ToolExecutionNode } from '../lib/agentRunBlocks'

interface Props {
  jobs: DeepPlanJobRow[]
  pipelineError?: string | null
  isLive?: boolean
  messageId?: string
}

const JobStatusIcon: React.FC<{ job: DeepPlanJobRow; isLive?: boolean }> = ({
  job,
  isLive,
}) => {
  if (job.status === 'running' && isLive) {
    return (
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--vs-accent)]" />
    )
  }
  if (job.status === 'completed') {
    return <Check className="h-3 w-3 shrink-0 text-[#7dcea0]" />
  }
  if (job.status === 'skipped') {
    return <Minus className="h-3 w-3 shrink-0 text-[var(--vs-text-tertiary)]" />
  }
  if (job.status === 'failed') {
    return <X className="h-3 w-3 shrink-0 text-[#f27d75]" />
  }
  return <span className="h-3 w-3 shrink-0 rounded-full bg-white/10" />
}

const WorkerToolRow: React.FC<{ node: ToolExecutionNode; isLive?: boolean }> = ({
  node,
  isLive,
}) => {
  const nodeLive = node.state === 'running' && Boolean(isLive)
  const [expanded, setExpanded] = useState(nodeLive)

  useEffect(() => {
    if (nodeLive) {
      setExpanded(true)
    }
  }, [nodeLive])

  return (
    <CollapsibleWorkRow
      label={node.summary}
      isLive={nodeLive}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <ToolCallDebugPanel node={node} />
    </CollapsibleWorkRow>
  )
}

const DeepPlanJobRowView: React.FC<{
  job: DeepPlanJobRow
  isLive?: boolean
  messageId?: string
}> = ({ job, isLive, messageId }) => {
  const openPanel = useAgentPanelStore((s) => s.openPanel)
  const panelTarget = useAgentPanelStore((s) => s.target)
  const panelOpen = useAgentPanelStore((s) => s.open)
  const [expanded, setExpanded] = useState(false)
  const rowLive = job.status === 'running' && isLive
  const label = formatDeepPlanJobRowLabel(job, rowLive)
  const workerNodes = job.workerNodes ?? []
  const hasWorkerDetail = workerNodes.length > 0
  const canOpenTrace = Boolean(messageId && hasWorkerDetail)
  const tracePanelActive =
    panelOpen &&
    panelTarget?.mode === 'deep_plan_stage' &&
    panelTarget.messageId === messageId &&
    panelTarget.deepPlanStageId === job.stageId

  const handleOpenTrace = () => {
    if (!messageId) {
      return
    }
    openPanel({
      messageId,
      mode: 'deep_plan_stage',
      deepPlanStageId: job.stageId,
      title: job.label,
    })
  }

  useEffect(() => {
    if (rowLive) {
      setExpanded(true)
    }
  }, [rowLive])

  if (!hasWorkerDetail) {
    return (
      <div className="flex min-w-0 items-start gap-2 py-0.5">
        <JobStatusIcon job={job} isLive={isLive} />
        <div className="min-w-0 flex-1">
          <p
            className={`text-[12px] leading-5 ${job.status === 'failed'
              ? 'text-[#ffbeb8]'
              : job.status === 'skipped'
                ? 'text-[var(--vs-text-tertiary)]'
                : 'text-[var(--vs-text-secondary)]'
              }`}
          >
            {label}
          </p>
          {job.artifactPath ? (
            <p className="truncate text-[11px] leading-4 text-[var(--vs-text-tertiary)]">
              {job.artifactPath}
            </p>
          ) : null}
          {job.status === 'failed' && job.reason ? (
            <p className="text-[11px] leading-4 text-[#ffbeb8]/80">{job.reason}</p>
          ) : null}
          {job.status === 'skipped' && job.reason ? (
            <p className="text-[11px] leading-4 text-[var(--vs-text-tertiary)]">{job.reason}</p>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-start gap-2">
      <JobStatusIcon job={job} isLive={isLive} />
      <div className="min-w-0 flex-1">
        <CollapsibleWorkRow
          label={label}
          isLive={rowLive}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
          className="pl-0"
        >
          {canOpenTrace ? (
            <button
              type="button"
              onClick={handleOpenTrace}
              className={`mb-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition ${
                tracePanelActive
                  ? 'border-[var(--vs-accent)] bg-[var(--vs-accent-muted)] text-[var(--vs-accent)]'
                  : 'border-white/10 bg-white/[0.03] text-[var(--vs-text-tertiary)] hover:bg-white/[0.06]'
              }`}
            >
              Open worker trace
            </button>
          ) : null}
          <div className="space-y-1">
            {workerNodes.map((node) => {
              const nodeKey = `${job.stageId}:${node.id}`
              return (
                <WorkerToolRow key={nodeKey} node={node} isLive={isLive} />
              )
            })}
            {job.artifactPath ? (
              <p className="truncate text-[11px] leading-4 text-[var(--vs-text-tertiary)]">
                {job.artifactPath}
              </p>
            ) : null}
            {job.status === 'failed' && job.reason ? (
              <p className="text-[11px] leading-4 text-[#ffbeb8]/80">{job.reason}</p>
            ) : null}
            {job.status === 'skipped' && job.reason ? (
              <p className="text-[11px] leading-4 text-[var(--vs-text-tertiary)]">{job.reason}</p>
            ) : null}
          </div>
        </CollapsibleWorkRow>
      </div>
    </div>
  )
}

const DeepPlanJobList: React.FC<Props> = ({
  jobs,
  pipelineError,
  isLive = false,
  messageId,
}) => {
  const [expanded, setExpanded] = useState(isLive)
  const summary = pipelineError && jobs.length === 0
    ? 'Deep plan pipeline failed'
    : formatDeepPlanJobsSummary(jobs, isLive)
  const segmentLive = isLive && jobs.some((job) => job.status === 'running')

  useEffect(() => {
    if (isLive) {
      setExpanded(true)
    }
  }, [isLive])

  return (
    <CollapsibleWorkRow
      label={summary}
      isLive={segmentLive}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <div className="space-y-0.5">
        {pipelineError && jobs.length === 0 ? (
          <p className="text-[12px] leading-5 text-[#ffbeb8]">{pipelineError}</p>
        ) : null}
        {jobs.map((job) => (
          <DeepPlanJobRowView key={job.stageId} job={job} isLive={isLive} messageId={messageId} />
        ))}
      </div>
    </CollapsibleWorkRow>
  )
}

export default DeepPlanJobList
