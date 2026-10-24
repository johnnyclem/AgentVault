/**
 * `archiveHyperVault` reports the Arweave copy as verified only when the
 * re-fetched bundle is signed by the key this run signed with and its
 * signature, checksums and Merkle root all pass. A bundle re-signed with
 * another key, or one whose Merkle root no longer matches its entries, is not
 * verified.
 *
 * The HyperVault client and the Arweave archiver are faked; the snapshot,
 * signing and verification are real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveHyperVault, type ArchiverLike } from '../../src/hypervault/pipeline.js';
import { buildSnapshot, canonicalManifestBytes, type HypervaultSnapshot } from '../../src/hypervault/snapshot.js';
import { loadOrCreateSigningKey } from '../../src/backup/backup.js';
import type { HyperVaultClient } from '../../src/hypervault/client.js';
import { sampleManifest, sampleRecords } from './fixtures.js';

let tmp: string;
let keyPath: string;

function fakeClient(): HyperVaultClient {
  return {
    exportVault: async () => ({ records: sampleRecords(), manifest: sampleManifest() }),
    postArchiveReceipt: async () => undefined,
  } as unknown as HyperVaultClient;
}

/** An archiver that stores the uploaded bundle and returns `tamper(bundle)` when it is fetched back */
function fakeArchiver(tamper: (snapshot: HypervaultSnapshot) => Promise<HypervaultSnapshot>): ArchiverLike {
  let uploaded = '';
  return {
    archive: async (state) => {
      uploaded = String((state as { snapshot: string }).snapshot);
      return { success: true, transactionId: 'tx-1' };
    },
    fetchBundle: async () => {
      const returned = await tamper(JSON.parse(uploaded) as HypervaultSnapshot);
      return { state: JSON.stringify({ snapshot: JSON.stringify(returned) }) };
    },
    verifyBundle: async () => ({ valid: true }),
  };
}

async function archive(tamper: (snapshot: HypervaultSnapshot) => Promise<HypervaultSnapshot>) {
  return archiveHyperVault({
    client: fakeClient(),
    projectRoot: tmp,
    arweaveJwk: { kty: 'RSA' },
    archiver: fakeArchiver(tamper),
    signingKeyPath: keyPath,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-archive-verify-'));
  keyPath = path.join(tmp, 'signing.key');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('archiveHyperVault verification', () => {
  it('verifies an unchanged round trip', async () => {
    const result = await archive(async (snapshot) => snapshot);
    expect(result.arweaveTx).toBe('tx-1');
    expect(result.verified).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not verify a bundle re-signed with another key', async () => {
    const otherKeyPath = path.join(tmp, 'other.key');
    // Internally consistent, but signed by someone else
    const result = await archive(async () => buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: otherKeyPath }));
    expect(result.verified).toBe(false);
    expect(result.errors).toContain('Snapshot public key does not match the expected key');
  });

  it('does not verify a bundle whose Merkle root does not match its entries', async () => {
    const result = await archive(async (snapshot) => {
      // Same key and valid checksums, but a signed manifest with a wrong Merkle root
      const manifest = { ...snapshot.manifest, merkleRoot: crypto.randomBytes(32).toString('hex') };
      const { ed25519 } = await import('@noble/curves/ed25519');
      const { privateKey } = await loadOrCreateSigningKey(keyPath);
      const signature = Buffer.from(ed25519.sign(canonicalManifestBytes(manifest), privateKey)).toString('hex');
      return { ...snapshot, manifest, signature };
    });
    expect(result.verified).toBe(false);
    expect(result.errors).toContain('Merkle root mismatch');
  });
});
