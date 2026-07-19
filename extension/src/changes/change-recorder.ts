import * as crypto from 'node:crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { classifyFileForSnapshot } from '../snapshot/exclusion-list';
import { DiffService } from '../snapshot/diff-service';
import type { FileChange, FileChangeOperation } from './change-types';

export interface BuildChangesInput {
  action: string;
  payload: Record<string, unknown>;
  fileUris: vscode.Uri[];
  beforeTexts: Map<string, string>;
  snapshotDir: string;
}

export class ChangeRecorder {
  async captureBeforeTexts(fileUris: vscode.Uri[]): Promise<Map<string, string>> {
    const beforeTexts = new Map<string, string>();

    for (const uri of fileUris) {
      beforeTexts.set(uri.toString(), await this.readWorkspaceText(uri));
    }

    return beforeTexts;
  }

  async buildChanges(input: BuildChangesInput): Promise<FileChange[]> {
    const { action, payload, fileUris, beforeTexts, snapshotDir } = input;
    const renameOldPath = optionalString(payload.oldPath);
    const renameNewPath = optionalString(payload.newPath);
    const folderHints = buildFolderHints(action, payload);
    const changes: FileChange[] = [];

    for (const uri of fileUris) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const oldText = beforeTexts.get(uri.toString()) ?? '';
      const newText = await this.readWorkspaceText(uri);
      const isDirectory = await this.isDirectory(uri, action, relativePath, oldText, newText, folderHints);

      const operation = this.resolveOperation(
        action,
        relativePath,
        renameOldPath,
        renameNewPath,
        oldText,
        newText,
        isDirectory
      );

      if (operation === 'edit' && oldText === newText) {
        continue;
      }

      const diff = DiffService.computeDiff(path.basename(uri.fsPath), oldText, newText);
      let additions = diff.additions;
      let deletions = diff.deletions;

      if (operation === 'create' && additions === 0 && deletions === 0 && newText) {
        additions = countTextLines(newText);
      } else if (operation === 'delete' && additions === 0 && deletions === 0 && oldText) {
        deletions = countTextLines(oldText);
      }

      const safeRelativePath = relativePath.replace(/[^a-zA-Z0-9.\-_\\/]/g, '_');
      const snapshotPath = path.join(snapshotDir, safeRelativePath);
      const undoEligible = classifyFileForSnapshot(uri) === 'include' && !isDirectory;

      const change: FileChange = {
        changeId: crypto.randomBytes(8).toString('hex'),
        path: relativePath,
        file: path.basename(uri.fsPath),
        operation,
        additions,
        deletions,
        diffText: diff.diffText,
        applied: true,
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

  private async readWorkspaceText(uri: vscode.Uri): Promise<string> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText();
    } catch {
      try {
        return await fs.readFile(uri.fsPath, 'utf8');
      } catch {
        return '';
      }
    }
  }

  private async isDirectory(
    uri: vscode.Uri,
    action: string,
    relativePath: string,
    oldText: string,
    newText: string,
    folderHints: Set<string>
  ): Promise<boolean> {
    if (folderHints.has(normalizeWorkspacePath(relativePath))) {
      return true;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.Directory;
    } catch {
      if (action === 'delete_path' && oldText === '' && newText === '') {
        return true;
      }
      return false;
    }
  }

  private resolveOperation(
    action: string,
    relativePath: string,
    renameOldPath: string | undefined,
    renameNewPath: string | undefined,
    oldText: string,
    newText: string,
    isDirectory: boolean
  ): FileChangeOperation {
    if (action === 'create_file') {
      if (isDirectory) {
        return 'create_folder';
      }
      return oldText ? 'edit' : 'create';
    }

    if (action === 'write_file') {
      return oldText ? 'edit' : 'create';
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

    if (!oldText && newText) {
      return 'create';
    }

    if (oldText && !newText) {
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
