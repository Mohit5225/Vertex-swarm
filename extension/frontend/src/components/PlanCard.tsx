import React from 'react'
import { FileText, Play } from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'

interface Props {
  isReady: boolean
  isPast: boolean
}

const PlanCard: React.FC<Props> = ({ isReady, isPast }) => {
  const handleProceed = () => {
    // Send a message to the extension to proceed
    getVsCodeApi()?.postMessage({
      type: 'start-stream',
      payload: {
        message: 'Proceed with the plan.',
        ideContextEnabled: true,
      },
    })
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-white/10 bg-[#1a1f2e] shadow-lg">
      <div className="flex items-center gap-3 border-b border-white/10 bg-white/[0.02] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/20 text-blue-400">
          <FileText size={16} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-white">Implementation Plan</h3>
          <p className="text-xs text-[#9fb0cd]">
            {isPast ? 'Plan approved and executed' : isReady ? 'Plan generated and ready for review' : 'Generating plan...'}
          </p>
        </div>
        {!isReady && !isPast && (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        )}
      </div>

      {isReady && !isPast && (
        <div className="bg-white/[0.01] px-4 py-3">
          <p className="mb-4 text-sm text-[#9fb0cd]">
            Review the plan in the editor tab. If it looks good, click proceed to start execution.
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                getVsCodeApi()?.postMessage({
                  type: 'open-plan',
                  payload: {},
                })
              }}
              className="group flex items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-white/10 active:scale-[0.98]"
            >
              <FileText size={14} className="text-[#9fb0cd] transition-colors group-hover:text-white" />
              View Plan
            </button>
            <button
              onClick={handleProceed}
              className="group flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-500 active:scale-[0.98]"
            >
              <Play size={14} className="transition-transform group-hover:scale-110" />
              Proceed
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default PlanCard
