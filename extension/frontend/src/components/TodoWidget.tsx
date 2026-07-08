import React, { useMemo } from 'react'
import { CheckCircle2, Circle, Clock } from 'lucide-react'
import type { SessionEvent } from '../store/chatStore'

interface TodoItem {
  id: string
  label: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

interface Props {
  events: SessionEvent[]
  isHistorical?: boolean
}

const TodoWidget: React.FC<Props> = ({ events, isHistorical }) => {
  const items = useMemo(() => {
    let currentItems: TodoItem[] = []

    for (const event of events) {
      if ((event.type === 'todo_init' || event.type === 'todo_update') && event.metadata?.items) {
        currentItems = event.metadata.items as TodoItem[]
      }
    }

    return currentItems
  }, [events])

  if (items.length === 0) return null

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-white/10 bg-[#1a1f2e] shadow-lg">
      <div className="border-b border-white/10 bg-white/[0.02] px-4 py-2.5">
        <h3 className="text-sm font-medium text-white">Execution Plan</h3>
      </div>
      <div className="p-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
              item.status === 'in_progress' ? 'bg-blue-500/10' : 'hover:bg-white/[0.02]'
            }`}
          >
            <div className="mt-0.5 shrink-0">
              {item.status === 'completed' ? (
                <CheckCircle2 size={16} className="text-green-500" />
              ) : item.status === 'in_progress' ? (
                isHistorical ? (
                  <Circle size={16} className="text-red-500" />
                ) : (
                  <Clock size={16} className="animate-pulse text-blue-400" />
                )
              ) : item.status === 'failed' ? (
                <Circle size={16} className="text-red-500" />
              ) : (
                <Circle size={16} className="text-[#5e6ad2]" />
              )}
            </div>
            <span
              className={`text-[13px] leading-5 ${
                item.status === 'completed'
                  ? 'text-[#9fb0cd] line-through'
                  : item.status === 'in_progress'
                  ? (isHistorical ? 'text-red-400' : 'font-medium text-blue-100')
                  : item.status === 'failed'
                  ? 'text-red-400'
                  : 'text-[#9fb0cd]'
              }`}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default TodoWidget
