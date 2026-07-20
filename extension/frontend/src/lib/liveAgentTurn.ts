import type { ChatMessage } from '../store/chatStore'

const matchesMessageId = (message: ChatMessage, id: string | null | undefined) =>
  Boolean(id) && (message.id === id || message.dbMessageId === id)

export const findLastAgentMessage = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'agent') {
      return messages[index]
    }
  }

  return undefined
}

/**
 * True when this agent message is the live in-flight turn.
 * Falls back to the last agent message while streaming so UI state stays
 * correct even if activeMessageId drifts from the rendered message id.
 */
export const isLiveAgentTurn = (
  message: ChatMessage,
  isStreaming: boolean,
  activeMessageId: string | null,
  messages: ChatMessage[],
) => {
  if (message.type !== 'agent' || !isStreaming) {
    return false
  }

  if (matchesMessageId(message, activeMessageId)) {
    return true
  }

  const lastAgentMessage = findLastAgentMessage(messages)
  return lastAgentMessage?.id === message.id
}

export const resolveStreamingAgentMessageId = (
  messages: ChatMessage[],
  activeMessageId: string | null,
  isStreaming: boolean,
) => {
  if (!isStreaming) {
    return activeMessageId
  }

  if (activeMessageId) {
    const matchedMessage = messages.find(
      (message) =>
        message.type === 'agent' &&
        matchesMessageId(message, activeMessageId),
    )
    if (matchedMessage) {
      return matchedMessage.id
    }
  }

  return findLastAgentMessage(messages)?.id ?? null
}
