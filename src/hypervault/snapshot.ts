/**
 * HyperVault snapshot bundle — `agentvault-hypervault-snapshot-v1`
 *
 * A hypervault snapshot IS a thoughtform-bundle-style envelope (same
 * `entries: path -> base64` layout, gzip(JSON) wire format, per-entry
 * SHA-256 checksums) whose entries carry a full hypervault account export:
 *
 *   memories.ndjson         — live memories (all branches' heads)
 *   mind/commits.ndjson     — memory_commits (full DAG incl. merge parents)
 *   mind/revisions.ndjson   — memory_revisions (full history)
 *   mind/branches.json      — memory_branches
 *   mind/links.ndjson       — memory_links + memory_link_changes
 *   artifacts/<hash>.html   — artifact content, content-addressed
 *   artifacts/index.ndjson  — artifact metadata
 *   connections.ndjson      — artifact graph edges + memory_artifact_links
 *   embeddings.bin          — packed float32 vectors (+ embeddings.idx.json)
 *   conversations.ndjson    — optional (--include conversations)
 *
 * Integrity chain: per-entry SHA-256 → Merkle root (src/backup/merkle.ts)
 * → ed25519 manifest signature (~/.agentvault/arweave-signing.key), the
 * same semantics `ArweaveArchiver.verifyBundle` uses.
 *
 * Encryption uses `CanisterEncryption` (AES-256-GCM with validated auth
 * tags — audit-approved; explicitly NOT the legacy vetkeys.decryptJSON
 * path, see audit finding C-1). Keys are derived from a passphrase with
 * PBKDF2 (210k iterations). Private artifacts are always encrypted even
 * when `encrypt` is not requested (§7.5).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { computeMerkleRoot, type MerkleEntry } from '../backup/merkle.js';
import { loadOrCreateSigningKey } from '../backup/backup.js';
import { createCanisterEncryption, type CanisterEncryptedData } from '../canister/encryption.js';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import {
  hvArtifactSchema,
  hvMemorySchema,
  type HvExportManifest,
  type HvExportRecord,
} from './types.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const HYPERVAULT_SNAPSHOT_FORMAT = 'agentvault-hypervault-snapshot-v1';
export const SNAPSHOT_FILE_EXTENSION = '.hypervault-snapshot.json.gz';

const PBKDF2_ITERATIONS = 210_000;

export interface SnapshotEncryptionInfo {
  /** Key wrapping mode: passphrase (PBKDF2) or vetkeys (canister-derived) */
  mode: 'passphrase' | 'vetkeys';
  algorithm: 'aes-256-gcm';
  salt: string;
  iterations: number;
}

export interface HypervaultSnapshotManifest {
  version: '1.0';
  format: typeof HYPERVAULT_SNAPSHOT_FORMAT;
  createdAt: string;
  schemaVersion: number;
  cursor?: string;
  branchHeads?: Record<string, string>;
  rowCounts: Record<string, number>;
  /** sha256 (hex) of each entry's plaintext bytes */
  checksums: Record<string, string>;
  /** Merkle root over all plaintext entries */
  merkleRoot: string;
  /** Entries stored encrypted (JSON-wrapped AES-256-GCM payloads) */
  encryptedEntries: string[];
  encryption?: SnapshotEncryptionInfo;
  /** Rebuild artifacts intentionally outside the integrity surface (§5.5) */
  derived: string[];
}

export interface HypervaultSnapshot {
  format: typeof HYPERVAULT_SNAPSHOT_FORMAT;
  createdAt: string;
  manifest: HypervaultSnapshotManifest;
  /** ed25519 signature (hex) over canonical manifest bytes */
  signature: string;
  /** ed25519 public key (hex) */
  publicKey: string;
  /** entry path -> base64 content (ciphertext JSON for encrypted entries) */
  entries: Record<string, string>;
}

export interface BuildSnapshotOptions {
  /** Encrypt all entries with a passphrase-derived AES-256-GCM key */
  passphrase?: string;
  /** Include conversations/messages tables (default false — §10.7) */
  includeConversations?: boolean;
  /** Override signing key path (default ~/.agentvault/arweave-signing.key) */
  signingKeyPath?: string;
}

export interface SnapshotVerifyResult {
  valid: boolean;
  checksumsValid: boolean;
  merkleRootValid: boolean;
  signatureValid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface EntryPayload {
  path: string;
  content: Buffer;
  /** force encryption even without a snapshot-level passphrase */
  sensitive: boolean;
}

/**
 * Build a snapshot bundle from export records + export manifest.
 */
export async function buildSnapshot(
  records: HvExportRecord[],
  exportManifest: HvExportManifest,
  options: BuildSnapshotOptions = {},
): Promise<HypervaultSnapshot> {
  const byTable = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }

  const payloads: EntryPayload[] = [];
  const derived: string[] = [];

  const ndjson = (rows: Array<Record<string, unknown>>): Buffer =>
    Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8');

  // Memories (embeddings split out into the packed sidecar)
  const memories = byTable.get('memories') ?? [];
  const embeddingRows: Array<{ id: string; embedding: number[]; model?: string }> = [];
  const memoriesForEntry = memories.map((row) => {
    const parsed = hvMemorySchema.safeParse(row);
    if (parsed.success && parsed.data.embedding && parsed.data.embedding.length > 0) {
      embeddingRows.push({
        id: parsed.data.id,
        embedding: parsed.data.embedding,
        model: parsed.data.embedding_model,
      });
      return omitKeys(row, ['embedding']);
    }
    return row;
  });
  payloads.push({ path: 'memories.ndjson', content: ndjson(memoriesForEntry), sensitive: false });

  // Mind DAG
  payloads.push({ path: 'mind/commits.ndjson', content: ndjson(byTable.get('memory_commits') ?? []), sensitive: false });
  payloads.push({ path: 'mind/revisions.ndjson', content: ndjson(byTable.get('memory_revisions') ?? []), sensitive: false });
  payloads.push({
    path: 'mind/branches.json',
    content: Buffer.from(JSON.stringify(byTable.get('memory_branches') ?? [], null, 2) + '\n', 'utf-8'),
    sensitive: false,
  });
  payloads.push({
    path: 'mind/links.ndjson',
    content: ndjson([...(byTable.get('memory_links') ?? []), ...(byTable.get('memory_link_changes') ?? [])]),
    sensitive: false,
  });

  // Artifacts — content-addressed, private artifacts always encrypted (§7.5)
  const artifactRows = byTable.get('artifacts') ?? [];
  const artifactIndex: Array<Record<string, unknown>> = [];
  for (const row of artifactRows) {
    const parsed = hvArtifactSchema.safeParse(row);
    if (!parsed.success) {
      artifactIndex.push(row);
      continue;
    }
    const artifact = parsed.data;
    const contentHash =
      artifact.content_hash ?? crypto.createHash('sha256').update(artifact.content, 'utf-8').digest('hex');
    const entryPath = `artifacts/${sanitizeHash(contentHash)}.html`;
    payloads.push({
      path: entryPath,
      content: Buffer.from(artifact.content, 'utf-8'),
      sensitive: artifact.visibility === 'private',
    });
    artifactIndex.push({ ...omitKeys(row, ['content']), content_hash: contentHash, entry: entryPath });
  }
  payloads.push({ path: 'artifacts/index.ndjson', content: ndjson(artifactIndex), sensitive: false });

  // Connections + memory<->artifact links
  payloads.push({
    path: 'connections.ndjson',
    content: ndjson([...(byTable.get('connections') ?? []), ...(byTable.get('memory_artifact_links') ?? [])]),
    sensitive: false,
  });

  // Embeddings — packed float32 + id/model sidecar
  if (embeddingRows.length > 0) {
    const dims = embeddingRows[0]?.embedding.length ?? 0;
    const packed = Buffer.alloc(embeddingRows.length * dims * 4);
    embeddingRows.forEach((row, i) => {
      row.embedding.forEach((v, j) => packed.writeFloatLE(v, (i * dims + j) * 4));
    });
    payloads.push({ path: 'embeddings.bin', content: packed, sensitive: false });
    payloads.push({
      path: 'embeddings.idx.json',
      content: Buffer.from(
        JSON.stringify(
          {
            dims,
            model: embeddingRows[0]?.model,
            ids: embeddingRows.map((r) => r.id),
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      ),
      sensitive: false,
    });
  }

  // Conversations — opt-in and always sensitive (§10.7)
  if (options.includeConversations) {
    const conversations = [...(byTable.get('conversations') ?? []), ...(byTable.get('messages') ?? [])];
    payloads.push({ path: 'conversations.ndjson', content: ndjson(conversations), sensitive: true });
  }

  // Integrity surface over PLAINTEXT bytes
  const merkleEntries: MerkleEntry[] = payloads.map((p) => ({ path: p.path, content: p.content }));
  const checksums: Record<string, string> = {};
  for (const p of payloads) {
    checksums[p.path] = sha256(p.content);
  }
  const merkleRoot = computeMerkleRoot(merkleEntries);

  // Encryption
  const entries: Record<string, string> = {};
  const encryptedEntries: string[] = [];
  let encryption: SnapshotEncryptionInfo | undefined;
  const mustEncrypt = payloads.some((p) => p.sensitive);
  let key: Buffer | undefined;

  if (options.passphrase || mustEncrypt) {
    if (!options.passphrase) {
      throw new Error(
        'Snapshot contains private artifacts or conversations; a passphrase is required (they are always encrypted)',
      );
    }
    const salt = crypto.randomBytes(32);
    key = crypto.pbkdf2Sync(options.passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');
    encryption = {
      mode: 'passphrase',
      algorithm: 'aes-256-gcm',
      salt: salt.toString('hex'),
      iterations: PBKDF2_ITERATIONS,
    };
  }

  const encryptAll = Boolean(options.passphrase);
  const cipher = createCanisterEncryption({ algorithm: 'aes-256-gcm' });
  for (const p of payloads) {
    if (key && (encryptAll || p.sensitive)) {
      const result = await cipher.encrypt(p.content.toString('base64'), key);
      if (!result.success || !result.encrypted) {
        throw new Error(`Failed to encrypt snapshot entry ${p.path}: ${result.error ?? 'unknown error'}`);
      }
      entries[p.path] = Buffer.from(JSON.stringify(serializeEncrypted(result.encrypted)), 'utf-8').toString('base64');
      encryptedEntries.push(p.path);
    } else {
      entries[p.path] = p.content.toString('base64');
    }
  }

  const manifest: HypervaultSnapshotManifest = {
    version: '1.0',
    format: HYPERVAULT_SNAPSHOT_FORMAT,
    createdAt: new Date().toISOString(),
    schemaVersion: exportManifest.schema_version,
    cursor: exportManifest.cursor,
    branchHeads: exportManifest.branch_heads,
    rowCounts: exportManifest.row_counts,
    checksums,
    merkleRoot,
    encryptedEntries,
    encryption,
    derived,
  };

  // Sign the canonical manifest with the archival ed25519 key
  const { privateKey, publicKey } = await loadOrCreateSigningKey(
    options.signingKeyPath ?? defaultSigningKeyPath(),
  );
  const { ed25519 } = await import('@noble/curves/ed25519');
  const signature = Buffer.from(ed25519.sign(canonicalManifestBytes(manifest), privateKey)).toString('hex');

  return {
    format: HYPERVAULT_SNAPSHOT_FORMAT,
    createdAt: manifest.createdAt,
    manifest,
    signature,
    publicKey: publicKey.toString('hex'),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Serialize / deserialize
// ---------------------------------------------------------------------------

export async function writeSnapshot(snapshot: HypervaultSnapshot, filePath: string): Promise<number> {
  const compressed = await gzip(Buffer.from(JSON.stringify(snapshot), 'utf-8'));
  atomicWriteFileSync(filePath, compressed, { mode: 0o600 });
  return fs.statSync(filePath).size;
}

export async function readSnapshot(filePath: string): Promise<HypervaultSnapshot> {
  const raw = fs.readFileSync(filePath);
  const json = await gunzip(raw);
  const data = JSON.parse(json.toString('utf-8')) as unknown;
  validateSnapshot(data);
  return data;
}

export function validateSnapshot(data: unknown): asserts data is HypervaultSnapshot {
  if (!data || typeof data !== 'object') {
    throw new Error('Snapshot is not an object');
  }
  const bundle = data as Partial<HypervaultSnapshot>;
  if (bundle.format !== HYPERVAULT_SNAPSHOT_FORMAT) {
    throw new Error(`Unknown snapshot format: ${String(bundle.format)} (expected ${HYPERVAULT_SNAPSHOT_FORMAT})`);
  }
  if (!bundle.manifest || typeof bundle.manifest !== 'object') {
    throw new Error('Snapshot is missing its manifest');
  }
  if (!bundle.entries || typeof bundle.entries !== 'object') {
    throw new Error('Snapshot is missing its entries');
  }
  if (typeof bundle.signature !== 'string' || typeof bundle.publicKey !== 'string') {
    throw new Error('Snapshot is missing its manifest signature');
  }
}

// ---------------------------------------------------------------------------
// Verify — checks every link of the integrity chain (§7.3)
// ---------------------------------------------------------------------------

export async function verifySnapshot(
  snapshot: HypervaultSnapshot,
  options: { passphrase?: string; expectedPublicKey?: string } = {},
): Promise<SnapshotVerifyResult> {
  const errors: string[] = [];

  // 1. ed25519 signature over the canonical manifest
  let signatureValid = false;
  try {
    const { ed25519 } = await import('@noble/curves/ed25519');
    signatureValid = ed25519.verify(
      Buffer.from(snapshot.signature, 'hex'),
      canonicalManifestBytes(snapshot.manifest),
      Buffer.from(snapshot.publicKey, 'hex'),
    );
    if (!signatureValid) errors.push('Manifest signature verification failed');
    if (options.expectedPublicKey && options.expectedPublicKey !== snapshot.publicKey) {
      signatureValid = false;
      errors.push('Snapshot public key does not match the expected key');
    }
  } catch (error) {
    errors.push(`Signature check error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Per-entry checksums + 3. Merkle root — need plaintext, so decrypt
  //    encrypted entries when a passphrase is available.
  let checksumsValid = true;
  let merkleRootValid = false;
  const plaintexts: MerkleEntry[] = [];
  const encrypted = new Set(snapshot.manifest.encryptedEntries);
  const canDecrypt = Boolean(options.passphrase && snapshot.manifest.encryption);

  for (const [entryPath, b64] of Object.entries(snapshot.entries)) {
    let plaintext: Buffer | null = null;
    if (encrypted.has(entryPath)) {
      if (!canDecrypt) continue; // cannot check without the passphrase
      try {
        plaintext = await decryptEntry(snapshot, entryPath, options.passphrase!);
      } catch (error) {
        checksumsValid = false;
        errors.push(`Failed to decrypt entry ${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    } else {
      plaintext = Buffer.from(b64, 'base64');
    }
    const expected = snapshot.manifest.checksums[entryPath];
    if (!expected) {
      checksumsValid = false;
      errors.push(`Entry ${entryPath} is not listed in the manifest checksums`);
      continue;
    }
    if (sha256(plaintext) !== expected) {
      checksumsValid = false;
      errors.push(`Checksum mismatch for entry ${entryPath}`);
    }
    plaintexts.push({ path: entryPath, content: plaintext });
  }

  for (const entryPath of Object.keys(snapshot.manifest.checksums)) {
    if (!(entryPath in snapshot.entries)) {
      checksumsValid = false;
      errors.push(`Entry ${entryPath} referenced in manifest is missing from the snapshot`);
    }
  }

  const allPlaintextAvailable = plaintexts.length === Object.keys(snapshot.manifest.checksums).length;
  if (allPlaintextAvailable) {
    merkleRootValid = computeMerkleRoot(plaintexts) === snapshot.manifest.merkleRoot;
    if (!merkleRootValid) errors.push('Merkle root mismatch');
  } else if (encrypted.size > 0 && !canDecrypt) {
    // Signature still binds the Merkle root; report it as unverifiable.
    merkleRootValid = checksumsValid;
    errors.push('Encrypted entries present and no passphrase supplied; Merkle root only partially verified');
  }

  return {
    valid: signatureValid && checksumsValid && merkleRootValid && errors.length === 0,
    checksumsValid,
    merkleRootValid,
    signatureValid,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Entry access & restore
// ---------------------------------------------------------------------------

/** Read one entry's plaintext (decrypting when needed). */
export async function readSnapshotEntry(
  snapshot: HypervaultSnapshot,
  entryPath: string,
  passphrase?: string,
): Promise<Buffer> {
  const b64 = snapshot.entries[entryPath];
  if (b64 === undefined) {
    throw new Error(`Snapshot has no entry ${entryPath}`);
  }
  if (snapshot.manifest.encryptedEntries.includes(entryPath)) {
    if (!passphrase) {
      throw new Error(`Entry ${entryPath} is encrypted; a passphrase is required`);
    }
    return decryptEntry(snapshot, entryPath, passphrase);
  }
  return Buffer.from(b64, 'base64');
}

/**
 * Convert a snapshot back into export records — the reverse of
 * `buildSnapshot` — for `importVault` (chain → cloud resurrection) or a
 * local working-tree rebuild.
 */
export async function snapshotToRecords(
  snapshot: HypervaultSnapshot,
  passphrase?: string,
): Promise<HvExportRecord[]> {
  const records: HvExportRecord[] = [];

  const readNdjson = async (entryPath: string): Promise<Array<Record<string, unknown>>> => {
    if (!(entryPath in snapshot.entries)) return [];
    const text = (await readSnapshotEntry(snapshot, entryPath, passphrase)).toString('utf-8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  // Memories, re-joined with embeddings
  const embeddingsById = await readEmbeddings(snapshot, passphrase);
  for (const row of await readNdjson('memories.ndjson')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    const embedding = id ? embeddingsById.get(id) : undefined;
    records.push({ table: 'memories', row: embedding ? { ...row, embedding } : row });
  }

  for (const row of await readNdjson('mind/commits.ndjson')) records.push({ table: 'memory_commits', row });
  for (const row of await readNdjson('mind/revisions.ndjson')) records.push({ table: 'memory_revisions', row });
  for (const row of await readNdjson('mind/links.ndjson')) records.push({ table: 'memory_links', row });
  if ('mind/branches.json' in snapshot.entries) {
    const branches = JSON.parse(
      (await readSnapshotEntry(snapshot, 'mind/branches.json', passphrase)).toString('utf-8'),
    ) as Array<Record<string, unknown>>;
    for (const row of branches) records.push({ table: 'memory_branches', row });
  }

  // Artifacts, re-joined with their content entries
  for (const row of await readNdjson('artifacts/index.ndjson')) {
    const entry = typeof row.entry === 'string' ? row.entry : undefined;
    let content: string | undefined;
    if (entry && entry in snapshot.entries) {
      content = (await readSnapshotEntry(snapshot, entry, passphrase)).toString('utf-8');
    }
    const rest = omitKeys(row, ['entry']);
    records.push({ table: 'artifacts', row: content !== undefined ? { ...rest, content } : rest });
  }

  for (const row of await readNdjson('connections.ndjson')) records.push({ table: 'connections', row });
  for (const row of await readNdjson('conversations.ndjson')) records.push({ table: 'conversations', row });

  return records;
}

/** Read the packed embeddings sidecar back into per-memory vectors. */
export async function readEmbeddings(
  snapshot: HypervaultSnapshot,
  passphrase?: string,
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (!('embeddings.bin' in snapshot.entries) || !('embeddings.idx.json' in snapshot.entries)) {
    return result;
  }
  const idx = JSON.parse(
    (await readSnapshotEntry(snapshot, 'embeddings.idx.json', passphrase)).toString('utf-8'),
  ) as { dims: number; ids: string[]; model?: string };
  const packed = await readSnapshotEntry(snapshot, 'embeddings.bin', passphrase);
  idx.ids.forEach((id, i) => {
    const vector: number[] = [];
    for (let j = 0; j < idx.dims; j++) {
      vector.push(packed.readFloatLE((i * idx.dims + j) * 4));
    }
    result.set(id, vector);
  });
  return result;
}

/** The embedding model recorded in the snapshot sidecar, if any. */
export async function snapshotEmbeddingModel(
  snapshot: HypervaultSnapshot,
  passphrase?: string,
): Promise<string | undefined> {
  if (!('embeddings.idx.json' in snapshot.entries)) return undefined;
  const idx = JSON.parse(
    (await readSnapshotEntry(snapshot, 'embeddings.idx.json', passphrase)).toString('utf-8'),
  ) as { model?: string };
  return idx.model;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function decryptEntry(
  snapshot: HypervaultSnapshot,
  entryPath: string,
  passphrase: string,
): Promise<Buffer> {
  const info = snapshot.manifest.encryption;
  if (!info) {
    throw new Error('Snapshot manifest is missing encryption parameters');
  }
  const key = crypto.pbkdf2Sync(passphrase, Buffer.from(info.salt, 'hex'), info.iterations, 32, 'sha256');
  const wrapped = JSON.parse(Buffer.from(snapshot.entries[entryPath]!, 'base64').toString('utf-8')) as SerializedEncrypted;
  const cipher = createCanisterEncryption({ algorithm: 'aes-256-gcm' });
  const result = await cipher.decrypt(deserializeEncrypted(wrapped), key);
  if (!result.success || result.decrypted === undefined) {
    throw new Error(result.error ?? 'decryption failed (wrong passphrase or tampered entry)');
  }
  return Buffer.from(result.decrypted, 'base64');
}

interface SerializedEncrypted {
  ciphertext: string;
  iv: string;
  tag: string;
  algorithm: 'aes-256-gcm' | 'chacha20-poly1305';
  timestamp: number;
}

function serializeEncrypted(data: CanisterEncryptedData): SerializedEncrypted {
  return {
    ciphertext: Buffer.from(data.ciphertext).toString('hex'),
    iv: Buffer.from(data.iv).toString('hex'),
    tag: Buffer.from(data.tag).toString('hex'),
    algorithm: data.algorithm,
    timestamp: data.timestamp,
  };
}

function deserializeEncrypted(data: SerializedEncrypted): CanisterEncryptedData {
  return {
    ciphertext: new Uint8Array(Buffer.from(data.ciphertext, 'hex')),
    iv: new Uint8Array(Buffer.from(data.iv, 'hex')),
    tag: new Uint8Array(Buffer.from(data.tag, 'hex')),
    algorithm: data.algorithm,
    timestamp: data.timestamp,
  };
}

/** Canonical manifest bytes: alphabetically sorted keys (ArweaveArchiver idiom) */
export function canonicalManifestBytes(manifest: HypervaultSnapshotManifest): Buffer {
  const sorted = Object.keys(manifest)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      const value = (manifest as unknown as Record<string, unknown>)[k];
      if (value !== undefined) acc[k] = value;
      return acc;
    }, {});
  return Buffer.from(JSON.stringify(sorted), 'utf-8');
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function omitKeys(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!keys.includes(k)) result[k] = v;
  }
  return result;
}

function sanitizeHash(hash: string): string {
  return hash.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function defaultSigningKeyPath(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  return path.join(home, '.agentvault', 'arweave-signing.key');
}
