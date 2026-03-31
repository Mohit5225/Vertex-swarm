import * as vscode from 'vscode';
import { TokenManager } from './token-manager';
import { OAuthHandler } from './oauth-handler';
import { VertexSwarmChatRuntime } from './chat-runtime';
import { createRequestContext } from './request-context';
import type {
  ExtensionToWebviewMessage,
  RequestContextPayload,
  RequestContextSelection,
  SessionEvent,
} from './types/index';

const DEFAULT_IDE_CONTEXT_ENABLED = false;

interface ActiveParticipantRequest {
  stream: vscode.ChatResponseStream;
  resolve: () => void;
}

export class VertexSwarmChatParticipant {
  public static readonly participantId = 'vertex-swarm.participant';

  private readonly runtime: VertexSwarmChatRuntime;
  private activeRequest: ActiveParticipantRequest | null = null;

  constructor(
    context: vscode.ExtensionContext,
    tokenManager: TokenManager,
    oauthHandler: OAuthHandler,
    outputChannel: vscode.OutputChannel
  ) {
    this.runtime = new VertexSwarmChatRuntime({
      tokenManager,
      oauthHandler,
      context,
      outputChannel,
      postMessage: (message: object) => this.handleRuntimeMessage(message),
    });
  }

  public async handleRequest(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> {
    const prompt = request.prompt?.trim();
    if (!prompt) {
      stream.markdown('Please enter a prompt.');
      return;
    }

    if (this.activeRequest) {
      stream.markdown('Vertex Swarm is already processing another request.');
      return;
    }

    let resolveRequest: (() => void) | null = null;
    const donePromise = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });

    this.activeRequest = {
      stream,
      resolve: resolveRequest as () => void,
    };

    const cancelDisposable = token.onCancellationRequested(() => {
      void this.runtime.handleWebviewMessage({
        type: 'cancel-stream',
        payload: { sessionId: '' },
      });
      this.completeActiveRequest();
    });

    try {
      stream.progress('Vertex Swarm is thinking...');
      await this.runtime.handleWebviewMessage({
        type: 'start-stream',
        payload: {
          message: prompt,
          ideContextEnabled: DEFAULT_IDE_CONTEXT_ENABLED,
          requestContext: this.buildRequestContext(),
        },
      });
      await donePromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.markdown(`Vertex Swarm failed: ${message}`);
    } finally {
      cancelDisposable.dispose();
      this.completeActiveRequest();
    }
  }

  private handleRuntimeMessage(message: object): void {
    const activeRequest = this.activeRequest;
    if (!activeRequest) {
      return;
    }

    const runtimeMessage = message as ExtensionToWebviewMessage;

    switch (runtimeMessage.type) {
      case 'event':
        this.handleSessionEvent(runtimeMessage.payload, activeRequest.stream);
        break;
      case 'error':
        activeRequest.stream.markdown(`Vertex Swarm error: ${runtimeMessage.payload}`);
        this.completeActiveRequest();
        break;
      case 'logged-out':
        activeRequest.stream.markdown('Vertex Swarm is signed out. Open the sidebar to sign in.');
        this.completeActiveRequest();
        break;
      case 'cancel-stream':
        this.completeActiveRequest();
        break;
      default:
        break;
    }
  }

  private handleSessionEvent(event: SessionEvent, stream: vscode.ChatResponseStream): void {
    switch (event.type) {
      case 'output':
      case 'code':
        if (event.content) {
          stream.markdown(event.content);
        }
        break;
      case 'thinking':
      case 'status':
        stream.progress(event.content || 'Working...');
        break;
      case 'tool_call':
        stream.progress(this.describeToolCall(event.metadata));
        break;
      case 'tool_result':
        stream.progress(this.describeToolResult(event.metadata));
        break;
      case 'error':
        stream.markdown(`Vertex Swarm error: ${event.content}`);
        break;
      default:
        if (event.content) {
          stream.markdown(event.content);
        }
        break;
    }
  }

  private describeToolCall(metadata?: Record<string, unknown>): string {
    const toolName = this.readMetadataString(metadata, 'tool_name')
      || this.readMetadataString(metadata, 'toolName');
    const action = this.readMetadataString(metadata, 'action');
    return toolName
      ? action
        ? `Running ${toolName} (${action})...`
        : `Running ${toolName}...`
      : 'Running tool...';
  }

  private describeToolResult(metadata?: Record<string, unknown>): string {
    const toolName = this.readMetadataString(metadata, 'tool_name')
      || this.readMetadataString(metadata, 'toolName');
    const status = this.readMetadataString(metadata, 'status');
    const summary = this.readMetadataString(metadata, 'summary');
    const conflict = metadata?.conflict;
    if (toolName && status) {
      if (summary) {
        return `${toolName} finished with status ${status}. ${summary}`;
      }

      if (conflict && typeof conflict === 'object') {
        return `${toolName} finished with status ${status}. Conflict detected.`;
      }

      return `${toolName} finished with status ${status}.`;
    }
    if (toolName) {
      return `${toolName} finished.`;
    }
    return 'Tool finished.';
  }

  private readMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string
  ): string | undefined {
    if (!metadata) {
      return undefined;
    }
    const value = metadata[key];
    return typeof value === 'string' ? value : undefined;
  }

  private buildRequestContext(): RequestContextPayload | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    const activeTerminal = vscode.window.activeTerminal;
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) =>
      vscode.workspace.asRelativePath(folder.uri, false)
    ) ?? [];

    const activeFile = activeEditor
      ? {
          path: vscode.workspace.asRelativePath(activeEditor.document.uri, false),
          languageId: activeEditor.document.languageId,
          selection: this.buildSelectionContext(activeEditor),
        }
      : undefined;

    const terminalContext = activeTerminal
      ? {
          name: activeTerminal.name,
        }
      : undefined;

    if (!activeFile && !terminalContext && workspaceFolders.length === 0) {
      return undefined;
    }

    return createRequestContext({
      ...(activeFile ? { activeFile } : {}),
      ...(terminalContext ? { activeTerminal: terminalContext } : {}),
      ...(workspaceFolders.length > 0 ? { workspaceFolders } : {}),
    });
  }

  private buildSelectionContext(editor: vscode.TextEditor): RequestContextSelection | undefined {
    const { selection } = editor;
    const selectedText = editor.document.getText(selection).trim();
    if (!selectedText) {
      return undefined;
    }

    return {
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
      text: selectedText.slice(0, 2000),
    };
  }

  private completeActiveRequest(): void {
    if (!this.activeRequest) {
      return;
    }

    const { resolve } = this.activeRequest;
    this.activeRequest = null;
    resolve();
  }
}
