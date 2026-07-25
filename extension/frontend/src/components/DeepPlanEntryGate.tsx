import React, { useState } from 'react'
import { Layers, Play, X } from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'
import { type HilCardState } from '../lib/hilTypes'
import { useDeepPlanStore } from '../store/deepPlanStore'

interface Props {
  card: HilCardState
}

/**
 * Vertex-initiated deep plan entry — explicit Approve / Reject (not slash /deep-plan).
 * Submits planning_gate HIL answers via hil-respond RPC.
 */
const DeepPlanEntryGate: React.FC<Props> = ({ card }) => {
  const isResolved = card.status === 'resolved'
  const [isSubmitting, setIsSubmitting] = useState(false)
  const deactivate = useDeepPlanStore((s) => s.deactivate)

  const question = card.questions[0]
  const yesOption =
    question?.options.find((o) =>
      ['yes', 'deep_plan_yes', 'yes_deep_planning', 'run_deep_plan'].includes(o.id)
    ) ?? question?.options[0]
  const noOption =
    question?.options.find((o) => o.id === 'no') ??
    question?.options.find((o) => o !== yesOption) ??
    question?.options[1]

  const submit = (optionId: string, approved: boolean) => {
    if (isSubmitting || isResolved || !question) {
      return
    }
    const api = getVsCodeApi()
    if (!api) {
      return
    }
    setIsSubmitting(true)
    if (!approved) {
      deactivate()
    }
    api.postMessage({
      type: 'hil-respond',
      payload: {
        hil_session_id: card.hilSessionId,
        answers: [{ question_id: question.question_id, type: 'option', option_id: optionId }],
      },
    })
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/[0.06] shadow-lg">
      <div className="flex items-center gap-3 border-b border-amber-500/20 bg-amber-500/[0.04] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300">
          <Layers size={16} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-white">Deep planning suggested</h3>
          <p className="text-xs text-amber-200/70">
            {isResolved
              ? 'Entry decision recorded'
              : 'Vertex detected a large architectural change'}
          </p>
        </div>
      </div>

      {!isResolved && question && (
        <div className="px-4 py-3">
          <p className="mb-4 text-sm text-[#d4deef]">{question.prompt}</p>
          <div className="flex justify-end gap-2">
            {noOption && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => submit(noOption.id, false)}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
              >
                <X size={14} />
                Reject
              </button>
            )}
            {yesOption && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => submit(yesOption.id, true)}
                className="flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-50"
              >
                <Play size={14} />
                Approve deep plan
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DeepPlanEntryGate
