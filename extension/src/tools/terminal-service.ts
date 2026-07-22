import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ToolResult, SessionEvent } from '../types/index';
import { TerminalOutputStore, JobIntent, JobRecord, JobStatus, CleanupPolicy } from './terminal-output-store';

export interface TerminalContextState {
  name: string;
  purpose: string;
  isBusy: boolean;
  lifecycleAction: string;
}

export interface JobCompletionEvent {
  job_id: string;
  chat_id: string;
  exit_code: number | null;
  job_status: JobStatus;
  output_tail: string;
  command: string;
  status_message: string;
}

export interface TerminalActionResponse<T = Record<string, unknown>> {
  status: 'success' | 'error' | 'timeout' | 'verification_needed' | 'running' | 'cancelled';
  content: string;
  data?: T;
  error_code?: string;
}

export interface TerminalActionPayload {
  command?: string;
  cwd?: string;
  intent?: JobIntent;
  mode?: string;
  /** When true, run hidden (alias for user_visible: false). */
  hide?: boolean;
  user_visible?: boolean;
  estimated_duration_seconds?: number;
  terminal_name?: string;
  terminal_context?: {
    name?: string;
    purpose?: string;
    lifecycle_action?: string;
  };
  job_id?: string;
  tool_call_id?: string;
  execution_id?: string;
  pid?: number;
  input_text?: string;
  interrupt?: boolean;
  offset?: number;
  max_chars?: number;
}

export class TerminalService {
  private static readonly AWAIT_RESULT_WAIT_MS = 5000;
  private static readonly OUTPUT_TAIL_MAX = 200;
  private static readonly LONG_INTENT_VERIFY_MS = 2000;

  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly terminalContexts = new Map<string, TerminalContextState>();
  private readonly backgroundProcesses = new Map<number, cp.ChildProcess>();
  private readonly outputStore: TerminalOutputStore;
  
  // ANSI escape code regex
  private readonly ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B\r\n]*(?:[\x07\x1B\\]|$))/gm;
  private readonly completionNotified = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly postEvent: (event: SessionEvent) => void,
    private readonly onBackgroundEvent?: (event: JobCompletionEvent) => void
  ) {
    this.outputStore = new TerminalOutputStore(this.context);
    this.outputStore.initialize();
    
    this.outputStore.onTier3AutoKill = (job) => {
      this.killJobInternal(job);
    };

    vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, t] of this.terminals.entries()) {
        if (t === terminal) {
          this.terminals.delete(key);
          this.terminalContexts.delete(key);
          break;
        }
      }
    });

    vscode.window.onDidStartTerminalShellExecution(event => {
      for (const [key, t] of this.terminals.entries()) {
        if (t === event.terminal) {
          const ctx = this.terminalContexts.get(key);
          if (ctx) ctx.isBusy = true;
          break;
        }
      }
    });

    vscode.window.onDidEndTerminalShellExecution(event => {
      for (const [key, t] of this.terminals.entries()) {
        if (t === event.terminal) {
          const ctx = this.terminalContexts.get(key);
          if (ctx) ctx.isBusy = false;
          break;
        }
      }
    });
  }

  public getActiveTerminalContexts(): TerminalContextState[] {
    const activeContexts: TerminalContextState[] = [];
    for (const t of vscode.window.terminals) {
       const tracked = this.terminalContexts.get(t.name);
       if (tracked) {
         activeContexts.push(tracked);
       } else {
         activeContexts.push({
           name: t.name,
           purpose: 'User-created or untracked terminal',
           isBusy: false,
           lifecycleAction: 'keep_open_long_term'
         });
       }
    }
    return activeContexts;
  }

  async readJobOutput(jobId: string, offset = -8000, maxChars = 8000) {
    const result = await this.outputStore.getOutput(jobId, offset, maxChars);
    const job = this.outputStore.getJob(jobId);
    return {
      content: result.content,
      total_chars_buffered: result.total_chars_buffered,
      status: job?.job_status || 'unknown',
      exit_code: job?.exit_code ?? null,
    };
  }

  async cancelJobsForChat(chatId: string): Promise<void> {
    const runningJobs = this.outputStore
      .getJobsForChat(chatId)
      .filter((job) => job.job_status === 'running');

    for (const job of runningJobs) {
      this.killJobInternal(job);
    }
  }

  private async getOutputTail(jobId: string): Promise<string> {
    return this.outputStore.getOutputTail(jobId, TerminalService.OUTPUT_TAIL_MAX);
  }

  private async notifyJobCompletion(
    jobId: string,
    exitCode: number | null,
    statusMessage: string,
    jobStatus: JobStatus = 'completed',
  ): Promise<void> {
    if (this.completionNotified.has(jobId)) {
      return;
    }
    this.completionNotified.add(jobId);

    this.outputStore.completeJob(jobId, exitCode, jobStatus);
    const job = this.outputStore.getJob(jobId);
    if (!job?.chat_id || !this.onBackgroundEvent) {
      return;
    }

    const outputTail = await this.getOutputTail(jobId);
    this.onBackgroundEvent({
      job_id: jobId,
      chat_id: job.chat_id,
      exit_code: exitCode,
      job_status: jobStatus,
      output_tail: outputTail,
      command: job.command,
      status_message: statusMessage,
    });
  }

  private buildRunningResponse(
    jobId: string,
    command: string,
    extra: Record<string, unknown> = {},
  ): TerminalActionResponse {
    return {
      status: 'running',
      content: `Command started and is still running: ${command}. Wait for system notification or poll get_output before claiming success.`,
      data: {
        job_id: jobId,
        termination_reason: 'background',
        ...extra,
      },
    };
  }

  private async buildFinishedAwaitResultResponse(
    jobId: string,
    command: string,
    exitCode: number,
  ): Promise<TerminalActionResponse> {
    const outputTail = await this.getOutputTail(jobId);
    if (exitCode === 0) {
      return {
        status: 'success',
        content: outputTail || `Command completed successfully: ${command}`,
        data: {
          job_id: jobId,
          exit_code: exitCode,
          output_tail: outputTail,
          termination_reason: 'exit',
        },
      };
    }

    return {
      status: 'error',
      content: outputTail || `Command failed (exit ${exitCode}): ${command}`,
      data: {
        job_id: jobId,
        exit_code: exitCode,
        output_tail: outputTail,
        termination_reason: 'exit',
      },
    };
  }

  private isLongRunningIntent(intent: JobIntent): boolean {
    return intent === 'verify_start' || intent === 'observe' || intent === 'background';
  }

  private async attachRunMetadata(
    result: TerminalActionResponse,
    jobId: string,
    meta: {
      command: string;
      cwd?: string;
      terminalName: string;
      purpose?: string;
      userVisible: boolean;
    }
  ): Promise<TerminalActionResponse> {
    const snapshot = await this.outputStore.getOutput(jobId, -8000, 8000);
    return {
      ...result,
      data: {
        ...(result.data || {}),
        job_id: jobId,
        command: meta.command,
        cwd: meta.cwd,
        terminal_name: meta.terminalName,
        purpose: meta.purpose,
        user_visible: meta.userVisible,
        ...(snapshot.content
          ? { output: snapshot.content, output_tail: snapshot.content }
          : {}),
      },
    };
  }

  async execute(args: any, context: any): Promise<ToolResult> {
    const action = args.action || 'run_command';
    const payload = args.payload || {};
    // Ensure chat_id is available in context payload
    if (context && context.chat_id) {
      payload.chat_id = context.chat_id;
    }
    const startTime = Date.now();

    try {
      let result: any;
      if (action === 'run_command') {
        result = await this.runCommand(payload, context, args.request_id);
      } else {
        switch (action) {
          case 'send_input':
          result = await this.sendInput(payload);
          break;
        case 'get_output':
          result = await this.getOutput(payload);
          break;
        case 'get_diagnostics':
          result = await this.getDiagnostics(payload);
          break;
        case 'get_state':
          result = this.getState();
          break;
        case 'list_processes': // deprecated soon in favor of list_jobs
          result = this.listJobs(context);
          break;
        case 'list_jobs':
          result = this.listJobs(context);
          break;
        case 'kill_process': // deprecated soon in favor of kill_job
          result = await this.killJob(payload);
          break;
        case 'kill_job':
          result = await this.killJob(payload);
          break;
        case 'cleanup_output':
          result = await this.cleanupOutput(payload);
          break;
        case 'list_terminals':
          result = this.listTerminals();
          break;
        case 'new_terminal':
          result = await this.newTerminal(payload);
          break;
        case 'kill_terminal':
          result = this.killTerminal(payload);
          break;
          default:
            throw new Error(`Unknown terminal action: ${action}`);
        }
      }

      return {
        tool_name: 'terminal_ops',
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        request_id: args.request_id,
        action: action,
        status: result.status,
        content: result.content,
        data: result.data,
        error_code: result.error_code,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        tool_name: 'terminal_ops',
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        status: 'error',
        content: error instanceof Error ? error.message : String(error),
        execution_time_ms: Date.now() - startTime,
      };
    }
  }

  private async runCommand(
    payload: TerminalActionPayload,
    context: TerminalActionPayload,
    requestId?: string,
  ): Promise<TerminalActionResponse> {
    const command = payload.command as string;
    const cwd = payload.cwd;
    // Map deprecated 'mode' to new 'intent' and 'user_visible'
    let intent = (payload.intent || (payload.mode === 'background' ? 'observe' : 'await_result')) as JobIntent;
    let user_visible: boolean;
    if (payload.user_visible !== undefined) {
      user_visible = payload.user_visible;
    } else if (payload.hide !== undefined) {
      user_visible = !payload.hide;
    } else {
      // Hidden child_process on all platforms unless the caller opts into a visible terminal.
      user_visible = false;
    }
    let estimated_duration = payload.estimated_duration_seconds;
    let chatId = (payload as any).chat_id;

    const jobId = (context.tool_call_id || payload.job_id) as string;
    let terminalName = payload.terminal_name || 'Vertex Worker';
    let lifecycleAction = 'keep_open_long_term';
    
    if (payload.terminal_context) {
      terminalName = payload.terminal_context.name || terminalName;
      lifecycleAction = payload.terminal_context.lifecycle_action || lifecycleAction;
    }

    if (user_visible) {
       const existingContext = this.terminalContexts.get(terminalName);
       if (existingContext && existingContext.isBusy) {
         return {
           status: 'error',
           content: `Terminal '${terminalName}' is currently busy running another command. Please create a new terminal or use an idle one.`,
           data: {
             job_id: jobId,
             command,
             cwd,
             terminal_name: terminalName,
             purpose: payload.terminal_context?.purpose,
             user_visible,
           }
         };
       }
    }
      
    this.terminalContexts.set(terminalName, {
      name: terminalName,
      purpose: payload.terminal_context?.purpose || 'Default purpose',
      lifecycleAction: lifecycleAction,
      isBusy: user_visible
    });

    this.outputStore.registerJob({
      job_id: jobId,
      command,
      intent,
      user_visible,
      pid: null,
      terminal_name: terminalName,
      estimated_duration_seconds: estimated_duration,
      chat_id: chatId,
      request_id: requestId,
    });

    const runMeta = {
      command,
      cwd,
      terminalName,
      purpose: payload.terminal_context?.purpose,
      userVisible: user_visible,
    };

    try {
      if (user_visible) {
        const terminal = await this.getOrCreateTerminal(terminalName);
        const result = await this.runViaShellIntegration(terminal, command, cwd, jobId, intent);
        return this.attachRunMetadata(result, jobId, runMeta);
      } else {
        const result = await this.runViaFallback(command, cwd, jobId, intent);
        return this.attachRunMetadata(result, jobId, runMeta);
      }
    } finally {
      // If blocking/await_result, clean up terminal auto close
      // Actually we don't dispose terminals here directly anymore to preserve output buffers for observation
    }
  }

  private async runViaShellIntegration(
    terminal: vscode.Terminal,
    command: string,
    cwd: string | undefined,
    jobId: string,
    intent: JobIntent
  ): Promise<TerminalActionResponse> {
    if (!terminal.shellIntegration) {
      this.log(`Terminal: Shell integration missing for ${terminal.name}. Rerouting directly to background fallback process.`);
      terminal.dispose();
      this.terminals.delete(terminal.name);
      this.terminalContexts.delete(terminal.name);
      
      const job = this.outputStore.getJob(jobId);
      if (job) job.user_visible = false;

      return await this.runViaFallback(command, cwd, jobId, intent);
    }

    if (cwd) {
      const shell = vscode.env.shell.toLowerCase();
      const isPowershell = shell.includes('pwsh') || shell.includes('powershell');
      const isCmd = shell.includes('cmd.exe');
      const cdCmd = isPowershell ? `Set-Location "${cwd}"` : isCmd ? `cd /d "${cwd}"` : `cd "${cwd}"`;

      this.log(`Terminal: Injecting location: ${cdCmd}`);
      const cdExecution = terminal.shellIntegration.executeCommand(cdCmd);

      if (!cdExecution) {
        this.log(`Terminal: Shell integration failed to execute cdCmd. Rerouting directly to background fallback process.`);
        terminal.dispose();
        this.terminals.delete(terminal.name);
        this.terminalContexts.delete(terminal.name);
        
        const job = this.outputStore.getJob(jobId);
        if (job) job.user_visible = false;

        return await this.runViaFallback(command, cwd, jobId, intent);
      }

      const cdTimeoutPromise = new Promise<number | undefined>((resolve) => setTimeout(() => resolve(undefined), 5000));
      const cdEventPromise = new Promise<number | undefined>((resolve) => {
        const d = vscode.window.onDidEndTerminalShellExecution(event => {
          if (event.execution === cdExecution) {
            d.dispose();
            resolve(event.exitCode);
          }
        });
      });

      const cdExitCode = await Promise.race([cdEventPromise, cdTimeoutPromise]);
      if (cdExitCode !== 0 && cdExitCode !== undefined) {
         return {
           status: 'error',
           content: `Failed to change directory to ${cwd} (exit code ${cdExitCode})`,
           data: { job_id: jobId }
         };
      }
    }

    this.log(`Terminal: Running via Shell Integration: ${command}`);

    let commandTriggered = false;
    let execution: vscode.TerminalShellExecution | undefined;
    
    const executionPromise = new Promise<void>((resolve) => {
      const d = vscode.window.onDidStartTerminalShellExecution(event => {
        if (event.terminal === terminal && event.execution.commandLine.value === command) {
           commandTriggered = true;
           execution = event.execution;
           d.dispose();
           
           (async () => {
             for await (const chunk of execution.read()) {
               const stripped = chunk.replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
               this.outputStore.appendOutput(jobId, stripped);
             }
           })();
           resolve();
        }
      });
      
      // The shellIntegration executeCommand
      try {
         const exec = terminal.shellIntegration!.executeCommand(command);
         if (exec) {
            commandTriggered = true;
            execution = exec;
            d.dispose();
            (async () => {
              for await (const chunk of execution.read()) {
                const stripped = chunk.replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                this.outputStore.appendOutput(jobId, stripped);
              }
            })();
            resolve();
         }
      } catch(e) {}
    });

    const fallbackPromise = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    
    await Promise.race([executionPromise, fallbackPromise]);

    if (!commandTriggered) {
      this.log(`Terminal: Shell integration watchdog fired. Rerouting ${command} to background fallback process.`);
      // Dispose the empty terminal since we won't use it
      terminal.dispose();
      this.terminals.delete(terminal.name);
      this.terminalContexts.delete(terminal.name);
      
      // We must update the job record because it might have been registered as user_visible = true
      const job = this.outputStore.getJob(jobId);
      if (job) job.user_visible = false;

      return await this.runViaFallback(command, cwd, jobId, intent);
    }

    let exitCodePromise: Promise<number | undefined> = Promise.resolve(undefined);
    if (execution) {
       exitCodePromise = new Promise<number | undefined>((resolve) => {
          const d = vscode.window.onDidEndTerminalShellExecution(event => {
            if (event.execution === execution) {
               d.dispose();
               const exitCode = event.exitCode ?? null;
               const ctx = this.terminalContexts.get(terminal.name);
               if (ctx) {
                 ctx.isBusy = false;
                 if (ctx.lifecycleAction === 'auto_delete_after_command') {
                   setTimeout(() => {
                     terminal.dispose();
                     this.terminals.delete(terminal.name);
                     this.terminalContexts.delete(terminal.name);
                   }, 1000);
                 }
               }
               void this.notifyJobCompletion(
                 jobId,
                 exitCode,
                 `completed with exit code ${exitCode}`,
               );
               
               resolve(event.exitCode);
            }
          });
       });
    }

    if (execution) {
      const ctx = this.terminalContexts.get(terminal.name);
      if (ctx) {
        ctx.isBusy = true;
      }
    }

    if (this.isLongRunningIntent(intent)) {
       const windowPromise = new Promise<number | undefined>(resolve =>
         setTimeout(() => resolve(undefined), TerminalService.LONG_INTENT_VERIFY_MS));
       const earlyExit = await Promise.race([exitCodePromise, windowPromise]);
       
       if (earlyExit !== undefined && earlyExit !== 0) {
         return {
           status: 'error',
           content: `Command failed immediately (exit ${earlyExit}): ${command}`,
           data: { job_id: jobId, exit_code: earlyExit, termination_reason: 'exit' }
         };
       }
       if (earlyExit === 0) {
         return await this.buildFinishedAwaitResultResponse(jobId, command, 0);
       }
       return this.buildRunningResponse(jobId, command);
    }

    // await_result via visible shell: dispatch only — outcome unknown until get_output.
    return {
       status: 'verification_needed',
       content: `Command dispatched. Verification required — call get_output with job_id "${jobId}" before claiming success or failure.`,
       error_code: 'verification_needed',
       data: { job_id: jobId, termination_reason: 'dispatched' }
    };
  }

  private async runViaFallback(
    command: string,
    cwd: string | undefined,
    jobId: string,
    intent: JobIntent
  ): Promise<TerminalActionResponse> {
    this.log(`Terminal: Running via Fallback (child_process): ${command}`);

    // On Windows, detached: true allocates a new console window and ignores windowsHide.
    // Process-tree killing on Windows uses taskkill /T instead (see killProcessTree).
    const isWin = process.platform === 'win32';
    const proc = cp.spawn(command, {
      shell: true,
      cwd,
      detached: !isWin,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (proc.pid) {
      this.backgroundProcesses.set(proc.pid, proc);
      const job = this.outputStore.getJob(jobId);
      if (job) job.pid = proc.pid;
    }

    proc.stdout?.on('data', (data) => {
      const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      this.outputStore.appendOutput(jobId, stripped);
    });

    proc.stderr?.on('data', (data) => {
      const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      this.outputStore.appendOutput(jobId, stripped);
    });
    
    const exitPromise = new Promise<number>((resolve) => {
       proc.on('close', (code) => {
         void this.notifyJobCompletion(
           jobId,
           code ?? null,
           `completed with exit code ${code ?? 0}`,
         );
         resolve(code ?? 0);
       });
       proc.on('error', (err) => {
         void this.notifyJobCompletion(
           jobId,
           -1,
           `failed with error ${err.message}`,
           'completed',
         );
         resolve(-1);
       });
    });

    if (this.isLongRunningIntent(intent)) {
       const windowPromise = new Promise<number | undefined>(resolve =>
         setTimeout(() => resolve(undefined), TerminalService.LONG_INTENT_VERIFY_MS));
       const earlyExit = await Promise.race([exitPromise, windowPromise]);
       
       if (earlyExit !== undefined && earlyExit !== 0) {
         return {
           status: 'error',
           content: `Command failed immediately (exit ${earlyExit}): ${command}`,
           data: { job_id: jobId, exit_code: earlyExit, pid: proc.pid, termination_reason: 'exit' }
         };
       }
       if (earlyExit === 0) {
         return await this.buildFinishedAwaitResultResponse(jobId, command, 0);
       }
       return this.buildRunningResponse(jobId, command, { pid: proc.pid });
    }

    const waitPromise = new Promise<number | undefined>((resolve) =>
      setTimeout(() => resolve(undefined), TerminalService.AWAIT_RESULT_WAIT_MS));
    const finishedExit = await Promise.race([exitPromise, waitPromise]);

    if (finishedExit !== undefined) {
      return await this.buildFinishedAwaitResultResponse(jobId, command, finishedExit);
    }

    return {
       status: 'verification_needed',
       content: `Command dispatched. Verification required — call get_output with job_id "${jobId}" before claiming success or failure.`,
       error_code: 'verification_needed',
       data: { job_id: jobId, pid: proc.pid, termination_reason: 'dispatched' }
    };
  }

  private async getOrCreateTerminal(name: string): Promise<vscode.Terminal> {
    let terminal = this.terminals.get(name) || vscode.window.terminals.find(t => t.name === name);
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal(name);
    }
    if (!this.terminals.has(name)) {
      this.terminals.set(name, terminal);
    }
    terminal.show(true);
    for (let i = 0; i < 200; i++) {
      if (terminal.shellIntegration) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return terminal;
  }

  private killProcessTree(proc: cp.ChildProcess) {
    if (process.platform === 'win32') {
      cp.exec(`taskkill /pid ${proc.pid} /T /F`);
    } else {
      if (proc.pid) process.kill(-proc.pid);
    }
  }
  
  private killJobInternal(job: JobRecord) {
     if (job.pid) {
       const proc = this.backgroundProcesses.get(job.pid);
       if (proc) {
         this.killProcessTree(proc);
         this.backgroundProcesses.delete(job.pid);
       }
     } else if (job.terminal_name) {
       const t = this.terminals.get(job.terminal_name);
       if (t) {
         t.dispose();
         this.terminals.delete(job.terminal_name);
       }
     }
     this.outputStore.completeJob(job.job_id, null, 'killed');
  }

  // --- Action Implementations ---

  private async sendInput(payload: TerminalActionPayload): Promise<TerminalActionResponse> {
    const jobId = payload.job_id;
    if (!jobId) throw new Error('job_id is required');
    
    const job = this.outputStore.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    
    const text = payload.input_text || '';
    const asCtrlC = payload.interrupt || false;
    
    if (job.user_visible) {
       const terminal = this.terminals.get(job.terminal_name!) || vscode.window.terminals.find(t => t.name === job.terminal_name!);
       if (!terminal) throw new Error(`Terminal not found: ${job.terminal_name}`);
       if (asCtrlC) {
         terminal.sendText('\x03', false);
       } else {
         terminal.sendText(text, false);
       }
    } else {
       if (job.pid) {
         const proc = this.backgroundProcesses.get(job.pid);
         if (proc && proc.stdin) {
            proc.stdin.write(text);
         }
       }
    }
    
    return { status: 'success', content: 'Input sent successfully' };
  }

  private listJobs(context: TerminalActionPayload): TerminalActionResponse {
    const jobs = this.outputStore.getAllJobs();
    return { status: 'success', content: JSON.stringify(jobs, null, 2) };
  }

  private async killJob(payload: TerminalActionPayload): Promise<TerminalActionResponse> {
    const jobId = (payload.job_id || payload.pid) as string; // fallback to pid for backward compat
    if (!jobId) throw new Error('job_id is required');
    
    const job = this.outputStore.getJob(jobId);
    if (!job) {
       // Fallback for raw PID from old code
       const pid = parseInt(jobId);
       if (!isNaN(pid) && this.backgroundProcesses.has(pid)) {
         this.killProcessTree(this.backgroundProcesses.get(pid)!);
         this.backgroundProcesses.delete(pid);
         return { status: 'success', content: `Process ${pid} killed` };
       }
       return { status: 'error', content: `Job ${jobId} not found` };
    }
    
    this.killJobInternal(job);
    return { status: 'success', content: `Job ${jobId} killed` };
  }

  private getState(): TerminalActionResponse {
    return {
      status: 'success',
      content: JSON.stringify({
        os: process.platform,
        shell: vscode.env.shell,
        terminals: this.getActiveTerminalContexts(),
        jobs: this.outputStore.getAllJobs()
      }, null, 2)
    };
  }

  private async getOutput(payload: TerminalActionPayload): Promise<TerminalActionResponse> {
    const lookupId = (payload.job_id || payload.tool_call_id || payload.execution_id) as string;
    if (!lookupId) {
      return { status: 'error', content: 'job_id is required' };
    }

    const job = this.outputStore.findJob(lookupId);
    if (!job) {
      const activeJobs = this.outputStore.getAllJobs();
      const hint = activeJobs.length > 0
        ? 'Call list_jobs or get_state to see active jobs and their job_id values.'
        : 'No jobs are registered — run_command may not have started, or the extension restarted.';
      return {
        status: 'error',
        content: (
          `Job ${lookupId} not found. For get_output, use job_id from the prior run_command result `
          + `(data.job_id) — not request_id. ${hint}`
        ),
      };
    }

    const jobId = job.job_id;
    const offset = payload.offset || 0;
    const maxChars = payload.max_chars || 2000;

    const result = await this.outputStore.getOutput(jobId, offset, maxChars);
    
    let waitingForInput = false;
    if (job.job_status === 'running') {
       const silence = Date.now() - job.last_output_at;
       if (silence > 2000) {
          const trimmed = result.content.trimEnd();
          if (trimmed.endsWith('?') || trimmed.endsWith(':') || trimmed.endsWith('>') || trimmed.endsWith('#') || trimmed.endsWith('$')) {
             waitingForInput = true;
          }
       }
    }

    const baseData: Record<string, unknown> = {
      job_id: jobId,
      job_status: job.job_status,
      exit_code: job.exit_code,
      total_chars_buffered: result.total_chars_buffered,
      output: result.content,
      output_tail: result.content,
      waiting_for_input: waitingForInput,
    };
    if (lookupId !== jobId && job.request_id === lookupId) {
      baseData.resolved_via_request_id = lookupId;
    }

    if (job.job_status === 'killed') {
      return {
        status: 'cancelled',
        content: result.content || `Job ${jobId} was cancelled.`,
        error_code: 'cancelled',
        data: baseData,
      };
    }

    if (job.job_status === 'running') {
      return {
        status: 'running',
        content: result.content || 'Job is still running.',
        data: baseData,
      };
    }

    const exitCode = job.exit_code ?? 0;
    const toolStatus = exitCode === 0 ? 'success' : 'error';
    return {
      status: toolStatus,
      content: result.content,
      data: baseData,
    };
  }
  
  private async cleanupOutput(payload: TerminalActionPayload): Promise<TerminalActionResponse> {
     const jobId = payload.job_id as string;
     if (!jobId) throw new Error('job_id is required');
     await this.outputStore.cleanupJob(jobId);
     return { status: 'success', content: `Job ${jobId} cleaned up` };
  }

  private async getDiagnostics(args: TerminalActionPayload): Promise<TerminalActionResponse> {
    const diagnostics = vscode.languages.getDiagnostics().map(([uri, diags]) => ({
      file: uri.fsPath,
      diagnostics: diags.map(d => ({
        message: d.message,
        line: d.range.start.line + 1,
        severity: d.severity
      }))
    }));
    return { status: 'success', content: JSON.stringify(diagnostics, null, 2) };
  }

  private listTerminals(): TerminalActionResponse {
    const contexts = this.getActiveTerminalContexts();
    return { status: 'success', content: JSON.stringify(contexts, null, 2) };
  }

  private async newTerminal(payload: TerminalActionPayload): Promise<TerminalActionResponse> {
    const name = (payload.terminal_name || `Terminal-${Date.now()}`) as string;
    await this.getOrCreateTerminal(name);
    return { status: 'success', content: `Created terminal ${name}` };
  }

  private killTerminal(payload: TerminalActionPayload): TerminalActionResponse {
    const name = payload.terminal_name as string;
    const terminal = this.terminals.get(name) || vscode.window.terminals.find(t => t.name === name);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(name);
      this.terminalContexts.delete(name);
      return { status: 'success', content: `Killed terminal ${name}` };
    }
    return { status: 'error', content: `Terminal not found: ${name}` };
  }
}
