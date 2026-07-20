import type { ToolExecutionNode } from './agentRunBlocks'

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

const COMMAND_FROM_CONTENT = [
  /^Command dispatched to terminal:\s*(.+)$/i,
  /^Command started and passed verify window:\s*(.+)$/i,
  /^Command failed immediately \(exit -?\d+\):\s*(.+)$/i,
  /^Command failed immediately \(exit -?\d+\) —\s*(.+)$/i,
]

export const parseCommandFromContent = (content?: string) => {
  if (!content) {
    return undefined
  }

  const firstLine = content.split('\n')[0]?.trim()
  if (!firstLine) {
    return undefined
  }

  for (const pattern of COMMAND_FROM_CONTENT) {
    const match = firstLine.match(pattern)
    if (match?.[1]) {
      return match[1].trim()
    }
  }

  return undefined
}

export const extractTerminalPayload = (node: ToolExecutionNode) => {
  const data = asRecord(asRecord(node.resultDebug)?.data)
  const requestArgs = asRecord(asRecord(node.requestDebug)?.args)
  const nestedPayload = asRecord(requestArgs?.payload)
  const terminalContext = asRecord(nestedPayload?.terminal_context)
  const resultRecord = asRecord(node.resultDebug)
  const resultContent = stringValue(resultRecord?.content)

  const command =
    stringValue(
      data?.command,
      nestedPayload?.command,
      requestArgs?.command,
      parseCommandFromContent(resultContent)
    ) || ''

  const purpose = stringValue(
    terminalContext?.purpose,
    nestedPayload?.purpose,
    data?.purpose
  )

  const action = stringValue(node.action, data?.action, requestArgs?.action)

  return {
    data,
    payload: nestedPayload,
    action,
    command,
    cwd: stringValue(nestedPayload?.cwd, data?.cwd, requestArgs?.cwd),
    purpose,
    terminalName:
      stringValue(
        data?.terminal_name,
        terminalContext?.name,
        nestedPayload?.terminal_name
      ) || 'Vertex Worker',
    exitCode: data?.exit_code,
    pid: data?.pid,
    jobId: stringValue(data?.job_id, nestedPayload?.job_id),
    userVisible:
      nestedPayload?.user_visible ??
      data?.user_visible ??
      (nestedPayload?.hide !== undefined ? !nestedPayload.hide : false),
  }
}

export const extractTerminalOutput = (resultDebug: unknown): string => {
  if (!resultDebug) return ''
  if (typeof resultDebug === 'string') return resultDebug

  const resultRecord = asRecord(resultDebug)
  const data = asRecord(resultRecord?.data)

  if (data) {
    if (typeof data.output === 'string' && data.output.trim()) return data.output
    if (typeof data.output_tail === 'string' && data.output_tail.trim()) {
      return data.output_tail
    }
    if (typeof data.stdout === 'string' || typeof data.stderr === 'string') {
      return [data.stdout, data.stderr].filter(Boolean).join('\n')
    }
  }

  const content = stringValue(resultRecord?.content)
  if (content) {
    const parsedCommand = parseCommandFromContent(content)
    if (parsedCommand && content.split('\n').length === 1) {
      return ''
    }
    return content
  }

  if (typeof resultRecord?.output === 'string') return resultRecord.output
  if (typeof resultRecord?.output_tail === 'string') return resultRecord.output_tail

  try {
    return JSON.stringify(resultDebug, null, 2)
  } catch {
    return String(resultDebug)
  }
}

const COMMAND_TOOL_TAGS = [
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'git',
  'python',
  'pip',
  'node',
  'tsc',
  'vite',
  'cargo',
  'go',
  'make',
  'docker',
  'powershell',
  'pwsh',
]

export const extractCommandTags = (command: string, cwd?: string) => {
  const tags: string[] = []
  if (cwd) {
    tags.push('cd')
  }

  for (const tool of COMMAND_TOOL_TAGS) {
    if (new RegExp(`\\b${tool}\\b`, 'i').test(command)) {
      tags.push(tool)
    }
  }

  return tags.slice(0, 4)
}

export const truncateTerminalTitle = (command: string, maxLength = 72) => {
  const trimmed = command.trim()
  if (!trimmed) {
    return ''
  }

  const firstLine = trimmed.split('\n')[0]?.trim() || trimmed
  if (firstLine.length <= maxLength) {
    return firstLine
  }

  return `${firstLine.slice(0, maxLength - 1)}…`
}

const GENERIC_TERMINAL_SUMMARY =
  /^(running|completed|failed|timed out)\s+terminal_ops$/i

export const resolveTerminalTitle = (node: ToolExecutionNode) => {
  const { command, purpose, action } = extractTerminalPayload(node)
  const commandTitle = truncateTerminalTitle(command)

  if (commandTitle) {
    return commandTitle
  }

  if (purpose) {
    return purpose
  }

  const summary = node.summary.trim()
  if (summary && !GENERIC_TERMINAL_SUMMARY.test(summary)) {
    return summary
  }

  switch (action) {
    case 'run_command':
      return 'Shell command'
    case 'send_input':
      return 'Sent terminal input'
    case 'new_terminal':
      return 'Opened terminal'
    case 'kill_terminal':
      return 'Closed terminal'
    case 'kill_process':
    case 'kill_job':
      return 'Stopped background job'
    default:
      return 'Terminal action'
  }
}

export const shouldShowTerminalOutput = (action?: string) =>
  action === 'run_command' || action === 'send_input' || !action
