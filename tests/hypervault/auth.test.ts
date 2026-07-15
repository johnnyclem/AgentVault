import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHyperVaultKey,
  saveHypervaultState,
  loadHypervaultState,
  hypervaultStatePath,
  defaultHypervaultState,
} from '../../src/hypervault/auth.js';

describe('hypervault auth', () => {
  let tmp: string;
  const savedEnv = process.env.HYPERVAULT_API_KEY;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-auth-'));
    delete process.env.HYPERVAULT_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.HYPERVAULT_API_KEY;
    else process.env.HYPERVAULT_API_KEY = savedEnv;
  });

  it('resolves the flag key and flags it as insecure', async () => {
    const resolved = await resolveHyperVaultKey({ flagKey: 'hv_flagkey' });
    expect(resolved?.key).toBe('hv_flagkey');
    expect(resolved?.source).toBe('flag');
    expect(resolved?.insecureSource).toBe(true);
  });

  it('prefers the env var over the vault, non-insecure', async () => {
    process.env.HYPERVAULT_API_KEY = 'hv_envkey';
    const resolved = await resolveHyperVaultKey({ agentId: 'agent-x' });
    expect(resolved?.key).toBe('hv_envkey');
    expect(resolved?.source).toBe('env');
    expect(resolved?.insecureSource).toBe(false);
  });

  it('returns null when nothing supplies a key', async () => {
    const resolved = await resolveHyperVaultKey({});
    expect(resolved).toBeNull();
  });

  it('never writes a plaintext hv_ key to the state file', () => {
    const state = { ...defaultHypervaultState(), keyRef: 'vault:hashicorp/agent/hypervault_api_key' };
    saveHypervaultState(state, tmp);
    const raw = fs.readFileSync(hypervaultStatePath(tmp), 'utf-8');
    expect(raw).not.toMatch(/hv_[A-Za-z0-9]{8,}/);
    expect(loadHypervaultState(tmp)?.keyRef).toBe('vault:hashicorp/agent/hypervault_api_key');
  });

  it('refuses to persist an accidental plaintext key', () => {
    const state = { ...defaultHypervaultState(), userIdHint: 'hv_abcdef1234567890' };
    expect(() => saveHypervaultState(state, tmp)).toThrow(/plaintext/i);
  });
});
