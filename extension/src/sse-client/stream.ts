import { SessionEvent, ExtensionMessage } from '../types/index.js';

/**
 * SSEStreamClient: Opens EventSource connection to backend
 * Parses server-sent events and relays them to Webview via postMessage
 */
export class SSEStreamClient {
  private eventSource: EventSource | null = null;
  private isConnected = false;

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

      // Fetch API with EventSource (Node.js doesn't have EventSource, use native fetch)
      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'text/event-stream',
        },
      });

      if (!response.ok) {
        throw new Error(`Stream connection failed: ${response.statusText}`);
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
              const event: SessionEvent = {
                id: eventData.id || `evt-${Date.now()}`,
                type: eventData.type || 'status',
                content: eventData.content || '',
                timestamp: eventData.timestamp || Date.now(),
                metadata: eventData.metadata,
              };
              this.onEvent(event);
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
  async cancelStream(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.backendUrl}/api/v1/sessions/${sessionId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
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
}
