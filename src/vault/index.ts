/**
 * HashiCorp Vault integration for AgentVault
 *
 * Provides per-agent private Vault instances for secrets and API key management.
 * Each agent gets an isolated namespace within a shared Vault server, with
 * configurable access policies.
 *
 * Usage:
 *   import { VaultClient } from './vault/index.js';
 *
 *   const client = VaultClient.create('my-agent');
 *   await client.putSecret('openai-key', 'sk-...');
 *   const result = await client.getSecret('openai-key');
 */

export * from './types.js';
export { VaultClient } from './client.js';
export {
  loadVaultConfig,
  saveVaultConfig,
  loadAgentPolicies,
  saveAgentPolicies,
  getOrCreateAgentPolicy,
  validateVaultConfig,
  getVaultConfigDir,
  ensureVaultConfigDir,
} from './config.js';
