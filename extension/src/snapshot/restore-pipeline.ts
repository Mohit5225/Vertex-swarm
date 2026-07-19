import * as vscode from 'vscode';
import * as path from 'path';
import { SnapshotManifest, SnapshotHandle, SnapshotManifestEntry } from './types';

async function restoreTextEntry(
  entry: SnapshotManifestEntry,
  workspaceEdit: vscode.WorkspaceEdit
): Promise<void> {
  const targetUri = vscode.Uri.parse(entry.path);

  if (!entry.snapshotPath) {
    throw new Error(`Missing snapshotPath for disk backend file ${entry.path}`);
  }

  const snapshotFileUri = vscode.Uri.file(entry.snapshotPath);
  const contentData = await vscode.workspace.fs.readFile(snapshotFileUri);
  const originalContent = Buffer.from(contentData).toString('utf8');

  let currentDocument: vscode.TextDocument;
  try {
    currentDocument = await vscode.workspace.openTextDocument(targetUri);
    const lastLine = currentDocument.lineAt(currentDocument.lineCount - 1);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      lastLine.range.end
    );
    workspaceEdit.replace(targetUri, fullRange, originalContent);
  } catch {
    workspaceEdit.createFile(targetUri, { ignoreIfExists: true });
    const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    workspaceEdit.replace(targetUri, fullRange, originalContent);
  }
}

async function restoreBinaryEntry(entry: SnapshotManifestEntry): Promise<void> {
  const targetUri = vscode.Uri.parse(entry.path);

  if (!entry.snapshotPath) {
    throw new Error(`Missing snapshotPath for disk backend file ${entry.path}`);
  }

  const snapshotFileUri = vscode.Uri.file(entry.snapshotPath);
  const contentData = await vscode.workspace.fs.readFile(snapshotFileUri);
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.file(path.dirname(targetUri.fsPath))
  );
  await vscode.workspace.fs.writeFile(targetUri, contentData, { overwrite: true });
}

export async function restoreSnapshotPipeline(handle: SnapshotHandle, snapshotDir: string): Promise<void> {
  const manifestUri = vscode.Uri.file(path.join(snapshotDir, 'manifest.json'));
  let manifestData: Uint8Array;
  try {
    manifestData = await vscode.workspace.fs.readFile(manifestUri);
  } catch (err) {
    throw new Error(`Snapshot manifest not found at ${manifestUri.fsPath}`);
  }

  const manifest: SnapshotManifest = JSON.parse(Buffer.from(manifestData).toString('utf8'));
  const workspaceEdit = new vscode.WorkspaceEdit();
  const binaryRestores: SnapshotManifestEntry[] = [];

  for (const entry of manifest.files) {
    const targetUri = vscode.Uri.parse(entry.path);

    if (!entry.existedBefore) {
      workspaceEdit.deleteFile(targetUri, { ignoreIfNotExists: true });
    } else if (entry.backend === 'disk') {
      if (entry.isBinary) {
        binaryRestores.push(entry);
      } else {
        await restoreTextEntry(entry, workspaceEdit);
      }
    } else if (entry.backend === 'git') {
      throw new Error('Git backend restoration is not implemented in Phase 1.');
    }
  }

  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (!success) {
    throw new Error('Failed to apply workspace edit during restore.');
  }

  for (const entry of binaryRestores) {
    await restoreBinaryEntry(entry);
  }
}

export async function restoreSnapshotFilePipeline(handle: SnapshotHandle, snapshotDir: string, fileUri: string): Promise<void> {
  const manifestUri = vscode.Uri.file(path.join(snapshotDir, 'manifest.json'));
  let manifestData: Uint8Array;
  try {
    manifestData = await vscode.workspace.fs.readFile(manifestUri);
  } catch (err) {
    throw new Error(`Snapshot manifest not found at ${manifestUri.fsPath}`);
  }

  const manifest: SnapshotManifest = JSON.parse(Buffer.from(manifestData).toString('utf8'));
  const entry = manifest.files.find(f => f.path === fileUri);

  if (!entry) {
    throw new Error(`File ${fileUri} not found in snapshot manifest`);
  }

  const targetUri = vscode.Uri.parse(entry.path);

  if (!entry.existedBefore) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.deleteFile(targetUri, { ignoreIfNotExists: true });
    const success = await vscode.workspace.applyEdit(workspaceEdit);
    if (!success) {
      throw new Error(`Failed to apply workspace edit during file restore for ${fileUri}.`);
    }
    return;
  }

  if (entry.backend === 'disk' && entry.isBinary) {
    await restoreBinaryEntry(entry);
    return;
  }

  if (entry.backend === 'disk') {
    const workspaceEdit = new vscode.WorkspaceEdit();
    await restoreTextEntry(entry, workspaceEdit);
    const success = await vscode.workspace.applyEdit(workspaceEdit);
    if (!success) {
      throw new Error(`Failed to apply workspace edit during file restore for ${fileUri}.`);
    }
    return;
  }

  if (entry.backend === 'git') {
    throw new Error('Git backend restoration is not implemented in Phase 1.');
  }
}
