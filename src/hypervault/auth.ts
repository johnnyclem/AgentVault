/**
 * HyperVault key resolution & local state
 *
 * Resolution chain (per the AGENTS.md wallet-secret policy — keys never
 * persist in flags or config files):
 *
 *   1. explicit key passed by the caller (e.g. a `--key` flag — discouraged)
 *   2. HYPERVAULT_API_KEY environment variable
 *   3. secrets vault lookup (`hypervault_api_key` for the agent)
 *
 * Interactive prompting is the CLI layer's job; this module is
 * non-interactive. `.agentvault/hypervault.json` stores a `keyRef`
 * (vault pointer), never the key itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import type { SecretProvider } from '../vault/provider.js';
import { hypervaultStateSchema, type HypervaultState } from './types.js';
import { DEFAULT_HYPERVAULT_API_URL } from './client.js';

export const HYPERVAULT_KEY_SECRET_NAME = 'hypervault_api_key';
export const HYPERVAULT_STATE_FILENAME = 'hypervault.json';

export type HyperVaultKeySource = 'flag' | 'env' | 'vault';

export interface ResolvedHyperVaultKey {
  key: string;
  source: HyperVaultKeySource;
  /** Vault pointer for persisting in hypervault.json (vault source only) */
  keyRef?: string;
  /** Set when the key arrived via a CLI flag — callers should warn */
  insecureSource: boolean;
}

type VaultBackend = 'hashicorp' | 'bitwarden';

function resolveVaultBackend(): VaultBackend {
  const b = (process.env.AGENTVAULT_VAULT_BACKEND ?? 'hashicorp').toLowerCase();
  return b === 'bitwarden' || b === 'bw' ? 'bitwarden' : 'hashicorp';
}

async function buildVaultProvider(agentId: string, backend: VaultBackend): Promise<SecretProvider> {
  if (backend === 'bitwarden') {
    const { BitwardenProvider } = await import('../vault/bitwarden.js');
    return new BitwardenProvider({ agentId });
  }
  const { HashiCorpVaultProvider } = await import('../vault/hashicorp-provider.js');
  return HashiCorpVaultProvider.forAgent(agentId);
}

export function makeKeyRef(backend: VaultBackend, agentId: string): string {
  return `vault:${backend}/${agentId}/${HYPERVAULT_KEY_SECRET_NAME}`;
}

/**
 * Resolve the HyperVault API key without prompting.
 *
 * @param options.flagKey - key passed on the command line (discouraged)
 * @param options.agentId - agent identifier for the vault lookup
 * @returns The resolved key, or null when no source produced one.
 */
export async function resolveHyperVaultKey(options: {
  flagKey?: string;
  agentId?: string;
} = {}): Promise<ResolvedHyperVaultKey | null> {
  if (options.flagKey) {
    return { key: options.flagKey, source: 'flag', insecureSource: true };
  }

  const envKey = process.env.HYPERVAULT_API_KEY;
  if (envKey) {
    return { key: envKey, source: 'env', insecureSource: false };
  }

  if (options.agentId) {
    const backend = resolveVaultBackend();
    try {
      const provider = await buildVaultProvider(options.agentId, backend);
      const value = await provider.getSecret(HYPERVAULT_KEY_SECRET_NAME);
      if (value) {
        return {
          key: value,
          source: 'vault',
          keyRef: makeKeyRef(backend, options.agentId),
          insecureSource: false,
        };
      }
    } catch {
      // Vault not configured / unreachable — fall through to null.
    }
  }

  return null;
}

/**
 * Store the key in the secrets vault and return its keyRef.
 * Throws when no vault backend is configured/reachable.
 */
export async function storeHyperVaultKey(agentId: string, key: string): Promise<string> {
  const backend = resolveVaultBackend();
  const provider = await buildVaultProvider(agentId, backend);
  await provider.storeSecret(HYPERVAULT_KEY_SECRET_NAME, key);
  return makeKeyRef(backend, agentId);
}

// ---------------------------------------------------------------------------
// State file (.agentvault/hypervault.json)
// ---------------------------------------------------------------------------

export function hypervaultStatePath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, '.agentvault', HYPERVAULT_STATE_FILENAME);
}

export function loadHypervaultState(projectRoot: string = process.cwd()): HypervaultState | null {
  const filePath = hypervaultStatePath(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return hypervaultStateSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Persist HyperVault state. Refuses to write anything that looks like a
 * plaintext `hv_` key (defence in depth for §7.1).
 */
export function saveHypervaultState(state: HypervaultState, projectRoot: string = process.cwd()): void {
  const serialized = JSON.stringify(hypervaultStateSchema.parse(state), null, 2) + '\n';
  if (/hv_[A-Za-z0-9]{8,}/.test(serialized)) {
    throw new Error('Refusing to write a plaintext HyperVault key to hypervault.json (use the secrets vault)');
  }
  atomicWriteFileSync(hypervaultStatePath(projectRoot), serialized, { encoding: 'utf8', mode: 0o600 });
}

export function defaultHypervaultState(): HypervaultState {
  return hypervaultStateSchema.parse({ apiUrl: process.env.HYPERVAULT_API_URL ?? DEFAULT_HYPERVAULT_API_URL });
}
