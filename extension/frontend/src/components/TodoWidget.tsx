import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, Circle, Clock, X } from 'lucide-react'
import type { TodoItem } from '../store/chatStore'

interface Props {
  items: TodoItem[]
  isStreaming: boolean
  onClose?: () => void
}

const TodoWidget: React.FC<Props> = ({ items, isStreaming, onClose }) => {
  const [isExpanded, setIsExpanded] = useState(true)

  const summary = useMemo(() => {
    const completed = items.filter((item) => item.status === 'done').length
    const inProgress = items.filter((item) => item.status === 'in_progress').length
    return {
      completed,
      inProgress,
      total: items.length,
      allDone: items.length > 0 && completed === items.length,
    }
  }, [items])

  useEffect(() => {
    if (summary.inProgress > 0) {
      setIsExpanded(true)
    }
  }, [summary.inProgress])

  if (items.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col border-t border-white/[0.05] bg-[#0a0d14]/88 backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setIsExpanded((value) => !value)}
        className="flex items-center justify-between px-4 py-2 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-[#c6d2e7]">
              Execution progress
            </span>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[#7f91b4]">
              {summary.completed}/{summary.total}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[#8fa3c7]">
            {summary.allDone
              ? 'All steps finished.'
              : summary.inProgress > 0
              ? 'The current task stays pinned here while the run continues above.'
              : isStreaming
              ? 'Checklist initialized and waiting for the next active step.'
              : 'Most recent execution checklist.'}
          </p>
        </div>
        <div className="flex items-center">
          <span
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#6f81a1] transition ${
              isExpanded ? 'rotate-180' : ''
            }`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
          {onClose && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-[#6f81a1] hover:bg-white/10 hover:text-white"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="space-y-1 px-2 pb-2 max-h-[40vh] overflow-y-auto">
          {items.map((item) => {
            const label = item.status === 'in_progress' ? item.activeForm : item.content

            return (
              <div
                key={item.id}
                className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                  item.status === 'in_progress' ? 'bg-blue-500/10' : 'hover:bg-white/[0.02]'
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {item.status === 'done' ? (
                    <CheckCircle2 size={16} className="text-green-500" />
                  ) : item.status === 'in_progress' ? (
                    <Clock
                      size={16}
                      className={isStreaming ? 'animate-pulse text-blue-400' : 'text-blue-300'}
                    />
                  ) : (
                    <Circle size={16} className="text-[#5e6ad2]" />
                  )}
                </div>
                <span
                  className={`text-[13px] leading-5 ${
                    item.status === 'done'
                      ? 'text-[#9fb0cd] line-through'
                      : item.status === 'in_progress'
                      ? 'font-medium text-blue-100'
                      : 'text-[#9fb0cd]'
                  }`}
                >
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default TodoWidget
