/**
 * In-memory secret provider for testing and local development
 *
 * Secrets are held only in process memory – no backend is required.
 * Useful for unit tests and development workflows where a real Vault
 * or Bitwarden instance is not available.
 */

import type { SecretProvider, SecretProviderHealth } from './provider.js';

export class MemorySecretProvider implements SecretProvider {
  readonly name = 'In-Memory (ephemeral)';

  private readonly store = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async storeSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async listSecrets(): Promise<string[]> {
    return [...this.store.keys()];
  }

  async deleteSecret(key: string): Promise<void> {
    if (!this.store.has(key)) {
      throw new Error(`Secret "${key}" not found`);
    }
    this.store.delete(key);
  }

  async healthCheck(): Promise<SecretProviderHealth> {
    return { healthy: true, message: 'In-memory provider is ready', version: '1.0.0' };
  }

  /**
   * Clear all secrets. Useful between tests.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Number of secrets stored.
   */
  get size(): number {
    return this.store.size;
  }
}
