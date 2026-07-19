import * as vscode from 'vscode';
import * as fs from 'fs/promises';

export const SNAPSHOT_SCHEME = 'vertex-snapshot';

export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  // Event emitter for when the content changes
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * Generates a URI for the snapshot content provider.
   * @param originalUri The URI of the live file in the workspace
   * @param snapshotPath The absolute path to the saved snapshot file on disk (or undefined if the file was newly created)
   */
  public static getUri(originalUri: vscode.Uri, snapshotPath?: string): vscode.Uri {
    const query = snapshotPath ? `snapshotPath=${encodeURIComponent(snapshotPath)}` : 'newFile=true';
    return originalUri.with({
      scheme: SNAPSHOT_SCHEME,
      query
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const isNewFile = query.get('newFile') === 'true';
    const isDeleted = query.get('deletedFile') === 'true';
    const snapshotPath = query.get('snapshotPath');

    if (isDeleted) {
      return '';
    }

    if (isNewFile || !snapshotPath) {
      return '';
    }

    try {
      const content = await fs.readFile(snapshotPath, 'utf8');
      return content;
    } catch (err) {
      console.error(`[SnapshotContentProvider] Failed to read snapshot file at ${snapshotPath}:`, err);
      return '';
    }
  }
}
