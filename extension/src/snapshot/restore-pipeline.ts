import * as vscode from 'vscode';
import * as path from 'path';
import { SnapshotManifest, SnapshotHandle } from './types';

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

  for (const entry of manifest.files) {
    const targetUri = vscode.Uri.parse(entry.path);

    if (!entry.existedBefore) {
      // Phase 1: File did not exist, so we delete it natively to keep it in the Undo stack
      workspaceEdit.deleteFile(targetUri, { ignoreIfNotExists: true });
    } else {
      if (entry.backend === 'disk') {
        if (!entry.snapshotPath) {
          throw new Error(`Missing snapshotPath for disk backend file ${entry.path}`);
        }
        
        // Read original content from snapshot
        const snapshotFileUri = vscode.Uri.file(entry.snapshotPath);
        const contentData = await vscode.workspace.fs.readFile(snapshotFileUri);
        const originalContent = Buffer.from(contentData).toString('utf8');

        // Note for Phase 1: naive full-text replace via WorkspaceEdit.
        // Phase 4 will replace this with a 3-way merge conflict injection.
        let currentDocument: vscode.TextDocument;
        try {
          currentDocument = await vscode.workspace.openTextDocument(targetUri);
        } catch {
          // Document was deleted by the user after the agent ran. We need to create it back.
          workspaceEdit.createFile(targetUri, { ignoreIfExists: true });
          // Note: openTextDocument might fail if it really doesn't exist, but WorkspaceEdit handles
          // edits on URIs even if the file isn't currently open/existing, as long as it's created.
          const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
          workspaceEdit.replace(targetUri, fullRange, originalContent);
          continue;
        }

        const lastLine = currentDocument.lineAt(currentDocument.lineCount - 1);
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          lastLine.range.end
        );

        workspaceEdit.replace(targetUri, fullRange, originalContent);
      } else if (entry.backend === 'git') {
        throw new Error('Git backend restoration is not implemented in Phase 1.');
      }
    }
  }

  // Apply the accumulated edits via VS Code API
  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (!success) {
    throw new Error('Failed to apply workspace edit during restore.');
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

  const workspaceEdit = new vscode.WorkspaceEdit();
  const targetUri = vscode.Uri.parse(entry.path);

  if (!entry.existedBefore) {
    workspaceEdit.deleteFile(targetUri, { ignoreIfNotExists: true });
  } else {
    if (entry.backend === 'disk') {
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
    } else if (entry.backend === 'git') {
      throw new Error('Git backend restoration is not implemented in Phase 1.');
    }
  }

  const success = await vscode.workspace.applyEdit(workspaceEdit);
  if (!success) {
    throw new Error(`Failed to apply workspace edit during file restore for ${fileUri}.`);
  }
}
