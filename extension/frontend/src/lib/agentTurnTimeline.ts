import { type SessionEvent } from '../store/chatStore'
import {
  applyToolResultToNode,
  createToolNodeFromCall,
  createToolNodeFromResult,
  systemToneFromPhase,
  type ToolExecutionNode,
  type ToolExecutionState,
} from './agentRunBlocks'
import { FILE_MUTATION_ACTIONS, extractFileChangesFromData } from './messageDiffs'
import {
  getEventPhase,
  getEventToolCallId,
  normalizeEventText,
} from './sessionEvents'
import { loadedToolsLabelFromStatusEvent } from './loadedTools'
import {
  applyHilResolvedEvent,
  cardFromHilQuestionEvent,
} from './hilCardState'
import { type HilCardState } from './hilTypes'

const HIDDEN_STATUS_PHASES = new Set([
  'preparing_context',
  'calling_model',
  'awaiting_tool_result',
  'tool_requested',
  'tool_result',
  'tool_result_received',
  'resuming_after_tool',
  'awaiting_hil',
  'assistant_output',
  'completed',
])

const EXPLORE_ACTIONS = new Set([
  'read_file',
  'bulk_files_read',
  'search_text',
  'list_dir',
])

export type TurnSegment =
  | {
      kind: 'narrative'
      id: string
      text: string
      tone: 'default' | 'code'
    }
  | {
      kind: 'thought'
      id: string
      text: string
      startedAt: number
      completedAt: number
      isLive?: boolean
    }
  | {
      kind: 'explore'
      id: string
      filesRead: number
      searches: number
      lists: number
      nodes: ToolExecutionNode[]
      isLive?: boolean
    }
  | {
      kind: 'edit'
      id: string
      node: ToolExecutionNode
    }
  | {
      kind: 'terminal'
      id: string
      node: ToolExecutionNode
    }
  | {
      kind: 'tool'
      id: string
      node: ToolExecutionNode
    }
  | {
      kind: 'context'
      id: string
      label: string
    }
  | {
      kind: 'hil'
      id: string
      card: HilCardState
    }
  | {
      kind: 'system'
      id: string
      text: string
      tone: 'info' | 'warning' | 'error'
    }

export interface AgentTurnTimeline {
  segments: TurnSegment[]
  startedAt: number
  completedAt?: number
  durationMs: number
  hasToolWork: boolean
}

const TOOL_WORK_SEGMENT_KINDS = new Set<TurnSegment['kind']>([
  'explore',
  'edit',
  'terminal',
  'tool',
  'context',
])

export const segmentIsToolWork = (segment: TurnSegment) =>
  TOOL_WORK_SEGMENT_KINDS.has(segment.kind)

export const computeTurnTiming = (
  events: SessionEvent[],
  messageStartedAt?: number,
  persistedDurationMs?: number
) => {
  const eventTimestamps = events
    .map((event) => event.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === 'number' && timestamp > 0)

  for (const event of events) {
    if (event.type !== 'thinking') {
      continue
    }

    const metadata = event.metadata
    if (typeof metadata?.reasoningStartedAt === 'number') {
      eventTimestamps.push(metadata.reasoningStartedAt)
    }
    if (typeof metadata?.reasoningCompletedAt === 'number') {
      eventTimestamps.push(metadata.reasoningCompletedAt)
    }
  }

  const completedAt =
    eventTimestamps.length > 0
      ? Math.max(...eventTimestamps)
      : messageStartedAt ?? Date.now()

  if (typeof persistedDurationMs === 'number' && persistedDurationMs > 0) {
    return {
      startedAt: completedAt - persistedDurationMs,
      completedAt,
      durationMs: persistedDurationMs,
    }
  }

  if (eventTimestamps.length === 0) {
    const fallback = messageStartedAt ?? Date.now()
    return {
      startedAt: fallback,
      completedAt: fallback,
      durationMs: 0,
    }
  }

  const startedAt = Math.min(...eventTimestamps)
  return {
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const countPathsInNode = (node: ToolExecutionNode) => {
  const args = asRecord(asRecord(node.requestDebug)?.args)
  const payload = asRecord(args?.payload)
  const paths = payload?.paths
  if (Array.isArray(paths)) {
    return paths.length
  }
  return 1
}

const countExploreNodes = (nodes: ToolExecutionNode[]) => {
  let filesRead = 0
  let searches = 0
  let lists = 0

  for (const node of nodes) {
    switch (node.action) {
      case 'read_file':
        filesRead += 1
        break
      case 'bulk_files_read':
        filesRead += countPathsInNode(node)
        break
      case 'search_text':
        searches += 1
        break
      case 'list_dir':
        lists += 1
        break
      default:
        break
    }
  }

  return { filesRead, searches, lists }
}

export const formatDuration = (durationMs: number) => {
  if (durationMs < 1000) {
    return '<1s'
  }

  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export const getThoughtDurationMs = (segment: Extract<TurnSegment, { kind: 'thought' }>) => {
  const delta = segment.completedAt - segment.startedAt
  return delta > 0 ? delta : 0
}

export const formatExploreSummary = (
  counts: { filesRead: number; searches: number; lists: number },
  isLive = false
) => {
  const parts: string[] = []

  if (counts.filesRead > 0) {
    parts.push(
      isLive
        ? `Reading ${counts.filesRead} file${counts.filesRead === 1 ? '' : 's'}`
        : `Explored ${counts.filesRead} file${counts.filesRead === 1 ? '' : 's'}`
    )
  }

  if (counts.searches > 0) {
    parts.push(
      isLive
        ? `Searching (${counts.searches})`
        : `${counts.searches} search${counts.searches === 1 ? '' : 'es'}`
    )
  }

  if (counts.lists > 0) {
    parts.push(
      isLive
        ? `Listing ${counts.lists} folder${counts.lists === 1 ? '' : 's'}`
        : `Listed ${counts.lists} folder${counts.lists === 1 ? '' : 's'}`
    )
  }

  if (parts.length === 0) {
    return isLive ? 'Exploring workspace…' : 'Explored workspace'
  }

  if (!isLive && counts.filesRead > 0 && (counts.searches > 0 || counts.lists > 0)) {
    const tail = [
      counts.searches > 0 ? `${counts.searches} search${counts.searches === 1 ? '' : 'es'}` : '',
      counts.lists > 0 ? `${counts.lists} list${counts.lists === 1 ? '' : 's'}` : '',
    ].filter(Boolean)
    return `Explored ${counts.filesRead} file${counts.filesRead === 1 ? '' : 's'}, ${tail.join(', ')}`
  }

  return parts.join(', ')
}

export const formatThoughtSummary = (durationMs: number, isLive = false) => {
  if (isLive) {
    return 'Thinking…'
  }

  if (durationMs <= 0) {
    return 'Thought briefly'
  }

  return `Thought for ${formatDuration(durationMs)}`
}

/** Status updates streamed via the model reasoning channel should read as narrative. */
export const isUserFacingProse = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (trimmed.length > 2200) {
    return false
  }

  const preview = trimmed.slice(0, 160)
  const userFacingOpeners = [
    /^let me\b/i,
    /^i'?ll\b/i,
    /^i will\b/i,
    /^now let me\b/i,
    /^good[,.!\s]/i,
    /^next[,.\s]/i,
    /^first[,.\s]/i,
    /^the issue\b/i,
    /^the problem\b/i,
    /^i see\b/i,
    /^i found\b/i,
    /^here'?s\b/i,
    /^this (is|looks|should)\b/i,
    /^looking at\b/i,
    /^i need to (read|check|fix|update|edit|create|open|run|start|verify)\b/i,
    /^we (need|should)\b/i,
  ]

  if (userFacingOpeners.some((pattern) => pattern.test(preview) || pattern.test(trimmed))) {
    return true
  }

  const bulletHeavy = (trimmed.match(/^\s*[-*•\d.]+\s+/gm) || []).length >= 4
  if (bulletHeavy) {
    return false
  }

  return false
}

const isNarrativeJunkFragment = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return true
  }

  if (trimmed.length <= 3) {
    return true
  }

  if (/^[\s.!?…\-_,;:()[\]{}'"`]+$/.test(trimmed)) {
    return true
  }

  return false
}

const coalesceAdjacentNarratives = (segments: TurnSegment[]): TurnSegment[] => {
  const result: TurnSegment[] = []

  for (const segment of segments) {
    const previous = result[result.length - 1]
    if (
      segment.kind === 'narrative' &&
      previous?.kind === 'narrative' &&
      previous.tone === segment.tone
    ) {
      previous.text = `${previous.text}${segment.text}`
      continue
    }

    result.push(
      segment.kind === 'narrative'
        ? { ...segment }
        : segment
    )
  }

  return result
}

const normalizeForComparison = (text: string) =>
  text.replace(/\s+/g, ' ').trim()

const reconcileTimelineWithContent = (
  segments: TurnSegment[],
  content?: string,
  isTurnLive = false
): TurnSegment[] => {
  const contentText = content?.trim()
  if (!contentText) {
    return segments
  }

  const narrativeFromEvents = segments
    .filter((segment): segment is Extract<TurnSegment, { kind: 'narrative' }> => segment.kind === 'narrative')
    .map((segment) => segment.text)
    .join('')

  const normalizedContent = normalizeForComparison(contentText)
  const normalizedNarrativeFromInput = normalizeForComparison(narrativeFromEvents)

  const withoutDuplicateThoughts: TurnSegment[] = []

  for (const segment of segments) {
    if (segment.kind !== 'thought') {
      withoutDuplicateThoughts.push(segment)
      continue
    }

    const thought = segment.text.trim()
    if (!thought) {
      continue
    }

    if (normalizedContent.includes(normalizeForComparison(thought))) {
      continue
    }

    if (normalizedNarrativeFromInput.includes(normalizeForComparison(thought))) {
      continue
    }

    if (isTurnLive && isUserFacingProse(thought)) {
      withoutDuplicateThoughts.push({
        kind: 'narrative',
        id: segment.id,
        text: thought,
        tone: 'default',
      })
      continue
    }

    withoutDuplicateThoughts.push(segment)
  }

  let result = withoutDuplicateThoughts

  if (!isTurnLive) {
    result = result.filter((segment) => {
      if (segment.kind !== 'narrative' || segment.tone !== 'default') {
        return true
      }

      return !isNarrativeJunkFragment(segment.text)
    })
    result = coalesceAdjacentNarratives(result)
  }

  const narrativeFromResult = result
    .filter((segment): segment is Extract<TurnSegment, { kind: 'narrative' }> => segment.kind === 'narrative')
    .map((segment) => segment.text)
    .join('')

  const normalizedNarrative = normalizeForComparison(narrativeFromResult)

  if (normalizedNarrative && normalizedNarrative === normalizedContent) {
    return result
  }

  if (normalizedNarrative) {
    if (
      !isTurnLive &&
      contentText &&
      !normalizedContent.includes(normalizedNarrative) &&
      normalizedNarrative.length < normalizedContent.length
    ) {
      const workSegments = result.filter(
        (segment) => segment.kind !== 'narrative' || segment.tone === 'code'
      )
      const narrativeSegment: TurnSegment = {
        kind: 'narrative',
        id: 'content-primary',
        text: contentText,
        tone: 'default',
      }

      return [...workSegments, narrativeSegment]
    }

    return result
  }

  const narrativeSegment: TurnSegment = {
    kind: 'narrative',
    id: 'content-primary',
    text: contentText,
    tone: 'default',
  }

  const hasWork = result.some(
    (segment) => segment.kind !== 'narrative' && segment.kind !== 'system'
  )

  if (!hasWork) {
    return [narrativeSegment]
  }

  return [...result, narrativeSegment]
}

const TERMINAL_CARD_ACTIONS = new Set([
  'run_command',
  'send_input',
  'new_terminal',
])

const classifyNode = (node: ToolExecutionNode) => {
  if (node.action === 'tools_loaded' || node.action === 'context_loaded') {
    return 'context' as const
  }
  if (
    node.toolName === 'terminal_ops' &&
    (!node.action || TERMINAL_CARD_ACTIONS.has(node.action))
  ) {
    return 'terminal' as const
  }
  if (FILE_MUTATION_ACTIONS.has(node.action ?? '')) {
    return 'edit' as const
  }
  if (EXPLORE_ACTIONS.has(node.action ?? '')) {
    return 'explore' as const
  }
  return 'tool' as const
}

const appendNarrative = (segments: TurnSegment[], text: string, tone: 'default' | 'code', id: string) => {
  if (!text.trim()) {
    return
  }

  const previous = segments[segments.length - 1]
  if (previous?.kind === 'narrative' && previous.tone === tone) {
    previous.text = `${previous.text}${text}`
    return
  }

  segments.push({
    kind: 'narrative',
    id,
    text,
    tone,
  })
}

export const buildAgentTurnTimeline = (
  events: SessionEvent[],
  content?: string,
  messageStartedAt?: number,
  isTurnLive = false,
  persistedDurationMs?: number
): AgentTurnTimeline => {
  const segments: TurnSegment[] = []
  const openToolNodes = new Map<string, ToolExecutionNode>()
  const segmentNodes = new Map<string, ToolExecutionNode>()
  const hilCardBySession = new Map<string, HilCardState>()
  const skippedHilToolCallIds = new Set<string>()

  let exploreBuffer: ToolExecutionNode[] = []
  let activeExploreSegment: Extract<TurnSegment, { kind: 'explore' }> | null = null
  let activeThoughtSegment: Extract<TurnSegment, { kind: 'thought' }> | null = null
  let thoughtBuffer: {
    id: string
    text: string
    startedAt: number
    completedAt: number
  } | null = null

  let segmentCounter = 0
  const nextId = (prefix: string) => `${prefix}-${segmentCounter++}`

  const syncExploreSegment = (isLive = false) => {
    if (exploreBuffer.length === 0) {
      return
    }

    const counts = countExploreNodes(exploreBuffer)
    if (!activeExploreSegment) {
      activeExploreSegment = {
        kind: 'explore',
        id: nextId('explore'),
        ...counts,
        nodes: [...exploreBuffer],
        isLive,
      }
      segments.push(activeExploreSegment)
      return
    }

    activeExploreSegment.filesRead = counts.filesRead
    activeExploreSegment.searches = counts.searches
    activeExploreSegment.lists = counts.lists
    activeExploreSegment.nodes = [...exploreBuffer]
    activeExploreSegment.isLive = isLive
  }

  const flushExplore = (isLive = false) => {
    if (exploreBuffer.length === 0) {
      return
    }

    syncExploreSegment(isLive)
    exploreBuffer = []
    activeExploreSegment = null
  }

  const syncThoughtSegment = (isLive = false) => {
    if (!thoughtBuffer?.text.trim()) {
      return
    }

    if (!activeThoughtSegment) {
      activeThoughtSegment = {
        kind: 'thought',
        id: thoughtBuffer.id,
        text: thoughtBuffer.text,
        startedAt: thoughtBuffer.startedAt,
        completedAt: thoughtBuffer.completedAt,
        isLive,
      }
      segments.push(activeThoughtSegment)
      return
    }

    activeThoughtSegment.text = thoughtBuffer.text
    activeThoughtSegment.completedAt = thoughtBuffer.completedAt
    activeThoughtSegment.isLive = isLive
  }

  const flushThought = (isLive = false) => {
    if (!thoughtBuffer?.text.trim()) {
      thoughtBuffer = null
      activeThoughtSegment = null
      return
    }

    syncThoughtSegment(isLive)
    thoughtBuffer = null
    activeThoughtSegment = null
  }

  const flushWorkBuffers = (isLive = false) => {
    flushExplore(isLive)
    flushThought(isLive)
  }

  const upsertSegmentNode = (node: ToolExecutionNode) => {
    const existingIndex = segments.findIndex(
      (segment) =>
        (segment.kind === 'edit' ||
          segment.kind === 'terminal' ||
          segment.kind === 'tool') &&
        segment.node.id === node.id
    )

    if (existingIndex === -1) {
      return false
    }

    const segment = segments[existingIndex]
    if (
      segment.kind === 'edit' ||
      segment.kind === 'terminal' ||
      segment.kind === 'tool'
    ) {
      segment.node = { ...node }
    }
    return true
  }

  const pushNodeSegment = (node: ToolExecutionNode, isLive = false) => {
    const category = classifyNode(node)

    if (category === 'explore') {
      flushThought(isLive)
      const bufferIndex = exploreBuffer.findIndex((entry) => entry.id === node.id)
      if (bufferIndex === -1) {
        exploreBuffer.push(node)
      } else {
        exploreBuffer[bufferIndex] = node
      }
      syncExploreSegment(isLive || node.state === 'running')
      return
    }

    flushWorkBuffers(isLive)

    if (category === 'context') {
      segments.push({
        kind: 'context',
        id: node.id,
        label: node.summary,
      })
      return
    }

    if (category === 'edit') {
      if (!upsertSegmentNode(node)) {
        segments.push({ kind: 'edit', id: node.id, node })
      }
      return
    }

    if (category === 'terminal') {
      if (!upsertSegmentNode(node)) {
        segments.push({ kind: 'terminal', id: node.id, node })
      }
      return
    }

    if (!upsertSegmentNode(node)) {
      segments.push({ kind: 'tool', id: node.id, node })
    }
  }

  const registerNode = (node: ToolExecutionNode, isLive = false) => {
    segmentNodes.set(node.id, node)
    pushNodeSegment(node, isLive)
  }

  const updateNode = (node: ToolExecutionNode, isLive = false) => {
    segmentNodes.set(node.id, node)

    const bufferIndex = exploreBuffer.findIndex((entry) => entry.id === node.id)
    if (bufferIndex !== -1) {
      exploreBuffer[bufferIndex] = node
      syncExploreSegment(isLive || node.state === 'running')
      return
    }

    pushNodeSegment(node, isLive)
  }

  for (const event of events) {
    if (event.type === 'output') {
      const text = normalizeEventText(event.content)
      if (!text.trim()) {
        continue
      }
      flushWorkBuffers()
      appendNarrative(segments, text, 'default', event.id)
      continue
    }

    if (event.type === 'code') {
      const text = normalizeEventText(event.content)
      if (!text) {
        continue
      }
      flushWorkBuffers()
      appendNarrative(segments, text, 'code', event.id)
      continue
    }

    if (event.type === 'thinking') {
      const text = normalizeEventText(event.content)
      if (!text.trim()) {
        continue
      }

      if (isUserFacingProse(text) && isTurnLive) {
        flushWorkBuffers()
        appendNarrative(segments, text, 'default', event.id)
        continue
      }

      flushExplore()

      const eventTimestamp = event.timestamp || Date.now()
      const metadata = event.metadata
      const startedAt =
        typeof metadata?.reasoningStartedAt === 'number'
          ? metadata.reasoningStartedAt
          : eventTimestamp
      const completedAt =
        typeof metadata?.reasoningCompletedAt === 'number'
          ? metadata.reasoningCompletedAt
          : eventTimestamp

      if (!thoughtBuffer) {
        thoughtBuffer = {
          id: event.id,
          text,
          startedAt,
          completedAt,
        }
      } else {
        thoughtBuffer.text = `${thoughtBuffer.text}${text}`
        thoughtBuffer.completedAt = Math.max(thoughtBuffer.completedAt, completedAt)
      }
      syncThoughtSegment(isTurnLive)
      continue
    }

    if (event.type === 'tool_call') {
      flushThought(false)
      const node = createToolNodeFromCall(event)
      // hil_tool UI is the inline card — skip the generic tool receipt row
      if (node.toolName === 'hil_tool') {
        if (node.toolCallId) {
          skippedHilToolCallIds.add(node.toolCallId)
        }
        continue
      }
      if (node.toolCallId) {
        openToolNodes.set(node.toolCallId, node)
      }
      registerNode(node, isTurnLive && node.state === 'running')
      continue
    }

    if (event.type === 'tool_result') {
      const toolCallId = getEventToolCallId(event)
      if (toolCallId && skippedHilToolCallIds.has(toolCallId)) {
        skippedHilToolCallIds.delete(toolCallId)
        continue
      }

      const matchingNode = toolCallId ? openToolNodes.get(toolCallId) : undefined

      if (matchingNode?.toolName === 'hil_tool') {
        continue
      }

      if (matchingNode) {
        applyToolResultToNode(matchingNode, event)
        openToolNodes.delete(toolCallId as string)
        updateNode(matchingNode, isTurnLive && matchingNode.state === 'running')
      } else {
        flushWorkBuffers()
        const node = createToolNodeFromResult(event)
        registerNode(node)
      }
      continue
    }

    if (event.type === 'hil_question') {
      const card = cardFromHilQuestionEvent(event)
      if (!card) {
        continue
      }
      flushWorkBuffers()
      hilCardBySession.set(card.hilSessionId, card)
      segments.push({
        kind: 'hil',
        id: card.hilSessionId,
        card,
      })
      continue
    }

    if (event.type === 'hil_resolved') {
      const updated = applyHilResolvedEvent(hilCardBySession, event)
      if (!updated) {
        continue
      }
      const segmentIndex = segments.findIndex(
        (segment) => segment.kind === 'hil' && segment.id === updated.hilSessionId
      )
      if (segmentIndex !== -1) {
        segments[segmentIndex] = {
          kind: 'hil',
          id: updated.hilSessionId,
          card: updated,
        }
      }
      continue
    }

    if (event.type === 'status') {
      const phase = getEventPhase(event)

      if (phase === 'tools_loaded' || phase === 'tool_context_loaded') {
        const label = loadedToolsLabelFromStatusEvent(event)
        if (label) {
          flushWorkBuffers()
          segments.push({
            kind: 'context',
            id: event.id,
            label,
          })
        }
        continue
      }

      if (phase === 'hil_card' || phase === 'awaiting_hil') {
        flushWorkBuffers()
        segments.push({
          kind: 'context',
          id: event.id,
          label: 'HIL card active — answer to continue',
        })
        continue
      }

      if (phase && HIDDEN_STATUS_PHASES.has(phase)) {
        continue
      }

      const text = normalizeEventText(event.content)
      if (!text) {
        continue
      }

      flushWorkBuffers()
      segments.push({
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

      flushWorkBuffers()
      segments.push({
        kind: 'system',
        id: event.id,
        text,
        tone: 'error',
      })
    }
  }

  flushWorkBuffers(isTurnLive)

  let finalizedSegments = segments

  const hasNarrative = finalizedSegments.some((segment) => segment.kind === 'narrative')
  const hasOutputEvents = events.some(
    (event) => event.type === 'output' || event.type === 'code'
  )

  if (!hasNarrative && !hasOutputEvents && content?.trim()) {
    finalizedSegments.push({
      kind: 'narrative',
      id: nextId('narrative-fallback'),
      text: content,
      tone: 'default',
    })
  }

  finalizedSegments = reconcileTimelineWithContent(finalizedSegments, content, isTurnLive)

  const hasToolWork = finalizedSegments.some((segment) => segmentIsToolWork(segment))
  const timing = computeTurnTiming(events, messageStartedAt, persistedDurationMs)

  return {
    segments: finalizedSegments,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    durationMs: timing.durationMs,
    hasToolWork,
  }
}

export const segmentIsLive = (segment: TurnSegment, isTurnLive: boolean) => {
  if (!isTurnLive) {
    return false
  }

  if (segment.kind === 'thought' || segment.kind === 'explore') {
    return Boolean(segment.isLive)
  }

  if (segment.kind === 'edit' || segment.kind === 'terminal' || segment.kind === 'tool') {
    return segment.node.state === 'running'
  }

  if (segment.kind === 'hil') {
    return segment.card.status === 'pending'
  }

  return false
}

export const turnHasLiveWork = (segments: TurnSegment[], isTurnLive: boolean) => {
  if (!isTurnLive) {
    return false
  }

  return segments.some((segment) => segmentIsLive(segment, isTurnLive))
}

const sanitizeHistoricalNode = (node: ToolExecutionNode): ToolExecutionNode => {
  if (node.state !== 'running') {
    return node
  }

  return {
    ...node,
    state: 'error' as ToolExecutionState,
  }
}

/** Normalize live flags and zombie running states for completed turns. */
export const finalizeAgentTurnTimeline = (
  timeline: AgentTurnTimeline,
  isTurnLive: boolean
): AgentTurnTimeline => {
  if (isTurnLive) {
    return timeline
  }

  const segments = timeline.segments.map((segment): TurnSegment => {
    if (segment.kind === 'thought') {
      return { ...segment, isLive: false }
    }

    if (segment.kind === 'explore') {
      return {
        ...segment,
        isLive: false,
        nodes: segment.nodes.map(sanitizeHistoricalNode),
      }
    }

    if (segment.kind === 'edit' || segment.kind === 'terminal' || segment.kind === 'tool') {
      return {
        ...segment,
        node: sanitizeHistoricalNode(segment.node),
      }
    }

    return segment
  })

  return {
    ...timeline,
    segments,
  }
}

export const getNodeDurationMs = (node: ToolExecutionNode) => {
  if (typeof node.executionTimeMs === 'number' && node.executionTimeMs > 0) {
    return node.executionTimeMs
  }

  if (node.completedAt && node.startedAt) {
    const delta = node.completedAt - node.startedAt
    if (delta > 0) {
      return delta
    }
  }

  return undefined
}

export const summarizeTurnRollup = (segments: TurnSegment[]) => {
  let editCount = 0
  let additions = 0
  let deletions = 0

  for (const segment of segments) {
    if (segment.kind !== 'edit') {
      continue
    }

    editCount += 1
    const data = asRecord(asRecord(segment.node.resultDebug)?.data)
    const changes = extractFileChangesFromData(data)
    for (const change of changes) {
      additions += change.additions ?? 0
      deletions += change.deletions ?? 0
    }
  }

  if (editCount === 0) {
    return null
  }

  const fileLabel = `Edited ${editCount} file${editCount === 1 ? '' : 's'}`
  if (additions > 0 || deletions > 0) {
    return `${fileLabel} · +${additions} −${deletions}`
  }

  return fileLabel
}

export const segmentIsAlwaysVisible = (segment: TurnSegment) =>
  segment.kind === 'narrative' ||
  segment.kind === 'context' ||
  segment.kind === 'hil' ||
  segment.kind === 'edit' ||
  segment.kind === 'terminal' ||
  segment.kind === 'system'
