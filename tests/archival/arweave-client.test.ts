/**
 * ArweaveClient driven through the real arweave library against a stand-in
 * gateway (see tests/fixtures/arweave-gateway.ts), so these tests fail if the
 * library is missing, cannot be loaded, or changes how it signs and posts.
 *
 * The property the evidence page relies on is pinned here: the bytes posted
 * to Arweave are exactly the bytes prepareArchive hashed, so a browser that
 * downloads arweave.net/raw/{tx} and hashes it gets the recorded checksum.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArweaveClient } from '../../src/archival/arweave-client.js';
import {
  arweaveTestJwk,
  fakeArweaveGateway,
  sha256Hex,
  transactionIdOf,
  type FakeGateway,
} from '../fixtures/arweave-gateway.js';

let gateway: FakeGateway;

beforeEach(() => {
  gateway = fakeArweaveGateway();
  vi.stubGlobal('fetch', gateway.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ArweaveClient.uploadData', () => {
  it('signs with the given key and posts a string as its UTF-8 bytes', async () => {
    const jwk = arweaveTestJwk();
    const text = '{"note":"Grüße ✓"}';

    const result = await new ArweaveClient().uploadData(text, jwk, { tags: { 'agent-id': 'agent-1' } });

    expect(gateway.posted).toHaveLength(1);
    const [tx] = gateway.posted;
    expect(result).toEqual({ success: true, transactionId: tx!.id });
    expect(tx!.data.equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(tx!.dataSize).toBe(Buffer.byteLength(text, 'utf8'));
    expect(tx!.tags['agent-id']).toBe('agent-1');
    expect(tx!.owner).toBe(jwk.n);
    expect(tx!.id).toBe(transactionIdOf(tx!.signature));
  });

  it('posts a Buffer as its own bytes, not as base64 text', async () => {
    const bytes = Buffer.from('{"concept":"x"}', 'utf8');

    const result = await new ArweaveClient().uploadData(bytes, arweaveTestJwk());

    expect(result.success).toBe(true);
    expect(gateway.posted[0]!.data.equals(bytes)).toBe(true);
    expect(gateway.posted[0]!.dataSize).toBe(bytes.length);
  });

  it('reports a POST the gateway rejects as a failure', async () => {
    gateway.postStatus = 400;

    const result = await new ArweaveClient().uploadData('{}', arweaveTestJwk());

    expect(result.success).toBe(false);
    expect(result.transactionId).toBeUndefined();
    expect(result.error).toContain('400');
  });

  it('reports an unreachable gateway as a failure', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    const result = await new ArweaveClient().uploadData('{}', arweaveTestJwk());

    expect(result).toEqual({ success: false, error: 'fetch failed' });
  });
});

// Data over 256 KiB is posted as a transaction header followed by one /chunk
// request per 256 KiB. arweave-js on its own waits about 40 s before each
// retry of a failed chunk and gives up only after 100 failures, so these
// tests would time out without the client's own limits.
describe('ArweaveClient.uploadData limits', () => {
  const multiChunk = Buffer.alloc(600 * 1024, 'agentvault');

  it('posts data over one chunk through /chunk', async () => {
    const result = await new ArweaveClient().uploadData(multiChunk, arweaveTestJwk());

    const [tx] = gateway.posted;
    expect(result).toEqual({ success: true, transactionId: tx!.id });
    expect(tx!.dataSize).toBe(multiChunk.length);
    expect(gateway.chunks).toHaveLength(3);
    const reassembled = Buffer.concat([...gateway.chunks].sort((a, b) => a.offset - b.offset).map((c) => c.chunk));
    expect(reassembled.equals(multiChunk)).toBe(true);
  });

  it('stops after maxChunkRetries failed chunk posts in a row', async () => {
    gateway.chunkStatus = 500;
    const client = new ArweaveClient({ uploadLimits: { maxChunkRetries: 2, retryDelayMs: 1 } });

    const result = await client.uploadData(multiChunk, arweaveTestJwk());

    expect(result.success).toBe(false);
    expect(result.transactionId).toBeUndefined();
    expect(gateway.chunks).toHaveLength(3);
    expect(result.error).toContain('rejected 3 times in a row');
  });

  it('gives up at the deadline when the gateway never answers the POST', async () => {
    gateway.hang.add('tx');
    const client = new ArweaveClient({ uploadLimits: { deadlineMs: 200 } });
    const started = Date.now();

    const result = await client.uploadData('{}', arweaveTestJwk());

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.success).toBe(false);
    expect(result.transactionId).toBeUndefined();
    expect(result.error).toMatch(/^Upload did not complete within 0\.2s \(transaction [\w-]{43} may or may not have been accepted\)$/);
  });

  it('gives up at the deadline while chunk posts keep failing', async () => {
    gateway.chunkStatus = 500;
    const client = new ArweaveClient({ uploadLimits: { deadlineMs: 300, maxChunkRetries: 1_000, retryDelayMs: 20 } });

    const result = await client.uploadData(multiChunk, arweaveTestJwk());

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not complete within 0.3s');

    // Nothing more goes out once the upload has been reported failed.
    const sent = gateway.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.chunks).toHaveLength(sent);
  });
});

describe('ArweaveClient.getTransactionData', () => {
  it('returns the stored data as text', async () => {
    const client = new ArweaveClient();
    const text = '{"format":"agentvault-arweave-bundle-v1","state":"ü"}';
    const { transactionId } = await client.uploadData(text, arweaveTestJwk());

    expect(await client.getTransactionData(transactionId!)).toBe(text);
  });
});

describe('ArweaveClient.getTransactionStatus', () => {
  const id = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';
  const mined = JSON.stringify({ block_height: 1_500_000, block_indep_hash: 'h'.repeat(64), number_of_confirmations: 3 });

  it.each([
    ['confirmed', 200, mined],
    ['pending', 202, 'Pending'],
    ['not_found', 404, 'Not Found.'],
    ['error', 500, 'Internal Server Error'],
  ] as const)('is %s when the gateway answers %i', async (expected, status, body) => {
    gateway.statuses.set(id, { status, body });

    expect(await new ArweaveClient().getTransactionStatus(id)).toBe(expected);
  });

  it('is an error, not pending, when the gateway cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    expect(await new ArweaveClient().getTransactionStatus(id)).toBe('error');
  });
});

describe('archive checksum', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-arweave-client-'));
    vi.stubEnv('HOME', home);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('matches the SHA-256 and size of the bytes uploadJSON posts', async () => {
    const { prepareArchive, getArchive, getArchiveData } = await import('../../src/archival/archive-manager.js');
    const payload = { agentId: 'agent-1', canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', paths: { config: '/srv/ä/agent.json' }, n: 1.5 };

    const { archiveId } = prepareArchive('agent-1', '1.0.0', payload);
    const record = getArchive(archiveId!)!;
    const result = await new ArweaveClient().uploadJSON(getArchiveData(archiveId!), arweaveTestJwk());

    expect(result.success).toBe(true);
    const [tx] = gateway.posted;
    expect(sha256Hex(tx!.data)).toBe(record.checksum);
    expect(tx!.dataSize).toBe(record.sizeBytes);
    expect(tx!.tags['Content-Type']).toBe('application/json');
  });
});
