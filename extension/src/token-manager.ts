import * as vscode from 'vscode';

/**
 * TokenManager: Handles secure token storage via VS Code SecretStorage
 * Tokens are stored in OS keychain, never in Webview memory
 */
export class TokenManager {
  private static readonly TOKEN_KEY = 'vertex-swarm-auth-token';
  private static readonly USER_KEY = 'vertex-swarm-auth-user';

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Store token and user metadata securely
   */
  async setToken(token: string, userMetadata: Record<string, unknown>): Promise<void> {
    try {
      await this.secrets.store(TokenManager.TOKEN_KEY, token);
      await this.secrets.store(
        TokenManager.USER_KEY,
        JSON.stringify(userMetadata)
      );
    } catch (error) {
      console.error('Failed to store token:', error);
      throw new Error('Could not store authentication token');
    }
  }

  /**
   * Retrieve stored token
   */
  async getToken(): Promise<string | undefined> {
    try {
      return await this.secrets.get(TokenManager.TOKEN_KEY);
    } catch (error) {
      console.error('Failed to retrieve token:', error);
      return undefined;
    }
  }

  /**
   * Retrieve user metadata
   */
  async getUserMetadata(): Promise<Record<string, unknown> | undefined> {
    try {
      const userJson = await this.secrets.get(TokenManager.USER_KEY);
      return userJson ? JSON.parse(userJson) : undefined;
    } catch (error) {
      console.error('Failed to retrieve user metadata:', error);
      return undefined;
    }
  }

  /**
   * Check if token exists
   */
  async hasToken(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  /**
   * Clear stored token (logout)
   */
  async clearToken(): Promise<void> {
    try {
      await this.secrets.delete(TokenManager.TOKEN_KEY);
      await this.secrets.delete(TokenManager.USER_KEY);
    } catch (error) {
      console.error('Failed to clear token:', error);
    }
  }
}
