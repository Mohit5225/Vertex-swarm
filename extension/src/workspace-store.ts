import * as vscode from 'vscode';

const COLLAPSED_FOLDERS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.turbo',
  'coverage',
  '.nyc_output',
  'target',
  'bin',
  'obj',
]);

const MAX_DEPTH_TWO_ITEMS = 30;

export class WorkspaceStore implements vscode.Disposable {
  private workspaceSkeleton: string | null = null;
  private skeletonBuiltAtMs = 0;
  private lastStructuralChangeAtMs = Date.now();
  private watcher: vscode.FileSystemWatcher | null = null;
  private renameWatcher: vscode.Disposable | null = null;

  private readonly shortCacheTtlMs = 30_000;
  private readonly staleAfterMs = 30 * 60 * 1000;

  async getSkeleton(): Promise<string> {
    const now = Date.now();

    if (
      this.workspaceSkeleton
      && now - this.skeletonBuiltAtMs < this.shortCacheTtlMs
    ) {
      return this.workspaceSkeleton;
    }

    if (now - this.lastStructuralChangeAtMs > this.staleAfterMs) {
      this.workspaceSkeleton = await this.buildWorkspaceSkeleton();
      this.skeletonBuiltAtMs = now;
      this.lastStructuralChangeAtMs = now;
      this.startWatcher();
      return this.workspaceSkeleton;
    }

    if (!this.workspaceSkeleton) {
      this.workspaceSkeleton = await this.buildWorkspaceSkeleton();
      this.skeletonBuiltAtMs = now;
      this.startWatcher();
    }

    return this.workspaceSkeleton;
  }

  async buildWorkspaceSkeleton(): Promise<string> {
    const rootFolders = vscode.workspace.workspaceFolders;
    if (!rootFolders || rootFolders.length === 0) {
      return '[no workspace folder opened]';
    }

    const lines: string[] = [];

    for (const rootFolder of rootFolders) {
      const rootFolderName = rootFolder.name || vscode.workspace.asRelativePath(rootFolder.uri, false);
      lines.push(`${rootFolderName}/`);

      let rootEntries: [string, vscode.FileType][];

      try {
        rootEntries = await vscode.workspace.fs.readDirectory(rootFolder.uri);
      } catch {
        continue;
      }

      const sortedRootEntries = [...rootEntries].sort(([leftName], [rightName]) =>
        leftName.localeCompare(rightName)
      );

      for (const [entryName, entryType] of sortedRootEntries) {
        if (entryType !== vscode.FileType.Directory) {
          lines.push(`  ${entryName}`);
          continue;
        }

        if (COLLAPSED_FOLDERS.has(entryName)) {
          lines.push(`  ${entryName}/ [collapsed]`);
          continue;
        }

        lines.push(`  ${entryName}/`);

        const subfolderUri = vscode.Uri.joinPath(rootFolder.uri, entryName);
        let subEntries: [string, vscode.FileType][];

        try {
          subEntries = await vscode.workspace.fs.readDirectory(subfolderUri);
        } catch {
          continue;
        }

        const sortedSubEntries = [...subEntries]
          .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
          .slice(0, MAX_DEPTH_TWO_ITEMS);

        for (const [subEntryName, subEntryType] of sortedSubEntries) {
          lines.push(`    ${subEntryName}${subEntryType === vscode.FileType.Directory ? '/' : ''}`);
        }
      }
    }

    return lines.join('\n');
  }

  private startWatcher(): void {
    if (this.watcher || this.renameWatcher) {
      return;
    }

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onStructuralChange = () => this.invalidateSkeletonCache();

    this.watcher.onDidCreate(onStructuralChange);
    this.watcher.onDidDelete(onStructuralChange);
    this.renameWatcher = vscode.workspace.onDidRenameFiles(onStructuralChange);
  }

  private invalidateSkeletonCache(): void {
    this.workspaceSkeleton = null;
    this.skeletonBuiltAtMs = 0;
    this.lastStructuralChangeAtMs = Date.now();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
    this.renameWatcher?.dispose();
    this.renameWatcher = null;
  }
}
