import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';


/** Internal structure tracking a single snapshot's metadata during GC. */
interface SnapshotInfo {
  sessionDir: string;
  snapshotDir: string; // The messageId folder name
  fullPath: string;
  timestamp: number;
  sizeBytes: number;
}

export class SnapshotGarbageCollector {
  private static readonly SIZE_CAP_BYTES = 500 * 1024 * 1024; // 500 MB
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly snapshotsRootDir: string) {}

  public start() {
    // Run immediately
    this.run().catch(err => console.error('VertexSwarm: Initial garbage collection failed', err));

    // And then every 6 hours
    this.timer = setInterval(() => {
      this.run().catch(err => console.error('VertexSwarm: Periodic garbage collection failed', err));
    }, 6 * 60 * 60 * 1000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public dispose() {
    this.stop();
  }

  public async run() {
    try {
      const exists = await fs.access(this.snapshotsRootDir).then(() => true).catch(() => false);
      if (!exists) return;

      const retentionDays = vscode.workspace.getConfiguration('vertexSwarm').get<number>('snapshotRetentionDays', 7);
      const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
      const cutoffTime = Date.now() - retentionMs;

      const snapshots: SnapshotInfo[] = [];

      // 1. Gather all snapshots and calculate sizes
      const sessionDirs = await fs.readdir(this.snapshotsRootDir);
      
      for (const session of sessionDirs) {
        const sessionPath = path.join(this.snapshotsRootDir, session);
        const sessionStat = await fs.stat(sessionPath);
        
        if (!sessionStat.isDirectory()) continue;

        const messageDirs = await fs.readdir(sessionPath);
        for (const message of messageDirs) {
          const snapshotPath = path.join(sessionPath, message);
          const snapshotStat = await fs.stat(snapshotPath);
          
          if (!snapshotStat.isDirectory()) continue;

          // Find timestamp
          let timestamp = snapshotStat.mtimeMs;
          try {
            const manifestContent = await fs.readFile(path.join(snapshotPath, 'manifest.json'), 'utf8');
            const manifest = JSON.parse(manifestContent);
            if (manifest.timestamp) {
              timestamp = new Date(manifest.timestamp).getTime();
            }
          } catch {
            // fallback to mtime if manifest is missing/invalid
          }

          // Calculate size
          const sizeBytes = await this.getDirSize(snapshotPath);

          snapshots.push({
            sessionDir: session,
            snapshotDir: message,
            fullPath: snapshotPath,
            timestamp,
            sizeBytes
          });
        }
      }

      // 2. Time-based eviction (older than configured retention)
      let remainingSnapshots = [];
      let totalRemainingSize = 0;

      for (const snap of snapshots) {
        if (snap.timestamp < cutoffTime) {
          await this.deleteDir(snap.fullPath);
        } else {
          remainingSnapshots.push(snap);
          totalRemainingSize += snap.sizeBytes;
        }
      }

      // 3. Size-based eviction (if > SIZE_CAP_BYTES)
      if (totalRemainingSize > SnapshotGarbageCollector.SIZE_CAP_BYTES) {
        // Sort oldest first
        remainingSnapshots.sort((a, b) => a.timestamp - b.timestamp);

        for (const snap of remainingSnapshots) {
          if (totalRemainingSize <= SnapshotGarbageCollector.SIZE_CAP_BYTES) {
            break;
          }
          await this.deleteDir(snap.fullPath);
          totalRemainingSize -= snap.sizeBytes;
        }
      }

      // 4. Cleanup empty session directories
      for (const session of sessionDirs) {
        const sessionPath = path.join(this.snapshotsRootDir, session);
        try {
          const contents = await fs.readdir(sessionPath);
          if (contents.length === 0) {
            await this.deleteDir(sessionPath);
          }
        } catch {
          // ignore
        }
      }

    } catch (e) {
      console.error(`Garbage collection error: ${e}`);
    }
  }

  private async getDirSize(dirPath: string): Promise<number> {
    let size = 0;
    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
          size += await this.getDirSize(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          size += stat.size;
        }
      }
    } catch {
      // ignore missing files during size calculation
    }
    return size;
  }

  private async deleteDir(dirPath: string): Promise<void> {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore errors (e.g. permission denied)
    }
  }
}
