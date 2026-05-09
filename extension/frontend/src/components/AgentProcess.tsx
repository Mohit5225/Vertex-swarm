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
  Trash2,
  Wrench,
  X,
  Sparkles
} from 'lucide-react'

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

    for (let index = 0; index < nodesBuffer.length; ) {
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
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8bd7ff]" />
    case 'error':
      return <X className="h-3.5 w-3.5 text-[#ff9f95]" />
    case 'timeout':
      return <Clock3 className="h-3.5 w-3.5 text-[#f1cb78]" />
    default:
      return <Check className="h-3.5 w-3.5 text-[#79d3b3]" />
  }
}

const renderChevron = (expanded: boolean) => (
  <span
    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[#6f81a1] transition ${
      expanded ? 'rotate-180' : ''
    }`}
  >
    <ChevronDown className="h-3.5 w-3.5" />
  </span>
)

const NodeAccordion: React.FC<{
  node: ToolExecutionNode
  expanded: boolean
  onToggle: () => void
}> = ({ node, expanded, onToggle }) => {
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

      {expanded ? (
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
    </div>
  )
}

const GroupAccordion: React.FC<{
  item: TimelineGroupItem
  expanded: boolean
  expandedNodes: Record<string, boolean>
  onToggleGroup: () => void
  onToggleNode: (nodeId: string) => void
}> = ({ item, expanded, expandedNodes, onToggleGroup, onToggleNode }) => {
  const Icon = actionIcon(item.action)

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

      {expanded ? (
        <div className="mt-1 space-y-1">
          {item.nodes.map((node) => (
            <NodeAccordion
              key={node.id}
              node={node}
              expanded={expandedNodes[node.id] ?? false}
              onToggle={() => onToggleNode(node.id)}
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
  const items = useMemo(() => groupTimelineItems(block.steps), [block.steps])
  const scrollRef = useRef<HTMLDivElement>(null)

  const isRunning = block.steps.some(
    step => step.kind === 'node' && step.node.state === 'running'
  ) || Boolean(isStreamingMessage && isActiveBlock)

  const [processExpanded, setProcessExpanded] = useState<boolean>(isRunning)

  useEffect(() => {
    setProcessExpanded(isRunning)
  }, [isRunning])

  useEffect(() => {
    if (processExpanded && isRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [items, processExpanded, isRunning])

  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={() => setProcessExpanded(!processExpanded)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.03]"
      >
        <div className="flex items-center gap-2 text-[12px] font-medium text-[#7384a3]">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8bd7ff]" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 text-[#fff]" />
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
          className="mt-2 space-y-1 rounded-xl bg-white/[0.01] px-2 py-3 max-h-[300px] overflow-y-auto custom-scrollbar"
        >
          {items.map((item) => {
            if (item.kind === 'thinking') {
              const paragraphs = item.text.split(/\n{2,}/).filter(Boolean)
              return (
                <div key={item.id} className="relative py-1">
                  <div className="absolute left-[9px] top-3 bottom-1 w-px bg-[#313641]" />
                  <div className="space-y-3">
                    {paragraphs.map((paragraph, index) => (
                      <div key={index} className="relative pl-8">
                        <div className="absolute left-[6px] top-[9px] z-10 h-[6px] w-[6px] rounded-full bg-[#8b9ebf] ring-[3px] ring-[#141b2a]" />
                        <div className="whitespace-pre-wrap text-[13px] leading-6 text-[#a1b0cb]">
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
            />
          )
          })}
        </div>
      )}
    </div>
  )
}

export default AgentTimeline
