import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import type { ToolContext, ToolResult } from '../types/index';
import {
  buildConflictResult as buildWorkspaceConflictResult,
  extractWorkspaceOpsRequest,
  normalizeWorkspaceOpsAction,
  parseWorkspaceOpsMode as parseWorkspaceOpsModeContract,
} from './workspace-ops-contract.mjs';

const FALLBACK_EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/__pycache__/**,**/.venv/**,**/venv/**}';

const DEFAULT_SEARCH_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
];

const SEARCH_TEXT_LIMITS = {
  maxResults: 20,
  maxSearchCalls: 2,
  timeoutMs: 20_000,
  maxSynonymTerms: 2,
};

const RG_MAX_BUFFER_BYTES = 2_000_000;

const HARD_LIMITS = {
  maxFileReadBytes: 1_000_000,
  maxPaginatedRangeLines: 200,
  maxGrepFileScanBytes: 500_000,
  maxFindFilesBeforeFallbackExclude: 5_000,
  maxEditOperations: 500,
  maxWriteFileBytes: 1_000_000,
  maxWorkspaceRequestCache: 1_000,
  maxBulkReadFiles: 5,
  maxBulkReadBytes: 100_000,
};

type WorkspaceOpsAction =
  | 'list_dir'
  | 'search_text'
  | 'read_file'
  | 'bulk_files_read'
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
  requestId?: string;
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

interface SearchTextRequest {
  query: string;
  multipleQueries?: string[];  // LLM-provided additional search queries to batch together
  filePattern: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  caseSensitive: boolean;
  exactMatch: boolean;
  useRegex: boolean;  // Enable regex pattern matching instead of fixed-string search
  maxResults: number;
  maxSearchCalls: number;
  timeoutMs: number;
  variantsEnabled: boolean;
  maxSynonymTerms: number;
  includeSearchPlan: boolean;
}

interface SearchExecutionResult {
  toolResult: ToolResult;
  backendUsed: 'shell_bundled' | 'shell_system' | 'manual_scan';
  fallbackReason?: string;
}

interface RipgrepExecutionAttempt {
  status: 'success' | 'fallback';
  result?: ToolResult;
  backendUsed?: 'shell_bundled' | 'shell_system';
  reason?: string;
}

interface RipgrepCommandResolution {
  command: string;
  backendUsed: 'shell_bundled' | 'shell_system';
}

interface RipgrepResolutionAttempt {
  resolution?: RipgrepCommandResolution;
  reason?: string;
}

interface SearchPassMetadata {
  passNumber: number;
  query: string;
  resultCount: number;
  timeElapsedMs: number;
  namingForms?: string[];  // The naming convention variants tried (e.g., ["max_tokens", "maxTokens", "max tokens"])
  timedOut?: boolean;
}

interface SearchPassResult {
  metadata: SearchPassMetadata;
  hits: string[];
}

type ExecFileError = NodeJS.ErrnoException & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

interface ExecFileCommandResult {
  stdout: string;
  stderr: string;
  error: ExecFileError | null;
  timedOut: boolean;
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
    searchRequest: SearchTextRequest,
    context: ToolContext
  ): Promise<SearchExecutionResult> {
    const startMs = Date.now();

    const ripgrepAttempt = await this.trySearchWithRipgrep(searchRequest, context, startMs);
    if (ripgrepAttempt.status === 'success' && ripgrepAttempt.result && ripgrepAttempt.backendUsed) {
      return {
        toolResult: ripgrepAttempt.result,
        backendUsed: ripgrepAttempt.backendUsed,
      };
    }

    const manualResult = await this.grep_workspace_manual(searchRequest, context, startMs);
    return {
      toolResult: manualResult,
      backendUsed: 'manual_scan',
      fallbackReason: ripgrepAttempt.reason,
    };
  }

  private async grep_workspace_manual(
    searchRequest: SearchTextRequest,
    context: ToolContext,
    startMs: number
  ): Promise<ToolResult> {
    try {
      const includePatterns = [
        searchRequest.filePattern,
        ...searchRequest.includeGlobs,
      ].filter((value, index, collection) => collection.indexOf(value) === index)
        .slice(0, searchRequest.maxSearchCalls);
      const excludePattern = this.toBraceGlob(searchRequest.excludeGlobs);
      const dedupedFiles = new Map<string, vscode.Uri>();

      for (const includePattern of includePatterns) {
        const foundFiles = await vscode.workspace.findFiles(includePattern, excludePattern);
        for (const foundFile of foundFiles) {
          dedupedFiles.set(foundFile.fsPath.toLowerCase(), foundFile);
        }
      }

      let files = [...dedupedFiles.values()];
      if (files.length > HARD_LIMITS.maxFindFilesBeforeFallbackExclude) {
        const fallbackExcludePattern = this.toBraceGlob([
          ...searchRequest.excludeGlobs,
          ...DEFAULT_SEARCH_EXCLUDE_GLOBS,
        ]) || FALLBACK_EXCLUDE;
        const fallbackFiles = new Map<string, vscode.Uri>();

        for (const includePattern of includePatterns) {
          const foundFiles = await vscode.workspace.findFiles(includePattern, fallbackExcludePattern);
          for (const foundFile of foundFiles) {
            fallbackFiles.set(foundFile.fsPath.toLowerCase(), foundFile);
          }
        }

        files = [...fallbackFiles.values()];
      }

      const queryList = this.buildQueryList(searchRequest);
      const searchPasses = queryList.map((queryText, index) => {
        const namingForms = searchRequest.variantsEnabled
          ? this.generateSearchVariants(queryText)
          : [queryText];
        const queryNeedles = searchRequest.caseSensitive
            ? namingForms
            : namingForms.map((term) => term.toLowerCase());

        return {
          metadata: {
            passNumber: index + 1,
            query: queryText,
            resultCount: 0,
            timeElapsedMs: 0,
            namingForms,
          } as SearchPassMetadata,
          queryNeedles,
          hits: [] as string[],
        };
      });

      const timeoutAt = startMs + searchRequest.timeoutMs;
      let timedOut = false;
      let totalCollectedHits = 0;
      const globallySeenHits = new Set<string>();
      const searchStart = Date.now();

      for (const fileUri of files) {
        if (totalCollectedHits >= searchRequest.maxResults) {
          break;
        }
        if (Date.now() >= timeoutAt) {
          timedOut = true;
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
          if (Date.now() >= timeoutAt) {
            timedOut = true;
            break;
          }

          const lineText = lines[lineIndex];
          const relativePath = vscode.workspace.asRelativePath(fileUri, false);
          const formattedHit = `${relativePath}:${lineIndex + 1}: ${lineText.trim().slice(0, 150)}`;
          const dedupeKey = `${relativePath}:${lineIndex + 1}`;

          for (const searchPass of searchPasses) {
            if (!this.containsAnySearchQuery(lineText, searchPass.queryNeedles, searchRequest.caseSensitive)) {
              continue;
            }

            if (globallySeenHits.has(dedupeKey)) {
              break;
            }

            globallySeenHits.add(dedupeKey);
            searchPass.hits.push(formattedHit);
            totalCollectedHits += 1;
            break;
          }

          if (totalCollectedHits >= searchRequest.maxResults) {
            break;
          }
        }

        if (timedOut) {
          break;
        }
      }

      const timeElapsed = Date.now() - searchStart;
      const passResults: SearchPassResult[] = searchPasses.map((searchPass) => {
        const metadata: SearchPassMetadata = {
          ...searchPass.metadata,
          resultCount: searchPass.hits.length,
          timeElapsedMs: timeElapsed,
          timedOut: timedOut || undefined,
        };
        return {
          metadata,
          hits: searchPass.hits,
        };
      });

      const content = this.formatSearchContent(
        searchRequest,
        queryList,
        passResults,
        timedOut
      );

      const resultObj = this.successResult('grep_workspace', context, content, startMs);
      resultObj.data = {
        pass_count: passResults.length,
        passes: passResults.map((passResult) => passResult.metadata),
      };

      return resultObj;
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

  private async trySearchWithRipgrep(
    searchRequest: SearchTextRequest,
    context: ToolContext,
    startMs: number
  ): Promise<RipgrepExecutionAttempt> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return {
          status: 'fallback',
          reason: 'Ripgrep skipped because no workspace folder is open.',
        };
      }

      const includePatterns = [
        searchRequest.filePattern,
        ...searchRequest.includeGlobs,
      ].filter((value, index, collection) => collection.indexOf(value) === index)
        .slice(0, searchRequest.maxSearchCalls);

      const resolutionAttempt = await this.resolveRipgrepCommand(workspaceFolders[0].uri.fsPath);
      if (!resolutionAttempt.resolution) {
        return {
          status: 'fallback',
          reason: resolutionAttempt.reason ?? 'No usable ripgrep binary was found.',
        };
      }
      const resolution = resolutionAttempt.resolution;

      const queryList = this.buildQueryList(searchRequest);
      const timeoutAt = startMs + searchRequest.timeoutMs;
      
      const seenSearchHits = new Set<string>();
      let maxResultsExceeded = false;

      // Execute all ripgrep passes in parallel
      const passPromises = queryList.map((queryText, index) =>
        this.executeRipgrepPass(
          queryText,
          index + 1,  // passNumber
          searchRequest,
          includePatterns,
          resolution,
          workspaceFolders[0].uri.fsPath,
          timeoutAt
        )
      );

      const passResults = await Promise.allSettled(passPromises);

      for (const passResult of passResults) {
        if (passResult.status === 'rejected') {
          const reason = passResult.reason instanceof Error
            ? passResult.reason.message
            : String(passResult.reason);
          return {
            status: 'fallback',
            reason: `Ripgrep pass failed: ${reason}`,
          };
        }
      }

      // Collect results and metadata
      const orderedPassResults: SearchPassResult[] = [];
      for (const result of passResults) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        orderedPassResults.push(result.value);
      }

      orderedPassResults.sort((left, right) => left.metadata.passNumber - right.metadata.passNumber);

      const dedupedLocationKeys = new Set<string>();
      let remainingHits = searchRequest.maxResults;
      for (const passResult of orderedPassResults) {
        const dedupedHits: string[] = [];
        for (const hit of passResult.hits) {
          if (remainingHits <= 0) {
            break;
          }

          const locationKey = hit.substring(0, hit.lastIndexOf(':'));
          if (dedupedLocationKeys.has(locationKey)) {
            continue;
          }

          dedupedLocationKeys.add(locationKey);
          dedupedHits.push(hit);
          remainingHits -= 1;
        }

        passResult.hits = dedupedHits;
        passResult.metadata.resultCount = dedupedHits.length;
      }

      const timedOut = orderedPassResults.some((passResult) => Boolean(passResult.metadata.timedOut));
      const content = this.formatSearchContent(
        searchRequest,
        queryList,
        orderedPassResults,
        timedOut
      );

      const resultObj = this.successResult('grep_workspace', context, content, startMs);
      resultObj.data = {
        pass_count: orderedPassResults.length,
        passes: orderedPassResults.map((passResult) => passResult.metadata),
      };

      return {
        status: 'success',
        backendUsed: resolution.backendUsed,
        result: resultObj,
      };
    } catch (error) {
      return {
        status: 'fallback',
        reason: `Ripgrep search failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async executeRipgrepPass(
    semanticVariant: string,
    passNumber: number,
    searchRequest: SearchTextRequest,
    includePatterns: string[],
    resolution: RipgrepCommandResolution,
    workspaceRootPath: string,
    timeoutAt: number
  ): Promise<{ metadata: SearchPassMetadata; hits: string[] }> {
    const passStart = Date.now();

    // Check if already timed out
    if (Date.now() >= timeoutAt) {
      return {
        metadata: {
          passNumber,
          query: semanticVariant,
          resultCount: 0,
          timeElapsedMs: 0,
          timedOut: true,
        },
        hits: [],
      };
    }

    const namingVariants = searchRequest.variantsEnabled
      ? this.generateSearchVariants(semanticVariant)
      : [semanticVariant];

    const rgArgs = this.buildRipgrepArgs(searchRequest, includePatterns, namingVariants);

    const remainingTime = Math.max(1000, timeoutAt - Date.now());
    const execResult = await this.execFileCommand(
      resolution.command,
      rgArgs,
      workspaceRootPath,
      remainingTime
    );

    const timeElapsed = Date.now() - passStart;
    const errorCode = this.execErrorCode(execResult.error);

    if (execResult.timedOut) {
      return {
        metadata: {
          passNumber,
          query: semanticVariant,
          resultCount: 0,
          timeElapsedMs: timeElapsed,
          timedOut: true,
        },
        hits: [],
      };
    }

    if (typeof errorCode === 'string' && errorCode === 'ENOENT') {
      throw new Error('Ripgrep binary was not found on PATH.');
    }

    if (errorCode !== undefined && errorCode !== 1) {
      const stderrPreview = execResult.stderr.trim();
      throw new Error(
        stderrPreview
          ? `Ripgrep failed: ${stderrPreview}`
          : `Ripgrep failed with code ${String(errorCode)}.`
      );
    }

    const hits = this.parseRipgrepOutput(execResult.stdout, searchRequest.maxResults);

    return {
      metadata: {
        passNumber,
        query: semanticVariant,
        resultCount: hits.length,
        timeElapsedMs: timeElapsed,
        namingForms: namingVariants,
      },
      hits,
    };
  }

  private buildRipgrepArgs(
    searchRequest: SearchTextRequest,
    includePatterns: string[],
    queryTerms?: string[]
  ): string[] {
    const args = [
      '--no-heading',
      '--line-number',
      '--color',
      'never',
      '--max-count',
      String(searchRequest.maxResults),
    ];

    if (!searchRequest.caseSensitive) {
      args.push('--ignore-case');
    }

    // Disable --fixed-strings when regex mode is enabled
    if (!searchRequest.useRegex) {
      args.push('--fixed-strings');
    }

    for (const includePattern of includePatterns) {
      if (includePattern && includePattern !== '**/*') {
        args.push('--glob', includePattern);
      }
    }

    for (const excludeGlob of searchRequest.excludeGlobs) {
      args.push('--glob', `!${excludeGlob}`);
    }

    const terms = queryTerms && queryTerms.length > 0
      ? queryTerms
      : [searchRequest.query];
    for (const term of terms) {
      args.push('-e', term);
    }

    args.push('.');
    return args;
  }

  private async resolveRipgrepCommand(cwd: string): Promise<RipgrepResolutionAttempt> {
    const bundledCandidates = this.getBundledRipgrepCandidates();

    for (const bundledCandidate of bundledCandidates) {
      const exists = await this.pathExists(bundledCandidate);
      if (!exists) {
        continue;
      }

      const bundledProbe = await this.execFileCommand(
        bundledCandidate,
        ['--version'],
        cwd,
        1_500
      );

      if (!bundledProbe.error && !bundledProbe.timedOut) {
        return {
          resolution: {
            command: bundledCandidate,
            backendUsed: 'shell_bundled',
          },
        };
      }
    }

    const systemProbe = await this.execFileCommand('rg', ['--version'], cwd, 1_500);
    if (!systemProbe.error && !systemProbe.timedOut) {
      return {
        resolution: {
          command: 'rg',
          backendUsed: 'shell_system',
        },
      };
    }

    return {
      reason: bundledCandidates.length > 0
        ? 'Bundled ripgrep binary is not available, and system rg is not installed on PATH.'
        : 'No bundled ripgrep path candidates found, and system rg is not installed on PATH.',
    };
  }

  private getBundledRipgrepCandidates(): string[] {
    const extensionRoot = this.getCurrentExtensionRootPath();
    if (!extensionRoot) {
      return [];
    }

    const extensionUri = vscode.Uri.file(extensionRoot);
    const executableName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const platformArch = `${process.platform}-${process.arch}`;

    const candidates = [
      vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'ripgrep', 'bin', executableName).fsPath,
      vscode.Uri.joinPath(extensionUri, 'bin', platformArch, executableName).fsPath,
      vscode.Uri.joinPath(extensionUri, 'bin', process.platform, executableName).fsPath,
      vscode.Uri.joinPath(extensionUri, 'bin', executableName).fsPath,
      vscode.Uri.joinPath(extensionUri, 'dist', 'bin', platformArch, executableName).fsPath,
      vscode.Uri.joinPath(extensionUri, 'dist', 'bin', executableName).fsPath,
    ];

    return candidates.filter((candidate, index, collection) =>
      collection.indexOf(candidate) === index
    );
  }

  private getCurrentExtensionRootPath(): string | undefined {
    const extension = vscode.extensions.all.find((entry) => {
      const packageJson = entry.packageJSON as { name?: unknown };
      return packageJson.name === 'vertex-swarm-extension';
    });

    return extension?.extensionUri.fsPath;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }

  private async execFileCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<ExecFileCommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: RG_MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          const execError = (error as ExecFileError | null) ?? null;
          const timedOut = Boolean(execError?.killed) && execError?.signal === 'SIGTERM';
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: execError,
            timedOut,
          });
        }
      );
    });
  }

  private execErrorCode(error: ExecFileError | null): string | number | undefined {
    if (!error) {
      return undefined;
    }

    return error.code;
  }

  private generateSearchVariants(baseQuery: string): string[] {
    // Generate naming convention variants: snake_case ↔ camelCase ↔ space-separated
    // Input: "northstar" or "north_star" or "north star"
    // Output: all 3 forms
    const variants: string[] = [];
    const seen = new Set<string>();
    
    // Add original
    if (!seen.has(baseQuery.toLowerCase())) {
      variants.push(baseQuery);
      seen.add(baseQuery.toLowerCase());
    }

    // Convert to snake_case
    const snakeCase = baseQuery
      .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase to snake_case
      .replace(/\s+/g, '_')  // spaces to underscores
      .toLowerCase();
    if (snakeCase !== baseQuery && !seen.has(snakeCase)) {
      variants.push(snakeCase);
      seen.add(snakeCase);
    }

    // Convert to camelCase
    const camelCase = baseQuery
      .split(/[_\s]+/)
      .map((part, i) => i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
    if (camelCase !== baseQuery && !seen.has(camelCase.toLowerCase())) {
      variants.push(camelCase);
      seen.add(camelCase.toLowerCase());
    }

    // Convert to space-separated
    const spaceSeparated = baseQuery
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase to space
      .replace(/_/g, ' ')  // underscores to spaces
      .toLowerCase();
    if (spaceSeparated !== baseQuery && !seen.has(spaceSeparated.toLowerCase())) {
      variants.push(spaceSeparated);
      seen.add(spaceSeparated.toLowerCase());
    }

    return variants;
  }

  private parseRipgrepOutput(stdout: string, maxResults: number): string[] {
    const parsedResults: string[] = [];
    const seen = new Set<string>();

    for (const rawLine of stdout.split(/\r?\n/)) {
      if (!rawLine.trim()) {
        continue;
      }

      const match = rawLine.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        continue;
      }

      const path = match[1];
      const lineNumber = match[2];
      const snippet = match[3].trim().slice(0, 150);
      const formatted = `${path}:${lineNumber}: ${snippet}`;
      if (seen.has(formatted)) {
        continue;
      }

      seen.add(formatted);
      parsedResults.push(formatted);
      if (parsedResults.length >= maxResults) {
        break;
      }
    }

    return parsedResults;
  }

  private async read_file_paginated(
    filePath: string,
    startLine: number,
    endLine: number,
    context: ToolContext
  ): Promise<ToolResult & { current_hash?: string; total_lines?: number }> {
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

      const document = await vscode.workspace.openTextDocument(fileUri);
      const fullContent = document.getText();
      const fileLines = fullContent.split(/\r?\n/);
      const sliceStart = Math.max(0, startLine - 1);
      const sliceEnd = Math.min(endLine, fileLines.length);
      const content = fileLines.slice(sliceStart, sliceEnd).join('\n');

      // Compute hash over the FULL file content so the LLM can use it as
      // expected_hash in a subsequent edit_file call.
      const currentHash = this.computeContentHash(fullContent);

      return {
        ...this.successResult('read_file_paginated', context, content, startMs),
        current_hash: currentHash,
        total_lines: fileLines.length,
      };
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

  private async read_files_bulk(
    paths: string[],
    context: ToolContext
  ): Promise<ToolResult & { files?: any[]; truncated?: boolean }> {
    const startMs = Date.now();
    try {
      if (!Array.isArray(paths)) {
        return this.errorResult(
          'read_files_bulk',
          context,
          'paths must be an array of strings.',
          'INVALID_PATHS',
          startMs
        );
      }
      if (paths.length > HARD_LIMITS.maxBulkReadFiles) {
        return this.errorResult(
          'read_files_bulk',
          context,
          `Requested ${paths.length} files exceeds ${HARD_LIMITS.maxBulkReadFiles} limit.`,
          'TOO_MANY_FILES',
          startMs
        );
      }

      let totalBytes = 0;
      let truncated = false;
      const files: any[] = [];

      for (const path of paths) {
        if (typeof path !== 'string') continue;
        const fileUri = this.resolveWorkspacePath(path);
        try {
          const stat = await vscode.workspace.fs.stat(fileUri);
          if (stat.type !== vscode.FileType.File) {
            files.push({ path, status: 'error', error: 'Not a file' });
            continue;
          }
          if (totalBytes + stat.size > HARD_LIMITS.maxBulkReadBytes) {
            truncated = true;
            files.push({ path, status: 'error', error: `Skipped due to ${HARD_LIMITS.maxBulkReadBytes} bytes limit.` });
            continue;
          }
          const document = await vscode.workspace.openTextDocument(fileUri);
          const content = document.getText();
          totalBytes += stat.size;

          files.push({
            path,
            content,
            current_hash: this.computeContentHash(content),
            total_lines: content.split(/\r?\n/).length,
            status: 'success'
          });
        } catch (e) {
          files.push({ path, status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      }

      return {
        ...this.successResult('read_files_bulk', context, JSON.stringify({ files, truncated }), startMs),
        files,
        truncated
      };
    } catch (error) {
      return this.errorResult(
        'read_files_bulk',
        context,
        `Read files failed: ${error instanceof Error ? error.message : String(error)}`,
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
          const searchRequest = this.parseSearchTextPayload(request.payload);
          const searchExecution = await this.grep_workspace(searchRequest, context);
          const result = searchExecution.toolResult;
          const existingData = this.optionalObjectArg(result.data) ?? {};
          return this.cacheWorkspaceResult(
            request.requestId,
            this.withToolName(result, 'workspace_ops', {
              requestId: request.requestId,
              action: request.action,
              summary: `Searched for "${searchRequest.query}" in ${searchRequest.filePattern}.`,
              data: {
                ...existingData,
                backendUsed: searchExecution.backendUsed,
                fallbackReason: searchExecution.fallbackReason ?? null,
                query: searchRequest.query,
                filePattern: searchRequest.filePattern,
                includeGlobs: searchRequest.includeGlobs,
                excludeGlobs: searchRequest.excludeGlobs,
                caseSensitive: searchRequest.caseSensitive,
                exactMatch: searchRequest.exactMatch,
                maxResults: searchRequest.maxResults,
                maxSearchCalls: searchRequest.maxSearchCalls,
                timeoutMs: searchRequest.timeoutMs,
                variantsEnabled: searchRequest.variantsEnabled,
                maxSynonymTerms: searchRequest.maxSynonymTerms,
                includeSearchPlan: searchRequest.includeSearchPlan,
              },
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
              // current_hash MUST be included here so the LLM can pass it as
              // expected_hash in a subsequent edit_file call.
              data: {
                path,
                startLine,
                endLine,
                total_lines: result.total_lines ?? null,
                current_hash: result.current_hash ?? null,
              },
            })
          );
        }

        case 'bulk_files_read': {
          const paths = this.requireArrayField(request.payload, 'paths');
          const result = await this.read_files_bulk(paths as string[], context);
          return this.cacheWorkspaceResult(
            request.requestId,
            this.withToolName(result, 'workspace_ops', {
              requestId: request.requestId,
              action: request.action,
              summary: `Read ${paths.length} files.`,
              data: {
                files: result.files ?? [],
                truncated: result.truncated ?? false,
              },
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

      const normalizedEdits: NormalizedTextEdit[] = [];
      for (let index = 0; index < rawEdits.length; index++) {
        const edits = this.normalizeTextEdits(rawEdits[index], index, document);
        normalizedEdits.push(...edits);
      }

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
      await refreshedDocument.save();
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
      const filesPayload = request.payload.files as Array<{ path: string, content?: string }> | undefined;
      let filesToCreate: Array<{ path: string, content?: string }> = [];

      // Support legacy single file format and new multiple files format
      if (filesPayload && Array.isArray(filesPayload)) {
        for (const file of filesPayload) {
          if (!file || typeof file.path !== 'string') {
            return this.errorResult('workspace_ops', context, 'Each item in "files" array must be an object with a "path" string property.', 'INVALID_FILES', startMs);
          }
        }
        filesToCreate = filesPayload;
      } else {
        const legacyPath = this.requireStringField(request.payload, 'path');
        const legacyContent = this.optionalStringField(request.payload, 'content');
        filesToCreate = [{ path: legacyPath, content: legacyContent }];
      }

      const overwrite = this.optionalBooleanField(request.payload, 'overwrite') ?? false;

      if (filesToCreate.length === 0) {
        return this.errorResult('workspace_ops', context, 'create_file requires at least one file or folder to create.', 'INVALID_FILES', startMs);
      }

      let fileCount = 0;
      let folderCount = 0;

      for (const file of filesToCreate) {
        const isFolder = file.content === undefined || file.content === null || file.path.endsWith('/') || file.path.endsWith('\\');
        if (isFolder) {
          folderCount++;
        } else {
          fileCount++;
        }
      }

      if (fileCount > 5) {
        return this.errorResult('workspace_ops', context, `create_file limit exceeded: max 5 files per turn, but ${fileCount} requested.`, 'LIMIT_EXCEEDED', startMs);
      }

      if (folderCount > 1) {
        return this.errorResult('workspace_ops', context, `create_file limit exceeded: max 1 folder per turn, but ${folderCount} requested.`, 'LIMIT_EXCEEDED', startMs);
      }

      const resultsData: any[] = [];
      let totalBytes = 0;

      for (const file of filesToCreate) {
        const fileUri = this.resolveWorkspacePath(file.path);
        const existingStat = await this.tryStat(fileUri);
        const exists = Boolean(existingStat);

        if (exists && !overwrite) {
          return this.cacheWorkspaceResult(request.requestId, this.errorResult(
            'workspace_ops',
            context,
            `create_file target already exists: ${file.path}`,
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
            file.path
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
            file.path
          );
          if (concurrencyError) {
            return this.cacheWorkspaceResult(request.requestId, concurrencyError);
          }
        }

        const isFolder = file.content === undefined || file.content === null || file.path.endsWith('/') || file.path.endsWith('\\');
        
        if (!isFolder) {
            const contentBytes = new TextEncoder().encode(file.content ?? '');
            totalBytes += contentBytes.byteLength;
            if (contentBytes.byteLength > HARD_LIMITS.maxWriteFileBytes) {
              return this.errorResult(
                'workspace_ops',
                context,
                `create_file content for ${file.path} is too large (${contentBytes.byteLength} bytes). Max ${HARD_LIMITS.maxWriteFileBytes} bytes.`,
                'FILE_TOO_LARGE',
                startMs
              );
            }
        }
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
              summary: `Previewed create_file for ${filesToCreate.length} item(s).`,
              data: {
                count: filesToCreate.length,
                overwrite,
                total_bytes: totalBytes,
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

      for (const file of filesToCreate) {
        const fileUri = this.resolveWorkspacePath(file.path);
        const isFolder = file.content === undefined || file.content === null || file.path.endsWith('/') || file.path.endsWith('\\');

        if (isFolder) {
            await vscode.workspace.fs.createDirectory(fileUri);
            resultsData.push({ path: file.path, type: 'folder', applied: true });
        } else {
            await this.ensureParentDirectory(fileUri);
            const contentBytes = new TextEncoder().encode(file.content ?? '');
            await vscode.workspace.fs.writeFile(fileUri, contentBytes);
            const nextHash = this.computeContentHash(file.content ?? '');
            resultsData.push({ path: file.path, type: 'file', next_hash: nextHash, applied: true });
        }
      }

      return this.cacheWorkspaceResult(request.requestId, this.successResult(
        'workspace_ops',
        context,
        JSON.stringify(
          {
            action: request.action,
            mode: request.mode,
            request_id: request.requestId,
            summary: `Created ${filesToCreate.length} item(s).`,
            data: {
              items: resultsData,
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
    const request = extractWorkspaceOpsRequest(rawArgs);
    return {
      action: request.action as WorkspaceOpsAction,
      requestId: request.requestId,
      mode: request.mode as WorkspaceOpsMode,
      payload: request.payload,
      expectedHash: request.expectedHash,
      expectedVersion: request.expectedVersion,
    };
  }

  private parseSearchTextPayload(payload: Record<string, unknown>): SearchTextRequest {
    const query = this.requireStringField(payload, 'query').trim();
    if (!query) {
      throw new Error('search_text query cannot be empty.');
    }

    const multipleQueries = this.optionalStringArrayField(payload, 'multiple_queries') ?? this.optionalStringArrayField(payload, 'variants');
    const filePattern = this.optionalStringField(payload, 'filePattern')?.trim() || '**/*';
    const includeGlobs = this.optionalStringArrayField(payload, 'includeGlobs') ?? [];
    const excludeGlobs = this.optionalStringArrayField(payload, 'excludeGlobs')
      ?? [...DEFAULT_SEARCH_EXCLUDE_GLOBS];
    const caseSensitive = this.optionalBooleanField(payload, 'caseSensitive') ?? false;
    const exactMatch = this.optionalBooleanField(payload, 'exactMatch') ?? false;
    const useRegex = this.optionalBooleanField(payload, 'useRegex') ?? false;
    const requestedVariantsEnabled = this.optionalBooleanField(payload, 'variantsEnabled');
    const variantsEnabled = exactMatch ? false : (requestedVariantsEnabled ?? true);
    const maxResults = this.clampPositiveInteger(
      this.optionalIntegerField(payload, 'maxResults'),
      SEARCH_TEXT_LIMITS.maxResults,
      SEARCH_TEXT_LIMITS.maxResults
    );
    const maxSearchCalls = this.clampPositiveInteger(
      this.optionalIntegerField(payload, 'maxSearchCalls'),
      SEARCH_TEXT_LIMITS.maxSearchCalls,
      SEARCH_TEXT_LIMITS.maxSearchCalls
    );
    const timeoutMs = this.clampPositiveInteger(
      this.optionalIntegerField(payload, 'timeoutMs'),
      SEARCH_TEXT_LIMITS.timeoutMs,
      SEARCH_TEXT_LIMITS.timeoutMs
    );
    const maxSynonymTerms = this.clampPositiveInteger(
      this.optionalIntegerField(payload, 'maxSynonymTerms'),
      SEARCH_TEXT_LIMITS.maxSynonymTerms,
      SEARCH_TEXT_LIMITS.maxSynonymTerms
    );
    const includeSearchPlan = this.optionalBooleanField(payload, 'includeSearchPlan') ?? true;

    return {
      query,
      multipleQueries,
      filePattern,
      includeGlobs,
      excludeGlobs,
      caseSensitive,
      exactMatch,
      useRegex,
      maxResults,
      maxSearchCalls,
      timeoutMs,
      variantsEnabled,
      maxSynonymTerms,
      includeSearchPlan,
    };
  }

  private clampPositiveInteger(
    requestedValue: number | undefined,
    defaultValue: number,
    maxValue: number
  ): number {
    const candidate = requestedValue ?? defaultValue;
    const boundedMinimum = candidate < 1 ? 1 : candidate;
    return boundedMinimum > maxValue ? maxValue : boundedMinimum;
  }

  private buildQueryList(searchRequest: SearchTextRequest): string[] {
    const query = searchRequest.query.trim();
    const queryList: string[] = [query];
    if (!searchRequest.variantsEnabled) {
      return queryList;
    }

    const seen = new Set<string>([query.toLowerCase()]);
    for (const rawQuery of searchRequest.multipleQueries ?? []) {
      const q = rawQuery.trim();
      if (!q) {
        continue;
      }

      const normalizedQ = q.toLowerCase();
      if (seen.has(normalizedQ)) {
        continue;
      }

      queryList.push(q);
      seen.add(normalizedQ);

      if (queryList.length >= searchRequest.maxSynonymTerms + 1) {
        break;
      }
    }

    return queryList;
  }

  private formatSearchContent(
    searchRequest: SearchTextRequest,
    queryList: string[],
    passResults: SearchPassResult[],
    timedOut: boolean
  ): string {
    const hasAnyHits = passResults.some((passResult) => passResult.hits.length > 0);
    if (!hasAnyHits) {
      return `No results for "${queryList.join(', ')}"${timedOut ? ` (timeout ${searchRequest.timeoutMs}ms)` : ''}`;
    }

    if (!searchRequest.includeSearchPlan) {
      const compactHits: string[] = [];
      for (const passResult of passResults) {
        for (const hit of passResult.hits) {
          compactHits.push(hit);
        }
      }
      return compactHits.join('\n');
    }

    const outputLines: string[] = [];
    outputLines.push(`SEARCH_QUERY: ${searchRequest.query}`);
    const extras = queryList.slice(1);
    if (extras.length > 0) {
      outputLines.push(`ADDITIONAL_QUERIES: ${extras.join(' | ')}`);
    }

    for (const passResult of passResults) {
      const passType = `QUERY_${passResult.metadata.passNumber}`;
      outputLines.push('');
      outputLines.push(`${passType}="${passResult.metadata.query}" hits=${passResult.hits.length}`);

      if (passResult.metadata.namingForms && passResult.metadata.namingForms.length > 0) {
        outputLines.push(`naming_forms=${passResult.metadata.namingForms.join(' | ')}`);
      }

      for (const hit of passResult.hits) {
        outputLines.push(hit);
      }
    }

    if (timedOut) {
      outputLines.push('');
      outputLines.push(`TIMEOUT: search stopped after ${searchRequest.timeoutMs}ms.`);
    }

    return outputLines.join('\n');
  }

  private containsSearchQuery(lineText: string, queryNeedle: string, caseSensitive: boolean): boolean {
    if (caseSensitive) {
      return lineText.includes(queryNeedle);
    }

    return lineText.toLowerCase().includes(queryNeedle);
  }

  private containsAnySearchQuery(
    lineText: string,
    queryNeedles: string[],
    caseSensitive: boolean
  ): boolean {
    for (const queryNeedle of queryNeedles) {
      if (this.containsSearchQuery(lineText, queryNeedle, caseSensitive)) {
        return true;
      }
    }

    return false;
  }

  private toBraceGlob(patterns: string[]): string | undefined {
    if (patterns.length === 0) {
      return undefined;
    }

    return `{${patterns.join(',')}}`;
  }

  private cacheWorkspaceResult(requestId: string, result: ToolResult): ToolResult {
    const normalizedResult = this.normalizeWorkspaceResult(result, requestId);
    
    // Do not cache errors. This ensures that if the LLM makes a syntax mistake and retries
    // with the same request_id but corrected arguments, it actually executes the operation
    // instead of instantly returning the cached error.
    if (normalizedResult.status === 'error') {
      return normalizedResult;
    }

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
      }) as ToolResult;
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
        }) as ToolResult;
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
      }) as ToolResult;
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

  private normalizeTextEdits(
    entry: unknown,
    index: number,
    document: vscode.TextDocument
  ): NormalizedTextEdit[] {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Edit at index ${index} must be an object.`);
    }

    const edit = entry as Record<string, unknown>;
    const startLine = this.requireIntegerField(edit, 'startLine', index);
    const endLine = this.requireIntegerField(edit, 'endLine', index);
    const targetContent = this.requireStringField(edit, 'targetContent');
    const replacementContent = this.requireStringField(edit, 'replacementContent');
    const allowMultiple = edit.allowMultiple === true;

    const startPos = new vscode.Position(startLine - 1, 0);
    const endPos = document.lineAt(Math.min(endLine - 1, document.lineCount - 1)).range.end;
    const searchRange = new vscode.Range(startPos, endPos);
    
    const searchAreaText = document.getText(searchRange);

    const normalizedSearchArea = searchAreaText.replace(/\r\n/g, '\n');
    let normalizedTarget = targetContent.replace(/\r\n/g, '\n');
    let normalizedReplacement = replacementContent;

    if (normalizedTarget === '') {
      throw new Error(`Edit at index ${index} has an empty targetContent.`);
    }

    const fileUsesTabs = /^\t/m.test(searchAreaText);
    const targetUsesTabs = /^\t/m.test(normalizedTarget);
    
    if (fileUsesTabs && !targetUsesTabs) {
      normalizedTarget = normalizedTarget.replace(/^( {2,8})/gm, (match) => '\t'.repeat(Math.max(1, Math.floor(match.length / 4))));
      normalizedReplacement = normalizedReplacement.replace(/^( {2,8})/gm, (match) => '\t'.repeat(Math.max(1, Math.floor(match.length / 4))));
    } else if (!fileUsesTabs && targetUsesTabs) {
      normalizedTarget = normalizedTarget.replace(/^\t+/gm, (match) => '    '.repeat(match.length));
      normalizedReplacement = normalizedReplacement.replace(/^\t+/gm, (match) => '    '.repeat(match.length));
    }

    let matches: number[] = [];
    let currentIndex = normalizedSearchArea.indexOf(normalizedTarget);
    while (currentIndex !== -1) {
      matches.push(currentIndex);
      currentIndex = normalizedSearchArea.indexOf(normalizedTarget, currentIndex + 1);
    }

    if (matches.length === 0) {
      // Trick 1: Whitespace-Agnostic Matching Fallback
      const strippedSearchArea = normalizedSearchArea.replace(/\s+/g, '');
      const strippedTarget = normalizedTarget.replace(/\s+/g, '');
      
      if (strippedTarget === '') {
        throw new Error(`Edit ${index} failed: 'targetContent' only contains whitespace.`);
      }

      let strippedMatchIndex = strippedSearchArea.indexOf(strippedTarget);
      
      if (strippedMatchIndex !== -1) {
        // Find all matches in the stripped string
        const strippedMatches: number[] = [];
        let currIdx = strippedMatchIndex;
        while (currIdx !== -1) {
          strippedMatches.push(currIdx);
          currIdx = strippedSearchArea.indexOf(strippedTarget, currIdx + 1);
        }

        if (strippedMatches.length > 1 && !allowMultiple) {
          throw new Error(`Edit ${index} failed: Found ${strippedMatches.length} occurrences of 'targetContent' (ignoring whitespace). Make it more unique or set allowMultiple: true.`);
        }

        // Map stripped indices back to original indices
        const mapStrippedToOriginal: number[] = [];
        for (let i = 0; i < normalizedSearchArea.length; i++) {
          if (!/\s/.test(normalizedSearchArea[i])) {
            mapStrippedToOriginal.push(i);
          }
        }

        const editsToApply: NormalizedTextEdit[] = [];
        for (const sMatch of strippedMatches) {
          const originalStartIndex = mapStrippedToOriginal[sMatch];
          const strippedEndIndex = sMatch + strippedTarget.length - 1;
          const originalEndIndex = mapStrippedToOriginal[strippedEndIndex];
          
          const textBeforeMatch = normalizedSearchArea.substring(0, originalStartIndex);
          const linesBefore = textBeforeMatch.split('\n');
          const lineOffset = linesBefore.length - 1;
          const charOffset = linesBefore[linesBefore.length - 1].length;

          const matchStartPos = new vscode.Position(
            startPos.line + lineOffset, 
            lineOffset === 0 ? startPos.character + charOffset : charOffset
          );

          const matchedText = normalizedSearchArea.substring(originalStartIndex, originalEndIndex + 1);
          const matchedLines = matchedText.split('\n');
          const targetLineCount = matchedLines.length - 1;
          const targetCharOffset = matchedLines[matchedLines.length - 1].length;

          let matchEndPos: vscode.Position;
          if (targetLineCount === 0) {
            matchEndPos = new vscode.Position(matchStartPos.line, matchStartPos.character + targetCharOffset);
          } else {
            matchEndPos = new vscode.Position(matchStartPos.line + targetLineCount, targetCharOffset);
          }

          editsToApply.push({
            range: new vscode.Range(matchStartPos, matchEndPos),
            newText: normalizedReplacement,
            startOffset: document.offsetAt(matchStartPos),
            endOffset: document.offsetAt(matchEndPos),
            summary: {
              startLine: matchStartPos.line + 1,
              startCol: matchStartPos.character + 1,
              endLine: matchEndPos.line + 1,
              endCol: matchEndPos.character + 1,
              textLength: normalizedReplacement.length,
            },
          });
        }
        
        return editsToApply;
      }

      throw new Error(`Edit ${index} failed: 'targetContent' not found between lines ${startLine}-${endLine}. Check exact string matching.`);
    }

    if (matches.length > 1 && !allowMultiple) {
      throw new Error(`Edit ${index} failed: Found ${matches.length} occurrences of 'targetContent'. Make it more unique or set allowMultiple: true.`);
    }

    const editsToApply: NormalizedTextEdit[] = [];
    
    for (const matchIndex of matches) {
      const textBeforeMatch = normalizedSearchArea.substring(0, matchIndex);
      const linesBefore = textBeforeMatch.split('\n');
      const lineOffset = linesBefore.length - 1;
      const charOffset = linesBefore[linesBefore.length - 1].length;

      const targetLines = normalizedTarget.split('\n');
      const targetLineCount = targetLines.length - 1;
      const targetCharOffset = targetLines[targetLines.length - 1].length;

      const matchStartPos = new vscode.Position(
        startPos.line + lineOffset, 
        lineOffset === 0 ? startPos.character + charOffset : charOffset
      );
      
      let matchEndPos: vscode.Position;
      if (targetLineCount === 0) {
        matchEndPos = new vscode.Position(matchStartPos.line, matchStartPos.character + targetCharOffset);
      } else {
        matchEndPos = new vscode.Position(matchStartPos.line + targetLineCount, targetCharOffset);
      }

      editsToApply.push({
        range: new vscode.Range(matchStartPos, matchEndPos),
        newText: normalizedReplacement,
        startOffset: document.offsetAt(matchStartPos),
        endOffset: document.offsetAt(matchEndPos),
        summary: {
          startLine: matchStartPos.line + 1,
          startCol: matchStartPos.character + 1,
          endLine: matchEndPos.line + 1,
          endCol: matchEndPos.character + 1,
          textLength: normalizedReplacement.length,
        },
      });
    }

    return editsToApply;
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

  private optionalStringArrayField(
    source: Record<string, unknown>,
    fieldName: string
  ): string[] | undefined {
    const value = source[fieldName];
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`Invalid string array field: ${fieldName}`);
    }

    return value
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
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
      request_id: envelope?.requestId ?? envelope?.request_id ?? result.request_id,
      action: envelope?.action ?? result.action,
      summary: envelope?.summary ?? result.summary,
      data: envelope?.data ?? result.data,
      conflict: envelope?.conflict ?? result.conflict ?? null,
    };
  }

  public resolveWorkspacePath(inputPath: string): vscode.Uri {
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
