import { type SessionEvent } from '../store/chatStore'
import { type DiffStat } from '../components/SnapshotCard'
import { buildAgentRunBlocks } from './agentRunBlocks'

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

export const normalizeDiffStat = (diff: DiffStat): DiffStat => {
  if ((diff.additions > 0 || diff.deletions > 0) || !diff.diffText?.trim()) {
    return diff
  }

  const counted = countLinesFromDiffText(diff.diffText)
  return {
    ...diff,
    additions: counted.additions,
    deletions: counted.deletions,
  }
}

export interface MessageDiffSummary {
  diffs: DiffStat[]
  snapshotId: string
  sessionId: string
  messageId: string
}

/**
 * Collects and merges per-file diff stats across every process block in an agent turn.
 * Incremental edits to the same file are summed so totals match the full turn.
 */
export const collectMessageDiffs = (
  events: SessionEvent[],
  content = ''
): MessageDiffSummary => {
  const blocks = buildAgentRunBlocks(events, content)
  const diffMap = new Map<string, DiffStat>()
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
      const rawDiffs = Array.isArray(data?.snapshot_diffs)
        ? (data.snapshot_diffs as DiffStat[])
        : []

      if (!snapshotId && typeof data?.snapshot_id === 'string') {
        snapshotId = data.snapshot_id
        sessionId = typeof data.snapshot_session_id === 'string' ? data.snapshot_session_id : ''
        messageId = data.snapshot_id
      }

      for (const rawDiff of rawDiffs) {
        const diff = normalizeDiffStat(rawDiff)
        const key = diff.originalUri || diff.file
        if (!key) {
          continue
        }

        const existing = diffMap.get(key)
        if (existing) {
          existing.additions += diff.additions
          existing.deletions += diff.deletions
          if (diff.snapshotPath) {
            existing.snapshotPath = diff.snapshotPath
          }
          if (diff.diffText) {
            existing.diffText = diff.diffText
          }
        } else {
          diffMap.set(key, { ...diff })
        }
      }
    }
  }

  return {
    diffs: Array.from(diffMap.values()),
    snapshotId,
    sessionId,
    messageId,
  }
}
