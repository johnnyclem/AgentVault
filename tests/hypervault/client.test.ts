import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { HyperVaultClient, HyperVaultError } from '../../src/hypervault/client.js';
import { sampleManifest, sampleRecords, toNdjson } from './fixtures.js';

const BASE = 'https://hv.test';

describe('HyperVaultClient', () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    await mockAgent.close();
  });

  it('validates a good key and reports the user hint', async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: '/api/keys', method: 'GET' })
      .reply(200, { user_id: 'user-123' });

    const client = new HyperVaultClient({ apiKey: 'hv_good', apiUrl: BASE });
    const result = await client.validateKey();
    expect(result.valid).toBe(true);
    expect(result.userIdHint).toBe('user-123');
  });

  it('reports an invalid key on 401 without throwing', async () => {
    mockAgent.get(BASE).intercept({ path: '/api/keys', method: 'GET' }).reply(401, { error: 'nope' });
    const client = new HyperVaultClient({ apiKey: 'hv_bad', apiUrl: BASE });
    expect(await client.validateKey()).toEqual({ valid: false });
  });

  it('sends the X-HyperVault-Key header', async () => {
    // The interceptor only matches when the header is present with the right
    // value; a missing/wrong header would fall through to a mock error.
    mockAgent
      .get(BASE)
      .intercept({
        path: '/api/memories',
        method: 'GET',
        headers: { 'x-hypervault-key': 'hv_secret' },
      })
      .reply(200, []);
    const client = new HyperVaultClient({ apiKey: 'hv_secret', apiUrl: BASE });
    await expect(client.listMemories()).resolves.toEqual([]);
  });

  it('retries on 429 and then succeeds', async () => {
    const pool = mockAgent.get(BASE);
    pool.intercept({ path: '/api/memories', method: 'GET' }).reply(429, 'slow down');
    pool.intercept({ path: '/api/memories', method: 'GET' }).reply(200, [{ id: 'm', content: 'x', tags: [] }]);
    const client = new HyperVaultClient({ apiKey: 'hv_k', apiUrl: BASE, backoffMs: 1 });
    const memories = await client.listMemories();
    expect(memories).toHaveLength(1);
  });

  it('streams and validates an NDJSON export, surfacing the manifest', async () => {
    mockAgent
      .get(BASE)
      .intercept({ path: '/api/export', method: 'GET' })
      .reply(200, toNdjson(sampleRecords(), sampleManifest()));

    const client = new HyperVaultClient({ apiKey: 'hv_k', apiUrl: BASE });
    const { records, manifest } = await client.exportVault();
    expect(records.length).toBe(sampleRecords().length);
    expect(manifest.branch_heads).toEqual({ main: 'commit-2' });
    expect(records.filter((r) => r.table === 'memories')).toHaveLength(2);
  });

  it('rejects an export whose schema version is newer than supported', async () => {
    const manifest = { ...sampleManifest(), schema_version: 99 };
    mockAgent
      .get(BASE)
      .intercept({ path: '/api/export', method: 'GET' })
      .reply(200, toNdjson(sampleRecords(), manifest));
    const client = new HyperVaultClient({ apiKey: 'hv_k', apiUrl: BASE });
    await expect(client.exportVault()).rejects.toBeInstanceOf(HyperVaultError);
  });
});
