import type { FileSystemService } from './file-system-service';
import type { ToolCallPayload, ToolContext, ToolResult } from '../types/index';

export class ToolExecutor {
  constructor(
    private readonly fileSystemService: FileSystemService,
    private readonly backendUrl: string,
    private readonly getAccessToken: (
      options?: { forceRefresh?: boolean }
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
      switch (message.tool_name) {
        case 'list_dir': {
          toolResult = await this.fileSystemService.list_dir(
            this.requireStringArg(message.args.path, 'path'),
            context
          );
          break;
        }

        case 'grep_workspace': {
          toolResult = await this.fileSystemService.grep_workspace(
            this.requireStringArg(message.args.query, 'query'),
            this.optionalStringArg(message.args.filePattern),
            context
          );
          break;
        }

        case 'read_file_paginated': {
          toolResult = await this.fileSystemService.read_file_paginated(
            this.requireStringArg(message.args.path, 'path'),
            this.requireNumberArg(message.args.startLine, 'startLine'),
            this.requireNumberArg(message.args.endLine, 'endLine'),
            context
          );
          break;
        }

        default: {
          toolResult = {
            tool_name: message.tool_name,
            tool_call_id: context.tool_call_id,
            session_id: context.session_id,
            chat_id: context.chat_id,
            message_id: context.message_id,
            status: 'error',
            content: `Unknown tool: ${message.tool_name}`,
            error_code: 'UNKNOWN_TOOL',
            execution_time_ms: 0,
          };
          break;
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
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
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
      const refreshedToken = await this.getAccessToken({ forceRefresh: true });
      if (refreshedToken && refreshedToken !== accessToken) {
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

  private requireStringArg(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Missing or invalid string arg: ${fieldName}`);
    }

    return value;
  }

  private optionalStringArg(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    return value;
  }

  private requireNumberArg(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Missing or invalid number arg: ${fieldName}`);
    }

    return value;
  }
}
