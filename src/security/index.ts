/**
 * Security module for AgentVault
 *
 * This module provides encryption, decryption, and key management
 * using VetKeys for threshold key derivation.
 */

export * from './types.js';

// VetKeysClient is exported from types.js, avoid re-exporting from vetkeys.js
export { VetKeysClient } from './types.js';

// Re-export decryptJSON from vetkeys.js
export { decryptJSON } from './vetkeys.js';
