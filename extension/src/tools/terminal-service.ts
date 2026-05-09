import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ToolResult, SessionEvent } from '../types/index';

/**
 * TerminalService
 * Handles terminal execution via Shell Integration (Primary) or child_process (Fallback).
 */
export class TerminalService {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly backgroundProcesses = new Map<number, cp.ChildProcess>();
  private readonly heartbeatFlushes = new Map<string, NodeJS.Timeout>();
  private readonly outputBuffers = new Map<string, string>();

  // ANSI escape code regex for stripping colors/formatting and OSC sequences
  private readonly ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*[\x07\x1B\\])/g;

  constructor(
    private readonly log: (message: string) => void,
    private readonly postEvent: (event: SessionEvent) => void
  ) { }

  /**
   * Execute a terminal operation
   */
  async execute(args: any, context: any): Promise<ToolResult> {
    const action = args.action || 'run_command';
    const startTime = Date.now();

    try {
      if (action === 'run_command') {
        return await this.runCommand(args, context);
      }

      let result: any;
      switch (action) {
        case 'send_input':
          result = await this.sendInput(args);
          break;
        case 'get_output':
          result = this.getOutput(args);
          break;
        case 'get_diagnostics':
          result = await this.getDiagnostics(args);
          break;
        case 'get_state':
          result = this.getState();
          break;
        case 'list_processes':
          result = this.listProcesses(context);
          break;
        case 'kill_process':
          result = this.killProcess(args);
          break;
        case 'list_terminals':
          result = this.listTerminals();
          break;
        case 'new_terminal':
          result = await this.newTerminal(args);
          break;
        case 'kill_terminal':
          result = this.killTerminal(args);
          break;
        default:
          throw new Error(`Unknown terminal action: ${action}`);
      }

      return {
        tool_name: 'terminal_ops',
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        status: result.status,
        content: result.content,
        data: result.data,
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

  /**
   * Run a command (Blocking or Background)
   */
  private async runCommand(args: any, context: any): Promise<ToolResult> {
    const { command, cwd, mode = 'blocking', timeout_seconds = 360, wait_for_pattern } = args;
    const terminal = await this.getOrCreateTerminal(args.terminal_name || 'Vertex Worker');

    // Start Heartbeat for live progress
    this.startHeartbeat(context.tool_call_id);

    if (terminal.shellIntegration) {
      return await this.runViaShellIntegration(terminal, command, cwd, context, timeout_seconds, wait_for_pattern, mode);
    } else {
      return await this.runViaFallback(command, cwd, context, timeout_seconds, wait_for_pattern, mode);
    }
  }

  /**
   * Primary Path: VS Code Shell Integration
   */
  private async runViaShellIntegration(
    terminal: vscode.Terminal,
    command: string,
    cwd: string | undefined,
    context: any,
    timeout: number,
    waitForPattern?: string,
    mode?: string
  ): Promise<ToolResult> {
    if (cwd) {
      const shell = vscode.env.shell.toLowerCase();
      const isPowershell = shell.includes('pwsh') || shell.includes('powershell');
      const isCmd = shell.includes('cmd.exe');
      const cdCmd = isPowershell ? `Set-Location "${cwd}"` : isCmd ? `cd /d "${cwd}"` : `cd "${cwd}"`;

      this.log(`Terminal: Injecting location: ${cdCmd}`);
      const cdExecution = terminal.shellIntegration!.executeCommand(cdCmd);

      const cdExitCode = await new Promise<number | undefined>((resolve) => {
        const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
          if (event.execution === cdExecution) {
            disposable.dispose();
            resolve(event.exitCode);
          }
        });
      });

      if (cdExitCode !== 0 && cdExitCode !== undefined) {
        this.stopHeartbeat(context.tool_call_id);
        return {
          tool_name: 'terminal_ops',
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          status: 'error',
          content: `Failed to change directory to ${cwd} (exit code ${cdExitCode})`,
          execution_time_ms: 0,
        };
      }
    }

    this.log(`Terminal: Running via Shell Integration: ${command}`);

    // Stable API: executeCommand returns a TerminalShellExecution
    const execution = terminal.shellIntegration!.executeCommand(command);
    let output = '';

    const startTime = Date.now();

    if (mode === 'background' && !waitForPattern) {
      // Fire and forget reading to drain stream
      (async () => {
        for await (const chunk of execution.read()) { }
      })();
      this.stopHeartbeat(context.tool_call_id);
      return {
        tool_name: 'terminal_ops',
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        status: 'success',
        content: `Command started in background: ${command}`,
        data: { exit_code: 0 },
        execution_time_ms: Date.now() - startTime,
      };
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Terminal command timed out')), timeout * 1000)
    );

    try {
      const executionPromise = (async () => {
        for await (const chunk of execution.read()) {
          const sanitized = chunk.replace(this.ansiRegex, '');
          output += sanitized;
          this.appendToBuffer(context.tool_call_id, sanitized);

          if (waitForPattern && new RegExp(waitForPattern, 'i').test(output)) {
            return 0; // Return early with success status
          }
        }

        // Wait for actual completion event to get exit code
        return new Promise<number | undefined>((resolve) => {
          const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
            if (event.execution === execution) {
              disposable.dispose();
              resolve(event.exitCode);
            }
          });
        });
      })();

      const exitCode = await Promise.race([executionPromise, timeoutPromise]);
      this.stopHeartbeat(context.tool_call_id);

      return {
        tool_name: 'terminal_ops',
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        status: exitCode === 0 ? 'success' : 'error',
        content: output,
        data: { exit_code: exitCode },
        execution_time_ms: Date.now() - startTime,
      };
    } catch (err) {
      this.stopHeartbeat(context.tool_call_id);
      throw err;
    }
  }

  /**
   * Fallback Path: child_process.spawn
   */
  private async runViaFallback(
    command: string,
    cwd: string | undefined,
    context: any,
    timeout: number,
    waitForPattern?: string,
    mode?: string
  ): Promise<ToolResult> {
    this.log(`Terminal: Running via Fallback (child_process): ${command}`);
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const proc = cp.spawn(command, {
        shell: true,
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (proc.pid) {
        this.backgroundProcesses.set(proc.pid, proc);
      }

      if (mode === 'background' && !waitForPattern) {
        this.stopHeartbeat(context.tool_call_id);
        resolve({
          tool_name: 'terminal_ops',
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          status: 'success',
          content: `Background process started with PID ${proc.pid}`,
          data: { exit_code: 0, pid: proc.pid },
          execution_time_ms: Date.now() - startTime,
        });
        return;
      }

      let output = '';
      const timer = setTimeout(() => {
        this.killProcessTree(proc);
        reject(new Error('Terminal command timed out'));
      }, timeout * 1000);

      const checkPattern = () => {
        if (waitForPattern && new RegExp(waitForPattern, 'i').test(output)) {
          clearTimeout(timer);
          this.stopHeartbeat(context.tool_call_id);
          resolve({
            tool_name: 'terminal_ops',
            tool_call_id: context.tool_call_id,
            session_id: context.session_id,
            chat_id: context.chat_id,
            message_id: context.message_id,
            status: 'success',
            content: output,
            data: { exit_code: 0 },
            execution_time_ms: Date.now() - startTime,
          });
        }
      };

      proc.stdout?.on('data', (data) => {
        const sanitized = data.toString().replace(this.ansiRegex, '');
        output += sanitized;
        this.appendToBuffer(context.tool_call_id, sanitized);
        checkPattern();
      });

      proc.stderr?.on('data', (data) => {
        const sanitized = data.toString().replace(this.ansiRegex, '');
        output += sanitized;
        this.appendToBuffer(context.tool_call_id, sanitized);
        checkPattern();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this.stopHeartbeat(context.tool_call_id);
        resolve({
          tool_name: 'terminal_ops',
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          status: code === 0 ? 'success' : 'error',
          content: output,
          data: { exit_code: code },
          execution_time_ms: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.stopHeartbeat(context.tool_call_id);
        reject(err);
      });
    });
  }

  /**
   * Helper: Get or create a terminal instance
   */
  private async getOrCreateTerminal(name: string): Promise<vscode.Terminal> {
    let terminal = this.terminals.get(name);
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal(name);
      this.terminals.set(name, terminal);
      terminal.show(true);
      
      // Wait for shell integration to become available (up to 3 seconds)
      for (let i = 0; i < 60; i++) {
        if (terminal.shellIntegration) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return terminal;
  }

  /**
   * Heartbeat: Flush buffer to UI every 200ms
   */
  private startHeartbeat(toolCallId: string) {
    const interval = setInterval(() => {
      const buffer = this.outputBuffers.get(toolCallId) || '';
      if (buffer.length > 0) {
        this.postEvent({
          id: vscode.Uri.parse(`temp:${Date.now()}`).toString(),
          type: 'output',
          content: buffer,
          timestamp: Date.now()
        });
        this.outputBuffers.set(toolCallId, ''); // Clear buffer after flush
      }
    }, 200);
    this.heartbeatFlushes.set(toolCallId, interval);
  }

  private stopHeartbeat(toolCallId: string) {
    const interval = this.heartbeatFlushes.get(toolCallId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatFlushes.delete(toolCallId);
    }
    this.outputBuffers.delete(toolCallId);
  }

  private appendToBuffer(toolCallId: string, text: string) {
    const current = this.outputBuffers.get(toolCallId) || '';
    this.outputBuffers.set(toolCallId, current + text);
  }

  private killProcessTree(proc: cp.ChildProcess) {
    if (process.platform === 'win32') {
      cp.exec(`taskkill /pid ${proc.pid} /T /F`);
    } else {
      if (proc.pid) process.kill(-proc.pid);
    }
  }

  // --- Action Implementations ---

  private async sendInput(args: any): Promise<ToolResult> {
    const terminal = this.terminals.get(args.terminal_name || 'Vertex Worker');
    if (!terminal) {
      throw new Error(`Terminal not found: ${args.terminal_name}`);
    }
    terminal.sendText(args.input_text || '', false);
    return { status: 'success', content: 'Input sent successfully' } as any;
  }

  private listProcesses(context: any): ToolResult {
    const procs = Array.from(this.backgroundProcesses.entries()).map(([pid, p]) => ({
      pid,
      killed: p.killed
    }));
    return { status: 'success', content: JSON.stringify(procs, null, 2) } as any;
  }

  private killProcess(args: any): ToolResult {
    const pid = args.pid;
    if (!pid) throw new Error('pid is required');
    const proc = this.backgroundProcesses.get(pid);
    if (proc) {
      this.killProcessTree(proc);
      this.backgroundProcesses.delete(pid);
      return { status: 'success', content: `Process ${pid} killed` } as any;
    }
    return { status: 'error', content: `Process ${pid} not found` } as any;
  }

  private getState(): ToolResult {
    return {
      status: 'success',
      content: JSON.stringify({
        os: process.platform,
        shell: vscode.env.shell,
        terminals: Array.from(this.terminals.keys())
      }, null, 2)
    } as any;
  }



  private getOutput(args: any): ToolResult {
    // Basic implementation placeholder for Phase 4
    return { status: 'success', content: 'Output placeholder' } as any;
  }

  private async getDiagnostics(args: any): Promise<ToolResult> {
    const diagnostics = vscode.languages.getDiagnostics().map(([uri, diags]) => ({
      file: uri.fsPath,
      diagnostics: diags.map(d => ({
        message: d.message,
        line: d.range.start.line + 1,
        severity: d.severity
      }))
    }));
    return { status: 'success', content: JSON.stringify(diagnostics, null, 2) } as any;
  }

  private listTerminals(): ToolResult {
    const names = vscode.window.terminals.map(t => t.name);
    return { status: 'success', content: JSON.stringify(names, null, 2) } as any;
  }

  private async newTerminal(args: any): Promise<ToolResult> {
    const name = args.terminal_name || `Terminal-${Date.now()}`;
    await this.getOrCreateTerminal(name);
    return { status: 'success', content: `Created terminal ${name}` } as any;
  }

  private killTerminal(args: any): ToolResult {
    const name = args.terminal_name;
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(name);
      return { status: 'success', content: `Terminal ${name} disposed` } as any;
    }
    return { status: 'error', content: `Terminal ${name} not found` } as any;
  }
}
