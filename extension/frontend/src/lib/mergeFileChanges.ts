import { type FileChange, type FileChangeOperation } from './fileChangeTypes'

export const normalizePathKey = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

const isTerminalOperation = (operation: FileChangeOperation): boolean =>
  operation === 'delete' || operation === 'delete_folder'

const mergeOperation = (
  existing: FileChangeOperation,
  incoming: FileChangeOperation
): FileChangeOperation => {
  if (incoming !== 'edit') {
    return incoming
  }
  return existing
}

/**
 * Merges two change records for the same path within a turn.
 * Terminal deletes replace prior stats; rename source-path deletes are deferred to finalize.
 */
export const mergeFileChanges = (existing: FileChange, incoming: FileChange): FileChange => {
  // Source-path delete as part of rename — keep prior edit stats for rollup in finalizeTurnChanges.
  if (incoming.operation === 'delete' && incoming.renamedTo) {
    if (existing.operation === 'edit' || existing.operation === 'create') {
      return {
        ...existing,
        renamedTo: incoming.renamedTo,
        undo: incoming.undo ?? existing.undo,
      }
    }
    return incoming
  }

  if (isTerminalOperation(incoming.operation)) {
    return {
      ...incoming,
      changeId: existing.changeId,
    }
  }

  if (isTerminalOperation(existing.operation)) {
    return existing
  }

  if (incoming.operation === 'rename') {
    return {
      ...incoming,
      changeId: existing.changeId,
      additions: existing.isBinary || incoming.isBinary ? 0 : existing.additions + incoming.additions,
      deletions: existing.isBinary || incoming.isBinary ? 0 : existing.deletions + incoming.deletions,
      isBinary: Boolean(existing.isBinary || incoming.isBinary),
      byteSizeBefore: existing.byteSizeBefore ?? incoming.byteSizeBefore,
      byteSizeAfter: incoming.byteSizeAfter ?? existing.byteSizeAfter,
      diffText: incoming.diffText || existing.diffText,
      renamedFrom: incoming.renamedFrom ?? existing.renamedFrom,
      renamedTo: incoming.renamedTo ?? existing.renamedTo,
      undo: incoming.undo ?? existing.undo,
    }
  }

  return {
    ...existing,
    additions: existing.isBinary ? 0 : existing.additions + (incoming.isBinary ? 0 : incoming.additions),
    deletions: existing.isBinary ? 0 : existing.deletions + (incoming.isBinary ? 0 : incoming.deletions),
    isBinary: Boolean(existing.isBinary || incoming.isBinary),
    byteSizeBefore: existing.byteSizeBefore ?? incoming.byteSizeBefore,
    byteSizeAfter: incoming.byteSizeAfter ?? existing.byteSizeAfter,
    operation: mergeOperation(existing.operation, incoming.operation),
    diffText: incoming.diffText || existing.diffText,
    renamedFrom: incoming.renamedFrom ?? existing.renamedFrom,
    renamedTo: incoming.renamedTo ?? existing.renamedTo,
    undo: incoming.undo ?? existing.undo,
  }
}

/**
 * Collapses rename pairs into a single row on the new path and rolls up
 * any prior edits that happened on the old path before the rename.
 */
export const finalizeTurnChanges = (changes: FileChange[]): FileChange[] => {
  const renameByOldPath = new Map<string, FileChange>()

  for (const change of changes) {
    if (change.operation === 'rename' && change.renamedFrom) {
      renameByOldPath.set(normalizePathKey(change.renamedFrom), change)
    }
  }

  if (renameByOldPath.size === 0) {
    return changes
  }

  for (const change of changes) {
    const pathKey = normalizePathKey(change.path)
    const renameRow = renameByOldPath.get(pathKey)
    if (!renameRow || change === renameRow) {
      continue
    }

    if (change.operation === 'edit' || change.operation === 'create') {
      if (change.isBinary) {
        renameRow.byteSizeBefore = Math.min(renameRow.byteSizeBefore ?? change.byteSizeBefore ?? 0, change.byteSizeBefore ?? 0)
        renameRow.byteSizeAfter = change.byteSizeAfter ?? renameRow.byteSizeAfter
        renameRow.isBinary = true
      } else {
        renameRow.additions += change.additions
        renameRow.deletions += change.deletions
      }
      if (change.diffText) {
        renameRow.diffText = change.diffText
      }
    }
  }

  const supersededPaths = new Set(renameByOldPath.keys())

  return changes.filter((change) => {
    const pathKey = normalizePathKey(change.path)

    if (supersededPaths.has(pathKey)) {
      return false
    }

    if (change.operation === 'delete' && change.renamedTo) {
      return false
    }

    return true
  })
}
