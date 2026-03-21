import * as vscode from 'vscode';
import type { ToolContext, ToolResult } from '../types/index';

const FALLBACK_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/venv/**}';

const HARD_LIMITS = {
  maxFileReadBytes: 1_000_000,
  maxPaginatedRangeLines: 200,
  maxGrepResults: 50,
  maxGrepFileScanBytes: 500_000,
  maxFindFilesBeforeFallbackExclude: 5_000,
};

export class FileSystemService {
  async list_dir(dirPath: string, context: ToolContext): Promise<ToolResult> {
    const startMs = Date.now();

    try {
      const directoryUri = this.resolveWorkspacePath(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      const content = entries
        .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
        .sort((left, right) => left.localeCompare(right))
        .join('\n');

      return this.successResult('list_dir', context, content, startMs);
    } catch (error) {
      return this.errorResult(
        'list_dir',
        context,
        `Directory listing failed: ${error instanceof Error ? error.message : String(error)}`,
        'ENOENT',
        startMs
      );
    }
  }

  async grep_workspace(
    query: string,
    filePattern: string | undefined,
    context: ToolContext
  ): Promise<ToolResult> {
    const startMs = Date.now();

    try {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        return this.errorResult(
          'grep_workspace',
          context,
          'Query cannot be empty.',
          'GREP_ERROR',
          startMs
        );
      }

      const includePattern = filePattern?.trim() || '**/*';
      let files = await vscode.workspace.findFiles(includePattern, undefined);

      if (files.length > HARD_LIMITS.maxFindFilesBeforeFallbackExclude) {
        files = await vscode.workspace.findFiles(includePattern, FALLBACK_EXCLUDE);
      }

      const queryLower = normalizedQuery.toLowerCase();
      const grepResults: string[] = [];

      for (const fileUri of files) {
        if (grepResults.length >= HARD_LIMITS.maxGrepResults) {
          break;
        }

        let fileStats: vscode.FileStat;
        try {
          fileStats = await vscode.workspace.fs.stat(fileUri);
        } catch {
          continue;
        }

        if (fileStats.size > HARD_LIMITS.maxGrepFileScanBytes) {
          continue;
        }

        let decodedContent: string;
        try {
          const fileBytes = await vscode.workspace.fs.readFile(fileUri);
          decodedContent = new TextDecoder().decode(fileBytes);
        } catch {
          continue;
        }

        const lines = decodedContent.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const lineText = lines[lineIndex];
          if (!lineText.toLowerCase().includes(queryLower)) {
            continue;
          }

          const relativePath = vscode.workspace.asRelativePath(fileUri, false);
          grepResults.push(`${relativePath}:${lineIndex + 1}: ${lineText.trim().slice(0, 150)}`);

          if (grepResults.length >= HARD_LIMITS.maxGrepResults) {
            break;
          }
        }
      }

      const content = grepResults.length > 0
        ? grepResults.join('\n')
        : `No results for "${normalizedQuery}"`;

      return this.successResult('grep_workspace', context, content, startMs);
    } catch (error) {
      return this.errorResult(
        'grep_workspace',
        context,
        `Grep failed: ${error instanceof Error ? error.message : String(error)}`,
        'GREP_ERROR',
        startMs
      );
    }
  }

  async read_file_paginated(
    filePath: string,
    startLine: number,
    endLine: number,
    context: ToolContext
  ): Promise<ToolResult> {
    const startMs = Date.now();

    try {
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        return this.errorResult(
          'read_file_paginated',
          context,
          'startLine and endLine must be integers.',
          'READ_ERROR',
          startMs
        );
      }

      if (startLine < 1 || endLine < 1 || endLine < startLine) {
        return this.errorResult(
          'read_file_paginated',
          context,
          'Invalid range. startLine and endLine must be >= 1 and endLine must be >= startLine.',
          'READ_ERROR',
          startMs
        );
      }

      const rangeSize = endLine - startLine + 1;
      if (rangeSize > HARD_LIMITS.maxPaginatedRangeLines) {
        return this.errorResult(
          'read_file_paginated',
          context,
          `Range ${rangeSize} lines exceeds ${HARD_LIMITS.maxPaginatedRangeLines} line max. Split into smaller calls.`,
          'RANGE_TOO_LARGE',
          startMs
        );
      }

      const fileUri = this.resolveWorkspacePath(filePath);
      const fileStats = await vscode.workspace.fs.stat(fileUri);

      if (fileStats.size > HARD_LIMITS.maxFileReadBytes) {
        return this.errorResult(
          'read_file_paginated',
          context,
          `File too large (${fileStats.size} bytes). Max ${HARD_LIMITS.maxFileReadBytes} bytes.`,
          'FILE_TOO_LARGE',
          startMs
        );
      }

      const fileBytes = await vscode.workspace.fs.readFile(fileUri);
      const fileLines = new TextDecoder().decode(fileBytes).split(/\r?\n/);
      const sliceStart = Math.max(0, startLine - 1);
      const sliceEnd = Math.min(endLine, fileLines.length);
      const content = fileLines.slice(sliceStart, sliceEnd).join('\n');

      return this.successResult('read_file_paginated', context, content, startMs);
    } catch (error) {
      return this.errorResult(
        'read_file_paginated',
        context,
        `Read failed: ${error instanceof Error ? error.message : String(error)}`,
        'READ_ERROR',
        startMs
      );
    }
  }

  private resolveWorkspacePath(inputPath: string): vscode.Uri {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error('No workspace folder is currently open.');
    }

    const normalizedInput = inputPath.trim();
    if (!normalizedInput) {
      throw new Error('Path cannot be empty.');
    }

    const rawUri = this.isAbsolutePath(normalizedInput)
      ? vscode.Uri.file(normalizedInput)
      : vscode.Uri.joinPath(workspaceFolders[0].uri, normalizedInput.replace(/^\.\//, ''));

    const rawFsPathLower = rawUri.fsPath.toLowerCase();
    for (const folder of workspaceFolders) {
      const workspacePathLower = folder.uri.fsPath.toLowerCase();
      if (rawFsPathLower === workspacePathLower || rawFsPathLower.startsWith(`${workspacePathLower}\\`) || rawFsPathLower.startsWith(`${workspacePathLower}/`)) {
        return rawUri;
      }
    }

    throw new Error('Path must be inside an opened workspace folder.');
  }

  private isAbsolutePath(pathValue: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('/') || pathValue.startsWith('\\\\');
  }

  private successResult(
    toolName: ToolResult['tool_name'],
    context: ToolContext,
    content: string,
    startMs: number
  ): ToolResult {
    return {
      tool_name: toolName,
      tool_call_id: context.tool_call_id,
      session_id: context.session_id,
      chat_id: context.chat_id,
      message_id: context.message_id,
      status: 'success',
      content,
      execution_time_ms: Date.now() - startMs,
    };
  }

  private errorResult(
    toolName: ToolResult['tool_name'],
    context: ToolContext,
    content: string,
    errorCode: ToolResult['error_code'],
    startMs: number
  ): ToolResult {
    return {
      tool_name: toolName,
      tool_call_id: context.tool_call_id,
      session_id: context.session_id,
      chat_id: context.chat_id,
      message_id: context.message_id,
      status: 'error',
      content,
      error_code: errorCode,
      execution_time_ms: Date.now() - startMs,
    };
  }
}
