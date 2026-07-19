import * as path from 'path';
import * as vscode from 'vscode';
import { classifyFileForSnapshot } from '../snapshot/exclusion-list';
import { DiffService } from '../snapshot/diff-service';
import type { FileChange, FileChangeOperation } from './change-types';
import { buildChangeId } from './change-id';
import {
  readWorkspaceFileState,
  stateByteSize,
  stateHasContent,
  stateText,
  type FileContentState,
} from './file-content-state';

export interface BuildChangesInput {
  action: string;
  payload: Record<string, unknown>;
  fileUris: vscode.Uri[];
  beforeStates: Map<string, FileContentState>;
  snapshotDir: string;
  requestId?: string;
}

export class ChangeRecorder {
  async captureBeforeStates(fileUris: vscode.Uri[]): Promise<Map<string, FileContentState>> {
    const beforeStates = new Map<string, FileContentState>();

    for (const uri of fileUris) {
      beforeStates.set(uri.toString(), await readWorkspaceFileState(uri));
    }

    return beforeStates;
  }

  async buildChanges(input: BuildChangesInput): Promise<FileChange[]> {
    const { action, payload, fileUris, beforeStates, snapshotDir, requestId } = input;
    const renameOldPath = optionalString(payload.oldPath);
    const renameNewPath = optionalString(payload.newPath);
    const folderHints = buildFolderHints(action, payload);
    const changes: FileChange[] = [];

    for (const uri of fileUris) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const oldState = beforeStates.get(uri.toString()) ?? { kind: 'missing' as const };
      const newState = await readWorkspaceFileState(uri);
      const isDirectory = this.isDirectoryState(oldState, newState, action, relativePath, folderHints);

      const oldText = stateText(oldState);
      const newText = stateText(newState);
      const isBinary = oldState.kind === 'binary' || newState.kind === 'binary';
      const byteSizeBefore = stateByteSize(oldState);
      const byteSizeAfter = stateByteSize(newState);

      const operation = this.resolveOperation(
        action,
        relativePath,
        renameOldPath,
        renameNewPath,
        oldState,
        newState,
        isDirectory
      );

      if (operation === 'edit') {
        if (isBinary) {
          if (byteSizeBefore === byteSizeAfter) {
            continue;
          }
        } else if (oldText === newText) {
          continue;
        }
      }

      let additions = 0;
      let deletions = 0;
      let diffText = '';

      if (!isBinary) {
        const diff = DiffService.computeDiff(path.basename(uri.fsPath), oldText, newText);
        additions = diff.additions;
        deletions = diff.deletions;
        diffText = diff.diffText;

        if (operation === 'create' && additions === 0 && deletions === 0 && newText) {
          additions = countTextLines(newText);
        } else if (operation === 'delete' && additions === 0 && deletions === 0 && oldText) {
          deletions = countTextLines(oldText);
        }
      }

      const safeRelativePath = relativePath.replace(/[^a-zA-Z0-9.\-_\\/]/g, '_');
      const snapshotPath = path.join(snapshotDir, safeRelativePath);
      const undoEligible = classifyFileForSnapshot(uri) === 'include' && !isDirectory;

      const change: FileChange = {
        changeId: buildChangeId(requestId, relativePath),
        path: relativePath,
        file: path.basename(uri.fsPath),
        operation,
        additions,
        deletions,
        diffText,
        applied: true,
        requestId,
        isBinary,
        byteSizeBefore,
        byteSizeAfter,
        undo: {
          undoAvailable: undoEligible,
          originalUri: uri.toString(),
          snapshotPath: undoEligible ? snapshotPath : undefined,
        },
      };

      if (operation === 'rename') {
        if (renameNewPath && pathsMatch(relativePath, renameNewPath)) {
          change.renamedFrom = renameOldPath;
        }
      }

      if (operation === 'delete' && renameOldPath && pathsMatch(relativePath, renameOldPath)) {
        change.renamedTo = renameNewPath;
      }

      changes.push(change);
    }

    return changes;
  }

  private isDirectoryState(
    oldState: FileContentState,
    newState: FileContentState,
    action: string,
    relativePath: string,
    folderHints: Set<string>
  ): boolean {
    if (folderHints.has(normalizeWorkspacePath(relativePath))) {
      return true;
    }
    if (oldState.kind === 'directory' || newState.kind === 'directory') {
      return true;
    }
    if (action === 'delete_path' && oldState.kind === 'missing' && newState.kind === 'missing') {
      return true;
    }
    return false;
  }

  private resolveOperation(
    action: string,
    relativePath: string,
    renameOldPath: string | undefined,
    renameNewPath: string | undefined,
    oldState: FileContentState,
    newState: FileContentState,
    isDirectory: boolean
  ): FileChangeOperation {
    const hadContent = stateHasContent(oldState);
    const hasContent = stateHasContent(newState);

    if (action === 'create_file') {
      if (isDirectory) {
        return 'create_folder';
      }
      return hadContent ? 'edit' : 'create';
    }

    if (action === 'write_file') {
      return hadContent ? 'edit' : 'create';
    }

    if (action === 'delete_path' || action === 'delete_file') {
      return isDirectory ? 'delete_folder' : 'delete';
    }

    if (action === 'rename_path') {
      if (renameNewPath && pathsMatch(relativePath, renameNewPath)) {
        return 'rename';
      }
      if (renameOldPath && pathsMatch(relativePath, renameOldPath)) {
        return 'delete';
      }
      return 'rename';
    }

    if (!hadContent && hasContent) {
      return 'create';
    }

    if (hadContent && !hasContent) {
      return 'delete';
    }

    return 'edit';
  }
}

function buildFolderHints(action: string, payload: Record<string, unknown>): Set<string> {
  const hints = new Set<string>();

  if (action !== 'create_file') {
    return hints;
  }

  const markFolder = (filePath: unknown, content: unknown) => {
    if (typeof filePath !== 'string') {
      return;
    }
    const isFolder =
      content === undefined ||
      content === null ||
      filePath.endsWith('/') ||
      filePath.endsWith('\\');
    if (isFolder) {
      hints.add(normalizeWorkspacePath(filePath));
    }
  };

  const filesPayload = payload.files;
  if (Array.isArray(filesPayload)) {
    for (const file of filesPayload) {
      if (file && typeof file === 'object') {
        const entry = file as { path?: unknown; content?: unknown };
        markFolder(entry.path, entry.content);
      }
    }
  } else {
    markFolder(payload.path, payload.content);
  }

  return hints;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function countTextLines(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return text.split('\n').length;
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function pathsMatch(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}
