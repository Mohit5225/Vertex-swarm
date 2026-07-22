import React from 'react'
import { FileText, Play } from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'
import { useChatStore } from '../store/chatStore'

interface Props {
  status: 'generating' | 'ready' | 'executed'
}

const PlanCard: React.FC<Props> = ({ status }) => {
  const isReady = status === 'ready'
  const isPast = status === 'executed'
  const {
    isStreaming,
    currentIdeContextEnabled,
    addMessage,
    beginAssistantMessage,
    setStreaming,
    setError,
    setPlanReadyForMessageId,
  } = useChatStore()

  const handleProceed = () => {
    if (isStreaming) {
      return
    }

    const tempId = `msg-${Date.now()}`
    addMessage({
      id: tempId,
      type: 'user',
      content: 'Proceed with the plan.',
      timestamp: Date.now(),
    })
    beginAssistantMessage()
    setError(null)
    setStreaming(true)
    setPlanReadyForMessageId(null)

    getVsCodeApi()?.postMessage({
      type: 'start-stream',
      payload: {
        message: 'Proceed with the plan.',
        ideContextEnabled: currentIdeContextEnabled,
        tempId,
      },
    })
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-[var(--vs-border)] bg-[var(--vs-surface)] shadow-lg">
      <div className="flex items-center gap-3 border-b border-[var(--vs-border-soft)] bg-white/[0.02] px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--vs-accent-muted)] text-[var(--vs-accent)]">
          <FileText size={16} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-medium text-white">Implementation Plan</h3>
          <p className="text-xs text-[#9fb0cd]">
            {isPast ? 'Plan approved and executed' : isReady ? 'Plan generated and ready for review' : 'Generating plan...'}
          </p>
        </div>
        {!isReady && !isPast && (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--vs-accent)] border-t-transparent" />
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
              disabled={isStreaming}
              className="group primary-btn flex items-center gap-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
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
