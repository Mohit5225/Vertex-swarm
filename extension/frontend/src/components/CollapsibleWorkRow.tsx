import React from 'react'
import { ChevronDown } from 'lucide-react'

interface Props {
  label: string
  isLive?: boolean
  expanded: boolean
  onToggle: () => void
  children?: React.ReactNode
  className?: string
}

const CollapsibleWorkRow: React.FC<Props> = ({
  label,
  isLive,
  expanded,
  onToggle,
  children,
  className = '',
}) => (
  <div className={`py-0.5 ${className}`}>
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition hover:bg-white/[0.03]"
    >
      <span
        className={`text-[12px] font-medium ${
          isLive ? 'vs-text-shimmer' : 'text-[var(--vs-text-tertiary)]'
        }`}
      >
        {label}
      </span>
      {children ? (
        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vs-text-tertiary)]">
          <ChevronDown
            className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
      ) : null}
    </button>
    {children && expanded ? <div className="mt-1 pl-5">{children}</div> : null}
  </div>
)

export default CollapsibleWorkRow
