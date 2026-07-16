import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export type JobIntent = 'await_result' | 'verify_start' | 'observe' | 'blocking' | 'background'; // include deprecated ones for now
export type JobStatus = 'running' | 'overdue' | 'stalled_suspected' | 'killed' | 'completed';
export type CleanupPolicy = 'now' | 'keep' | 'undecided';

export interface JobRecord {
  job_id: string;
  command: string;
  intent: JobIntent;
  user_visible: boolean;
  job_status: JobStatus;
  started_at: number;
  total_chars_buffered: number;
  last_output_at: number;
  last_polled_at: number;
  pid: number | null;
  pinned: boolean;
  terminal_name?: string;
  estimated_duration_seconds?: number;
  chat_id?: string;
}

export class TerminalOutputStore {
  private storageDir: string;
  private jobs: Map<string, JobRecord> = new Map();
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(private context: vscode.ExtensionContext) {
    if (!context.storageUri) {
      // Fallback if no workspace is opened, use globalStorageUri
      this.storageDir = path.join(context.globalStorageUri.fsPath, 'terminal-outputs');
    } else {
      this.storageDir = path.join(context.storageUri.fsPath, 'terminal-outputs');
    }
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create terminal output directory: ${error}`);
    }

    // Start TTL sweep (every 10 minutes)
    this.sweepInterval = setInterval(() => this.runSweep(), 10 * 60 * 1000);
  }

  dispose(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
    }
  }

  private getFilePath(jobId: string): string {
    // Sanitize jobId just in case
    const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `${safeJobId}.txt`);
  }

  registerJob(record: Omit<JobRecord, 'job_status' | 'started_at' | 'total_chars_buffered' | 'last_output_at' | 'last_polled_at' | 'pinned'>): JobRecord {
    const fullRecord: JobRecord = {
      ...record,
      job_status: 'running',
      started_at: Date.now(),
      total_chars_buffered: 0,
      last_output_at: Date.now(),
      last_polled_at: Date.now(),
      pinned: false,
    };
    this.jobs.set(record.job_id, fullRecord);
    return fullRecord;
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  getAllJobs(): JobRecord[] {
    return Array.from(this.jobs.values());
  }

  updateJobStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.job_status = status;
    }
  }

  async appendOutput(jobId: string, data: string): Promise<void> {
    if (!data) return;
    
    const job = this.jobs.get(jobId);
    if (job) {
      job.last_output_at = Date.now();
      job.total_chars_buffered += data.length;
    }

    const filePath = this.getFilePath(jobId);
    try {
      // Fire and forget, but catch errors
      await fs.appendFile(filePath, data, 'utf8');
    } catch (error) {
      console.error(`Failed to write terminal output for job ${jobId}: ${error}`);
    }
  }

  async getOutput(jobId: string, offsetChars: number = 0, maxChars: number = 2000): Promise<{ content: string; total_chars_buffered: number }> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.last_polled_at = Date.now();
    }
    
    const filePath = this.getFilePath(jobId);
    try {
      const stat = await fs.stat(filePath);
      
      // We will read the whole file if it's small, otherwise use precise string index matching.
      // For now, read the whole file to safely extract substring since max string length in V8 is large.
      const content = await fs.readFile(filePath, 'utf8');
      
      let start = offsetChars;
      if (start < 0) {
        start = Math.max(0, content.length + start);
      }
      
      const chunk = content.slice(start, start + maxChars);
      return { content: chunk, total_chars_buffered: content.length };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { content: '', total_chars_buffered: job?.total_chars_buffered || 0 };
      }
      console.error(`Failed to read terminal output for job ${jobId}: ${error}`);
      return { content: '', total_chars_buffered: job?.total_chars_buffered || 0 };
    }
  }

  async cleanupJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    const filePath = this.getFilePath(jobId);
    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`Failed to delete terminal output file for job ${jobId}: ${error}`);
      }
    }
  }

  private async runSweep(): Promise<void> {
    const now = Date.now();
    const thirtyMins = 30 * 60 * 1000;
    const fifteenMins = 15 * 60 * 1000;
    const fiveMins = 5 * 60 * 1000;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.pinned) continue;
      
      const age = now - job.started_at;
      const unpolledTime = now - job.last_polled_at;
      const silenceTime = now - job.last_output_at;

      // Rule 1: Abandoned hidden jobs (Tier 3 auto-kill candidate)
      if (
        !job.user_visible &&
        job.job_status !== 'completed' &&
        job.job_status !== 'killed' &&
        unpolledTime >= fifteenMins &&
        silenceTime >= fiveMins
      ) {
        if (this.onTier3AutoKill) {
          this.onTier3AutoKill(job);
        }
      }

      // Rule 2: Cleanup completed/old abandoned files
      if (age >= thirtyMins) {
        if (job.job_status === 'completed' || job.job_status === 'killed') {
          // Completed job, older than 30 mins -> clean up
          await this.cleanupJob(jobId);
        } else if (unpolledTime >= thirtyMins) {
          // Abandoned job (unpolled for 30 mins) -> clean up
          await this.cleanupJob(jobId);
        }
      }
    }
    
    // Also sweep the disk for files that are not in the map
    try {
      const files = await fs.readdir(this.storageDir);
      for (const file of files) {
        const filePath = path.join(this.storageDir, file);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > thirtyMins) {
          const jobId = file.replace(/\.txt$/, '');
          if (!this.jobs.has(jobId)) {
             await fs.unlink(filePath).catch(() => {});
          }
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  // Callback for when a job needs to be auto-killed
  public onTier3AutoKill?: (job: JobRecord) => void;
}
