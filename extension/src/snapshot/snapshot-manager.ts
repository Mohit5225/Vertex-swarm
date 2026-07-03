import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ISnapshotManager, SnapshotContext, SnapshotHandle, SnapshotManifest, SnapshotManifestEntry } from './types';
import { classifyFileForSnapshot } from './exclusion-list';
import { restoreSnapshotPipeline } from './restore-pipeline';

export class DiskSnapshotManager implements ISnapshotManager {
  
  public getSnapshotDir(context: { sessionId: string; messageId: string }): string {
    return path.join(os.homedir(), '.vertex-swarm', 'snapshots', context.sessionId, context.messageId);
  }

  async createSnapshot(fileUris: vscode.Uri[], context: SnapshotContext): Promise<SnapshotHandle> {
    const snapshotId = crypto.randomBytes(16).toString('hex');
    const snapshotDir = this.getSnapshotDir(context);
    
    // Ensure snapshot directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(snapshotDir));

    const manifestEntries: SnapshotManifestEntry[] = [];
    const warnedFiles: string[] = [];

    // Deduplicate fileUris just in case
    const uniqueUris = Array.from(new Map(fileUris.map(u => [u.toString(), u])).values());

    for (const uri of uniqueUris) {
      const classification = classifyFileForSnapshot(uri);
      if (classification === 'silent-skip') continue;
      if (classification === 'warned-skip') {
        warnedFiles.push(uri.fsPath);
        continue;
      }

      let existedBefore = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        existedBefore = false;
      }

      // Phase 1 MVP: Everything is disk-backed
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const safeRelativePath = relativePath.replace(/[^a-zA-Z0-9.\-_\\/]/g, '_');
      const snapshotPath = path.join(snapshotDir, safeRelativePath);

      if (existedBefore) {
        // Capture live buffer state
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = doc.getText();

        // Write snapshot file to disk
        const snapshotUri = vscode.Uri.file(snapshotPath);
        // Ensure parent dir of snapshot file exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(snapshotPath)));
        await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(content, 'utf8'));
      }

      manifestEntries.push({
        path: uri.toString(),
        existedBefore,
        backend: 'disk',
        snapshotPath: existedBefore ? snapshotPath : undefined
      });
    }

    if (warnedFiles.length > 0) {
      const fileNames = warnedFiles.map(f => path.basename(f)).join(', ');
      console.warn(`[SnapshotManager] Skipped protected files from undo: ${warnedFiles.join(', ')}`);
      // Use status bar message (non-modal, non-intrusive) instead of a popup that interrupts flow
      vscode.window.setStatusBarMessage(
        `⚠ Undo not available for: ${fileNames} (protected file)`,
        8000
      );
    }

    const manifest: SnapshotManifest = {
      snapshotId,
      timestamp: new Date().toISOString(),
      files: manifestEntries
    };

    // Atomic write of manifest
    const manifestTmpUri = vscode.Uri.file(path.join(snapshotDir, 'manifest.tmp.json'));
    const manifestUri = vscode.Uri.file(path.join(snapshotDir, 'manifest.json'));

    await vscode.workspace.fs.writeFile(manifestTmpUri, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    await vscode.workspace.fs.rename(manifestTmpUri, manifestUri, { overwrite: true });

    return {
      snapshotId,
      sessionId: context.sessionId,
      messageId: context.messageId
    };
  }

  async restoreSnapshot(handle: SnapshotHandle): Promise<void> {
    const snapshotDir = this.getSnapshotDir(handle);
    await restoreSnapshotPipeline(handle, snapshotDir);
  }
}
