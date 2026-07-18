import { type DiffStat, type FileChangeOperation } from '../components/SnapshotCard'

export const countTextLines = (text: string): number => {
  if (!text.trim()) {
    return 0
  }
  return text.split('\n').length
}

export const inferOperation = (diff: DiffStat): FileChangeOperation => {
  if (diff.operation) {
    return diff.operation
  }
  if (diff.additions > 0 && diff.deletions === 0) {
    return 'create'
  }
  if (diff.deletions > 0 && diff.additions === 0) {
    return 'delete'
  }
  return 'edit'
}

export const operationLabel = (operation: FileChangeOperation): string => {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    case 'rename':
      return 'Renamed'
    default:
      return 'Edited'
  }
}

export const summarizeFileChanges = (diffs: DiffStat[]): string => {
  if (diffs.length === 0) {
    return 'No file changes'
  }

  const counts: Record<FileChangeOperation, number> = {
    edit: 0,
    create: 0,
    delete: 0,
    rename: 0,
  }

  for (const diff of diffs) {
    counts[inferOperation(diff)] += 1
  }

  const parts: string[] = []
  if (counts.create > 0) {
    parts.push(`Created ${counts.create}`)
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

  const suffix = diffs.length === 1 ? 'file' : 'files'
  if (parts.length === 1) {
    return `${parts[0]} ${suffix}`
  }

  return `Changed ${diffs.length} ${suffix}`
}

export const shouldShowLineStats = (diff: DiffStat): boolean => {
  const operation = inferOperation(diff)
  if (operation === 'create' || operation === 'delete' || operation === 'rename') {
    return diff.additions > 0 || diff.deletions > 0
  }
  return true
}

export const fileChangeDetail = (diff: DiffStat): string | null => {
  const operation = inferOperation(diff)
  if (operation === 'rename' && diff.renamedFrom) {
    return `${diff.renamedFrom} → ${diff.file}`
  }
  if (operation === 'create' || operation === 'delete' || operation === 'rename') {
    return operationLabel(operation)
  }
  return null
}
