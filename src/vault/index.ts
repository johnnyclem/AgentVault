/**
 * Secret management for AgentVault
 *
 * Supports HashiCorp Vault (self-hosted via Docker or any Vault server) and
 * Bitwarden CLI as secret backends.  All providers implement the `SecretProvider`
 * interface – secrets are fetched at runtime only and are NEVER persisted to
 * the ICP canister.
 *
 * Quick start (HashiCorp Vault):
 *   # Start local Vault:  docker compose up -d
 *   import { HashiCorpVaultProvider } from './vault/index.js';
 *   const provider = HashiCorpVaultProvider.forAgent('my-agent');
 *   await provider.storeSecret('api_binance', process.env.KEY!);
 *   const key = await provider.getSecret('api_binance'); // fetch at runtime only
 *
 * Quick start (Bitwarden):
 *   import { BitwardenProvider } from './vault/index.js';
 *   const provider = new BitwardenProvider({ agentId: 'my-agent' });
 *   const key = await provider.getSecret('api_binance');
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

// Unified provider interface + runtime helpers
export type { SecretProvider, SecretProviderHealth } from './provider.js';
export { fetchSecretsAsEnv, fetchAllSecretsAsEnv } from './provider.js';

// Concrete provider implementations
export { HashiCorpVaultProvider } from './hashicorp-provider.js';
export { BitwardenProvider } from './bitwarden.js';
export type { BitwardenConfig } from './bitwarden.js';
export { MemorySecretProvider } from './memory-provider.js';

// ---------------------------------------------------------------------------
// Agent Safehouse – Secret Management Layer
// ---------------------------------------------------------------------------

// Safehouse types
export type {
  SecretAccessLevel,
  SecretScopeGrant,
  SecretSandboxScope,
  EncryptedMemoryEntry,
  RotationStrategy,
  SecretRotationConfig,
  SecretRotationState,
  LeakSeverity,
  LeakDetectionEvent,
  InjectionMethod,
  SecretInjectionConfig,
  InjectedSecret,
  AuditAction,
  SecretAuditEntry,
  SecretManagementLayerConfig,
  SecretManagementStats,
} from './safehouse-types.js';

// Safehouse components
export { EncryptedMemoryStore } from './encrypted-memory-store.js';
export { SecretSandbox } from './secret-sandbox.js';
export type { CreateScopeOptions, AuditCallback } from './secret-sandbox.js';
export { SecretRotationManager } from './secret-rotation.js';
export { SecretLeakDetector } from './secret-leak-detector.js';
export type { LeakEventCallback, LeakDetectorOptions } from './secret-leak-detector.js';
export { SecretInjector } from './secret-injector.js';
export { SecretAccessAudit } from './secret-audit.js';

// Unified orchestrator
export { SecretManagementLayer } from './secret-management-layer.js';
