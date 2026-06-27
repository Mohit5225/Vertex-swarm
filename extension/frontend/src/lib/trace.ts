import { type ChatMessage, type SessionEvent } from '../store/chatStore'

const truncate = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 3)}...` : value

const normalize = (value?: string | null) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''

const titleCase = (value: string) =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())

const eventToolName = (event: SessionEvent) => {
  const toolName = event.metadata?.tool_name ?? event.metadata?.toolName
  return typeof toolName === 'string' && toolName.trim() ? toolName : null
}

const eventActionName = (event: SessionEvent) => {
  const directAction = event.metadata?.action
  if (typeof directAction === 'string' && directAction.trim()) {
    return directAction.trim()
  }

  const args = event.metadata?.args
  if (
    args &&
    typeof args === 'object' &&
    typeof (args as Record<string, unknown>).action === 'string'
  ) {
    return ((args as Record<string, unknown>).action as string).trim()
  }

  return null
}

const eventPhaseLabel = (event: SessionEvent) => {
  const phase = event.metadata?.phase
  if (typeof phase !== 'string' || !phase.trim()) {
    return null
  }

  const phaseMap: Record<string, string> = {
    preparing_context: 'Preparing Context',
    calling_model: 'Calling Model',
    resuming_after_tool: 'Continuing After Tool',
    awaiting_tool_result: 'Waiting For Tool Result',
    tool_requested: 'Tool Requested',
    tool_result: 'Tool Result',
    tool_result_received: 'Tool Result Received',
    assistant_output: 'Writing Response',
    completed: 'Final Answer Ready',
    reasoning: 'Thinking',
    cancelled: 'Cancelled',
    fallback_model: 'Switching Model',
    tool_timeout: 'Tool Timed Out',
    stream_exception: 'Run Failed',
    empty_response: 'No Visible Answer',
  }

  return phaseMap[phase] ?? titleCase(phase)
}

const stringifyDetail = (value: unknown) => {
  if (typeof value === 'string') {
    return normalize(value)
  }

  if (typeof value === 'undefined') {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const getTraceEventTitle = (event: SessionEvent) => {
  const toolName = eventToolName(event)
  const actionName = eventActionName(event)
  const phaseLabel = eventPhaseLabel(event)

  switch (event.type) {
    case 'thinking':
      return 'Thinking'
    case 'status':
      return phaseLabel ?? 'Status Update'
    case 'tool_call':
      return actionName ? titleCase(actionName) : toolName ? `Running ${toolName}` : 'Running Tool'
    case 'tool_result':
      return toolName
        ? `${toolName} Complete`
        : actionName
          ? `${titleCase(actionName)} Complete`
          : 'Tool Result'
    case 'code':
      return 'Editing Code'
    case 'error':
      return 'Issue Detected'
    default:
      return 'Execution Event'
  }
}

export const getTraceEventSummary = (event: SessionEvent) => {
  const toolName = eventToolName(event)
  const actionName = eventActionName(event)
  const executionTimeMs = event.metadata?.execution_time_ms
  const errorCode = event.metadata?.error_code
  const status = event.metadata?.status
  const metadataSummary =
    typeof event.metadata?.summary === 'string' ? normalize(event.metadata.summary) : ''
  const content = normalize(event.content)

  switch (event.type) {
    case 'thinking':
      return content
        ? truncate(content, 120)
        : 'Reasoning about the next step'

    case 'tool_call':
      if (metadataSummary) {
        return truncate(metadataSummary, 120)
      }
      
      // Special handling for search_text to show regex mode and multiple queries
      if (actionName === 'search_text') {
        const args = event.metadata?.args as Record<string, unknown> | undefined
        if (args) {
          const query = typeof args.query === 'string' ? args.query : null
          const useRegex = args.useRegex === true
          const multipleQueries = Array.isArray(args.multiple_queries) ? args.multiple_queries : (Array.isArray(args.variants) ? args.variants : null)
          
          const parts = []
          if (query) parts.push(`Searching: "${query}"`)
          if (useRegex) parts.push('(regex mode)')
          if (multipleQueries && Array.isArray(multipleQueries) && multipleQueries.length > 0) {
            const queriesList = multipleQueries.filter((v): v is string => typeof v === 'string').join(', ')
            if (queriesList) parts.push(`+ [${queriesList}]`)
          }
          
          if (parts.length > 0) {
            return truncate(parts.join(' '), 120)
          }
        }
      }
      
      if (actionName && toolName) {
        return `${toolName} is handling ${titleCase(actionName).toLowerCase()}`
      }
      return toolName ? `Calling ${toolName}` : 'Dispatching tool call'

    case 'tool_result': {
      if (metadataSummary) {
        return truncate(metadataSummary, 140)
      }

      const parts = [
        toolName ? `${toolName}` : actionName ? titleCase(actionName) : 'Tool result',
        typeof status === 'string' ? status : null,
        typeof executionTimeMs === 'number' ? `${executionTimeMs} ms` : null,
        typeof errorCode === 'string' ? errorCode : null,
      ].filter(Boolean)
      return parts.join(' | ') || 'Tool result received'
    }

    case 'error':
      return content || 'Execution failed'

    case 'status':
      return content || 'Agent status updated'

    case 'code':
      return content
        ? truncate(content, 120)
        : 'Code activity'

    default:
      return content
        ? truncate(content, 120)
        : 'Output updated'
  }
}

export const getTraceEventDetail = (event: SessionEvent) => {
  const content = normalize(event.content)
  const summary = normalize(getTraceEventSummary(event))

  if (event.type === 'tool_call') {
    const args = event.metadata?.args
    const argsText = stringifyDetail(args)
    return argsText && normalize(argsText) !== summary ? argsText : content
  }

  if (event.type === 'tool_result') {
    const sections = [
      content,
      stringifyDetail(event.metadata?.conflict),
      stringifyDetail(event.metadata?.data),
    ].filter(Boolean)

    const uniqueSections = sections.filter(
      (section, index) =>
        normalize(section) &&
        normalize(section) !== summary &&
        sections.findIndex((candidate) => normalize(candidate) === normalize(section)) === index
    )

    return uniqueSections.join('\n\n')
  }

  if (!content || content === summary) {
    return ''
  }

  return content
}

const latestTraceEvent = (message?: ChatMessage | null) => {
  if (!message?.events || message.events.length === 0) {
    return null
  }

  return message.events[message.events.length - 1]
}

export const describePendingMessage = (message?: ChatMessage | null) => {
  const lastEvent = latestTraceEvent(message)
  if (!lastEvent) {
    return 'Preparing the agent run...'
  }

  const toolName = eventToolName(lastEvent)

  switch (lastEvent.type) {
    case 'thinking':
      return 'Reasoning through the request...'

    case 'tool_call':
      return toolName ? `Running ${toolName}...` : 'Running a workspace tool...'

    case 'tool_result':
      return toolName
        ? `${toolName} finished. Drafting the answer...`
        : 'Tool finished. Drafting the answer...'

    case 'status':
      return lastEvent.content?.trim() || 'Agent execution in progress...'

    case 'error':
      return lastEvent.content?.trim() || 'The agent run failed.'

    default:
      if (message?.content?.trim()) {
        return 'Streaming the response...'
      }
      return 'Agent execution in progress...'
  }
}

export const describeStreamState = (
  messages: ChatMessage[],
  isStreaming: boolean
) => {
  if (!isStreaming) {
    if (messages.length > 0) {
      return 'Ready for the next prompt'
    }
    return 'Start with a task, bug, file path, or review request'
  }

  const latestAgentMessage = [...messages]
    .reverse()
    .find((message) => message.type === 'agent')

  return describePendingMessage(latestAgentMessage)
}
