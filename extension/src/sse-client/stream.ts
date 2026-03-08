import { SessionEvent } from '../types/index.js';

/**
 * SSEStreamClient: Opens EventSource connection to backend
 * Parses server-sent events and relays them to Webview via postMessage
 */
export class SSEStreamClient {
  private eventSource: EventSource | null = null;
  private isConnected = false;
  private abortController: AbortController | null = null;

  constructor(
    private readonly backendUrl: string,
    private readonly token: string,
    private readonly onEvent: (event: SessionEvent) => void,
    private readonly onError: (error: string) => void,
    private readonly onClose: () => void
  ) {}

  /**
   * Open SSE connection to backend stream endpoint
   */
  async openStream(sessionId: string): Promise<void> {
    try {
      const streamUrl = `${this.backendUrl}/api/v1/sessions/${sessionId}/stream`;
      this.abortController = new AbortController();

      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
        },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(await this.buildErrorMessage(response));
      }

      this.isConnected = true;
      await this.parseStreamResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('SSE stream error:', errorMessage);
      this.onError(errorMessage);
      this.cleanup();
    }
  }

  async openChatStream(chatId: string, message: string): Promise<void> {
    try {
      const streamUrl = `${this.backendUrl}/api/v1/chats/${chatId}/messages`;
      this.abortController = new AbortController();

      const response = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: message }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(await this.buildErrorMessage(response));
      }

      this.isConnected = true;
      await this.parseStreamResponse(response);
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
  private async parseStreamResponse(response: Response): Promise<void> {
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

          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.substring(6));
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
      this.cleanup();
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
      this.cleanup();
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
      typeof eventData.toolName === 'string' ? eventData.toolName : undefined;
    const args =
      eventData.args && typeof eventData.args === 'object'
        ? (eventData.args as Record<string, unknown>)
        : undefined;
    const metadata =
      eventData.metadata && typeof eventData.metadata === 'object'
        ? {
            ...(eventData.metadata as Record<string, unknown>),
            ...(toolName ? { toolName } : {}),
            ...(args ? { args } : {}),
            ...(rawType === 'token' ? { appendMode: 'token' } : {}),
          }
        : {
            ...(toolName ? { toolName } : {}),
            ...(args ? { args } : {}),
            ...(rawType === 'token' ? { appendMode: 'token' } : {}),
          };
    const content =
      typeof eventData.content === 'string'
        ? eventData.content
        : type === 'tool_call' && toolName
          ? `Calling ${toolName}${args ? ` with ${JSON.stringify(args)}` : ''}`
          : '';

    return {
      id: typeof eventData.id === 'string' ? eventData.id : `evt-${Date.now()}`,
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
