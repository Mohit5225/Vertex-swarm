import React from 'react'
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Clock3,
  FilePenLine,
  FilePlus2,
  FileText,
  FolderOpen,
  Loader2,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type { ToolExecutionNode } from '../lib/agentRunBlocks'
import {
  extractFileChangesFromData,
  normalizeFileChange,
} from '../lib/messageDiffs'
import { fileChangeDetail } from '../lib/fileChangeStats'
import { ChangeStatBadges } from './ChangeStatBadges'

const formatDebugPayload = (value: unknown) => {
  if (typeof value === 'string') {
    return value.trim() || '(empty)'
  }

  if (typeof value === 'undefined') {
    return '(not captured)'
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const actionIcon = (action?: string) => {
  switch (action) {
    case 'read_file':
    case 'bulk_files_read':
      return FileText
    case 'edit_file':
      return FilePenLine
    case 'create_file':
      return FilePlus2
    case 'list_dir':
      return FolderOpen
    case 'rename_path':
      return ArrowRightLeft
    case 'delete_path':
      return Trash2
    default:
      return Wrench
  }
}

const stateIndicator = (state: ToolExecutionNode['state']) => {
  switch (state) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--vs-accent)]" />
    case 'error':
      return <X className="h-3.5 w-3.5 text-[var(--vs-danger)]" />
    case 'timeout':
      return <Clock3 className="h-3.5 w-3.5 text-[#f1cb78]" />
    default:
      return <Check className="h-3.5 w-3.5 text-[var(--vs-success)]" />
  }
}

const renderChevron = (expanded: boolean) => (
  <span
    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--vs-text-tertiary)] transition ${
      expanded ? 'rotate-180' : ''
    }`}
  >
    <ChevronDown className="h-3.5 w-3.5" />
  </span>
)

interface Props {
  node: ToolExecutionNode
  expanded: boolean
  onToggle: () => void
}

/** Single file-edit receipt row — used by AgentTurnView edit segments. */
export const FileEditRow: React.FC<Props> = ({ node, expanded, onToggle }) => {
  const Icon = actionIcon(node.action)
  const rawChanges = extractFileChangesFromData(
    (node.resultDebug as { data?: Record<string, unknown> })?.data
  )
  const diffs = rawChanges.map(normalizeFileChange)
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0)
  const changeDetail = diffs.length === 1 ? fileChangeDetail(diffs[0]) : null
  const hasDiffStats = node.state === 'success' && (additions > 0 || deletions > 0)
  const hasChangeDetail = node.state === 'success' && Boolean(changeDetail)

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        className="group flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition hover:bg-white/[0.04]"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--vs-surface)] text-[var(--vs-text-primary)] shadow-[0_0_0_3px_rgba(10,14,22,0.94)]">
          <Icon className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--vs-text-secondary)]">
          {node.summary}
        </span>
        {hasChangeDetail ? (
          <span className="shrink-0 text-[11px] font-medium text-[var(--vs-accent-bright)]">
            {changeDetail}
          </span>
        ) : null}
        {hasDiffStats ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[11px] text-[var(--vs-success)]">+{additions}</span>
            <span className="font-mono text-[11px] text-[var(--vs-danger)]">-{deletions}</span>
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-1.5">
          {stateIndicator(node.state)}
          {renderChevron(expanded)}
        </span>
      </button>

      {expanded ? (
        <div className="ml-7 mt-1 overflow-hidden rounded-[14px] border border-white/[0.04] bg-[linear-gradient(180deg,rgba(18,25,39,0.95),rgba(12,18,29,0.98))]">
          {diffs.length > 0 ? (
            <div className="space-y-2 px-3 py-2.5">
              {diffs.map((diff, index) => (
                <div key={index}>
                  <div className="mb-1 flex items-center gap-2 truncate text-[10px] font-medium text-[var(--vs-text-tertiary)]">
                    <span className="truncate" title={diff.path}>
                      {diff.path}
                    </span>
                    {fileChangeDetail(diff) ? (
                      <span className="shrink-0 text-[var(--vs-accent-bright)]">
                        {fileChangeDetail(diff)}
                      </span>
                    ) : null}
                    <ChangeStatBadges change={diff} />
                  </div>
                  {diff.isBinary ? (
                    <p className="text-[11px] text-[var(--vs-text-tertiary)]">
                      Binary file — use Review to open.
                    </p>
                  ) : diff.diffText ? (
                    <pre className="custom-scrollbar max-h-[200px] overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                      {diff.diffText.split('\n').map((line, lineIndex) => {
                        let color = 'text-[var(--vs-text-secondary)]'
                        if (line.startsWith('+')) color = 'text-[var(--vs-success)]'
                        else if (line.startsWith('-')) color = 'text-[var(--vs-danger)]'
                        else if (line.startsWith('@')) color = 'text-[var(--vs-accent)]'
                        return (
                          <div key={lineIndex} className={color}>
                            {line}
                          </div>
                        )
                      })}
                    </pre>
                  ) : (
                    <p className="text-[11px] text-[var(--vs-text-tertiary)]">No line diff available.</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2 px-3 py-2.5">
              {node.requestDebug ? (
                <div className="rounded-xl bg-white/[0.035] px-3 py-2.5">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--vs-text-tertiary)]">
                    Input
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--vs-text-secondary)]">
                    {formatDebugPayload(node.requestDebug)}
                  </pre>
                </div>
              ) : null}
              {node.resultDebug ? (
                <div className="rounded-xl bg-white/[0.035] px-3 py-2.5">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--vs-text-tertiary)]">
                    Output
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--vs-text-secondary)]">
                    {formatDebugPayload(node.resultDebug)}
                  </pre>
                </div>
              ) : null}
              {!node.requestDebug && !node.resultDebug ? (
                <p className="py-1 text-[11px] text-[var(--vs-text-tertiary)]">No details captured.</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default FileEditRow
