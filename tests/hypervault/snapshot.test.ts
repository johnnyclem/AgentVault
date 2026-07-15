import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildSnapshot,
  writeSnapshot,
  readSnapshot,
  verifySnapshot,
  snapshotToRecords,
  readEmbeddings,
} from '../../src/hypervault/snapshot.js';
import { sampleManifest, sampleRecords } from './fixtures.js';

describe('hypervault snapshot bundle', () => {
  let tmp: string;
  let keyPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-snap-'));
    keyPath = path.join(tmp, 'signing.key');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips records → bundle → records (deep equal on core tables)', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: keyPath });
    const file = path.join(tmp, 'snap.gz');
    await writeSnapshot(snapshot, file);

    const loaded = await readSnapshot(file);
    const records = await snapshotToRecords(loaded);

    const memoriesIn = sampleRecords().filter((r) => r.table === 'memories');
    const memoriesOut = records.filter((r) => r.table === 'memories');
    expect(memoriesOut).toHaveLength(memoriesIn.length);
    expect(memoriesOut.map((r) => r.row.id).sort()).toEqual(memoriesIn.map((r) => r.row.id).sort());

    // artifact content survives the content-addressed split/rejoin
    const artifact = records.find((r) => r.table === 'artifacts');
    expect(artifact?.row.content).toBe('<h1>Hello</h1>');
  });

  it('preserves embeddings through the packed sidecar', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: keyPath });
    const embeddings = await readEmbeddings(snapshot);
    expect(embeddings.get('mem-1')).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ]);
  });

  it('verifies signature, checksums, and Merkle root', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: keyPath });
    const result = await verifySnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.checksumsValid).toBe(true);
    expect(result.merkleRootValid).toBe(true);
  });

  it('rejects a tampered entry (checksum + Merkle break)', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: keyPath });
    // Corrupt the memories entry
    snapshot.entries['memories.ndjson'] = Buffer.from('tampered', 'utf-8').toString('base64');
    const result = await verifySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.checksumsValid).toBe(false);
  });

  it('rejects a tampered manifest (signature break)', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: keyPath });
    snapshot.manifest.merkleRoot = crypto.randomBytes(32).toString('hex');
    const result = await verifySnapshot(snapshot);
    expect(result.signatureValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('encrypts entries and round-trips with the passphrase', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), {
      signingKeyPath: keyPath,
      passphrase: 'correct horse battery staple',
    });
    expect(snapshot.manifest.encryptedEntries).toContain('memories.ndjson');
    // Ciphertext should not contain the plaintext
    const raw = Buffer.from(snapshot.entries['memories.ndjson']!, 'base64').toString('utf-8');
    expect(raw).not.toContain('quick brown fox');

    const verified = await verifySnapshot(snapshot, { passphrase: 'correct horse battery staple' });
    expect(verified.valid).toBe(true);

    const records = await snapshotToRecords(snapshot, 'correct horse battery staple');
    expect(records.filter((r) => r.table === 'memories')).toHaveLength(2);
  });

  it('fails decryption with the wrong passphrase (auth tag rejects)', async () => {
    const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), {
      signingKeyPath: keyPath,
      passphrase: 'right-passphrase',
    });
    await expect(snapshotToRecords(snapshot, 'wrong-passphrase')).rejects.toThrow();
  });
});
