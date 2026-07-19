import type { FileChange, FileChangeOperation } from './fileChangeTypes'
import { inferOperation } from './fileChangeStats'

export interface ReviewSnapshotPayload {
  file: string
  originalUri: string
  snapshotPath?: string
  operation: FileChangeOperation
  isNewFile: boolean
  isDeleted: boolean
  isBinary: boolean
}

export const buildReviewPayload = (change: FileChange): ReviewSnapshotPayload | null => {
  const operation = inferOperation(change)
  const originalUri = change.undo?.originalUri
  if (!originalUri) {
    return null
  }

  const isBinary = Boolean(change.isBinary)

  if (operation === 'create' || operation === 'create_folder') {
    return {
      file: change.file,
      originalUri,
      operation,
      isNewFile: true,
      isDeleted: false,
      isBinary,
    }
  }

  if (operation === 'delete' || operation === 'delete_folder') {
    if (!change.undo?.snapshotPath && !isBinary) {
      return null
    }
    return {
      file: change.file,
      originalUri,
      snapshotPath: change.undo?.snapshotPath,
      operation,
      isNewFile: false,
      isDeleted: true,
      isBinary,
    }
  }

  if (operation === 'rename') {
    return {
      file: change.file,
      originalUri,
      snapshotPath: change.undo?.snapshotPath,
      operation,
      isNewFile: false,
      isDeleted: false,
      isBinary,
    }
  }

  if (!isBinary && !change.undo?.snapshotPath) {
    return null
  }

  return {
    file: change.file,
    originalUri,
    snapshotPath: change.undo?.snapshotPath,
    operation,
    isNewFile: false,
    isDeleted: false,
    isBinary,
  }
}

export const canReviewChange = (change: FileChange): boolean =>
  buildReviewPayload(change) !== null
