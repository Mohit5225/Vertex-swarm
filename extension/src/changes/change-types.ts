export type FileChangeOperation =
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  | 'create_folder'
  | 'delete_folder';

export interface UndoHandle {
  undoAvailable: boolean;
  originalUri: string;
  snapshotPath?: string;
}

/** Canonical mutation record — source of truth for summary UI. */
export interface FileChange {
  changeId: string;
  path: string;
  file: string;
  operation: FileChangeOperation;
  additions: number;
  deletions: number;
  diffText: string;
  applied: boolean;
  renamedFrom?: string;
  renamedTo?: string;
  undo?: UndoHandle;
}
