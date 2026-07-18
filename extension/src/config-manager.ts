import * as vscode from 'vscode';

export interface VertexConfig {
  llmBaseUrl: string;
  llmModel: string;
  llmKey: string;
  exaKey: string;
  llmReasoningEnabled: boolean;
  llmReasoningEffort: string;
}

export class ConfigManager {
  /**
   * Maximum total time (ms) to wait for SecretStorage to become available after
   * VS Code starts. The OS keychain can take several seconds to unlock on login.
   */
  private static readonly SECRET_STORAGE_READY_TIMEOUT_MS = 6000;

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Polls SecretStorage for the given key until it returns a non-empty value or
   * the timeout elapses. Uses exponential backoff starting at 200ms.
   * Returns the value if found, or an empty string if the timeout expires.
   */
  private async waitForSecret(key: string): Promise<string> {
    const deadline = Date.now() + ConfigManager.SECRET_STORAGE_READY_TIMEOUT_MS;
    let delay = 200;

    // First attempt immediately — fast path for the common case.
    const initial = await this.context.secrets.get(key);
    if (initial) {
      return initial;
    }

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const value = await this.context.secrets.get(key);
      if (value) {
        return value;
      }
      // Exponential backoff capped at 1 second between attempts.
      delay = Math.min(delay * 2, 1000);
    }

    return '';
  }

  public async getConfig(): Promise<VertexConfig> {
    const config = vscode.workspace.getConfiguration('vertexSwarm');
    
    // Default to DeepSeek if not provided
    const llmBaseUrl = config.get<string>('llmBaseUrl') || 'https://api.deepseek.com/v1';
    const llmModel = config.get<string>('llmModel') || 'deepseek-v4-pro';
    const llmReasoningEnabled = config.get<boolean>('llmReasoningEnabled', true);
    const llmReasoningEffort = config.get<string>('llmReasoningEffort') || 'medium';
    
    // Read secrets directly — no retry here; callers that need startup resilience
    // should go through hasValidConfig() first, which uses waitForSecret().
    const llmKey = await this.context.secrets.get('llm_key') || '';
    const exaKey = await this.context.secrets.get('exa_key') || '';

    return {
      llmBaseUrl,
      llmModel,
      llmKey,
      exaKey,
      llmReasoningEnabled,
      llmReasoningEffort,
    };
  }

  /**
   * Returns true only if a non-empty LLM key is stored. On startup, blocks
   * (with exponential backoff) until SecretStorage is ready or the timeout
   * elapses, preventing the spurious "Configure Provider" flash.
   */
  public async hasValidConfig(): Promise<boolean> {
    const llmKey = await this.waitForSecret('llm_key');
    return llmKey.trim().length > 0;
  }

  public async updateConfig(updates: Partial<VertexConfig>): Promise<void> {
    const config = vscode.workspace.getConfiguration('vertexSwarm');

    if (updates.llmBaseUrl !== undefined) {
      await config.update('llmBaseUrl', updates.llmBaseUrl, vscode.ConfigurationTarget.Global);
    }
    
    if (updates.llmModel !== undefined) {
      await config.update('llmModel', updates.llmModel, vscode.ConfigurationTarget.Global);
    }

    if (updates.llmKey !== undefined) {
      await this.context.secrets.store('llm_key', updates.llmKey.trim());
    }

    if (updates.exaKey !== undefined) {
      await this.context.secrets.store('exa_key', updates.exaKey.trim());
    }
  }
}
