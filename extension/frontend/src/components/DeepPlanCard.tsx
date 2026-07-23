import React from 'react'
import { Layers, Play, X } from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'
import { useChatStore } from '../store/chatStore'

interface Props {
  pipelineId: string
  title?: string
  status: 'running' | 'ready' | 'resolved'
}

const DeepPlanCard: React.FC<Props> = ({ pipelineId, title, status }) => {
  const isReady = status === 'ready'
  const isPast = status === 'resolved'
  const { isStreaming } = useChatStore()

  const handleApprove = () => {
    getVsCodeApi()?.postMessage({
      type: 'planning-approve',
      payload: { pipeline_id: pipelineId },
    })
  }

  const handleReject = () => {
    const feedback = window.prompt('Optional: why are you rejecting this deep plan?') ?? ''
    getVsCodeApi()?.postMessage({
      type: 'planning-reject',
      payload: { pipeline_id: pipelineId, rejection_feedback: feedback },
    })
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)] shadow-lg">
      <div className="flex items-center gap-3 border-b border-[var(--vs-border-soft)] bg-white/[0.02] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--vs-accent-muted)] text-[var(--vs-accent)]">
          <Layers size={16} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-white">{title || 'Deep plan'}</h3>
          <p className="text-xs text-[#9fb0cd]">
            {isPast
              ? 'Deep plan reviewed'
              : isReady
                ? 'Pipeline complete — approve to continue (Phase 1 stub)'
                : 'Deep planning pipeline running…'}
          </p>
        </div>
      </div>

      {isReady && !isPast && (
        <div className="bg-white/[0.01] px-4 py-3">
          <p className="mb-4 text-sm text-[#9fb0cd]">
            Review <code className="text-[#c5d4f0]">plan_pipeline/index.md</code> under this chat.
            Approve unblocks the agent; reject returns feedback for a revise call.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleReject}
              disabled={isStreaming}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
            >
              <X size={14} />
              Reject
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={isStreaming}
              className="group primary-btn flex items-center gap-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play size={14} className="transition-transform group-hover:scale-110" />
              Approve plan
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DeepPlanCard
