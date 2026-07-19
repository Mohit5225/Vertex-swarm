export type FileChangeOperation =
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  | 'create_folder'
  | 'delete_folder'

export interface UndoHandle {
  undoAvailable: boolean
  originalUri: string
  snapshotPath?: string
}

export interface FileChange {
  changeId: string
  path: string
  file: string
  operation: FileChangeOperation
  additions: number
  deletions: number
  diffText: string
  applied: boolean
  renamedFrom?: string
  renamedTo?: string
  undo?: UndoHandle
}

/** @deprecated Use FileChange — kept for chat history recorded before file_changes existed. */
export interface LegacyDiffStat {
  file: string
  path?: string
  originalUri: string
  snapshotPath: string
  additions: number
  deletions: number
  diffText: string
  operation?: FileChangeOperation
  renamedFrom?: string
  renamedTo?: string
}

export type DiffStat = FileChange
