import { type ChatMessage, type SessionEvent } from '../store/chatStore'

const truncate = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 3)}...` : value

const eventToolName = (event: SessionEvent) => {
  const toolName = event.metadata?.tool_name ?? event.metadata?.toolName
  return typeof toolName === 'string' && toolName.trim() ? toolName : null
}

export const getTraceEventSummary = (event: SessionEvent) => {
  const toolName = eventToolName(event)
  const executionTimeMs = event.metadata?.execution_time_ms
  const errorCode = event.metadata?.error_code
  const status = event.metadata?.status

  switch (event.type) {
    case 'thinking':
      return event.content?.trim()
        ? truncate(event.content.trim(), 120)
        : 'Reasoning about the next step'

    case 'tool_call':
      return toolName ? `Calling ${toolName}` : 'Dispatching tool call'

    case 'tool_result': {
      const parts = [
        toolName ? `${toolName}` : 'Tool result',
        typeof status === 'string' ? status : null,
        typeof executionTimeMs === 'number' ? `${executionTimeMs} ms` : null,
        typeof errorCode === 'string' ? errorCode : null,
      ].filter(Boolean)
      return parts.join(' | ') || 'Tool result received'
    }

    case 'error':
      return event.content?.trim() || 'Execution failed'

    case 'status':
      return event.content?.trim() || 'Agent status updated'

    case 'code':
      return event.content?.trim()
        ? truncate(event.content.trim(), 120)
        : 'Code activity'

    default:
      return event.content?.trim()
        ? truncate(event.content.trim(), 120)
        : 'Output updated'
  }
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
