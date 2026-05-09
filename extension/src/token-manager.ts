import * as vscode from 'vscode';

export type StoredSession =
  | {
      status: 'valid';
      token: string;
      userMetadata: Record<string, unknown>;
      refreshToken?: string;
      expiresAt: number;
    }
  | {
      status: 'expired';
      userMetadata: Record<string, unknown>;
      refreshToken?: string;
      expiresAt?: number;
    }
  | { status: 'missing' };

/**
 * TokenManager: Handles secure token storage via VS Code SecretStorage
 * Tokens are stored in OS keychain, never in Webview memory
 */
export class TokenManager {
  private static readonly TOKEN_KEY = 'vertex-swarm-auth-token';
  private static readonly USER_KEY = 'vertex-swarm-auth-user';
  private static readonly REFRESH_TOKEN_KEY = 'vertex-swarm-auth-refresh-token';
  private static readonly LEGACY_SESSION_TOKEN_KEY = 'vertex-swarm-auth-session-token';
  private static readonly SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Store token and user metadata securely
   */
  async setToken(
    token: string,
    userMetadata: Record<string, unknown>,
    refreshToken?: string
  ): Promise<void> {
    try {
      const now = Date.now();
      const jwtExpiryMs = this.getJwtExpiryMs(token);
      const storedUserMetadata = {
        ...userMetadata,
        authenticatedAt: now,
        expiresAt: jwtExpiryMs ?? now + TokenManager.SESSION_TTL_MS,
      };

      await this.secrets.store(TokenManager.TOKEN_KEY, token);
      await this.secrets.store(
        TokenManager.USER_KEY,
        JSON.stringify(storedUserMetadata)
      );
      if (refreshToken) {
        await this.secrets.store(TokenManager.REFRESH_TOKEN_KEY, refreshToken);
      }
      await this.secrets.delete(TokenManager.LEGACY_SESSION_TOKEN_KEY);
    } catch (error) {
      console.error('Failed to store token:', error);
      throw new Error('Could not store authentication token');
    }
  }

  /**
   * Retrieve the stored session and enforce JWT expiry when available.
   */
  async getSession(): Promise<StoredSession> {
    try {
      const [token, userJson, storedRefreshToken, legacySessionToken] = await Promise.all([
        this.secrets.get(TokenManager.TOKEN_KEY),
        this.secrets.get(TokenManager.USER_KEY),
        this.secrets.get(TokenManager.REFRESH_TOKEN_KEY),
        this.secrets.get(TokenManager.LEGACY_SESSION_TOKEN_KEY),
      ]);
      const refreshToken = storedRefreshToken || legacySessionToken;

      if (!token && !userJson && !refreshToken) {
        return { status: 'missing' };
      }

      const userMetadata = userJson
        ? (JSON.parse(userJson) as Record<string, unknown>)
        : {};

      if (!token) {
        if (refreshToken) {
          return {
            status: 'expired',
            userMetadata,
            refreshToken,
            expiresAt: this.normalizeExpiryMs(userMetadata.expiresAt),
          };
        }
        await this.clearToken();
        return { status: 'missing' };
      }

      let expiresAt = this.normalizeExpiryMs(userMetadata.expiresAt);

      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
        const jwtExpiryMs = this.getJwtExpiryMs(token);
        if (jwtExpiryMs) {
          expiresAt = jwtExpiryMs;
        }
      }

      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
        const now = Date.now();
        const upgradedUserMetadata = {
          ...userMetadata,
          authenticatedAt: now,
          expiresAt: now + TokenManager.SESSION_TTL_MS,
        };

        await this.secrets.store(
          TokenManager.USER_KEY,
          JSON.stringify(upgradedUserMetadata)
        );

        return {
          status: 'valid',
          token,
          userMetadata: upgradedUserMetadata,
          refreshToken: refreshToken || undefined,
          expiresAt: upgradedUserMetadata.expiresAt,
        };
      }

      if (expiresAt <= Date.now()) {
        if (refreshToken) {
          return {
            status: 'expired',
            userMetadata,
            refreshToken,
            expiresAt,
          };
        }

        await this.clearToken();
        return {
          status: 'expired',
          userMetadata,
          expiresAt,
        };
      }

      return {
        status: 'valid',
        token,
        userMetadata,
        refreshToken: refreshToken || undefined,
        expiresAt,
      };
    } catch (error) {
      console.error('Failed to retrieve stored session:', error);
      return { status: 'missing' };
    }
  }

  /**
   * Clear stored token (logout)
   */
  async clearToken(): Promise<void> {
    try {
      await this.secrets.delete(TokenManager.TOKEN_KEY);
      await this.secrets.delete(TokenManager.USER_KEY);
      await this.secrets.delete(TokenManager.REFRESH_TOKEN_KEY);
      await this.secrets.delete(TokenManager.LEGACY_SESSION_TOKEN_KEY);
    } catch (error) {
      console.error('Failed to clear token:', error);
    }
  }

  private getJwtExpiryMs(token: string): number | undefined {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return undefined;
      }

      const payload = JSON.parse(
        Buffer.from(this.normalizeBase64(parts[1]), 'base64').toString('utf-8')
      ) as { exp?: number | string };
      const expSeconds =
        typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);

      if (!Number.isFinite(expSeconds)) {
        return undefined;
      }

      return expSeconds * 1000;
    } catch (error) {
      console.warn('Failed to decode JWT expiry from stored token:', error);
      return undefined;
    }
  }

  private normalizeExpiryMs(value: unknown): number | undefined {
    const expiresAt =
      typeof value === 'number'
        ? value
        : Number(value);

    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  }

  private normalizeBase64(value: string): string {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const remainder = normalized.length % 4;

    if (remainder === 0) {
      return normalized;
    }

    return `${normalized}${'='.repeat(4 - remainder)}`;
  }
}
