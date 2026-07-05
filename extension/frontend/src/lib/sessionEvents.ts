import { type SessionEvent } from '../store/chatStore'

type UnknownRecord = Record<string, unknown>

const KNOWN_EVENT_TYPES: SessionEvent['type'][] = [
  'thinking',
  'code',
  'output',
  'error',
  'status',
  'tool_call',
  'tool_result',
  'plan_permission_request',
  'plan_chunk',
  'plan_ready',
  'todo_init',
  'todo_update',
]

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

const knownEventType = (value: unknown): SessionEvent['type'] => {
  const normalized = value === 'token' ? 'output' : value
  return typeof normalized === 'string' &&
    KNOWN_EVENT_TYPES.includes(normalized as SessionEvent['type'])
    ? (normalized as SessionEvent['type'])
    : 'status'
}

const buildToolCallRequestDebug = (
  rawEvent: UnknownRecord,
  metadata: UnknownRecord
) => {
  const requestPayload: UnknownRecord = {}
  const toolCallId = stringValue(rawEvent.tool_call_id, metadata.tool_call_id)
  const toolName = stringValue(rawEvent.tool_name, rawEvent.toolName, metadata.tool_name)
  const sessionId = stringValue(rawEvent.session_id, rawEvent.sessionId, metadata.session_id)
  const chatId = stringValue(rawEvent.chat_id, rawEvent.chatId, metadata.chat_id)
  const messageId = stringValue(rawEvent.message_id, rawEvent.messageId, metadata.message_id)
  const args = asRecord(rawEvent.args) ?? asRecord(metadata.args)

  if (toolCallId) {
    requestPayload.tool_call_id = toolCallId
  }
  if (toolName) {
    requestPayload.tool_name = toolName
  }
  if (sessionId) {
    requestPayload.session_id = sessionId
  }
  if (chatId) {
    requestPayload.chat_id = chatId
  }
  if (messageId) {
    requestPayload.message_id = messageId
  }
  if (args) {
    requestPayload.args = args
  }

  return Object.keys(requestPayload).length > 0 ? requestPayload : undefined
}

const buildToolResultDebug = (rawEvent: UnknownRecord, metadata: UnknownRecord) => {
  const resultPayload: UnknownRecord = {}
  const toolName = stringValue(rawEvent.tool_name, rawEvent.toolName, metadata.tool_name)
  const toolCallId = stringValue(rawEvent.tool_call_id, rawEvent.toolCallId, metadata.tool_call_id)
  const sessionId = stringValue(rawEvent.session_id, rawEvent.sessionId, metadata.session_id)
  const chatId = stringValue(rawEvent.chat_id, rawEvent.chatId, metadata.chat_id)
  const messageId = stringValue(rawEvent.message_id, rawEvent.messageId, metadata.message_id)
  const requestId = stringValue(rawEvent.request_id, rawEvent.requestId, metadata.request_id)
  const action = stringValue(rawEvent.action, metadata.action)
  const status = stringValue(rawEvent.status, metadata.status)
  const summary = stringValue(rawEvent.summary, metadata.summary)
  const errorCode = stringValue(rawEvent.error_code, rawEvent.errorCode, metadata.error_code)
  const executionTimeMs = numberValue(rawEvent.execution_time_ms, metadata.execution_time_ms)
  const content = typeof rawEvent.content === 'string' ? rawEvent.content : undefined

  if (toolName) {
    resultPayload.tool_name = toolName
  }
  if (toolCallId) {
    resultPayload.tool_call_id = toolCallId
  }
  if (sessionId) {
    resultPayload.session_id = sessionId
  }
  if (chatId) {
    resultPayload.chat_id = chatId
  }
  if (messageId) {
    resultPayload.message_id = messageId
  }
  if (requestId) {
    resultPayload.request_id = requestId
  }
  if (action) {
    resultPayload.action = action
  }
  if (status) {
    resultPayload.status = status
  }
  if (typeof content === 'string') {
    resultPayload.content = content
  }
  if (summary) {
    resultPayload.summary = summary
  }
  if (typeof rawEvent.data !== 'undefined' || typeof metadata.data !== 'undefined') {
    resultPayload.data = rawEvent.data ?? metadata.data ?? null
  }
  if (
    typeof rawEvent.conflict !== 'undefined' ||
    typeof metadata.conflict !== 'undefined'
  ) {
    resultPayload.conflict = rawEvent.conflict ?? metadata.conflict ?? null
  }
  if (typeof executionTimeMs === 'number') {
    resultPayload.execution_time_ms = executionTimeMs
  }
  if (errorCode) {
    resultPayload.error_code = errorCode
  }

  return Object.keys(resultPayload).length > 0 ? resultPayload : undefined
}

export const normalizeEventText = (value?: string | null) =>
  typeof value === 'string' ? value.replace(/\r\n/g, '\n') : ''

export const normalizeSessionEvent = (
  rawEvent: Partial<SessionEvent> & UnknownRecord,
  fallback: { id?: string; timestamp?: number } = {}
): SessionEvent => {
  const baseMetadata = asRecord(rawEvent.metadata) ?? {}
  const metadata: UnknownRecord = { ...baseMetadata }
  const type = knownEventType(rawEvent.type)
  const toolName = stringValue(rawEvent.tool_name, rawEvent.toolName, baseMetadata.tool_name)
  const toolCallId = stringValue(
    rawEvent.tool_call_id,
    rawEvent.toolCallId,
    baseMetadata.tool_call_id
  )
  const sessionId = stringValue(rawEvent.session_id, rawEvent.sessionId, baseMetadata.session_id)
  const chatId = stringValue(rawEvent.chat_id, rawEvent.chatId, baseMetadata.chat_id)
  const messageId = stringValue(rawEvent.message_id, rawEvent.messageId, baseMetadata.message_id)
  const args = asRecord(rawEvent.args) ?? asRecord(baseMetadata.args)
  const action = stringValue(
    rawEvent.action,
    baseMetadata.action,
    args?.action
  )
  const status = stringValue(rawEvent.status, baseMetadata.status)
  const summary = stringValue(rawEvent.summary, baseMetadata.summary)
  const phase = stringValue(rawEvent.phase, baseMetadata.phase)
  const requestId = stringValue(rawEvent.request_id, rawEvent.requestId, baseMetadata.request_id)
  const executionTimeMs = numberValue(rawEvent.execution_time_ms, baseMetadata.execution_time_ms)
  const errorCode = stringValue(rawEvent.error_code, rawEvent.errorCode, baseMetadata.error_code)
  const conflict = rawEvent.conflict ?? baseMetadata.conflict
  const data = typeof rawEvent.data !== 'undefined' ? rawEvent.data : baseMetadata.data
  const existingDebug = asRecord(baseMetadata.debug) ?? {}

  if (toolName) {
    metadata.tool_name = toolName
  }
  if (toolCallId) {
    metadata.tool_call_id = toolCallId
  }
  if (sessionId) {
    metadata.session_id = sessionId
  }
  if (chatId) {
    metadata.chat_id = chatId
  }
  if (messageId) {
    metadata.message_id = messageId
  }
  if (args) {
    metadata.args = args
  }
  if (action) {
    metadata.action = action
  }
  if (status) {
    metadata.status = status
  }
  if (summary) {
    metadata.summary = summary
  }
  if (phase) {
    metadata.phase = phase
  }
  if (requestId) {
    metadata.request_id = requestId
  }
  if (typeof executionTimeMs === 'number') {
    metadata.execution_time_ms = executionTimeMs
  }
  if (errorCode) {
    metadata.error_code = errorCode
  }
  if (typeof data !== 'undefined') {
    metadata.data = data
  }
  if (typeof conflict !== 'undefined') {
    metadata.conflict = conflict
  }

  const debug: UnknownRecord = { ...existingDebug }
  if (type === 'tool_call' && !debug.request) {
    const request = buildToolCallRequestDebug(rawEvent, metadata)
    if (request) {
      debug.request = request
    }
  }
  if (type === 'tool_result' && !debug.result) {
    const result = buildToolResultDebug(rawEvent, metadata)
    if (result) {
      debug.result = result
    }
  }
  if (Object.keys(debug).length > 0) {
    metadata.debug = debug
  }

  return {
    id:
      stringValue(rawEvent.id, fallback.id) ??
      `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    content:
      typeof rawEvent.content === 'string'
        ? rawEvent.content
        : type === 'tool_call' && toolName
          ? `Calling ${toolName}`
          : '',
    timestamp:
      numberValue(rawEvent.timestamp, fallback.timestamp) ??
      Date.now(),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  }
}

export const getEventPhase = (event: SessionEvent) =>
  stringValue(event.metadata?.phase)

export const getEventToolName = (event: SessionEvent) =>
  stringValue(event.metadata?.tool_name, event.metadata?.toolName)

export const getEventToolCallId = (event: SessionEvent) =>
  stringValue(event.metadata?.tool_call_id, event.metadata?.toolCallId)

export const getEventAction = (event: SessionEvent) => {
  const directAction = stringValue(event.metadata?.action)
  if (directAction) {
    return directAction
  }

  const args = asRecord(event.metadata?.args)
  const argsAction = stringValue(args?.action)
  if (argsAction) {
    return argsAction
  }

  return undefined
}

export const getEventStatus = (event: SessionEvent) =>
  stringValue(event.metadata?.status)

export const getEventDebugRequest = (event: SessionEvent) => {
  const debug = asRecord(event.metadata?.debug)
  return debug?.request
}

export const getEventDebugResult = (event: SessionEvent) => {
  const debug = asRecord(event.metadata?.debug)
  return debug?.result
}
