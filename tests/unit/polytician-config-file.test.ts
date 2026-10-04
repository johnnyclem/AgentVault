/**
 * The Polytician config file `agentvault polytician config` writes: the
 * agentVault section Polytician reads at startup, checked against Polytician's
 * AgentVaultConfigSchema (a mirror, plus Polytician's own when POLYTICIAN_ENTRY
 * names a built server). The token is a ${POLYTICIAN_AV_API_TOKEN} reference
 * Polytician expands from its environment, so no secret is written to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  buildPolyticianConfig,
  defaultPolyticianConfigPath,
  writePolyticianConfigFile,
  POLYTICIAN_API_TOKEN_REFERENCE,
} from '../../src/orchestration/polytician-config-file.js';
import { PolyticianConfigError } from '../../src/orchestration/polytician-config.js';
import { AgentVaultConfigSchema } from '../fixtures/polytician-3.0/agent-vault-config-schema.js';

/** Polytician's own schema, from the build POLYTICIAN_ENTRY ("node <polytician>/dist/index.js") runs. */
async function realSchema(): Promise<{ safeParse(value: unknown): { success: boolean; error?: unknown } } | null> {
  const script = process.env['POLYTICIAN_ENTRY']?.trim().split(/\s+/).find((part) => part.endsWith('index.js'));
  if (!script) return null;
  const module = join(dirname(script), 'integrations', 'agent-vault', 'config.js');
  if (!existsSync(module)) return null;
  return ((await import(pathToFileURL(module).href)) as { AgentVaultConfigSchema: never }).AgentVaultConfigSchema;
}

let dir: string;
let jwk: string;

/** The shape of an Arweave keyfile: an RSA private key as a JWK (values shortened). */
const WALLET = JSON.stringify({ kty: 'RSA', n: 'sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1Wl', e: 'AQAB', d: 'VFCWOqXr8nvZNyaaJLXdnNPXZKRaWCjkU5Q2egQQpTBMwhprMzWzpR8Sx' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'av-polytician-config-'));
  jwk = join(dir, 'arweave-wallet.json');
  writeFileSync(jwk, WALLET);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildPolyticianConfig', () => {
  it('writes the AgentVault URL, a token reference and the memory_repo branch', async () => {
    const config = buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' });

    expect(config).toEqual({
      agentVault: {
        apiBaseUrl: 'https://vault.example.com',
        apiToken: '${POLYTICIAN_AV_API_TOKEN}',
        memoryRepoBranch: 'polytician-main',
      },
    });
    expect(POLYTICIAN_API_TOKEN_REFERENCE).toBe('${POLYTICIAN_AV_API_TOKEN}');
    expect(AgentVaultConfigSchema.safeParse(config.agentVault).success).toBe(true);
    const real = await realSchema();
    if (real) expect(real.safeParse(config.agentVault).success).toBe(true);
  });

  it('adds an archival block only when asked, with the tag filter and the wallet path made absolute', async () => {
    // Polytician reads arweaveJwk as a file only when it starts with /, ./ or ../
    const config = buildPolyticianConfig({
      apiBaseUrl: 'http://localhost:3000',
      memoryRepoBranch: 'team-memory',
      archival: { tags: ['archive', 'public'], arweaveJwk: relative(process.cwd(), jwk) },
    });

    expect(config).toEqual({
      agentVault: {
        apiBaseUrl: 'http://localhost:3000',
        apiToken: '${POLYTICIAN_AV_API_TOKEN}',
        memoryRepoBranch: 'team-memory',
        archival: { enabled: true, tagFilter: ['archive', 'public'], arweaveJwk: jwk },
      },
    });
    const parsed = AgentVaultConfigSchema.safeParse(config.agentVault);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.archival).toMatchObject({ enabled: true, tagFilter: ['archive', 'public'] });
    const real = await realSchema();
    if (real) expect(real.safeParse(config.agentVault).success).toBe(true);
  });

  it('refuses what Polytician would refuse at startup', () => {
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'http://vault.example.com' })).toThrow(/https/);
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'vault.example.com' })).toThrow(PolyticianConfigError);
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com', archival: { tags: [], arweaveJwk: jwk } }))
      .toThrow(/at least one --archival-tag/);
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com', archival: { tags: [' '], arweaveJwk: jwk } }))
      .toThrow(/archival tag/);
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com', archival: { tags: ['archive'], arweaveJwk: join(dir, 'missing.json') } }))
      .toThrow(/Arweave wallet file not found/);
    expect(() => buildPolyticianConfig({ apiBaseUrl: 'https://user:s3cret@vault.example.com' })).toThrow(/credentials/);
  });

  it('refuses a wallet file that is not an Arweave key, without repeating its content', () => {
    const cases = {
      'not-json.json': 'not json at all: s3cret-material',
      'array.json': '["s3cret-material"]',
      'no-kty.json': '{"n":"s3cret-material","d":"x"}',
      'public-only.json': '{"kty":"RSA","n":"s3cret-material","e":"AQAB"}',
      'ec.json': '{"kty":"EC","crv":"P-256","d":"s3cret-material"}',
    };
    for (const [name, content] of Object.entries(cases)) {
      const file = join(dir, name);
      writeFileSync(file, content);
      let caught: unknown;
      try {
        buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com', archival: { tags: ['archive'], arweaveJwk: file } });
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(PolyticianConfigError);
      expect((caught as Error).message, name).toMatch(/not an Arweave wallet/);
      expect((caught as Error).message, name).toContain(file);
      expect((caught as Error).message, name).not.toContain('s3cret-material');
    }
  });
});

describe('writePolyticianConfigFile', () => {
  it("defaults to the file Polytician reads without --config", () => {
    expect(defaultPolyticianConfigPath('/home/someone')).toBe('/home/someone/.polytician/config.json');
  });

  it('creates the file readable by its owner only, in a directory only its owner can enter, with no token in it', () => {
    const path = join(dir, 'polytician', 'config.json');
    const config = buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' });

    const outcome = writePolyticianConfigFile(path, config, { force: false });

    expect(outcome).toEqual({ path, replaced: false, kept: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config);
    expect(readFileSync(path, 'utf8')).not.toMatch(/av-token|Bearer/);
  });

  it('refuses to overwrite an existing file without force, and leaves it as it was', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{"namespaces":["agent-a"]}');

    expect(() => writePolyticianConfigFile(path, buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' }), { force: false }))
      .toThrow(/already exists.*--force/s);
    expect(readFileSync(path, 'utf8')).toBe('{"namespaces":["agent-a"]}');
  });

  it("with force, sets the agentVault keys it writes, keeps every other setting and makes the file owner-only", () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({
      namespaces: ['agent-a'],
      agentVault: {
        apiBaseUrl: 'https://old.example.com',
        apiToken: 'operator-literal',
        agentPrincipal: 'aaaaa-aa',
        sync: { enabled: true },
        inference: { timeoutMs: 5000 },
      },
    }));
    chmodSync(path, 0o644);

    const outcome = writePolyticianConfigFile(path, buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' }), { force: true });

    expect(outcome).toEqual({ path, replaced: true, kept: ['agentPrincipal', 'sync', 'inference'] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      namespaces: ['agent-a'],
      agentVault: {
        apiBaseUrl: 'https://vault.example.com',
        apiToken: '${POLYTICIAN_AV_API_TOKEN}',
        agentPrincipal: 'aaaaa-aa',
        sync: { enabled: true },
        inference: { timeoutMs: 5000 },
        memoryRepoBranch: 'polytician-main',
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('with force, keeps an existing archival block unless archival is given or removed', () => {
    const path = join(dir, 'config.json');
    const existingArchival = { enabled: true, tagFilter: ['old'], arweaveJwk: '/old/wallet.json', debounceMs: 100, timeoutMs: 9000 };
    const write = (archival: boolean, removeArchival = false) => {
      writeFileSync(path, JSON.stringify({ agentVault: { apiBaseUrl: 'https://old.example.com', archival: existingArchival } }));
      const config = buildPolyticianConfig({
        apiBaseUrl: 'https://vault.example.com',
        archival: archival ? { tags: ['publish'], arweaveJwk: jwk } : undefined,
      });
      const outcome = writePolyticianConfigFile(path, config, { force: true, removeArchival });
      return { outcome, agentVault: JSON.parse(readFileSync(path, 'utf8')).agentVault as Record<string, unknown> };
    };

    const kept = write(false);
    expect(kept.agentVault.archival).toEqual(existingArchival);
    expect(kept.outcome.kept).toEqual(['archival']);

    // The tags and wallet change; the timing settings stay
    const replaced = write(true);
    expect(replaced.agentVault.archival).toEqual({ enabled: true, tagFilter: ['publish'], arweaveJwk: jwk, debounceMs: 100, timeoutMs: 9000 });
    expect(replaced.outcome.kept).toEqual([]);

    const removed = write(false, true);
    expect(removed.agentVault).not.toHaveProperty('archival');
    expect(removed.outcome.kept).toEqual([]);
  });

  it('refuses, even with force, a file it cannot read as a JSON object, since replacing it would lose its settings', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json');
    expect(() => writePolyticianConfigFile(path, buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' }), { force: true }))
      .toThrow(/not a JSON object/);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');

    mkdirSync(join(dir, 'a-directory'));
    expect(() => writePolyticianConfigFile(join(dir, 'a-directory'), buildPolyticianConfig({ apiBaseUrl: 'https://vault.example.com' }), { force: true }))
      .toThrow(PolyticianConfigError);
  });
});
