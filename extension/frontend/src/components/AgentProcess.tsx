import React, { useMemo, useState, useEffect, useRef } from 'react'
import type { ProcessBlock, ToolExecutionNode, ThinkingStep } from '../lib/agentRunBlocks'
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  Clock3,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import { getVsCodeApi } from '../lib/vscode'
import { SnapshotCard, type DiffStat } from './SnapshotCard'

interface Props {
  block: ProcessBlock
  isStreamingMessage?: boolean
  isActiveBlock?: boolean
}

type TimelineGroupItem = {
  kind: 'group'
  id: string
  action?: string
  summary: string
  nodes: ToolExecutionNode[]
}

type TimelineNodeItem = {
  kind: 'node'
  id: string
  node: ToolExecutionNode
}

type TimelineItem = TimelineGroupItem | TimelineNodeItem | ThinkingStep

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

const groupSummary = (action: string | undefined, count: number) => {
  switch (action) {
    case 'read_file':
    case 'bulk_files_read':
      return `Reviewed ${count} files`
    case 'search_text':
      return `Ran ${count} searches`
    case 'edit_file':
      return `Edited ${count} files`
    case 'create_file':
      return `Created ${count} files`
    case 'list_dir':
      return `Listed ${count} folders`
    case 'rename_path':
      return `Renamed ${count} paths`
    case 'delete_path':
      return `Deleted ${count} paths`
    default:
      return `Completed ${count} tool actions`
  }
}

const groupTimelineItems = (steps: ProcessBlock['steps']): TimelineItem[] => {
  const items: TimelineItem[] = []

  let nodesBuffer: ToolExecutionNode[] = []

  const flushNodes = () => {
    if (nodesBuffer.length === 0) return

    for (let index = 0; index < nodesBuffer.length;) {
      const node = nodesBuffer[index]
      const shouldGroup =
        node.state === 'success' &&
        typeof node.action === 'string' &&
        Boolean(node.action)

      if (!shouldGroup) {
        items.push({ kind: 'node', id: node.id, node })
        index += 1
        continue
      }

      const groupedNodes = [node]
      let nextIndex = index + 1

      while (nextIndex < nodesBuffer.length) {
        const nextNode = nodesBuffer[nextIndex]
        if (nextNode.state !== 'success' || nextNode.action !== node.action) {
          break
        }

        groupedNodes.push(nextNode)
        nextIndex += 1
      }

      if (groupedNodes.length >= 2) {
        items.push({
          kind: 'group',
          id: `group-${groupedNodes.map((groupNode) => groupNode.id).join('-')}`,
          action: node.action,
          summary: groupSummary(node.action, groupedNodes.length),
          nodes: groupedNodes,
        })
        index = nextIndex
        continue
      }

      items.push({ kind: 'node', id: node.id, node })
      index += 1
    }
    nodesBuffer = []
  }

  for (const step of steps) {
    if (step.kind === 'thinking') {
      flushNodes()
      items.push(step)
    } else {
      nodesBuffer.push(step.node)
    }
  }
  flushNodes()

  return items
}

const actionIcon = (action?: string) => {
  switch (action) {
    case 'search_text':
      return Search
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
    case 'run_command':
    case 'send_input':
    case 'get_output':
    case 'get_diagnostics':
    case 'get_state':
    case 'list_processes':
    case 'kill_process':
    case 'list_terminals':
    case 'new_terminal':
    case 'kill_terminal':
      return Terminal
    default:
      return Wrench
  }
}

const FILE_OPS = new Set([
  'edit_file',
  'create_file',
  'delete_path',
  'rename_path',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file'
])

const stateIndicator = (state: ToolExecutionNode['state']) => {
  switch (state) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5e6ad2]" />
    case 'error':
      return <X className="h-3.5 w-3.5 text-[#f43f5e]" />
    case 'timeout':
      return <Clock3 className="h-3.5 w-3.5 text-[#f1cb78]" />
    default:
      return <Check className="h-3.5 w-3.5 text-[#2dd4bf]" />
  }
}

const renderChevron = (expanded: boolean) => (
  <span
    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[#6f81a1] transition ${expanded ? 'rotate-180' : ''
      }`}
  >
    <ChevronDown className="h-3.5 w-3.5" />
  </span>
)

const extractTerminalOutput = (resultDebug: any): string => {
  if (!resultDebug) return ''
  if (typeof resultDebug === 'string') return resultDebug

  const data = resultDebug.data
  if (data) {
    if (typeof data.output === 'string') return data.output
    if (typeof data.stdout === 'string' || typeof data.stderr === 'string') {
      return [data.stdout, data.stderr].filter(Boolean).join('\n')
    }
  }

  if (typeof resultDebug.output === 'string') return resultDebug.output

  try {
    return JSON.stringify(resultDebug, null, 2)
  } catch {
    return String(resultDebug)
  }
}

/**
 * TerminalCard — shown instead of raw debug output for terminal_ops nodes.
 * Displays command + exit status and a "Show Terminal" button that focuses
 * the actual terminal panel instance. Now supports expanding to view output!
 */
const TerminalCard: React.FC<{
  node: ToolExecutionNode
  expanded?: boolean
}> = ({ node, expanded }) => {
  const data = (node.resultDebug as any)?.data as
    | { terminal_name?: string; command?: string; exit_code?: number | null }
    | undefined

  const terminalName = data?.terminal_name ?? (node.requestDebug as any)?.args?.payload?.terminal_context?.name ?? (node.requestDebug as any)?.args?.payload?.terminal_name ?? 'Vertex Worker'
  const command = data?.command ?? (node.requestDebug as any)?.args?.payload?.command ?? ''
  const exitCode = data?.exit_code
  const durationMs =
    node.completedAt && node.startedAt ? node.completedAt - node.startedAt : undefined

  const outputText = extractTerminalOutput(node.resultDebug)

  const handleShowTerminal = () => {
    getVsCodeApi()?.postMessage({ type: 'show-terminal', payload: { terminalName } })
  }

  return (
    <div className="mt-2 ml-0.5 overflow-hidden rounded-[18px] bg-[linear-gradient(180deg,rgba(18,25,39,0.95),rgba(12,18,29,0.98))] shadow-[0_14px_30px_rgba(0,0,0,0.22)] border border-white/[0.05]">
      {/* Header */}
      <div className="px-3 pt-3 pb-2">
        <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-[#7f91b4]">
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5" />
            <span>{terminalName}</span>
          </div>
          <div className="flex items-center gap-3">
            {exitCode !== undefined && exitCode !== null && (
              <span
                className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium ${exitCode === 0
                    ? 'bg-[#0c2a23] text-[#2dd4bf] border border-[#2dd4bf]/20'
                    : 'bg-[#3a1a1a] text-[#f43f5e] border border-[#f43f5e]/20'
                  }`}
              >
                exit {exitCode}
              </span>
            )}
            {durationMs !== undefined && (
              <span>{(durationMs / 1000).toFixed(1)}s</span>
            )}
          </div>
        </div>

        {command && (
          <div className="rounded-xl bg-white/[0.04] px-3 py-2">
            <p className="font-mono text-[11px] leading-5 text-[#c6d2e7] break-all">{command}</p>
          </div>
        )}
      </div>

      {/* Expanded view for terminal output */}
      {expanded ? (
        <div className="border-t border-white/[0.05] bg-[#06090e]">
          <div className="flex items-center justify-between px-3 py-2 bg-white/[0.02]">
            <span className="text-[10px] font-medium text-[#6f81a1] uppercase tracking-wider">Command Output</span>
            <button
              type="button"
              onClick={handleShowTerminal}
              className="flex items-center gap-1.5 rounded text-[10px] font-medium text-[#7d8cf0] transition hover:text-[#9eb1ff]"
            >
              <Terminal className="h-3 w-3" />
              Open Terminal Panel
            </button>
          </div>
          <div className="p-3 overflow-x-auto max-h-[300px] custom-scrollbar">
            <pre className="font-mono text-[11px] leading-5 text-[#a1b0cb] whitespace-pre-wrap break-words">
              {outputText || 'No output captured.'}
            </pre>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-3 flex justify-end">
          <button
            type="button"
            onClick={handleShowTerminal}
            className="flex items-center gap-1.5 rounded-lg bg-[#5e6ad2]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#9eb1ff] border border-[#5e6ad2]/20 transition hover:bg-[#5e6ad2]/20 hover:text-white active:scale-[0.97]"
          >
            <Terminal className="h-3 w-3" />
            Show Terminal
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * FileEditRow — inline first-class row shown directly in the chat thread
 * for every file-mutation tool call (edit, create, delete, rename).
 * Mirrors the Codex / Claude Code "Editing a file" pill UI.
 */
const FileEditRow: React.FC<{
  node: ToolExecutionNode
  expanded: boolean
  onToggle: () => void
}> = ({ node, expanded, onToggle }) => {
  const Icon = actionIcon(node.action)
  const diffs: DiffStat[] = (node.resultDebug as any)?.data?.snapshot_diffs ?? []
  const additions = diffs.reduce((s, d) => s + d.additions, 0)
  const deletions = diffs.reduce((s, d) => s + d.deletions, 0)
  const hasDiffStats = node.state === 'success' && (additions > 0 || deletions > 0)

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition hover:bg-white/[0.04] group"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#101726] text-[#d6e3fb] shadow-[0_0_0_3px_rgba(10,14,22,0.94)]">
          <Icon className="h-3 w-3" />
        </span>
        <span className="flex-1 min-w-0 text-[13px] font-medium text-[#c6d2e7] truncate">
          {node.summary}
        </span>
        {hasDiffStats && (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="font-mono text-[11px] text-[#2dd4bf]">+{additions}</span>
            <span className="font-mono text-[11px] text-[#f43f5e]">-{deletions}</span>
          </span>
        )}
        <span className="shrink-0 flex items-center gap-1.5">
          {stateIndicator(node.state)}
          {renderChevron(expanded)}
        </span>
      </button>

      {expanded && (
        <div className="ml-7 mt-1 rounded-[14px] bg-[linear-gradient(180deg,rgba(18,25,39,0.95),rgba(12,18,29,0.98))] border border-white/[0.04] overflow-hidden">
          {diffs.length > 0 ? (
            /* Tier 2: Quick-peek diff — shown when backend returns snapshot_diffs */
            <div className="px-3 py-2.5 space-y-2">
              {diffs.map((diff, idx) => (
                <div key={idx}>
                  <div className="mb-1 text-[10px] font-medium text-[#91a0bb] truncate">{diff.file}</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 font-mono max-h-[200px] custom-scrollbar">
                    {diff.diffText.split('\n').map((line, i) => {
                      let color = 'text-[#c6d2e7]'
                      if (line.startsWith('+')) color = 'text-[#2dd4bf]'
                      else if (line.startsWith('-')) color = 'text-[#f43f5e]'
                      else if (line.startsWith('@')) color = 'text-[#5e6ad2]'
                      return <div key={i} className={color}>{line}</div>
                    })}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            /* Fallback: raw tool input + output, same as NodeAccordion */
            <div className="px-3 py-2.5 space-y-2">
              {!!node.requestDebug && (
                <div className="rounded-xl bg-white/[0.035] px-3 py-2.5">
                  <div className="mb-1.5 text-[10px] font-medium text-[#91a0bb] uppercase tracking-wider">Input</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#c6d2e7]">
                    {formatDebugPayload(node.requestDebug)}
                  </pre>
                </div>
              )}
              {!!node.resultDebug && (
                <div className="rounded-xl bg-white/[0.035] px-3 py-2.5">
                  <div className="mb-1.5 text-[10px] font-medium text-[#91a0bb] uppercase tracking-wider">Output</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#c6d2e7]">
                    {formatDebugPayload(node.resultDebug)}
                  </pre>
                </div>
              )}
              {!node.requestDebug && !node.resultDebug && (
                <p className="text-[11px] text-[#6f81a1] py-1">No details captured.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const NodeAccordion: React.FC<{
  node: ToolExecutionNode
  expanded: boolean
  onToggle: () => void
  isHistorical?: boolean
}> = ({ node, expanded, onToggle, isHistorical }) => {
  const Icon = actionIcon(node.action)
  const requestLabel = node.requestDebug ? 'Input' : 'Request'
  const resultLabel = node.resultDebug ? 'Output' : 'Result'
  const requestPayload = formatDebugPayload(node.requestDebug)
  const resultPayload = formatDebugPayload(node.resultDebug)

  return (
    <div className="relative pl-8">
      <div className="absolute left-[0.55rem] top-[0.35rem] h-full w-px bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-transparent" />
      <div className="absolute left-0 top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-[#101726] text-[#d6e3fb] shadow-[0_0_0_4px_rgba(10,14,22,0.94)]">
        <Icon className="h-3 w-3" />
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 rounded-xl px-1 py-1 text-left transition hover:bg-white/[0.03]"
      >
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13px] font-medium leading-6 text-[#e8eefb]">
            {node.summary}
          </p>
        </div>

        <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
          {stateIndicator(node.state)}
          {renderChevron(expanded)}
        </div>
      </button>

      {/* Terminal ops: show terminal card (no raw output in chat) */}
      {node.toolName === 'terminal_ops' && expanded && (
        <TerminalCard node={node} expanded={true} />
      )}

      {/* Snapshot quick peek: show inline diff instead of JSON if diff exists */}
      {node.toolName !== 'terminal_ops' && expanded && (node.resultDebug as any)?.data?.snapshot_diffs?.length > 0 ? (
        <div className="mt-2 ml-0.5 rounded-[18px] bg-[linear-gradient(180deg,rgba(18,25,39,0.95),rgba(12,18,29,0.98))] px-3 py-3 shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-[#7f91b4]">
            <FileSearch className="h-3.5 w-3.5" />
            <span>Quick Peek (Diff)</span>
          </div>
          <div className="space-y-2">
            {((node.resultDebug as any).data.snapshot_diffs as DiffStat[]).map((diff, idx) => (
              <div key={idx} className="rounded-2xl bg-white/[0.035] px-3 py-2.5">
                <div className="mb-1.5 text-[11px] font-medium text-[#91a0bb] truncate">
                  {diff.file}
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 font-mono">
                  {diff.diffText.split('\n').map((line, i) => {
                    let color = 'text-[#c6d2e7]'
                    if (line.startsWith('+')) color = 'text-[#2dd4bf]'
                    else if (line.startsWith('-')) color = 'text-[#f43f5e]'
                    else if (line.startsWith('@')) color = 'text-[#5e6ad2]'
                    return <div key={i} className={color}>{line}</div>
                  })}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* All other tools: show debug view on expand */}
      {node.toolName !== 'terminal_ops' && expanded && !(node.resultDebug as any)?.data?.snapshot_diffs ? (
        <div className="mt-2 ml-0.5 rounded-[18px] bg-[linear-gradient(180deg,rgba(18,25,39,0.95),rgba(12,18,29,0.98))] px-3 py-3 shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-[#7f91b4]">
            <FileSearch className="h-3.5 w-3.5" />
            <span>Debug view</span>
          </div>

          <div className="space-y-2">
            <div className="rounded-2xl bg-white/[0.035] px-3 py-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-[#91a0bb]">
                {requestLabel}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#c6d2e7]">
                {requestPayload}
              </pre>
            </div>

            <div className="rounded-2xl bg-white/[0.035] px-3 py-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-[#91a0bb]">
                {resultLabel}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#c6d2e7]">
                {resultPayload}
              </pre>
            </div>
          </div>
        </div>
      ) : null}

      {/* Snapshot Card (Tier 1 Awareness) - Always visible if diffs exist */}
      {node.toolName !== 'terminal_ops' && (node.resultDebug as any)?.data?.snapshot_diffs?.length > 0 && (
        <SnapshotCard
          diffs={(node.resultDebug as any).data.snapshot_diffs}
          snapshotId={(node.resultDebug as any).data.snapshot_id}
          sessionId={(node.resultDebug as any).data.snapshot_session_id}
          messageId={(node.resultDebug as any).data.snapshot_id}
          isHistorical={isHistorical}
        />
      )}
    </div>
  )
}

const GroupAccordion: React.FC<{
  item: TimelineGroupItem
  expanded: boolean
  expandedNodes: Record<string, boolean>
  onToggleGroup: () => void
  onToggleNode: (nodeId: string) => void
  isHistorical?: boolean
}> = ({ item, expanded, expandedNodes, onToggleGroup, onToggleNode, isHistorical }) => {
  const Icon = actionIcon(item.action)

  // Aggregate diffs across all nodes in this group
  const allDiffs: DiffStat[] = [];
  let snapshotId = '';
  let sessionId = '';
  let messageId = '';

  for (const node of item.nodes) {
    const data = (node.resultDebug as any)?.data;
    if (data?.snapshot_diffs && Array.isArray(data.snapshot_diffs)) {
      allDiffs.push(...data.snapshot_diffs);
      // Use the first node that has snapshot data for IDs
      if (!snapshotId) snapshotId = data.snapshot_id ?? '';
      if (!sessionId) sessionId = data.snapshot_session_id ?? '';
      if (!messageId) messageId = data.snapshot_id ?? ''; // messageId == snapshot_id (the message_id on the backend)
    }
  }

  return (
    <div className="relative pl-8">
      <div className="absolute left-[0.55rem] top-[0.35rem] h-full w-px bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-transparent" />
      <div className="absolute left-0 top-0.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-[#101726] text-[#d6e3fb] shadow-[0_0_0_4px_rgba(10,14,22,0.94)]">
        <Icon className="h-3 w-3" />
      </div>

      <button
        type="button"
        onClick={onToggleGroup}
        className="flex w-full items-start justify-between gap-3 rounded-xl px-1 py-1 text-left transition hover:bg-white/[0.03]"
      >
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-[13px] font-medium leading-6 text-[#e8eefb]">
            {item.summary}
          </p>
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] text-[#7f91b4]">{item.nodes.length}</span>
          {renderChevron(expanded)}
        </div>
      </button>

      {allDiffs.length > 0 && snapshotId && sessionId && (
        <SnapshotCard
          diffs={allDiffs}
          snapshotId={snapshotId}
          sessionId={sessionId}
          messageId={messageId}
          isHistorical={isHistorical}
        />
      )}

      {expanded ? (
        <div className="mt-1 space-y-1">
          {item.nodes.map((node) => (
            <NodeAccordion
              key={node.id}
              node={node}
              expanded={expandedNodes[node.id] ?? false}
              onToggle={() => onToggleNode(node.id)}
              isHistorical={isHistorical}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const AgentTimeline: React.FC<Props> = ({ block, isStreamingMessage, isActiveBlock = false }) => {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({})
  const [expandedFileOps, setExpandedFileOps] = useState<Record<string, boolean>>({})
  
  const isHistorical = !isStreamingMessage;
  const sanitizedSteps = useMemo(() => {
    if (!isHistorical) return block.steps;
    return block.steps.map(step => {
      if (step.kind === 'node' && step.node.state === 'running') {
        return { ...step, node: { ...step.node, state: 'error' as const } }; // Treat zombie running states as interrupted
      }
      return step;
    });
  }, [block.steps, isHistorical]);

  const items = useMemo(() => groupTimelineItems(sanitizedSteps), [sanitizedSteps])
  const scrollRef = useRef<HTMLDivElement>(null)

  const isRunning = !isHistorical && (sanitizedSteps.some(
    step => step.kind === 'node' && step.node.state === 'running'
  ) || Boolean(isStreamingMessage && isActiveBlock))

  const [processExpanded, setProcessExpanded] = useState<boolean>(isRunning)

  useEffect(() => {
    setProcessExpanded(isRunning)
  }, [isRunning])

  useEffect(() => {
    if (processExpanded && isRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [items, processExpanded, isRunning])

  // Split steps: file-mutation ops rendered inline; everything else in accordion
  const fileOpNodes: ToolExecutionNode[] = []
  const hasNonFileOpSteps = sanitizedSteps.some(
    step => step.kind === 'thinking' || (step.kind === 'node' && !FILE_OPS.has(step.node.action ?? ''))
  )

  for (const step of sanitizedSteps) {
    if (step.kind === 'node' && FILE_OPS.has(step.node.action ?? '')) {
      fileOpNodes.push(step.node)
    }
  }

  // Aggregate all diffs from completed file-op nodes for the turn-level SnapshotCard
  const turnDiffs: DiffStat[] = []
  let turnSnapshotId = ''
  let turnSessionId = ''
  let turnMessageId = ''
  for (const node of fileOpNodes) {
    const data = (node.resultDebug as any)?.data
    if (data?.snapshot_diffs && Array.isArray(data.snapshot_diffs)) {
      turnDiffs.push(...data.snapshot_diffs)
      if (!turnSnapshotId) turnSnapshotId = data.snapshot_id ?? ''
      if (!turnSessionId) turnSessionId = data.snapshot_session_id ?? ''
      if (!turnMessageId) turnMessageId = data.snapshot_id ?? ''
    }
  }

  // Filter items for the accordion (exclude file-op nodes)
  const accordionItems = items.filter(item => {
    if (item.kind === 'thinking') return true
    if (item.kind === 'group') return !FILE_OPS.has(item.action ?? '')
    if (item.kind === 'node') return !FILE_OPS.has(item.node.action ?? '')
    return true
  })

  return (
    <div>
      {/* Inline file-op rows — visible directly in the chat thread */}
      {fileOpNodes.length > 0 && (
        <div className="space-y-0.5 mb-1">
          {fileOpNodes.map((node) => (
            <FileEditRow
              key={node.id}
              node={node}
              expanded={expandedFileOps[node.id] ?? false}
              onToggle={() =>
                setExpandedFileOps(cur => ({ ...cur, [node.id]: !(cur[node.id] ?? false) }))
              }
            />
          ))}
        </div>
      )}

      {/* Accordion for non-file ops (reads, searches, terminal, thinking) */}
      {hasNonFileOpSteps && (
        <>
          <button
            type="button"
            onClick={() => setProcessExpanded(!processExpanded)}
            className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.03]"
          >
            <div className="flex items-center gap-2 text-[12px] font-medium text-[#7384a3]">
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5e6ad2]" />
              ) : (
                <Check className="h-3.5 w-3.5 text-[#2dd4bf]" />
              )}
              <span>{isRunning ? 'Working...' : 'Finished working'}</span>
            </div>
            <div className="flex items-center">
              {renderChevron(processExpanded)}
            </div>
          </button>

          {processExpanded && (
            <div
              ref={scrollRef}
              className="mt-2 space-y-1 rounded-xl bg-[#0c0e15] border border-white/[0.04] px-2 py-3 max-h-[300px] overflow-y-auto custom-scrollbar shadow-inner"
            >
              {accordionItems.map((item) => {
                if (item.kind === 'thinking') {
                  const paragraphs = item.text.split(/\n{2,}/).filter(Boolean)
                  return (
                    <div key={item.id} className="relative py-1">
                      <div className="absolute left-[9px] top-3 bottom-1 w-px bg-[#313641]" />
                      <div className="space-y-3">
                        {paragraphs.map((paragraph, index) => (
                          <div key={index} className="relative pl-8">
                            <div className="absolute left-[6px] top-[9px] z-10 h-[6px] w-[6px] rounded-full bg-[#5e6ad2]/50 ring-[3px] ring-[#0c0e15]" />
                            <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#b4c4de]">
                              {paragraph}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }

                return item.kind === 'group' ? (
                  <GroupAccordion
                    key={item.id}
                    item={item}
                    expanded={expandedGroups[item.id] ?? false}
                    expandedNodes={expandedNodes}
                    onToggleGroup={() =>
                      setExpandedGroups((current) => ({
                        ...current,
                        [item.id]: !(current[item.id] ?? false),
                      }))
                    }
                    onToggleNode={(nodeId) =>
                      setExpandedNodes((current) => ({
                        ...current,
                        [nodeId]: !(current[nodeId] ?? false),
                      }))
                    }
                    isHistorical={isHistorical}
                  />
                ) : (
                  <NodeAccordion
                    key={item.id}
                    node={item.node}
                    expanded={expandedNodes[item.node.id] ?? false}
                    onToggle={() =>
                      setExpandedNodes((current) => ({
                        ...current,
                        [item.node.id]: !(current[item.node.id] ?? false),
                      }))
                    }
                    isHistorical={isHistorical}
                  />
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Turn-level SnapshotCard — one card aggregating all file edits in this turn */}
      {!isRunning && turnDiffs.length > 0 && turnSnapshotId && turnSessionId && (
        <SnapshotCard
          diffs={turnDiffs}
          snapshotId={turnSnapshotId}
          sessionId={turnSessionId}
          messageId={turnMessageId}
          isHistorical={isHistorical}
        />
      )}
    </div>
  )
}

export default AgentTimeline
