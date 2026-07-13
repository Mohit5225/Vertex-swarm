import * as vscode from 'vscode';

export interface VertexConfig {
  llmBaseUrl: string;
  llmModel: string;
  llmKey: string;
  exaKey: string;
}

export class ConfigManager {
  constructor(private context: vscode.ExtensionContext) {}

  public async getConfig(): Promise<VertexConfig> {
    const config = vscode.workspace.getConfiguration('vertexSwarm');
    
    // Default to DeepSeek if not provided
    const llmBaseUrl = config.get<string>('llmBaseUrl') || 'https://api.deepseek.com/v1';
    const llmModel = config.get<string>('llmModel') || 'deepseek-chat';
    
    const llmKey = await this.context.secrets.get('llm_key') || '';
    const exaKey = await this.context.secrets.get('exa_key') || '';

    return {
      llmBaseUrl,
      llmModel,
      llmKey,
      exaKey
    };
  }

  public async hasValidConfig(): Promise<boolean> {
    const config = await this.getConfig();
    // For now, the only strict requirement is having an LLM key.
    return config.llmKey.trim().length > 0;
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
