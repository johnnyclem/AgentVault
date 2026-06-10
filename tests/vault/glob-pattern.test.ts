/**
 * Tests for SEC-6: safe glob→regex conversion in Vault key validation.
 *
 * Exercises the externally observable behaviour via VaultClient.validateKey
 * (indirectly through getSecret which surfaces a policy-mismatch error).
 */

import { describe, it, expect } from 'vitest';
import { VaultClient } from '../../src/vault/client.js';
import type { VaultConfig, AgentVaultPolicy } from '../../src/vault/types.js';

function makeClient(allowedKeyPatterns: string[]): VaultClient {
  const config: VaultConfig = {
    address: 'http://127.0.0.1:8200',
    authMethod: 'token',
    token: 'unused-in-this-test',
  };
  const policy: AgentVaultPolicy = {
    agentId: 'test-agent',
    secretPath: 'agents/test-agent/secrets',
    engine: 'kv-v2',
    allowedKeyPatterns,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    allowList: true,
  };
  return VaultClient.createWithConfig(config, policy);
}

describe('Vault key pattern matching (SEC-6)', () => {
  it('treats regex metacharacters in the pattern as literals', async () => {
    // Pattern intentionally contains `.` and `+` — under the old code,
    // `key.with.dots` would have matched `keyXwithXdots` because `.`
    // was passed through to RegExp unescaped.
    const client = makeClient(['key.with.dots']);

    const ok = await client.getSecret('key.with.dots');
    expect(ok.success).toBe(false);
    // The error must be the network/auth failure, NOT a policy mismatch
    expect(ok.error).not.toMatch(/does not match allowed patterns/);

    const bad = await client.getSecret('keyXwithXdots');
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/does not match allowed patterns/);
  });

  it('supports `*` wildcard expansion', async () => {
    const client = makeClient(['secrets/*']);
    const ok = await client.getSecret('secrets/anything-here');
    expect(ok.error).not.toMatch(/does not match allowed patterns/);

    const bad = await client.getSecret('different/path');
    expect(bad.error).toMatch(/does not match allowed patterns/);
  });

  it('supports `?` single-char wildcard', async () => {
    const client = makeClient(['v?-token']);
    const ok = await client.getSecret('v1-token');
    expect(ok.error).not.toMatch(/does not match allowed patterns/);

    const bad = await client.getSecret('v10-token');
    expect(bad.error).toMatch(/does not match allowed patterns/);
  });

  it('escapes parens, alternation, and other regex metachars', async () => {
    // The old code would have constructed an invalid/explosive regex from
    // a pattern like `a(b|c)+` since none of these were escaped.
    const client = makeClient(['a(b|c)+']);
    const ok = await client.getSecret('a(b|c)+');
    expect(ok.error).not.toMatch(/does not match allowed patterns/);

    const expanded = await client.getSecret('abbb');
    expect(expanded.error).toMatch(/does not match allowed patterns/);
  });
});
