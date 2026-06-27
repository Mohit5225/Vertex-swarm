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

  // ANSI escape code regex — used only for pattern matching against output stream,
  // NOT for constructing content returned to the LLM.
  private readonly ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B\r\n]*(?:[\x07\x1B\\]|$))/gm;


  constructor(
    private readonly log: (message: string) => void,
    private readonly postEvent: (event: SessionEvent) => void
  ) { }

  /**
   * Execute a terminal operation
   */
  async execute(args: any, context: any): Promise<ToolResult> {
    const action = args.action || 'run_command';
    const payload = args.payload || {};
    const startTime = Date.now();

    try {
      if (action === 'run_command') {
        const mode = args.mode || 'blocking';
        return await this.runCommand(payload, context, mode);
      }

      let result: any;
      switch (action) {
        case 'send_input':
          result = await this.sendInput(payload);
          break;
        case 'get_output':
          result = this.getOutput(payload);
          break;
        case 'get_diagnostics':
          result = await this.getDiagnostics(payload);
          break;
        case 'get_state':
          result = this.getState();
          break;
        case 'list_processes':
          result = this.listProcesses(context);
          break;
        case 'kill_process':
          result = this.killProcess(payload);
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
  private async runCommand(payload: any, context: any, topLevelMode?: string): Promise<ToolResult> {
    const { command, cwd, mode: payloadMode, timeout_seconds = 360, wait_for_pattern } = payload;
    const mode = topLevelMode || payloadMode || 'blocking';
    const terminalName = payload.terminal_name || 'Vertex Worker';

    const terminal = await this.getOrCreateTerminal(terminalName);

    // Start Heartbeat for live progress
    this.startHeartbeat(context.tool_call_id);

    if (terminal.shellIntegration) {
      return await this.runViaShellIntegration(terminal, command, cwd, context, timeout_seconds, wait_for_pattern, mode, terminalName);
    } else {
      return await this.runViaFallback(command, cwd, context, timeout_seconds, wait_for_pattern, mode, terminalName);
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
    mode?: string,
    terminalName: string = 'Vertex Worker'
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
      return new Promise((resolve) => {
        let earlyExitCode: number | undefined;
        
        const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
          if (event.execution === execution) {
            earlyExitCode = event.exitCode;
          }
        });
        
        (async () => {
          for await (const chunk of execution.read()) {
            const stripped = chunk.replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            output += stripped;
            this.appendToBuffer(context.tool_call_id, stripped);
          }
        })();

        setTimeout(() => {
          disposable.dispose();
          this.stopHeartbeat(context.tool_call_id);
          
          if (earlyExitCode !== undefined && earlyExitCode !== 0) {
            resolve({
              tool_name: 'terminal_ops',
              tool_call_id: context.tool_call_id,
              session_id: context.session_id,
              chat_id: context.chat_id,
              message_id: context.message_id,
              status: 'error',
              content: `Command failed immediately (exit ${earlyExitCode}): ${command}\nOutput tail:\n${output.slice(-4000)}`,
              data: { 
                tool_call_id: context.tool_call_id,
                cwd,
                shell: vscode.env.shell,
                exit_code: earlyExitCode, 
                termination_reason: 'exit',
                command,
                output_tail: output.slice(-4000)
              },
              execution_time_ms: Date.now() - startTime,
            });
          } else {
            resolve({
              tool_name: 'terminal_ops',
              tool_call_id: context.tool_call_id,
              session_id: context.session_id,
              chat_id: context.chat_id,
              message_id: context.message_id,
              status: 'success',
              content: `Command started in background: ${command}`,
              data: { 
                tool_call_id: context.tool_call_id,
                cwd,
                shell: vscode.env.shell,
                exit_code: earlyExitCode ?? 0, 
                termination_reason: 'background',
                command
              },
              execution_time_ms: Date.now() - startTime,
            });
          }
        }, 500);
      });
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Terminal command timed out')), timeout * 1000)
    );

    try {
      const executionPromise = (async () => {
        for await (const chunk of execution.read()) {
          // Strip escape sequences only for pattern matching — output is never sent to LLM
          const stripped = chunk.replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          output += stripped;
          this.appendToBuffer(context.tool_call_id, stripped);

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
        content: exitCode === 0
          ? `Command succeeded: ${command}\nOutput tail:\n${output.slice(-4000)}`
          : `Command failed (exit ${exitCode ?? 'unknown'}): ${command}\nOutput tail:\n${output.slice(-4000)}`,
        data: {
          tool_call_id: context.tool_call_id,
          cwd,
          shell: vscode.env.shell,
          exit_code: exitCode,
          termination_reason: 'exit',
          terminal_name: terminalName,
          command,
          output_tail: output.slice(-4000)
        },
        execution_time_ms: Date.now() - startTime,
      };
    } catch (err: any) {
      this.stopHeartbeat(context.tool_call_id);
      if (err.message === 'Terminal command timed out') {
         return {
           tool_name: 'terminal_ops',
           tool_call_id: context.tool_call_id,
           session_id: context.session_id,
           chat_id: context.chat_id,
           message_id: context.message_id,
           status: 'error',
           content: `Command timed out: ${command}\nOutput tail:\n${output.slice(-4000)}`,
           data: {
             tool_call_id: context.tool_call_id,
             cwd,
             shell: vscode.env.shell,
             exit_code: -1,
             termination_reason: 'timeout',
             terminal_name: terminalName,
             command,
             output_tail: output.slice(-4000)
           },
           execution_time_ms: Date.now() - startTime,
         };
      }
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
    mode?: string,
    terminalName: string = 'Vertex Worker'
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

      let output = '';
      if (mode === 'background' && !waitForPattern) {
        let earlyExitCode: number | null = null;
        
        proc.on('close', (code) => {
          earlyExitCode = code;
        });
        proc.stdout?.on('data', (data) => {
          const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          output += stripped;
          this.appendToBuffer(context.tool_call_id, stripped);
        });
        proc.stderr?.on('data', (data) => {
          const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          output += stripped;
          this.appendToBuffer(context.tool_call_id, stripped);
        });

        setTimeout(() => {
          this.stopHeartbeat(context.tool_call_id);
          if (earlyExitCode !== null && earlyExitCode !== 0) {
            resolve({
              tool_name: 'terminal_ops',
              tool_call_id: context.tool_call_id,
              session_id: context.session_id,
              chat_id: context.chat_id,
              message_id: context.message_id,
              status: 'error',
              content: `Command failed immediately (exit ${earlyExitCode}): ${command}\nOutput tail:\n${output.slice(-4000)}`,
              data: { 
                tool_call_id: context.tool_call_id,
                cwd,
                shell: vscode.env.shell,
                exit_code: earlyExitCode, 
                termination_reason: 'exit',
                command,
                output_tail: output.slice(-4000)
              },
              execution_time_ms: Date.now() - startTime,
            });
          } else {
            resolve({
              tool_name: 'terminal_ops',
              tool_call_id: context.tool_call_id,
              session_id: context.session_id,
              chat_id: context.chat_id,
              message_id: context.message_id,
              status: 'success',
              content: `Background process started with PID ${proc.pid}`,
              data: { 
                tool_call_id: context.tool_call_id,
                cwd,
                shell: vscode.env.shell,
                exit_code: earlyExitCode ?? 0, 
                pid: proc.pid,
                termination_reason: 'background',
                command
              },
              execution_time_ms: Date.now() - startTime,
            });
          }
        }, 500);
        return;
      }

      const timer = setTimeout(() => {
        this.killProcessTree(proc);
        this.stopHeartbeat(context.tool_call_id);
        resolve({
          tool_name: 'terminal_ops',
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          status: 'error',
          content: `Command timed out: ${command}\nOutput tail:\n${output.slice(-4000)}`,
          data: {
            tool_call_id: context.tool_call_id,
            cwd,
            shell: vscode.env.shell,
            exit_code: -1,
            termination_reason: 'timeout',
            terminal_name: terminalName,
            command,
            output_tail: output.slice(-4000)
          },
          execution_time_ms: Date.now() - startTime,
        });
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
        const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        output += stripped;
        this.appendToBuffer(context.tool_call_id, stripped);
        checkPattern();
      });

      proc.stderr?.on('data', (data) => {
        const stripped = data.toString().replace(this.ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        output += stripped;
        this.appendToBuffer(context.tool_call_id, stripped);
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
          content: code === 0
            ? `Command succeeded: ${command}\nOutput tail:\n${output.slice(-4000)}`
            : `Command failed (exit ${code ?? 'unknown'}): ${command}\nOutput tail:\n${output.slice(-4000)}`,
          data: {
            tool_call_id: context.tool_call_id,
            cwd,
            shell: vscode.env.shell,
            exit_code: code,
            termination_reason: 'exit',
            terminal_name: terminalName,
            command,
            output_tail: output.slice(-4000)
          },
          execution_time_ms: Date.now() - startTime,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        this.stopHeartbeat(context.tool_call_id);
        resolve({
          tool_name: 'terminal_ops',
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          status: 'error',
          content: `Command error: ${err.message}\nOutput tail:\n${output.slice(-4000)}`,
          data: {
            tool_call_id: context.tool_call_id,
            cwd,
            shell: vscode.env.shell,
            exit_code: -1,
            termination_reason: 'error',
            terminal_name: terminalName,
            command,
            output_tail: output.slice(-4000)
          },
          execution_time_ms: Date.now() - startTime,
        });
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
      
      // Wait for shell integration to become available (up to 10 seconds)
      for (let i = 0; i < 200; i++) {
        if (terminal.shellIntegration) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return terminal;
  }

  /**
   * Heartbeat: previously flushed raw output to the UI as 'output' events.
   * Now a no-op interval — we keep the timer structure intact so stopHeartbeat
   * still works, but we never post raw terminal chunks to the chat.
   * Raw output lives in the terminal panel; the chat only sees the final summary.
   */
  private startHeartbeat(toolCallId: string) {
    // Buffer is maintained for wait_for_pattern matching only.
    // No events are emitted — raw output must not appear as chat text.
    const interval = setInterval(() => {
      // intentionally empty: do not flush buffer to UI
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

  private async sendInput(payload: any): Promise<ToolResult> {
    const terminal = this.terminals.get(payload.terminal_name || 'Vertex Worker');
    if (!terminal) {
      throw new Error(`Terminal not found: ${payload.terminal_name}`);
    }
    terminal.sendText(payload.input_text || '', false);
    return { status: 'success', content: 'Input sent successfully' } as any;
  }

  private listProcesses(context: any): ToolResult {
    const procs = Array.from(this.backgroundProcesses.entries()).map(([pid, p]) => ({
      pid,
      killed: p.killed
    }));
    return { status: 'success', content: JSON.stringify(procs, null, 2) } as any;
  }

  private killProcess(payload: any): ToolResult {
    const pid = payload.pid;
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



  private getOutput(payload: any): ToolResult {
    const toolCallId = payload.tool_call_id || payload.execution_id;
    if (!toolCallId) {
      return { status: 'error', content: 'tool_call_id or execution_id is required in payload' } as any;
    }
    const output = this.outputBuffers.get(toolCallId) || '';
    return { status: 'success', content: output } as any;
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

  private async newTerminal(payload: any): Promise<ToolResult> {
    const name = payload.terminal_name || `Terminal-${Date.now()}`;
    await this.getOrCreateTerminal(name);
    return { status: 'success', content: `Created terminal ${name}` } as any;
  }

  private killTerminal(payload: any): ToolResult {
    const name = payload.terminal_name;
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(name);
      return { status: 'success', content: `Terminal ${name} disposed` } as any;
    }
    return { status: 'error', content: `Terminal ${name} not found` } as any;
  }
}
