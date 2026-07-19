import { type SessionEvent } from '../store/chatStore'
import { buildAgentRunBlocks } from './agentRunBlocks'
import {
  type FileChange,
  type LegacyDiffStat,
} from './fileChangeTypes'
import { finalizeTurnChanges, mergeFileChanges, normalizePathKey } from './mergeFileChanges'

/** workspace_ops actions that mutate files — read/search/list are excluded. */
export const FILE_MUTATION_ACTIONS = new Set([
  'edit_file',
  'create_file',
  'delete_path',
  'rename_path',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file',
])

const countLinesFromDiffText = (diffText: string) => {
  let additions = 0
  let deletions = 0

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue
    }
    if (line.startsWith('+')) {
      additions += 1
    } else if (line.startsWith('-')) {
      deletions += 1
    }
  }

  return { additions, deletions }
}

const legacyToFileChange = (legacy: LegacyDiffStat, index: number): FileChange => ({
  changeId: legacy.originalUri || `${legacy.file}-${index}`,
  path: legacy.path || legacy.file,
  file: legacy.file,
  operation: legacy.operation ?? 'edit',
  additions: legacy.additions,
  deletions: legacy.deletions,
  diffText: legacy.diffText ?? '',
  applied: true,
  renamedFrom: legacy.renamedFrom,
  renamedTo: legacy.renamedTo,
  undo: {
    undoAvailable: Boolean(legacy.snapshotPath),
    originalUri: legacy.originalUri,
    snapshotPath: legacy.snapshotPath,
  },
})

export const normalizeFileChange = (change: FileChange): FileChange => {
  if (change.isBinary) {
    return change
  }

  if ((change.additions > 0 || change.deletions > 0) || !change.diffText?.trim()) {
    return change
  }

  const counted = countLinesFromDiffText(change.diffText)
  return {
    ...change,
    additions: counted.additions,
    deletions: counted.deletions,
  }
}

export const extractFileChangesFromData = (
  data?: Record<string, unknown>
): FileChange[] => {
  if (!data) {
    return []
  }

  if (Array.isArray(data.file_changes)) {
    return (data.file_changes as FileChange[]).map(normalizeFileChange)
  }

  if (Array.isArray(data.snapshot_diffs)) {
    return (data.snapshot_diffs as LegacyDiffStat[]).map(legacyToFileChange)
  }

  return []
}

export interface MessageFileChangeSummary {
  changes: FileChange[]
  snapshotId: string
  sessionId: string
  messageId: string
}

/**
 * Collects and merges mutation records across an agent turn.
 * Read-only workspace_ops (read_file, search_text, list_dir) are never included.
 */
export const collectMessageFileChanges = (
  events: SessionEvent[],
  content = ''
): MessageFileChangeSummary => {
  const blocks = buildAgentRunBlocks(events, content)
  const changeMap = new Map<string, FileChange>()
  let snapshotId = ''
  let sessionId = ''
  let messageId = ''

  for (const block of blocks) {
    if (block.kind !== 'process') {
      continue
    }

    for (const step of block.steps) {
      if (step.kind !== 'node') {
        continue
      }

      if (!FILE_MUTATION_ACTIONS.has(step.node.action ?? '')) {
        continue
      }

      if (step.node.state !== 'success') {
        continue
      }

      const data = (step.node.resultDebug as { data?: Record<string, unknown> })?.data
      const rawChanges = extractFileChangesFromData(data)

      if (!snapshotId && typeof data?.snapshot_id === 'string') {
        snapshotId = data.snapshot_id
        sessionId = typeof data.snapshot_session_id === 'string' ? data.snapshot_session_id : ''
        messageId = data.snapshot_id
      }

      for (const rawChange of rawChanges) {
        if (!rawChange.applied) {
          continue
        }

        const change = normalizeFileChange(rawChange)
        const key = normalizePathKey(change.path || change.undo?.originalUri || change.changeId)
        if (!key) {
          continue
        }

        const existing = changeMap.get(key)
        if (existing) {
          changeMap.set(key, mergeFileChanges(existing, change))
        } else {
          changeMap.set(key, { ...change })
        }
      }
    }
  }

  return {
    changes: finalizeTurnChanges(Array.from(changeMap.values())),
    snapshotId,
    sessionId,
    messageId,
  }
}

/** @deprecated Use collectMessageFileChanges */
export const collectMessageDiffs = (
  events: SessionEvent[],
  content = ''
) => {
  const summary = collectMessageFileChanges(events, content)
  return {
    diffs: summary.changes,
    snapshotId: summary.snapshotId,
    sessionId: summary.sessionId,
    messageId: summary.messageId,
  }
}

/** @deprecated Use normalizeFileChange */
export const normalizeDiffStat = normalizeFileChange
