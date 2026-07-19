import { type FileChange, type FileChangeOperation } from './fileChangeTypes'

export const countTextLines = (text: string): number => {
  if (!text.trim()) {
    return 0
  }
  return text.split('\n').length
}

export const inferOperation = (change: FileChange): FileChangeOperation => {
  if (change.operation) {
    return change.operation
  }
  if (change.additions > 0 && change.deletions === 0) {
    return 'create'
  }
  if (change.deletions > 0 && change.additions === 0) {
    return 'delete'
  }
  return 'edit'
}

export const operationLabel = (operation: FileChangeOperation): string => {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'create_folder':
      return 'Created folder'
    case 'delete':
      return 'Deleted'
    case 'delete_folder':
      return 'Deleted folder'
    case 'rename':
      return 'Renamed'
    default:
      return 'Edited'
  }
}

export const summarizeFileChanges = (changes: FileChange[]): string => {
  if (changes.length === 0) {
    return 'No file changes'
  }

  const counts: Record<string, number> = {
    edit: 0,
    create: 0,
    delete: 0,
    rename: 0,
    create_folder: 0,
    delete_folder: 0,
  }

  for (const change of changes) {
    counts[inferOperation(change)] = (counts[inferOperation(change)] ?? 0) + 1
  }

  const parts: string[] = []
  if (counts.create > 0) {
    parts.push(`Created ${counts.create}`)
  }
  if (counts.create_folder > 0) {
    parts.push(`Created ${counts.create_folder} folder${counts.create_folder === 1 ? '' : 's'}`)
  }
  if (counts.edit > 0) {
    parts.push(`Edited ${counts.edit}`)
  }
  if (counts.rename > 0) {
    parts.push(`Renamed ${counts.rename}`)
  }
  if (counts.delete > 0) {
    parts.push(`Deleted ${counts.delete}`)
  }
  if (counts.delete_folder > 0) {
    parts.push(`Deleted ${counts.delete_folder} folder${counts.delete_folder === 1 ? '' : 's'}`)
  }

  const suffix = changes.length === 1 ? 'file' : 'files'
  if (parts.length === 1) {
    return parts[0].includes('folder') ? parts[0] : `${parts[0]} ${suffix}`
  }

  return `Changed ${changes.length} ${suffix}`
}

export const shouldShowLineStats = (change: FileChange): boolean => {
  const operation = inferOperation(change)
  if (
    operation === 'create' ||
    operation === 'delete' ||
    operation === 'rename' ||
    operation === 'create_folder' ||
    operation === 'delete_folder'
  ) {
    return change.additions > 0 || change.deletions > 0
  }
  return true
}

export const fileChangeDetail = (change: FileChange): string | null => {
  const operation = inferOperation(change)
  if (operation === 'rename' && change.renamedFrom) {
    return `${change.renamedFrom} → ${change.path}`
  }
  if (
    operation === 'create' ||
    operation === 'delete' ||
    operation === 'rename' ||
    operation === 'create_folder' ||
    operation === 'delete_folder'
  ) {
    if (operation === 'create' && change.additions === 0 && change.deletions === 0) {
      return 'Created (empty)'
    }
    return operationLabel(operation)
  }
  return null
}

export const canUndoChange = (change: FileChange): boolean =>
  Boolean(change.undo?.undoAvailable && change.undo.originalUri)
