import { SessionEvent, type RequestContextPayload } from '../types/index.js';

/**
 * SSEStreamClient: Opens EventSource connection to backend
 * Parses server-sent events and relays them to Webview via postMessage
 */
export class SSEStreamClient {
  private eventSource: EventSource | null = null;
  private isConnected = false;
  private abortController: AbortController | null = null;
  private eventCounter = 0;

  constructor(
    private readonly backendUrl: string,
    private readonly token: string,
    private readonly onEvent: (event: SessionEvent) => void,
    private readonly onError: (error: string) => void,
    private readonly onClose: () => void
  ) {}

  async openChatStream(
    chatId: string,
    message: string,
    workspaceSkeleton?: string,
    ideContextEnabled?: boolean,
    requestContext?: RequestContextPayload
  ): Promise<void> {
    try {
      const postUrl = `${this.backendUrl}/api/v1/chats/${chatId}/messages`;
      this.abortController = new AbortController();

      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: message,
          ide_context_enabled: Boolean(ideContextEnabled),
          ...(workspaceSkeleton ? { workspace_skeleton: workspaceSkeleton } : {}),
          ...(requestContext ? { request_context: requestContext } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(await this.buildErrorMessage(response));
      }
      
      const responseData = await response.json() as { message_id?: string };
      const messageId = responseData.message_id;
      if (!messageId) {
        throw new Error('No message_id returned from POST');
      }

      this.isConnected = true;
      let lastEventId = '0';
      
      const connectStream = async () => {
        if (!this.isConnected || this.abortController?.signal.aborted) return;
        
        try {
          const streamResponse = await fetch(`${this.backendUrl}/api/v1/chats/${chatId}/messages/${messageId}/stream`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'text/event-stream',
              'Last-Event-ID': lastEventId,
            },
            signal: this.abortController?.signal,
          });

          if (!streamResponse.ok) {
            throw new Error(await this.buildErrorMessage(streamResponse));
          }

          let doneEventReceived = false;
          await this.parseStreamResponse(streamResponse, (id) => { lastEventId = id; }, () => { doneEventReceived = true; });
          
          if (!doneEventReceived && this.isConnected && !this.abortController?.signal.aborted) {
            console.log("Stream ended unexpectedly, reconnecting...");
            setTimeout(connectStream, 1000);
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'AbortError') return;
          if (this.isConnected && !this.abortController?.signal.aborted) {
            console.error("Stream fetch error, reconnecting:", e);
            setTimeout(connectStream, 2000);
          }
        }
      };
      
      await connectStream();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.cleanup();
        this.onClose();
        return;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('SSE stream error:', errorMessage);
      this.onError(errorMessage);
      this.cleanup();
    }
  }

  /**
   * Parse server-sent events from response body
   */
  private async parseStreamResponse(response: Response, onId?: (id: string) => void, onDone?: () => void): Promise<void> {
    if (!response.body) {
      throw new Error('Response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this.onClose();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Keep last incomplete line in buffer
        buffer = lines[lines.length - 1];

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();

          if (line === '') {
            // Empty line marks end of event
            continue;
          }
          
          if (line.startsWith('id: ')) {
            if (onId) onId(line.substring(4).trim());
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.substring(6));
              if (
                eventData &&
                typeof eventData === 'object' &&
                eventData.type === 'done'
              ) {
                if (onDone) onDone();
                await reader.cancel().catch(() => undefined);
                this.cleanup();
                this.onClose();
                return;
              }

              const normalizedEvent = this.normalizeEvent(eventData);
              if (normalizedEvent) {
                this.onEvent(normalizedEvent);
              }
            } catch (parseError) {
              console.error('Failed to parse event:', parseError);
            }
          }
        }
      }
    } finally {
      // Don't auto-cleanup on normal close, so reconnect can happen if needed
    }
  }

  /**
   * Cancel stream by sending cancel request, then close
   */
  async cancelStream(_sessionId: string): Promise<void> {
    try {
      this.abortController?.abort();
    } catch (error) {
      console.error('Failed to send cancel request:', error);
    } finally {
      // Don't auto-cleanup on normal close, so reconnect can happen if needed
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.abortController = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.isConnected = false;
  }

  /**
   * Check if stream is active
   */
  isActive(): boolean {
    return this.isConnected;
  }

  private async buildErrorMessage(response: Response): Promise<string> {
    const fallback = `Stream connection failed: ${response.status} ${response.statusText}`;

    try {
      const bodyText = await response.text();
      if (!bodyText) {
        return fallback;
      }

      const parsed = JSON.parse(bodyText) as { detail?: string };
      if (parsed.detail) {
        return `Stream connection failed: ${response.status} ${parsed.detail}`;
      }

      return `${fallback} - ${bodyText}`;
    } catch {
      return fallback;
    }
  }

  private normalizeEvent(eventData: Record<string, unknown>): SessionEvent | null {
    const rawType = typeof eventData.type === 'string' ? eventData.type : 'status';
    if (rawType === 'done') {
      return null;
    }

    const normalizedType =
      rawType === 'token'
        ? 'output'
        : rawType;
    const type: SessionEvent['type'] = this.isKnownEventType(normalizedType)
      ? normalizedType
      : 'status';
    const toolName =
      typeof eventData.toolName === 'string'
        ? eventData.toolName
        : typeof eventData.tool_name === 'string'
          ? eventData.tool_name
          : undefined;
    const toolCallId =
      typeof eventData.tool_call_id === 'string'
        ? eventData.tool_call_id
        : typeof eventData.toolCallId === 'string'
          ? eventData.toolCallId
          : undefined;
    const sessionId =
      typeof eventData.session_id === 'string'
        ? eventData.session_id
        : typeof eventData.sessionId === 'string'
          ? eventData.sessionId
          : undefined;
    const chatId =
      typeof eventData.chat_id === 'string'
        ? eventData.chat_id
        : typeof eventData.chatId === 'string'
          ? eventData.chatId
          : undefined;
    const messageId =
      typeof eventData.message_id === 'string'
        ? eventData.message_id
        : typeof eventData.messageId === 'string'
          ? eventData.messageId
          : undefined;
    const args =
      eventData.args && typeof eventData.args === 'object'
        ? (eventData.args as Record<string, unknown>)
        : undefined;
    const requestId =
      typeof eventData.request_id === 'string'
        ? eventData.request_id
        : typeof eventData.requestId === 'string'
          ? eventData.requestId
          : undefined;
    const action =
      typeof eventData.action === 'string'
        ? eventData.action
        : undefined;
    const summary =
      typeof eventData.summary === 'string'
        ? eventData.summary
        : undefined;
    const conflict =
      eventData.conflict && typeof eventData.conflict === 'object'
        ? (eventData.conflict as Record<string, unknown>)
        : undefined;
    const metadata = {
      ...(eventData.metadata && typeof eventData.metadata === 'object'
        ? (eventData.metadata as Record<string, unknown>)
        : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(args ? { args } : {}),
      ...(typeof eventData.status === 'string' ? { status: eventData.status } : {}),
      ...(typeof eventData.execution_time_ms === 'number'
        ? { execution_time_ms: eventData.execution_time_ms }
        : {}),
      ...(typeof eventData.error_code === 'string'
        ? { error_code: eventData.error_code }
        : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(action ? { action } : {}),
      ...(summary ? { summary } : {}),
      ...(typeof eventData.data !== 'undefined' ? { data: eventData.data } : {}),
      ...(conflict ? { conflict } : {}),
      ...(rawType === 'token' ? { appendMode: 'token' } : {}),
    };
    const content =
      typeof eventData.content === 'string'
        ? eventData.content
        : type === 'tool_call' && toolName
          ? `Calling ${toolName}${args ? ` with ${JSON.stringify(args)}` : ''}`
          : '';

    return {
      id:
        typeof eventData.id === 'string'
          ? eventData.id
          : `evt-${Date.now()}-${++this.eventCounter}`,
      type,
      content,
      timestamp:
        typeof eventData.timestamp === 'number' ? eventData.timestamp : Date.now(),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  private isKnownEventType(value: string): value is SessionEvent['type'] {
    return [
      'thinking',
      'code',
      'output',
      'error',
      'status',
      'tool_call',
      'tool_result',
    ].includes(value);
  }
}
