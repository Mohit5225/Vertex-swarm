import * as vscode from 'vscode';

export interface SnapshotHandle {
  snapshotId: string;
  sessionId: string;
  messageId: string;
}

export interface SnapshotManifestEntry {
  path: string; // workspace relative or absolute path (stringified URI)
  existedBefore: boolean;
  backend: 'disk' | 'git';
  snapshotPath?: string; // disk backend
  blob?: string;         // git backend
  isBinary?: boolean;
}

export interface SnapshotManifest {
  snapshotId: string;
  timestamp: string;
  files: SnapshotManifestEntry[];
}

export interface SnapshotContext {
  sessionId: string;
  messageId: string;
}

export interface ISnapshotManager {
  getSnapshotDir(context: SnapshotContext): string;
  createSnapshot(fileUris: vscode.Uri[], context: SnapshotContext): Promise<SnapshotHandle>;
  restoreSnapshot(handle: SnapshotHandle): Promise<void>;
}
