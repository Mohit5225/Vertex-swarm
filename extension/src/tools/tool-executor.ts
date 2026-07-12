import type { FileSystemService } from './file-system-service';
import type { ToolCallPayload, ToolContext, ToolResult } from '../types/index';
import type { TerminalService } from './terminal-service';
import * as vscode from 'vscode';
import type { ISnapshotManager } from '../snapshot/types';
import { DiffService } from '../snapshot/diff-service';
import * as fs from 'fs/promises';
import * as path from 'path';

export class ToolExecutor {
  constructor(
    private readonly fileSystemService: FileSystemService,
    private readonly terminalService: TerminalService,
    private readonly snapshotManager: ISnapshotManager,
    private readonly log: (message: string) => void = () => undefined
  ) { }

  async handle(message: ToolCallPayload): Promise<ToolResult> {
    this.log(
      `tool start name=${message.tool_name} tool_call_id=${message.tool_call_id} args=${JSON.stringify(message.args)}`
    );
    const context: ToolContext = {
      tool_call_id: message.tool_call_id,
      session_id: message.session_id,
      chat_id: message.chat_id,
      message_id: message.message_id,
    };

    let toolResult: ToolResult;

    try {
      const allowedTools = ['workspace_ops', 'terminal_ops'];

      // Resolve dotted-name hallucinations: e.g. "workspace_ops.run_json", "workspace_ops.list_dir"
      // The model sometimes wraps a valid workspace_ops call inside a fake sub-tool name.
      const dottedMatch = message.tool_name.match(/^(workspace_ops|terminal_ops)\.(.+)$/);
      let resolvedToolName: string = message.tool_name;
      let resolvedArgs: Record<string, unknown> = message.args;

      if (dottedMatch) {
        const baseTool = dottedMatch[1];
        const inferredAction = dottedMatch[2];
        const nested = message.args;

        // Case A: args already carry a complete workspace_ops call structure (e.g. workspace_ops.run_json).
        // The model put the right args inside but used the wrong outer tool name — just unwrap.
        const hasValidStructure =
          typeof nested.action === 'string' &&
          typeof nested.request_id === 'string' &&
          typeof nested.mode === 'string' &&
          nested.payload !== undefined;

        if (hasValidStructure) {
          resolvedToolName = baseTool;
          resolvedArgs = nested;
        } else {
          // Case B: args are flat (e.g. workspace_ops.list_dir with path/request_id at top level).
          // Best-effort: inject the inferred action and wrap payload.
          const hasPayload = typeof nested.payload === 'object' && nested.payload !== null;
          resolvedToolName = baseTool;
          resolvedArgs = {
            action: nested.action ?? inferredAction,
            request_id: nested.request_id,
            mode: nested.mode ?? 'preview',
            payload: hasPayload ? nested.payload : { ...nested },
          };
        }
      }

      if (!allowedTools.includes(resolvedToolName)) {
        const workspaceMeta = this.extractWorkspaceMeta(message.args);
        toolResult = {
          tool_name: message.tool_name,
          tool_call_id: context.tool_call_id,
          session_id: context.session_id,
          chat_id: context.chat_id,
          message_id: context.message_id,
          request_id: workspaceMeta.request_id,
          action: workspaceMeta.action,
          status: 'error',
          content: `Unknown tool "${message.tool_name}". Available tools: workspace_ops, terminal_ops, load_tool_context.`,
          summary: `Unknown tool: ${message.tool_name}.`,
          error_code: 'UNKNOWN_TOOL',
          execution_time_ms: 0,
        };
      } else if (resolvedToolName === 'terminal_ops') {
        this.normalizePayload(resolvedArgs);
        toolResult = await this.terminalService.execute(resolvedArgs, context);
      } else {
        this.normalizePayload(resolvedArgs);

        // Phase 1: Snapshot Interception Boundary
        const fileUris = this.extractFileUris(resolvedArgs);
        if (fileUris.length > 0) {
          try {
            await this.snapshotManager.createSnapshot(fileUris, {
              sessionId: context.session_id,
              messageId: context.message_id,
            });
            this.log(`Snapshot created successfully for ${fileUris.length} files`);
          } catch (snapshotErr) {
            this.log(`Snapshot creation failed: ${snapshotErr}`);
            throw new Error(`Failed to create snapshot for undo safety net: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`);
          }
        }

        toolResult = await this.fileSystemService.workspace_ops(resolvedArgs, context);

        // Compute diff if the tool succeeded and files were modified
        if (toolResult.status === 'success' && fileUris.length > 0) {
          try {
            const snapshotDir = this.snapshotManager.getSnapshotDir({
              sessionId: context.session_id,
              messageId: context.message_id
            });
            const diffs = [];
            for (const uri of fileUris) {
              // Use the EXACT same path derivation as DiskSnapshotManager.createSnapshot
              // so that the snapshot file is guaranteed to exist at this path.
              const relativePath = vscode.workspace.asRelativePath(uri, false);
              const safeRelativePath = relativePath.replace(/[^a-zA-Z0-9.\-_\\/]/g, '_');
              const snapshotPath = path.join(snapshotDir, safeRelativePath);

              let oldText = '';
              try {
                oldText = await fs.readFile(snapshotPath, 'utf8');
              } catch {
                // File was new (didn't exist before), so snapshot has no content
              }

              let newText = '';
              try {
                const doc = await vscode.workspace.openTextDocument(uri);
                newText = doc.getText();
              } catch {
                // File might have been deleted by the tool
              }

              const diff = DiffService.computeDiff(path.basename(uri.fsPath), oldText, newText);
              diffs.push({
                file: path.basename(uri.fsPath),
                originalUri: uri.toString(),
                snapshotPath,
                ...diff
              });
            }

            toolResult.data = {
              ...(typeof toolResult.data === 'object' && toolResult.data !== null ? toolResult.data : {}),
              snapshot_diffs: diffs,
              // Pass both IDs so the frontend can issue a correct undo-snapshot message
              snapshot_id: context.message_id,
              snapshot_session_id: context.session_id
            };
          } catch (e) {
            this.log(`Failed to compute diff: ${e}`);
          }
        }
      }
    } catch (error) {
      const workspaceMeta = this.extractWorkspaceMeta(message.args);
      toolResult = {
        tool_name: message.tool_name,
        tool_call_id: context.tool_call_id,
        session_id: context.session_id,
        chat_id: context.chat_id,
        message_id: context.message_id,
        status: 'error',
        content: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
        error_code: 'EXECUTION_ERROR',
        execution_time_ms: 0,
      };
    }

    this.log(
      `tool finish name=${toolResult.tool_name} tool_call_id=${toolResult.tool_call_id} status=${toolResult.status} execution_time_ms=${toolResult.execution_time_ms}`
    );
    return toolResult;
  }

  private normalizePayload(args: Record<string, any>) {
    if (typeof args !== 'object' || args === null) return;
    const { action, request_id, mode, payload, ...rest } = args;
    if (Object.keys(rest).length > 0) {
      args.payload = { ...(payload || {}), ...rest };
      for (const key of Object.keys(rest)) {
        delete args[key];
      }
    }
  }

  private extractWorkspaceMeta(args: Record<string, unknown>): { request_id?: string; action?: string } {
    const requestId = this.optionalStringArg(args.request_id);
    const action = this.optionalStringArg(args.action);

    return { request_id: requestId, action };
  }

  private optionalStringArg(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private extractFileUris(args: Record<string, any>): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    const action = args.action;
    const payload = args.payload;

    if (!payload) return uris;

    // Handle both LLM-facing action names (edit_file, create_file) and
    // internal workspace_ops action names (write_file, replace_file_content, etc.)
    const isFileWrite = [
      'write_file',
      'replace_file_content',
      'multi_replace_file_content',
      'edit_file',
      'create_file',
    ].includes(action);

    if (isFileWrite) {
      // Try TargetFile first (Antigravity-style tools), then path (LLM-style)
      const filePath = payload.TargetFile || payload.path || payload.target;
      if (filePath && typeof filePath === 'string') {
        try {
          uris.push(this.fileSystemService.resolveWorkspacePath(filePath));
        } catch {
          uris.push(vscode.Uri.file(filePath));
        }
      }
    } else if (['delete_file', 'delete_path'].includes(action)) {
      const filePath = payload.TargetPath || payload.path || payload.target;
      if (filePath && typeof filePath === 'string') {
        try {
          uris.push(this.fileSystemService.resolveWorkspacePath(filePath));
        } catch {
          uris.push(vscode.Uri.file(filePath));
        }
      }
    }

    return uris;
  }

}
