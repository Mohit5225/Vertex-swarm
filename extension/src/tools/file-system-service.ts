import * as vscode from 'vscode';
import type { ToolContext, ToolResult } from '../types/index';
import {
  buildConflictResult as buildWorkspaceConflictResult,
  extractWorkspaceOpsRequest,
  normalizeWorkspaceOpsAction,
  parseWorkspaceOpsMode as parseWorkspaceOpsModeContract,
} from './workspace-ops-contract.mjs';

const FALLBACK_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/venv/**}';

const HARD_LIMITS = {
  maxFileReadBytes: 1_000_000,
  maxPaginatedRangeLines: 200,
  maxGrepResults: 50,
  maxGrepFileScanBytes: 500_000,
  maxFindFilesBeforeFallbackExclude: 5_000,
  maxEditOperations: 500,
  maxWriteFileBytes: 1_000_000,
  maxWorkspaceRequestCache: 1_000,
};

type WorkspaceOpsAction =
  | 'list_dir'
  | 'search_text'
  | 'read_file'
  | 'edit_file'
  | 'create_file'
  | 'delete_path'
  | 'rename_path';

type WorkspaceOpsMode = 'preview' | 'apply';

interface WorkspaceOpsRequest {
  action: WorkspaceOpsAction;
  requestId: string;
  mode: WorkspaceOpsMode;
  payload: Record<string, unknown>;
  expectedHash?: string;
  expectedVersion?: string;
}

interface CachedWorkspaceResult {
  tool_name: ToolResult['tool_name'];
  status: ToolResult['status'];
  content: string;
  request_id?: string;
  action?: string;
  summary?: string;
  data?: unknown;
  conflict?: Record<string, unknown> | null;
  error_code?: string;
  execution_time_ms: number;
}

interface WorkspaceResultEnvelope {
  request_id?: string;
  action?: string;
  summary?: string;
  data?: unknown;
  conflict?: Record<string, unknown> | null;
}

interface NormalizedTextEdit {
  range: vscode.Range;
  newText: string;
  startOffset: number;
  endOffset: number;
  summary: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    textLength: number;
  };
}

export class FileSystemService {
  private readonly workspaceRequestCache = new Map<string, CachedWorkspaceResult>();

  private async list_dir(dirPath: string, context: ToolContext): Promise<ToolResult> {
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

  private async grep_workspace(
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

  private async read_file_paginated(
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

  async workspace_ops(
    rawArgs: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const startMs = Date.now();

    try {
      const request = this.parseWorkspaceOpsRequest(rawArgs);
      const cachedResult = this.getCachedWorkspaceResult(request.requestId, context);
      if (cachedResult) {
        return cachedResult;
      }

      switch (request.action) {
        case 'list_dir': {
          const path = this.requireStringField(request.payload, 'path');
          const result = await this.list_dir(path, context);
          return this.cacheWorkspaceResult(
            request.requestId,
            this.withToolName(result, 'workspace_ops', {
              requestId: request.requestId,
              action: request.action,
              summary: `Listed directory ${path}.`,
              data: { path },
            })
          );
        }

        case 'search_text': {
          const query = this.requireStringField(request.payload, 'query');
          const filePattern = this.optionalStringField(request.payload, 'filePattern');
          const result = await this.grep_workspace(query, filePattern, context);
          return this.cacheWorkspaceResult(
            request.requestId,
            this.withToolName(result, 'workspace_ops', {
              requestId: request.requestId,
              action: request.action,
              summary: `Searched for "${query}"${filePattern ? ` in ${filePattern}` : ''}.`,
              data: { query, filePattern: filePattern ?? null },
            })
          );
        }

        case 'read_file': {
          const path = this.requireStringField(request.payload, 'path');
          const startLine = this.optionalIntegerField(request.payload, 'startLine') ?? 1;
          const endLine = this.optionalIntegerField(request.payload, 'endLine')
            ?? (startLine + HARD_LIMITS.maxPaginatedRangeLines - 1);
          const result = await this.read_file_paginated(path, startLine, endLine, context);
          return this.cacheWorkspaceResult(
            request.requestId,
            this.withToolName(result, 'workspace_ops', {
              requestId: request.requestId,
              action: request.action,
              summary: `Read ${path} lines ${startLine}-${endLine}.`,
              data: { path, startLine, endLine },
            })
          );
        }

        case 'edit_file': {
          return this.runEditFile(request, context, startMs);
        }

        case 'create_file': {
          return this.runCreateFile(request, context, startMs);
        }

        case 'delete_path': {
          return this.runDeletePath(request, context, startMs);
        }

        case 'rename_path': {
          return this.runRenamePath(request, context, startMs);
        }

        default: {
          return this.errorResult(
            'workspace_ops',
            context,
            `Unsupported workspace_ops action: ${(request as { action?: string }).action ?? 'unknown'}`,
            'UNKNOWN_ACTION',
            startMs
          );
        }
      }
    } catch (error) {
      return this.errorResult(
        'workspace_ops',
        context,
        `workspace_ops failed: ${error instanceof Error ? error.message : String(error)}`,
        'WORKSPACE_OPS_ERROR',
        startMs
      );
    }
  }

  private async runEditFile(
    request: WorkspaceOpsRequest,
    context: ToolContext,
    startMs: number
  ): Promise<ToolResult> {
    try {
      const path = this.requireStringField(request.payload, 'path');
      const rawEdits = this.requireArrayField(request.payload, 'edits');

      if (rawEdits.length === 0) {
        return this.errorResult(
          'workspace_ops',
          context,
          'edit_file requires at least one edit.',
          'INVALID_EDITS',
          startMs
        );
      }

      if (rawEdits.length > HARD_LIMITS.maxEditOperations) {
        return this.errorResult(
          'workspace_ops',
          context,
          `edit_file supports at most ${HARD_LIMITS.maxEditOperations} edits per call.`,
          'TOO_MANY_EDITS',
          startMs
        );
      }

      const fileUri = this.resolveWorkspacePath(path);
      const document = await vscode.workspace.openTextDocument(fileUri);
      const currentContent = document.getText();
      const currentHash = this.computeContentHash(currentContent);

      const concurrencyError = this.validateConcurrencyGuard(
        request,
        currentHash,
        context,
        startMs,
        path
      );
      if (concurrencyError) {
        return this.cacheWorkspaceResult(request.requestId, concurrencyError);
      }

      const normalizedEdits = rawEdits.map((entry, index) =>
        this.normalizeTextEdit(entry, index, document)
      );

      const overlapViolation = this.findOverlappingEdit(normalizedEdits);
      if (overlapViolation) {
        return this.errorResult(
          'workspace_ops',
          context,
          overlapViolation,
          'OVERLAPPING_EDITS',
          startMs
        );
      }

      const nextContent = this.applyTextEdits(currentContent, normalizedEdits);
      const nextHash = this.computeContentHash(nextContent);
      const summary = normalizedEdits.map((edit) => edit.summary);

      if (request.mode === 'preview') {
        return this.cacheWorkspaceResult(request.requestId, this.successResult(
          'workspace_ops',
          context,
          JSON.stringify(
            {
              action: request.action,
              mode: request.mode,
              request_id: request.requestId,
              path,
              summary: `Previewed ${normalizedEdits.length} edit(s) in ${path}.`,
              data: {
                edit_count: normalizedEdits.length,
                current_hash: currentHash,
                next_hash: nextHash,
                applied: false,
                edits: summary,
              },
              conflict: null,
            },
            null,
            2
          ),
          startMs
        ));
      }

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(
        fileUri,
        normalizedEdits.map((entry) => vscode.TextEdit.replace(entry.range, entry.newText))
      );

      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) {
        return this.cacheWorkspaceResult(request.requestId, this.errorResult(
          'workspace_ops',
          context,
          `VS Code rejected edit_file apply for ${path}.`,
          'APPLY_FAILED',
          startMs
        ));
      }

      const refreshedDocument = await vscode.workspace.openTextDocument(fileUri);
      const appliedHash = this.computeContentHash(refreshedDocument.getText());

      return this.cacheWorkspaceResult(request.requestId, this.successResult(
        'workspace_ops',
        context,
        JSON.stringify(
          {
            action: request.action,
            mode: request.mode,
            request_id: request.requestId,
            path,
            summary: `Applied ${normalizedEdits.length} edit(s) to ${path}.`,
            data: {
              edit_count: normalizedEdits.length,
              current_hash: currentHash,
              next_hash: appliedHash,
              applied: true,
              edits: summary,
            },
            conflict: null,
          },
          null,
          2
        ),
        startMs
      ));
    } catch (error) {
      return this.cacheWorkspaceResult(request.requestId, this.errorResult(
        'workspace_ops',
        context,
        `edit_file failed: ${error instanceof Error ? error.message : String(error)}`,
        'EDIT_FAILED',
        startMs
      ));
    }
  }

  private async runCreateFile(
    request: WorkspaceOpsRequest,
    context: ToolContext,
    startMs: number
  ): Promise<ToolResult> {
    try {
      const path = this.requireStringField(request.payload, 'path');
      const content = this.requireStringField(request.payload, 'content');
      const overwrite = this.optionalBooleanField(request.payload, 'overwrite') ?? false;

      const fileUri = this.resolveWorkspacePath(path);
      const existingStat = await this.tryStat(fileUri);
      const exists = Boolean(existingStat);

      if (exists && !overwrite) {
        return this.cacheWorkspaceResult(request.requestId, this.errorResult(
          'workspace_ops',
          context,
          `create_file target already exists: ${path}`,
          'ALREADY_EXISTS',
          startMs
        ));
      }

      const currentVersion = exists && existingStat
        ? await this.computePathVersion(fileUri, existingStat)
        : undefined;

      if (request.mode === 'apply' && exists) {
        const concurrencyError = this.validateConcurrencyGuard(
          request,
          currentVersion ?? '',
          context,
          startMs,
          path
        );
        if (concurrencyError) {
          return this.cacheWorkspaceResult(request.requestId, concurrencyError);
        }
      } else if (currentVersion) {
        const concurrencyError = this.validateConcurrencyGuard(
          request,
          currentVersion,
          context,
          startMs,
          path
        );
        if (concurrencyError) {
          return this.cacheWorkspaceResult(request.requestId, concurrencyError);
        }
      }

      const contentBytes = new TextEncoder().encode(content);
      if (contentBytes.byteLength > HARD_LIMITS.maxWriteFileBytes) {
        return this.errorResult(
          'workspace_ops',
          context,
          `create_file content too large (${contentBytes.byteLength} bytes). Max ${HARD_LIMITS.maxWriteFileBytes} bytes.`,
          'FILE_TOO_LARGE',
          startMs
        );
      }

      if (request.mode === 'preview') {
        return this.cacheWorkspaceResult(request.requestId, this.successResult(
          'workspace_ops',
          context,
          JSON.stringify(
            {
              action: request.action,
              mode: request.mode,
              request_id: request.requestId,
              path,
              summary: `Previewed create_file for ${path}.`,
              data: {
                exists,
                overwrite,
                content_bytes: contentBytes.byteLength,
                applied: false,
              },
              conflict: null,
            },
            null,
            2
          ),
          startMs
        ));
      }

      await this.ensureParentDirectory(fileUri);
      await vscode.workspace.fs.writeFile(fileUri, contentBytes);
      const nextHash = this.computeContentHash(content);

      return this.cacheWorkspaceResult(request.requestId, this.successResult(
        'workspace_ops',
        context,
        JSON.stringify(
          {
            action: request.action,
            mode: request.mode,
            request_id: request.requestId,
            path,
            summary: `Created ${path}.`,
            data: {
              exists,
              overwrite,
              next_hash: nextHash,
              applied: true,
            },
            conflict: null,
          },
          null,
          2
        ),
        startMs
      ));
    } catch (error) {
      return this.cacheWorkspaceResult(request.requestId, this.errorResult(
        'workspace_ops',
        context,
        `create_file failed: ${error instanceof Error ? error.message : String(error)}`,
        'CREATE_FAILED',
        startMs
      ));
    }
  }

  private async runDeletePath(
    request: WorkspaceOpsRequest,
    context: ToolContext,
    startMs: number
  ): Promise<ToolResult> {
    try {
      const path = this.requireStringField(request.payload, 'path');
      const recursive = this.optionalBooleanField(request.payload, 'recursive') ?? false;
      const useTrash = this.optionalBooleanField(request.payload, 'useTrash') ?? false;

      const targetUri = this.resolveWorkspacePath(path);
      const targetStat = await this.tryStat(targetUri);

      if (!targetStat) {
        return this.cacheWorkspaceResult(request.requestId, this.errorResult(
          'workspace_ops',
          context,
          `delete_path target does not exist: ${path}`,
          'ENOENT',
          startMs
        ));
      }

      const targetVersion = await this.computePathVersion(targetUri, targetStat);
      const concurrencyError = this.validateConcurrencyGuard(
        request,
        targetVersion,
        context,
        startMs,
        path
      );
      if (concurrencyError) {
        return this.cacheWorkspaceResult(request.requestId, concurrencyError);
      }

      const isDirectory = targetStat.type === vscode.FileType.Directory;
      if (isDirectory && !recursive) {
        return this.cacheWorkspaceResult(request.requestId, this.errorResult(
          'workspace_ops',
          context,
          `delete_path requires recursive=true for directories: ${path}`,
          'RECURSIVE_REQUIRED',
          startMs
        ));
      }

      if (request.mode === 'preview') {
        return this.cacheWorkspaceResult(request.requestId, this.successResult(
          'workspace_ops',
          context,
          JSON.stringify(
            {
              action: request.action,
              mode: request.mode,
              request_id: request.requestId,
              path,
              summary: `Previewed delete for ${path}.`,
              data: {
                target_type: isDirectory ? 'directory' : 'file',
                recursive,
                use_trash: useTrash,
                applied: false,
              },
              conflict: null,
            },
            null,
            2
          ),
          startMs
        ));
      }

      await vscode.workspace.fs.delete(targetUri, {
        recursive: isDirectory ? true : recursive,
        useTrash,
      });

      return this.cacheWorkspaceResult(request.requestId, this.successResult(
        'workspace_ops',
        context,
        JSON.stringify(
          {
            action: request.action,
            mode: request.mode,
            request_id: request.requestId,
            path,
            summary: `Deleted ${path}.`,
            data: {
              target_type: isDirectory ? 'directory' : 'file',
              recursive,
              use_trash: useTrash,
              applied: true,
            },
            conflict: null,
          },
          null,
          2
        ),
        startMs
      ));
    } catch (error) {
      return this.cacheWorkspaceResult(request.requestId, this.errorResult(
        'workspace_ops',
        context,
        `delete_path failed: ${error instanceof Error ? error.message : String(error)}`,
        'DELETE_FAILED',
        startMs
      ));
    }
  }

  private async runRenamePath(
    request: WorkspaceOpsRequest,
    context: ToolContext,
    startMs: number
  ): Promise<ToolResult> {
    try {
      const oldPath = this.requireStringField(request.payload, 'oldPath');
      const newPath = this.requireStringField(request.payload, 'newPath');
      const overwrite = this.optionalBooleanField(request.payload, 'overwrite') ?? false;

      const oldUri = this.resolveWorkspacePath(oldPath);
      const newUri = this.resolveWorkspacePath(newPath);
      const oldStat = await this.tryStat(oldUri);

      if (!oldStat) {
        return this.cacheWorkspaceResult(request.requestId, this.errorResult(
          'workspace_ops',
          context,
          `rename_path source does not exist: ${oldPath}`,
          'ENOENT',
          startMs
        ));
      }

      const sourceVersion = await this.computePathVersion(oldUri, oldStat);
      const concurrencyError = this.validateConcurrencyGuard(
        request,
        sourceVersion,
        context,
        startMs,
        oldPath
      );
      if (concurrencyError) {
        return this.cacheWorkspaceResult(request.requestId, concurrencyError);
      }

      if (request.mode === 'preview') {
        return this.cacheWorkspaceResult(request.requestId, this.successResult(
          'workspace_ops',
          context,
          JSON.stringify(
            {
              action: request.action,
              mode: request.mode,
              request_id: request.requestId,
              old_path: oldPath,
              new_path: newPath,
              summary: `Previewed rename from ${oldPath} to ${newPath}.`,
              data: {
                overwrite,
                applied: false,
              },
              conflict: null,
            },
            null,
            2
          ),
          startMs
        ));
      }

      await this.ensureParentDirectory(newUri);
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite });

      return this.cacheWorkspaceResult(request.requestId, this.successResult(
        'workspace_ops',
        context,
        JSON.stringify(
          {
            action: request.action,
            mode: request.mode,
            request_id: request.requestId,
            old_path: oldPath,
            new_path: newPath,
            summary: `Renamed ${oldPath} to ${newPath}.`,
            data: {
              overwrite,
              applied: true,
            },
            conflict: null,
          },
          null,
          2
        ),
        startMs
      ));
    } catch (error) {
      return this.cacheWorkspaceResult(request.requestId, this.errorResult(
        'workspace_ops',
        context,
        `rename_path failed: ${error instanceof Error ? error.message : String(error)}`,
        'RENAME_FAILED',
        startMs
      ));
    }
  }

  private parseWorkspaceOpsRequest(rawArgs: Record<string, unknown>): WorkspaceOpsRequest {
    return extractWorkspaceOpsRequest(rawArgs);
  }

  private cacheWorkspaceResult(requestId: string, result: ToolResult): ToolResult {
    const normalizedResult = this.normalizeWorkspaceResult(result, requestId);
    const cachedResult: CachedWorkspaceResult = {
      tool_name: normalizedResult.tool_name,
      status: normalizedResult.status,
      content: normalizedResult.content,
      request_id: normalizedResult.request_id,
      action: normalizedResult.action,
      summary: normalizedResult.summary,
      data: normalizedResult.data,
      conflict: normalizedResult.conflict,
      error_code: normalizedResult.error_code,
      execution_time_ms: normalizedResult.execution_time_ms,
    };

    if (this.workspaceRequestCache.has(requestId)) {
      this.workspaceRequestCache.delete(requestId);
    }

    this.workspaceRequestCache.set(requestId, cachedResult);

    while (this.workspaceRequestCache.size > HARD_LIMITS.maxWorkspaceRequestCache) {
      const oldestKey = this.workspaceRequestCache.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }

      this.workspaceRequestCache.delete(oldestKey);
    }

    return normalizedResult;
  }

  private getCachedWorkspaceResult(
    requestId: string,
    context: ToolContext
  ): ToolResult | null {
    const cached = this.workspaceRequestCache.get(requestId);
    if (!cached) {
      return null;
    }

    return {
      tool_name: cached.tool_name,
      tool_call_id: context.tool_call_id,
      session_id: context.session_id,
      chat_id: context.chat_id,
      message_id: context.message_id,
      request_id: cached.request_id,
      action: cached.action,
      status: cached.status,
      content: cached.content,
      summary: cached.summary,
      data: cached.data,
      conflict: cached.conflict,
      error_code: cached.error_code,
      execution_time_ms: cached.execution_time_ms,
    };
  }

  private requiredStringFromCandidates(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    throw new Error('workspace_ops.request_id is required.');
  }

  private requireWorkspaceOpsAction(value: unknown): WorkspaceOpsAction {
    return normalizeWorkspaceOpsAction(value) as WorkspaceOpsAction;
  }

  private parseWorkspaceOpsMode(value: unknown): WorkspaceOpsMode {
    return parseWorkspaceOpsModeContract(value) as WorkspaceOpsMode;
  }

  private validateConcurrencyGuard(
    request: WorkspaceOpsRequest,
    currentVersion: string,
    context: ToolContext,
    startMs: number,
    targetLabel: string
  ): ToolResult | null {
    const expectedHash = request.expectedHash?.trim();
    const expectedVersion = request.expectedVersion?.trim();

    if (expectedHash && expectedVersion && expectedHash !== expectedVersion) {
      return buildWorkspaceConflictResult({
        request,
        context,
        startMs,
        errorCode: 'CONFLICTING_CONCURRENCY_GUARDS',
        summary: `Conflicting concurrency guards for ${targetLabel}: expected_hash and expected_version do not match.`,
        conflict: {
          target: targetLabel,
          expected_hash: expectedHash,
          expected_version: expectedVersion,
          current_version: currentVersion,
        },
      });
    }

    const expected = expectedHash ?? expectedVersion;
    if (!expected) {
      if (request.mode === 'apply') {
        return buildWorkspaceConflictResult({
          request,
          context,
          startMs,
          errorCode: 'MISSING_CONCURRENCY_GUARD',
          summary: `${request.action} requires expected_hash or expected_version before apply.`,
          conflict: {
            target: targetLabel,
            expected_hash: null,
            expected_version: null,
            current_version: currentVersion,
          },
        });
      }

      return null;
    }

    if (expected !== currentVersion) {
      return buildWorkspaceConflictResult({
        request,
        context,
        startMs,
        errorCode: 'HASH_CONFLICT',
        summary: `Concurrency conflict for ${targetLabel}. expected=${expected} actual=${currentVersion}`,
        conflict: {
          target: targetLabel,
          expected_version: expected,
          current_version: currentVersion,
        },
      });
    }

    return null;
  }

  private async computePathVersion(
    pathUri: vscode.Uri,
    fileStat: vscode.FileStat
  ): Promise<string> {
    if (fileStat.type === vscode.FileType.Directory) {
      const entries = await vscode.workspace.fs.readDirectory(pathUri);
      const normalizedEntries = entries
        .map(([name, type]) => `${name}:${type}`)
        .sort((left, right) => left.localeCompare(right))
        .join('|');
      return this.computeContentHash(normalizedEntries);
    }

    const fileBytes = await vscode.workspace.fs.readFile(pathUri);
    return this.computeContentHash(new TextDecoder().decode(fileBytes));
  }

  private normalizeTextEdit(
    entry: unknown,
    index: number,
    document: vscode.TextDocument
  ): NormalizedTextEdit {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Edit at index ${index} must be an object.`);
    }

    const edit = entry as Record<string, unknown>;
    const startLine = this.requireIntegerField(edit, 'startLine', index);
    const startCol = this.requireIntegerField(edit, 'startCol', index);
    const endLine = this.requireIntegerField(edit, 'endLine', index);
    const endCol = this.requireIntegerField(edit, 'endCol', index);
    const text = this.optionalStringField(edit, 'text')
      || this.optionalStringField(edit, 'newText')
      || this.optionalStringField(edit, 'replacementText');
    if (text === undefined) {
      throw new Error(`Missing or invalid string field: text in edit ${index}`);
    }

    const start = this.validatePosition(document, startLine, startCol, index, 'start');
    const end = this.validatePosition(document, endLine, endCol, index, 'end');

    if (document.offsetAt(start) > document.offsetAt(end)) {
      throw new Error(`Edit at index ${index} has start position after end position.`);
    }

    return {
      range: new vscode.Range(start, end),
      newText: text,
      startOffset: document.offsetAt(start),
      endOffset: document.offsetAt(end),
      summary: {
        startLine,
        startCol,
        endLine,
        endCol,
        textLength: text.length,
      },
    };
  }

  private findOverlappingEdit(edits: NormalizedTextEdit[]): string | null {
    const ordered = [...edits].sort((left, right) => {
      if (left.startOffset !== right.startOffset) {
        return left.startOffset - right.startOffset;
      }

      return left.endOffset - right.endOffset;
    });

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (current.startOffset < previous.endOffset) {
        return 'Overlapping edit ranges are not allowed in edit_file.';
      }
    }

    return null;
  }

  private applyTextEdits(content: string, edits: NormalizedTextEdit[]): string {
    const ordered = [...edits].sort((left, right) => {
      if (left.startOffset !== right.startOffset) {
        return right.startOffset - left.startOffset;
      }

      return right.endOffset - left.endOffset;
    });

    let updated = content;
    for (const edit of ordered) {
      updated = `${updated.slice(0, edit.startOffset)}${edit.newText}${updated.slice(edit.endOffset)}`;
    }

    return updated;
  }

  private computeContentHash(content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    const unsignedHash = hash >>> 0;
    return `fnv1a-${unsignedHash.toString(16).padStart(8, '0')}-${content.length}`;
  }

  private validatePosition(
    document: vscode.TextDocument,
    line: number,
    col: number,
    editIndex: number,
    positionLabel: 'start' | 'end'
  ): vscode.Position {
    if (line < 1 || line > document.lineCount) {
      throw new Error(
        `Edit at index ${editIndex} has invalid ${positionLabel}Line=${line}. File has ${document.lineCount} lines.`
      );
    }

    const zeroBasedLine = line - 1;
    const zeroBasedCol = col - 1;
    const lineText = document.lineAt(zeroBasedLine).text;

    if (zeroBasedCol < 0 || zeroBasedCol > lineText.length) {
      throw new Error(
        `Edit at index ${editIndex} has invalid ${positionLabel}Col=${col} for line ${line}.`
      );
    }

    return new vscode.Position(zeroBasedLine, zeroBasedCol);
  }

  private requireArrayField(
    source: Record<string, unknown>,
    fieldName: string
  ): unknown[] {
    const value = source[fieldName];
    if (!Array.isArray(value)) {
      throw new Error(`Missing or invalid array field: ${fieldName}`);
    }

    return value;
  }

  private requireIntegerField(
    source: Record<string, unknown>,
    fieldName: string,
    editIndex?: number
  ): number {
    const value = source[fieldName];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      const suffix = typeof editIndex === 'number' ? ` in edit ${editIndex}` : '';
      throw new Error(`Missing or invalid integer field: ${fieldName}${suffix}`);
    }

    return value;
  }

  private optionalIntegerField(
    source: Record<string, unknown>,
    fieldName: string
  ): number | undefined {
    const value = source[fieldName];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`Invalid integer field: ${fieldName}`);
    }

    return value;
  }

  private requireStringField(
    source: Record<string, unknown>,
    fieldName: string,
    editIndex?: number
  ): string {
    const value = source[fieldName];
    if (typeof value !== 'string') {
      const suffix = typeof editIndex === 'number' ? ` in edit ${editIndex}` : '';
      throw new Error(`Missing or invalid string field: ${fieldName}${suffix}`);
    }

    return value;
  }

  private optionalStringField(
    source: Record<string, unknown>,
    fieldName: string
  ): string | undefined {
    const value = source[fieldName];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new Error(`Invalid string field: ${fieldName}`);
    }

    return value;
  }

  private optionalBooleanField(
    source: Record<string, unknown>,
    fieldName: string
  ): boolean | undefined {
    const value = source[fieldName];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'boolean') {
      throw new Error(`Invalid boolean field: ${fieldName}`);
    }

    return value;
  }

  private optionalObjectArg(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private optionalStringFromUnknown(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    return value;
  }

  private async tryStat(pathUri: vscode.Uri): Promise<vscode.FileStat | null> {
    try {
      return await vscode.workspace.fs.stat(pathUri);
    } catch {
      return null;
    }
  }

  private async ensureParentDirectory(fileUri: vscode.Uri): Promise<void> {
    const lastSlash = Math.max(fileUri.path.lastIndexOf('/'), fileUri.path.lastIndexOf('\\'));
    if (lastSlash <= 0) {
      return;
    }

    const parentPath = fileUri.path.slice(0, lastSlash);
    const parentUri = fileUri.with({ path: parentPath });
    await vscode.workspace.fs.createDirectory(parentUri);
  }

  private withToolName(
    result: ToolResult,
    toolName: ToolResult['tool_name'],
    envelope?: WorkspaceResultEnvelope
  ): ToolResult {
    return {
      ...result,
      tool_name: toolName,
      request_id: envelope?.requestId ?? result.request_id,
      action: envelope?.action ?? result.action,
      summary: envelope?.summary ?? result.summary,
      data: envelope?.data ?? result.data,
      conflict: envelope?.conflict ?? result.conflict ?? null,
    };
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
      summary: content,
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
      summary: content,
      error_code: errorCode,
      execution_time_ms: Date.now() - startMs,
    };
  }

  private normalizeWorkspaceResult(result: ToolResult, fallbackRequestId?: string): ToolResult {
    const parsed = this.parseStructuredWorkspaceResult(result.content);
    return {
      ...result,
      request_id: result.request_id ?? parsed?.request_id ?? fallbackRequestId,
      action: result.action ?? parsed?.action,
      summary: result.summary ?? parsed?.summary ?? this.summarizeContent(result.content),
      data: result.data ?? parsed?.data,
      conflict: result.conflict ?? parsed?.conflict ?? null,
    };
  }

  private parseStructuredWorkspaceResult(content: string): WorkspaceResultEnvelope | null {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const envelope: WorkspaceResultEnvelope = {};
      if (typeof parsed.request_id === 'string') {
        envelope.request_id = parsed.request_id;
      }
      if (typeof parsed.action === 'string') {
        envelope.action = parsed.action;
      }
      if (typeof parsed.summary === 'string') {
        envelope.summary = parsed.summary;
      }
      if ('data' in parsed) {
        envelope.data = parsed.data;
      }
      if ('conflict' in parsed) {
        envelope.conflict = parsed.conflict as Record<string, unknown> | null;
      }

      return Object.keys(envelope).length > 0 ? envelope : null;
    } catch {
      return null;
    }
  }

  private summarizeContent(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  }

}
