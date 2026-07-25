import type { FileSystemService } from './file-system-service';
import type { ToolCallPayload, ToolContext, ToolResult } from '../types/index';
import type { TerminalService } from './terminal-service';
import * as vscode from 'vscode';
import type { ISnapshotManager } from '../snapshot/types';
import { ChangeRecorder } from '../changes/change-recorder';
import type { FileChange } from '../changes/change-types';
import { extractMutationPaths } from '../changes/extract-mutation-paths';
import { isApplyMode, isMutationAction } from '../changes/mutation-actions';

export class ToolExecutor {
  private readonly changeRecorder = new ChangeRecorder();
  private readonly pendingChangeCapture = new Map<
    string,
    {
      action: string;
      payload: Record<string, unknown>;
      fileUris: vscode.Uri[];
      beforeStates: Map<string, import('../changes/file-content-state').FileContentState>;
      requestId?: string;
    }
  >();

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

      const dottedMatch = message.tool_name.match(/^(workspace_ops|terminal_ops)\.(.+)$/);
      let resolvedToolName: string = message.tool_name;
      let resolvedArgs: Record<string, unknown> = message.args;

      if (dottedMatch) {
        const baseTool = dottedMatch[1];
        const inferredAction = dottedMatch[2];
        const nested = message.args;

        const hasValidStructure =
          typeof nested.action === 'string' &&
          typeof nested.request_id === 'string' &&
          typeof nested.mode === 'string' &&
          nested.payload !== undefined;

        if (hasValidStructure) {
          resolvedToolName = baseTool;
          resolvedArgs = nested;
        } else {
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

        const action = this.optionalStringArg(resolvedArgs.action) ?? '';
        const mode = resolvedArgs.mode;
        const isMutation = isMutationAction(action);
        const isApply = isApplyMode(mode);
        const payload =
          resolvedArgs.payload && typeof resolvedArgs.payload === 'object'
            ? (resolvedArgs.payload as Record<string, unknown>)
            : {};

        const fileUris = isMutation
          ? extractMutationPaths(resolvedArgs, (filePath) => this.fileSystemService.resolveWorkspacePath(filePath))
          : [];

        let beforeStates = new Map<string, import('../changes/file-content-state').FileContentState>();
        if (isMutation && isApply && fileUris.length > 0) {
          beforeStates = await this.changeRecorder.captureBeforeStates(fileUris);
        }

        // Snapshot layer — undo/review only; independent of summary ledger.
        if (isMutation && isApply && fileUris.length > 0) {
          try {
            await this.snapshotManager.createSnapshot(fileUris, {
              sessionId: context.session_id,
              messageId: context.message_id,
            });
            this.log(`Snapshot created successfully for ${fileUris.length} files`);
          } catch (snapshotErr) {
            this.log(`Snapshot creation failed: ${snapshotErr}`);
            throw new Error(
              `Failed to create snapshot for undo safety net: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`
            );
          }
        }

        toolResult = await this.fileSystemService.workspace_ops(resolvedArgs, context);

        // Defer diff/snapshot ledger — ack RPC immediately after disk apply.
        if (toolResult.status === 'success' && isMutation && isApply && fileUris.length > 0) {
          this.pendingChangeCapture.set(context.tool_call_id, {
            action,
            payload,
            fileUris,
            beforeStates,
            requestId: this.optionalStringArg(resolvedArgs.request_id),
          });
        }
      }
    } catch (error) {
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

  async finishChangeCapture(
    toolCallId: string,
    context: ToolContext,
  ): Promise<FileChange[] | null> {
    const pending = this.pendingChangeCapture.get(toolCallId);
    if (!pending) {
      return null;
    }

    this.pendingChangeCapture.delete(toolCallId);

    try {
      const snapshotDir = this.snapshotManager.getSnapshotDir({
        sessionId: context.session_id,
        messageId: context.message_id,
      });

      return await this.changeRecorder.buildChanges({
        action: pending.action,
        payload: pending.payload,
        fileUris: pending.fileUris,
        beforeStates: pending.beforeStates,
        snapshotDir,
        requestId: pending.requestId,
      });
    } catch (error) {
      this.log(`Failed to record file changes: ${error}`);
      return null;
    }
  }

  cancelChangeCapture(toolCallId: string): void {
    this.pendingChangeCapture.delete(toolCallId);
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
}
