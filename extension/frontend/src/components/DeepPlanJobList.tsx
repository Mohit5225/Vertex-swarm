import React, { useEffect, useMemo, useState } from 'react'
import { Check, Minus, X } from 'lucide-react'
import {
  type DeepPlanJobRow,
  formatDeepPlanJobRowLabel,
  formatDeepPlanJobsSummary,
} from '../lib/deepPlanJobTimeline'
import { findPlanningStageSpawnToolCallId } from '../lib/subagentTrace'
import { type SessionEvent } from '../store/chatStore'
import CollapsibleWorkRow from './CollapsibleWorkRow'

interface Props {
  jobs: DeepPlanJobRow[]
  pipelineError?: string | null
  isLive?: boolean
  messageId?: string
  events?: SessionEvent[]
}

const JobStatusIcon: React.FC<{ job: DeepPlanJobRow }> = ({ job }) => {
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

const SkippedStageRow: React.FC<{ job: DeepPlanJobRow }> = ({ job }) => {
  const label = formatDeepPlanJobRowLabel(job, false)

  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <JobStatusIcon job={job} />
      <div className="min-w-0 flex-1">
        <p
          className={`text-[12px] leading-5 ${
            job.status === 'failed'
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

const DeepPlanJobList: React.FC<Props> = ({
  jobs,
  pipelineError,
  isLive = false,
  events = [],
}) => {
  const [expanded, setExpanded] = useState(isLive)

  const summaryOnlyJobs = useMemo(
    () =>
      jobs.filter((job) => {
        if (!events.length) {
          return job.status === 'skipped' || job.status === 'failed'
        }
        return !findPlanningStageSpawnToolCallId(events, job.stageId)
      }),
    [events, jobs],
  )

  const summary = pipelineError && jobs.length === 0
    ? 'Deep plan pipeline failed'
    : formatDeepPlanJobsSummary(jobs, isLive)
  const segmentLive = isLive && jobs.some((job) => job.status === 'running')

  useEffect(() => {
    if (isLive) {
      setExpanded(true)
    }
  }, [isLive])

  if (summaryOnlyJobs.length === 0 && !pipelineError) {
    if (!segmentLive && jobs.length > 0) {
      return null
    }
    if (jobs.length === 0) {
      return null
    }
  }

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
        {summaryOnlyJobs.map((job) => (
          <SkippedStageRow key={job.stageId} job={job} />
        ))}
      </div>
    </CollapsibleWorkRow>
  )
}

export default DeepPlanJobList
