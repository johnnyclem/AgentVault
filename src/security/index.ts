/**
 * Security module for AgentVault
 *
 * This module provides encryption, decryption, and key management.
 * "VetKeys" here names seed-phrase encryption with Shamir secret sharing;
 * it does not use the ICP vetKD protocol or produce threshold signatures.
 */

export * from './types.js';

// VetKeysClient is exported from types.js, avoid re-exporting from vetkeys.js
export { VetKeysClient } from './types.js';

// Re-export decryptJSON and bundle encryption from vetkeys.js
export {
  decryptJSON,
  encryptBundleWithVetKeys,
  decryptBundle,
  isVetKeysEncryptedBundle,
} from './vetkeys.js';

// Multi-sig approval workflows
// Shamir's Secret Sharing over GF(2^8) — used for threshold key splitting
export * from './shamir.js';

export * from './multisig.js';

// TOTP (RFC 6238) — pure-Node implementation for Authy / Google Authenticator
export * from './totp.js';

// Multi-Factor Agent Approval — TOTP + nonce + one-time link + rate-limit + anomaly
export * from './mfa-approval.js';

// WebAuthn / Biometric fallback — P-256 device keys, Secure Enclave simulation
export * from './webauthn.js';

// ICP audit submission for MFA events (on-chain storage does not work yet; entries stay queued locally)
export * from './icp-audit.js';

// HashiCorp Vault integration
export { VaultClient } from '../vault/client.js';
export type {
  VaultConfig,
  VaultSecret,
  VaultSecretMetadata,
  VaultOperationResult,
  VaultHealthStatus,
  AgentVaultPolicy,
  AgentVaultInitOptions,
} from '../vault/types.js';
