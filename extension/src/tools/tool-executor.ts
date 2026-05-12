import type { FileSystemService } from './file-system-service';
import type { ToolCallPayload, ToolContext, ToolResult } from '../types/index';
import type { TerminalService } from './terminal-service';

export class ToolExecutor {
  constructor(
    private readonly fileSystemService: FileSystemService,
    private readonly terminalService: TerminalService,
    private readonly backendUrl: string,
    private readonly getAccessToken: (
      options?: { forceRefresh?: boolean; previousToken?: string }
    ) => Promise<string | undefined>,
    private readonly log: (message: string) => void = () => undefined
  ) {}

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
      if (!allowedTools.includes(message.tool_name)) {
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
          content: `Deprecated tool: ${message.tool_name}. Use workspace_ops or terminal_ops instead.`,
          summary: `Deprecated tool: ${message.tool_name}.`,
          error_code: 'DEPRECATED_TOOL',
          execution_time_ms: 0,
        };
      } else if (message.tool_name === 'terminal_ops') {
        toolResult = await this.terminalService.execute(
          message.args,
          context
        );
      } else {
        toolResult = await this.fileSystemService.workspace_ops(
          message.args,
          context
        );
      }
    } catch (error) {
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
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        summary: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        error_code: 'EXECUTION_ERROR',
        execution_time_ms: 0,
      };
    }

    this.log(
      `tool finish name=${toolResult.tool_name} tool_call_id=${toolResult.tool_call_id} status=${toolResult.status} execution_time_ms=${toolResult.execution_time_ms}`
    );
    await this.postToolResult(toolResult);
    this.log(
      `tool result posted name=${toolResult.tool_name} tool_call_id=${toolResult.tool_call_id} status=${toolResult.status}`
    );
    return toolResult;
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

  private async postToolResult(toolResult: ToolResult): Promise<void> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new Error('Authentication expired. Please sign in again.');
    }

    await this.postToolResultWithToken(toolResult, accessToken, true);
  }

  private async postToolResultWithToken(
    toolResult: ToolResult,
    accessToken: string,
    allowRetry: boolean
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };

    const response = await fetch(`${this.backendUrl}/api/v1/tools/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolResult),
    });

    if (response.status === 401 && allowRetry) {
      this.log(
        `tool result received 401, attempting forced token refresh tool_call_id=${toolResult.tool_call_id}`
      );
      const refreshedToken = await this.getAccessToken({
        forceRefresh: true,
        previousToken: accessToken,
      });
      if (refreshedToken) {
        await this.postToolResultWithToken(toolResult, refreshedToken, false);
        return;
      }
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      throw new Error(
        `Tool result POST failed: ${response.status} ${response.statusText}${responseBody ? ` - ${responseBody}` : ''}`
      );
    }
  }

}
