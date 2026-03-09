/**
 * Vault Health Service
 *
 * Provides backbone health checks against a configured HashiCorp Vault instance.
 */

import type { VaultBackboneHealth } from '../types.js';
import { VaultClient, loadVaultConfig, validateVaultConfig } from '../../vault/index.js';

export class VaultHealthService {
  /**
   * Check the health of the Vault backbone.
   *
   * Returns a structured health response:
   * - If Vault is not configured: { configured: false, healthy: false }
   * - If Vault is configured and reachable: { configured: true, healthy: true }
   * - If Vault is configured but unreachable: { configured: true, healthy: false }
   */
  async check(): Promise<VaultBackboneHealth> {
    const config = loadVaultConfig();

    if (!config) {
      return {
        configured: false,
        healthy: false,
        message: 'Vault is not configured. Set VAULT_ADDR and VAULT_TOKEN environment variables.',
      };
    }

    const errors = validateVaultConfig(config);
    if (errors.length > 0) {
      return {
        configured: true,
        healthy: false,
        vaultAddress: config.address,
        message: `Vault configuration invalid: ${errors.join(', ')}`,
      };
    }

    try {
      const client = VaultClient.createWithConfig(config, {
        agentId: '__health_check__',
        secretPath: 'agents/__health_check__/secrets',
        engine: 'kv-v2',
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        allowList: false,
      });

      const result = await client.health();

      if (result.success && result.data) {
        return {
          configured: true,
          healthy: !result.data.sealed,
          vaultAddress: config.address,
          vaultVersion: result.data.version,
          message: result.data.sealed
            ? 'Vault is sealed'
            : 'Vault backbone is healthy',
        };
      }

      return {
        configured: true,
        healthy: false,
        vaultAddress: config.address,
        message: result.error ?? 'Vault health check failed',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        configured: true,
        healthy: false,
        vaultAddress: config.address,
        message: `Vault health check failed: ${message}`,
      };
    }
  }
}
