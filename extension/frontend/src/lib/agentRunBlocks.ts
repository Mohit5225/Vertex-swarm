import { type SessionEvent } from '../store/chatStore'
import {
  getEventAction,
  getEventDebugRequest,
  getEventDebugResult,
  getEventPhase,
  getEventStatus,
  getEventToolCallId,
  getEventToolName,
  normalizeEventText,
} from './sessionEvents'

type UnknownRecord = Record<string, unknown>

export type ToolExecutionState = 'running' | 'success' | 'error' | 'timeout'

export interface ToolExecutionNode {
  id: string
  toolCallId?: string
  toolName?: string
  action?: string
  state: ToolExecutionState
  summary: string
  requestDebug?: unknown
  resultDebug?: unknown
  startedAt?: number
  completedAt?: number
  executionTimeMs?: number
}

export interface NarrativeBlock {
  kind: 'narrative'
  id: string
  text: string
  tone: 'default' | 'code'
}

export interface SystemBlock {
  kind: 'system'
  id: string
  text: string
  tone: 'info' | 'warning' | 'error'
}

export interface ThinkingStep {
  kind: 'thinking'
  id: string
  text: string
}

export interface PlanPermissionStep {
  kind: 'plan_permission_request'
  id: string
}

export interface TodoInitStep {
  kind: 'todo_init'
  id: string
}

export type ProcessStep = ThinkingStep | { kind: 'node'; node: ToolExecutionNode } | PlanPermissionStep | TodoInitStep

export interface ProcessBlock {
  kind: 'process'
  id: string
  steps: ProcessStep[]
}

export type AgentRunBlock = NarrativeBlock | SystemBlock | ProcessBlock

const HIDDEN_STATUS_PHASES = new Set([
  'preparing_context',
  'calling_model',
  'awaiting_tool_result',
  'tool_requested',
  'tool_result',
  'tool_result_received',
  'resuming_after_tool',
  'assistant_output',
  'completed',
])

/** Phases that should trigger an ephemeral toast notification in the UI. */
export const TOAST_STATUS_PHASES = new Set<string>([])

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined

const stringValue = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }

  return undefined
}

const numberValue = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }

  return undefined
}

const requestArgs = (requestDebug: unknown) =>
  asRecord(asRecord(requestDebug)?.args)

const requestPayload = (requestDebug: unknown) =>
  asRecord(requestArgs(requestDebug)?.payload)

const resultData = (resultDebug: unknown) =>
  asRecord(asRecord(resultDebug)?.data)

const lineRange = (startLine?: number, endLine?: number) => {
  if (typeof startLine !== 'number' || typeof endLine !== 'number') {
    return ''
  }

  return startLine === endLine
    ? ` line ${startLine}`
    : ` lines ${startLine}-${endLine}`
}

const summarizeToolExecution = ({
  action,
  toolName,
  state,
  requestDebug,
  resultDebug,
}: {
  action?: string
  toolName?: string
  state: ToolExecutionState
  requestDebug?: unknown
  resultDebug?: unknown
}) => {
  const args = requestArgs(requestDebug)
  const payload = requestPayload(requestDebug)
  const data = resultData(resultDebug)
  const query = stringValue(payload?.query, data?.query, args?.query)
  const filePattern = stringValue(payload?.filePattern, data?.filePattern)
  const path = stringValue(payload?.path, data?.path, data?.target)
  const oldPath = stringValue(payload?.oldPath, payload?.old_path, data?.oldPath)
  const newPath = stringValue(payload?.newPath, payload?.new_path, data?.newPath)
  const startLine = numberValue(payload?.startLine, data?.startLine)
  const endLine = numberValue(payload?.endLine, data?.endLine)
  const paths = Array.isArray(payload?.paths) ? payload.paths as string[] : undefined
  const terminalCommand = stringValue(
    payload?.command,
    data?.command,
    args?.command
  )
  const terminalPurpose = stringValue(
    asRecord(payload?.terminal_context)?.purpose,
    payload?.purpose
  )
  const terminalName = stringValue(
    data?.terminal_name,
    asRecord(payload?.terminal_context)?.name,
    payload?.terminal_name
  )

  const terminalLabel = () => {
    if (terminalPurpose) {
      return terminalPurpose
    }
    if (terminalCommand) {
      return terminalCommand.length > 72
        ? `${terminalCommand.slice(0, 71)}…`
        : terminalCommand
    }
    if (terminalName) {
      return terminalName
    }
    return undefined
  }

  if (state === 'timeout') {
    if (action === 'search_text' && query) {
      return `Search timed out for "${query}"`
    }
    if (path) {
      return `Timed out while processing ${path}`
    }
    return 'Tool execution timed out'
  }

  if (state === 'error') {
    if (toolName === 'web_search') {
      return query ? `Web search failed for "${query}"` : 'Web search failed'
    }

    switch (action) {
      case 'search_text':
        return query ? `Search failed for "${query}"` : 'Search failed'
      case 'read_file':
        return path ? `Read failed for ${path}` : 'Read failed'
      case 'bulk_files_read':
        return paths ? `Bulk read failed for ${paths.length} files` : 'Bulk read failed'
      case 'edit_file':
        return path ? `Edit failed for ${path}` : 'Edit failed'
      case 'create_file':
        return path ? `Create failed for ${path}` : 'Create failed'
      case 'delete_path':
        return path ? `Delete failed for ${path}` : 'Delete failed'
      case 'rename_path':
        return oldPath && newPath
          ? `Rename failed for ${oldPath}`
          : 'Rename failed'
      case 'run_command': {
        const label = terminalLabel()
        return label ? `Command failed: ${label}` : 'Command failed'
      }
      case 'send_input':
        return 'Failed to send terminal input'
      case 'new_terminal':
        return terminalName
          ? `Failed to open terminal ${terminalName}`
          : 'Failed to open terminal'
      default:
        return toolName ? `${toolName} failed` : 'Tool execution failed'
    }
  }

  if (toolName === 'web_search') {
    if (query) {
      return state === 'running'
        ? `Searching web for "${query}"`
        : `Searched web for "${query}"`
    }
    return state === 'running' ? 'Running web search' : 'Completed web search'
  }

  switch (action) {
    case 'search_text':
      if (query && filePattern) {
        return state === 'running'
          ? `Searching for "${query}" in ${filePattern}`
          : `Searched for "${query}" in ${filePattern}`
      }
      if (query) {
        return state === 'running'
          ? `Searching for "${query}"`
          : `Searched for "${query}"`
      }
      return state === 'running' ? 'Running search' : 'Completed search'

    case 'read_file':
      if (path) {
        const lines = lineRange(startLine, endLine)
        return state === 'running'
          ? `Reading ${path}${lines}`
          : `Read ${path}${lines}`
      }
      return state === 'running' ? 'Reading file' : 'Read file'

    case 'bulk_files_read':
      if (paths && paths.length > 0) {
        return state === 'running'
          ? `Reading ${paths.length} files`
          : `Read ${paths.length} files`
      }
      return state === 'running' ? 'Reading multiple files' : 'Read multiple files'

    case 'edit_file':
      return path
        ? state === 'running'
          ? `Editing ${path}`
          : `Edited ${path}`
        : state === 'running'
          ? 'Editing file'
          : 'Edited file'

    case 'create_file':
      return path
        ? state === 'running'
          ? `Creating ${path}`
          : `Created ${path}`
        : state === 'running'
          ? 'Creating file'
          : 'Created file'

    case 'delete_path':
      return path
        ? state === 'running'
          ? `Deleting ${path}`
          : `Deleted ${path}`
        : state === 'running'
          ? 'Deleting path'
          : 'Deleted path'

    case 'rename_path':
      if (oldPath && newPath) {
        return state === 'running'
          ? `Renaming ${oldPath} to ${newPath}`
          : `Renamed ${oldPath} to ${newPath}`
      }
      return state === 'running' ? 'Renaming path' : 'Renamed path'

    case 'list_dir':
      return path
        ? state === 'running'
          ? `Listing ${path}`
          : `Listed ${path}`
        : state === 'running'
          ? 'Listing directory'
          : 'Listed directory'

    case 'run_command': {
      const label = terminalLabel()
      if (label) {
        return state === 'running' ? `Running ${label}` : `Ran ${label}`
      }
      return state === 'running' ? 'Running command' : 'Ran command'
    }

    case 'send_input':
      return state === 'running' ? 'Sending terminal input' : 'Sent terminal input'

    case 'new_terminal':
      return terminalName
        ? state === 'running'
          ? `Opening terminal ${terminalName}`
          : `Opened terminal ${terminalName}`
        : state === 'running'
          ? 'Opening terminal'
          : 'Opened terminal'

    case 'get_output':
      return state === 'running' ? 'Reading terminal output' : 'Read terminal output'

    case 'kill_process':
    case 'kill_job':
      return state === 'running' ? 'Stopping background job' : 'Stopped background job'

    case 'kill_terminal':
      return terminalName
        ? state === 'running'
          ? `Closing terminal ${terminalName}`
          : `Closed terminal ${terminalName}`
        : state === 'running'
          ? 'Closing terminal'
          : 'Closed terminal'

    default:
      if (toolName) {
        return state === 'running'
          ? `Running ${toolName}`
          : `Completed ${toolName}`
      }
      return state === 'running' ? 'Running tool' : 'Completed tool'
  }
}

const createToolNodeFromCall = (event: SessionEvent): ToolExecutionNode => {
  const action = getEventAction(event)
  const toolName = getEventToolName(event)
  const requestDebug = getEventDebugRequest(event)

  return {
    id: getEventToolCallId(event) ?? event.id,
    toolCallId: getEventToolCallId(event),
    toolName,
    action,
    state: 'running',
    summary: summarizeToolExecution({
      action,
      toolName,
      state: 'running',
      requestDebug,
    }),
    requestDebug,
    startedAt: event.timestamp,
  }
}

const nodeStateFromResult = (event: SessionEvent): ToolExecutionState => {
  const status = getEventStatus(event)
  if (status === 'timeout') {
    return 'timeout'
  }
  if (status === 'error' || event.type === 'error') {
    return 'error'
  }
  return 'success'
}

const readExecutionTimeMs = (event: SessionEvent, resultDebug: unknown) => {
  const metadataMs = event.metadata?.execution_time_ms
  if (typeof metadataMs === 'number' && Number.isFinite(metadataMs)) {
    return metadataMs
  }

  const resultRecord = asRecord(resultDebug)
  const resultMs = resultRecord?.execution_time_ms
  if (typeof resultMs === 'number' && Number.isFinite(resultMs)) {
    return resultMs
  }

  return undefined
}

const applyToolResultToNode = (node: ToolExecutionNode, event: SessionEvent) => {
  const action = getEventAction(event) ?? node.action
  const toolName = getEventToolName(event) ?? node.toolName
  const state = nodeStateFromResult(event)
  const resultDebug = getEventDebugResult(event)
  const executionTimeMs = readExecutionTimeMs(event, resultDebug)

  node.action = action
  node.toolName = toolName
  node.state = state
  node.resultDebug = resultDebug
  node.completedAt = event.timestamp
  if (executionTimeMs !== undefined) {
    node.executionTimeMs = executionTimeMs
  }
  node.summary = summarizeToolExecution({
    action,
    toolName,
    state,
    requestDebug: node.requestDebug,
    resultDebug,
  })
}

const createToolNodeFromResult = (event: SessionEvent): ToolExecutionNode => {
  const action = getEventAction(event)
  const toolName = getEventToolName(event)
  const resultDebug = getEventDebugResult(event)
  const state = nodeStateFromResult(event)
  const executionTimeMs = readExecutionTimeMs(event, resultDebug)

  return {
    id: getEventToolCallId(event) ?? event.id,
    toolCallId: getEventToolCallId(event),
    toolName,
    action,
    state,
    summary: summarizeToolExecution({
      action,
      toolName,
      state,
      resultDebug,
    }),
    resultDebug,
    completedAt: event.timestamp,
    ...(executionTimeMs !== undefined ? { executionTimeMs } : {}),
  }
}

const appendNarrative = (
  blocks: AgentRunBlock[],
  block: NarrativeBlock
) => {
  const previousBlock = blocks[blocks.length - 1]
  if (previousBlock?.kind === 'narrative' && previousBlock.tone === block.tone) {
    previousBlock.text = `${previousBlock.text}${block.text}`
    return
  }

  blocks.push(block)
}

const systemToneFromPhase = (phase?: string): SystemBlock['tone'] => {
  switch (phase) {
    case 'fallback_model':
      return 'warning'
    case 'stream_exception':
    case 'tool_timeout':
    case 'empty_response':
      return 'error'
    default:
      return 'info'
  }
}

export const buildAgentRunBlocks = (events: SessionEvent[], content?: string): AgentRunBlock[] => {
  const blocks: AgentRunBlock[] = []
  const openToolNodes = new Map<string, ToolExecutionNode>()
  let processBlockCount = 0
  let activeProcessBlock: ProcessBlock | null = null

  const closeProcessBlock = () => {
    activeProcessBlock = null
  }

  const ensureProcessBlock = () => {
    if (activeProcessBlock) {
      return activeProcessBlock
    }

    processBlockCount += 1
    activeProcessBlock = {
      kind: 'process',
      id: `process-${processBlockCount}`,
      steps: [],
    }
    blocks.push(activeProcessBlock)
    return activeProcessBlock
  }

  for (const event of events) {
    if (event.type === 'output') {
      const text = normalizeEventText(event.content)
      if (!text.trim()) {
        continue
      }

      closeProcessBlock()
      appendNarrative(blocks, {
        kind: 'narrative',
        id: event.id,
        text,
        tone: 'default',
      })
      continue
    }

    if (event.type === 'thinking') {
      const text = normalizeEventText(event.content)
      if (!text.trim()) {
        continue
      }

      const block = ensureProcessBlock()
      const lastStep = block.steps[block.steps.length - 1]

      if (lastStep?.kind === 'thinking') {
        lastStep.text = `${lastStep.text}${text}`
      } else {
        block.steps.push({
          kind: 'thinking',
          id: event.id,
          text,
        })
      }
      continue
    }

    if (event.type === 'code') {
      const text = normalizeEventText(event.content)
      if (!text) {
        continue
      }

      closeProcessBlock()
      appendNarrative(blocks, {
        kind: 'narrative',
        id: event.id,
        text,
        tone: 'code',
      })
      continue
    }

    if (event.type === 'tool_call') {
      const block = ensureProcessBlock()
      const node = createToolNodeFromCall(event)
      block.steps.push({ kind: 'node', node })
      if (node.toolCallId) {
        openToolNodes.set(node.toolCallId, node)
      }
      continue
    }

    if (event.type === 'tool_result') {
      const toolCallId = getEventToolCallId(event)
      const matchingNode = toolCallId ? openToolNodes.get(toolCallId) : undefined

      if (matchingNode) {
        applyToolResultToNode(matchingNode, event)
        openToolNodes.delete(toolCallId as string)
      } else {
        const block = ensureProcessBlock()
        block.steps.push({ kind: 'node', node: createToolNodeFromResult(event) })
      }
      continue
    }

    if (event.type === 'status') {
      const phase = getEventPhase(event)

      if (phase === 'tool_context_loaded') {
        const text = normalizeEventText(event.content)
        if (text) {
          const block = ensureProcessBlock()
          block.steps.push({
            kind: 'node',
            node: {
              id: event.id,
              toolName: 'context_loaded',
              action: 'context_loaded',
              state: 'success',
              summary: text,
              startedAt: event.timestamp,
              completedAt: event.timestamp,
            }
          })
        }
        continue
      }

      if (phase && HIDDEN_STATUS_PHASES.has(phase)) {
        continue
      }

      const text = normalizeEventText(event.content)
      if (!text) {
        continue
      }

      closeProcessBlock()
      blocks.push({
        kind: 'system',
        id: event.id,
        text,
        tone: systemToneFromPhase(phase),
      })
      continue
    }

    if (event.type === 'error') {
      const text = normalizeEventText(event.content)
      if (!text) {
        continue
      }

      closeProcessBlock()
      blocks.push({
        kind: 'system',
        id: event.id,
        text,
        tone: 'error',
      })
      continue
    }

    if (event.type === 'plan_permission_request') {
      const block = ensureProcessBlock()
      block.steps.push({
        kind: 'plan_permission_request',
        id: event.id,
      })
      continue
    }

    if (event.type === 'todo_init') {
      const block = ensureProcessBlock()
      block.steps.push({
        kind: 'todo_init',
        id: event.id,
      })
      continue
    }
  }

  const hasNarrative = blocks.some((b) => b.kind === 'narrative')
  const hasOutputEvents = events.some(
    (event) => event.type === 'output' || event.type === 'code'
  )
  const hasThinkingSteps = blocks.some(
    (block) =>
      block.kind === 'process' &&
      block.steps.some((step) => step.kind === 'thinking')
  )
  // Only fall back to raw content for legacy turns without structured output events.
  // Never mirror thinking text as narrative — that belongs in the process accordion.
  if (
    !hasNarrative &&
    !hasOutputEvents &&
    !hasThinkingSteps &&
    content &&
    content.trim()
  ) {
    blocks.push({
      kind: 'narrative',
      id: `narrative-fallback-${Date.now()}`,
      text: content,
      tone: 'default',
    })
  }

  return blocks
    .map((block) => {
      if (block.kind !== 'process') {
        return block
      }

      return {
        ...block,
        steps: block.steps.filter(
          (step) => step.kind !== 'thinking' || step.text.trim().length > 0
        ),
      }
    })
    .filter((block) => {
      if (block.kind === 'process') {
        return block.steps.length > 0
      }

      return Boolean(block.text)
    })
}

export {
  createToolNodeFromCall,
  applyToolResultToNode,
  createToolNodeFromResult,
  summarizeToolExecution,
  systemToneFromPhase,
}
