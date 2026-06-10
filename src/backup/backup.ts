/**
 * Backup System
 *
 * Portable JSON format backup with embedded manifest and checksums
 * Stores backups in ~/.agentvault/backups/
 * CLE-101: Enhanced to include real canister state
 * CLE-MRB: Full backup adds SHA-256 Merkle root and ed25519-signed AES-256-GCM key
 * Encrypted full-state export: zip.enc (AES-256-GCM + PBKDF2) with optional
 * Arweave manifest upload and a restore flow that redeploys a fresh canister.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execa } from 'execa';
import type { AgentConfig } from '../packaging/types.js';
import { computeMerkleRoot, computeLeafHashes, type MerkleEntry } from './merkle.js';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { ArweaveClient, type JWKInterface } from '../archival/arweave-client.js';
import { deployAgent } from '../deployment/deployer.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const BACKUPS_DIR = path.join(AGENTVAULT_DIR, 'backups');
const ENCRYPTION_VERSION = 'enc-v1';

function ensureBackupsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function safeCopyDir(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(srcDir)) {
    return false;
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  return true;
}

function writeEncryptedFile(sourcePath: string, outputPath: string, passphrase: string): { sha256: string; size: number } {
  const plaintext = fs.readFileSync(sourcePath);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 210000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    version: ENCRYPTION_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: 210000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  const data = JSON.stringify(payload, null, 2);
  fs.writeFileSync(outputPath, data, 'utf8');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return { sha256, size: Buffer.byteLength(data) };
}

function decryptToZip(encryptedPath: string, outputZipPath: string, passphrase: string): void {
  const data = fs.readFileSync(encryptedPath, 'utf8');
  const payload = JSON.parse(data) as {
    version: string;
    iterations: number;
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };

  if (payload.version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encrypted backup format: ${payload.version}`);
  }

  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const key = crypto.pbkdf2Sync(passphrase, salt, payload.iterations, 32, 'sha256');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  fs.writeFileSync(outputZipPath, plaintext);
}

/**
 * Canister state captured in backup
 */
export interface CanisterState {
  canisterId: string;
  status: 'running' | 'stopped' | 'stopping';
  memorySize?: bigint;
  cycles?: bigint;
  moduleHash?: string;
  fetchedAt: string;
  tasks?: unknown[];
  memory?: unknown;
  context?: unknown;
}

export interface EncryptedKeyEnvelope {
  /** AES-256-GCM-wrapped data-encryption key: hex-encoded ciphertext */
  ciphertext: string;
  /** 12-byte IV used to wrap the key: hex */
  iv: string;
  /** 16-byte GCM auth tag: hex */
  tag: string;
}

export interface BackupManifest {
  version: string;
  agentName: string;
  timestamp: Date;
  created: Date;
  agentConfig?: AgentConfig;
  canisterId?: string;
  canisterState?: CanisterState;
  checksums: Record<string, string>;
  size: number;
  components: string[];
  /** Path to the local encrypted full-state zip (encrypted exports only). */
  localEncryptedZipPath?: string;
  /** Arweave transaction ID of the uploaded manifest (encrypted exports only). */
  arweaveManifestTxId?: string;
  /** SHA-256 of the encrypted zip payload (encrypted exports only). */
  encryptedZipSha256?: string;
  /**
   * SHA-256 Merkle root of all backup entries (sorted by path).
   * Present only in full backups (--full flag).
   */
  merkleRoot?: string;
  /**
   * AES-256-GCM data-encryption key wrapped with a key derived from
   * the ed25519 signing key via HKDF-SHA256.
   * Present only in full backups.
   */
  encryptedKey?: EncryptedKeyEnvelope;
  /**
   * ed25519 signature (hex) over the raw bytes of encryptedKey
   * (ciphertext || iv || tag). Allows verifying the key has not been
   * swapped without decrypting it.
   * Present only in full backups.
   */
  keySignature?: string;
  /**
   * ed25519 public key (hex) corresponding to the signing key.
   * Present only in full backups.
   */
  ed25519PublicKey?: string;
}

export interface BackupOptions {
  agentName: string;
  outputPath?: string;
  includeConfig?: boolean;
  canisterId?: string;
  includeCanisterState?: boolean;
}

export interface FullBackupOptions extends BackupOptions {
  /**
   * Path to the 32-byte ed25519 private key stored as hex.
   * Defaults to ~/.agentvault/backup-signing.key.
   * If the file does not exist, a new keypair is generated and saved.
   */
  signingKeyPath?: string;
}

export interface EncryptedBackupOptions extends BackupOptions {
  /** Passphrase used to derive the AES-256-GCM key (PBKDF2-SHA256). */
  passphrase: string;
  /** Path to an Arweave JWK; when set, the manifest is uploaded to Arweave. */
  arweaveJwkPath?: string;
  /** Optional WASM module to bundle so restore can redeploy a canister. */
  wasmPath?: string;
}

export interface ImportOptions {
  inputPath: string;
  targetAgentName?: string;
  overwrite?: boolean;
}

export interface FullRestoreOptions {
  zipPath: string;
  passphrase: string;
  network?: string;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  error?: string;
  sizeBytes?: number;
  manifest?: BackupManifest;
}

export interface FullBackupResult extends BackupResult {
  /** SHA-256 Merkle root of all backup entries */
  merkleRoot?: string;
  /** ed25519 public key (hex) used to sign the wrapped AES key */
  ed25519PublicKey?: string;
}

export interface FullRestoreResult {
  success: boolean;
  error?: string;
  deployedCanisterId?: string;
  restoredPath?: string;
}

export interface ImportResult {
  success: boolean;
  agentName?: string;
  error?: string;
  components: string[];
  warnings: string[];
}

async function uploadManifestToArweave(manifest: BackupManifest, encryptedZipSha256: string, jwkPath?: string): Promise<string | undefined> {
  if (!jwkPath) {
    return undefined;
  }

  const raw = fs.readFileSync(jwkPath, 'utf8');
  const jwk = JSON.parse(raw) as JWKInterface;
  const client = new ArweaveClient();

  const result = await client.uploadJSON({ manifest, encryptedZipSha256 }, jwk, {
    tags: {
      'App-Name': 'AgentVault',
      'Backup-Type': 'full-state-manifest',
      'Agent-Name': manifest.agentName,
    },
  });

  if (!result.success || !result.transactionId) {
    throw new Error(result.error || 'Arweave manifest upload failed');
  }

  return result.transactionId;
}

/**
 * Fetch canister state for backup
 */
async function fetchCanisterState(canisterId: string): Promise<CanisterState | null> {
  try {
    const { createICPClient } = await import('../deployment/icpClient.js');
    const client = createICPClient({ network: 'local' });

    const status = await client.getCanisterStatus(canisterId);

    const statusMap: Record<string, 'running' | 'stopped' | 'stopping'> = {
      running: 'running',
      stopped: 'stopped',
      stopping: 'stopping',
      pending: 'stopped',
    };

    const state: CanisterState = {
      canisterId,
      status: statusMap[status.status] || 'stopped',
      memorySize: status.memorySize,
      cycles: status.cycles,
      fetchedAt: new Date().toISOString(),
    };

    try {
      const tasksResult = await client.callAgentMethod(canisterId, 'getTasks', []);
      if (tasksResult) {
        state.tasks = tasksResult as unknown[];
      }
    } catch {
      // Tasks not available
    }

    try {
      const memoryResult = await client.callAgentMethod(canisterId, 'getMemory', []);
      if (memoryResult) {
        state.memory = memoryResult;
      }
    } catch {
      // Memory not available
    }

    try {
      const contextResult = await client.callAgentMethod(canisterId, 'getContext', []);
      if (contextResult) {
        state.context = contextResult;
      }
    } catch {
      // Context not available
    }

    return state;
  } catch (error) {
    console.warn('Failed to fetch canister state:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full-backup cryptographic helpers
// ---------------------------------------------------------------------------

const SIGNING_KEY_FILENAME = 'backup-signing.key';

/**
 * Load or create an ed25519 private key (32 raw bytes) stored as hex at
 * `keyPath`.  Returns { privateKey, publicKey } as Buffers.
 */
export async function loadOrCreateSigningKey(
  keyPath: string
): Promise<{ privateKey: Buffer; publicKey: Buffer }> {
  const { ed25519 } = await import('@noble/curves/ed25519');

  let privKeyHex: string;

  if (fs.existsSync(keyPath)) {
    privKeyHex = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(privKeyHex)) {
      throw new Error(`Signing key at ${keyPath} is not valid 32-byte hex`);
    }
  } else {
    // Generate new key and persist it
    const raw = crypto.randomBytes(32);
    privKeyHex = raw.toString('hex');
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // SEC-17: atomic write — a signing key MUST NOT exist in a half-written
    // state, otherwise subsequent loads would corrupt key material.
    atomicWriteFileSync(keyPath, privKeyHex, { encoding: 'utf8', mode: 0o600 });
  }

  const privateKey = Buffer.from(privKeyHex, 'hex');
  const publicKey = Buffer.from(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey };
}

/**
 * Derive a 32-byte AES key-wrapping key from an ed25519 private key using
 * HKDF-SHA256.  Using a separate wrapping key means the signing key is never
 * used directly for symmetric encryption.
 */
function deriveWrappingKey(privateKey: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    privateKey,
    Buffer.from('agentvault-backup-key-wrapping'),
    Buffer.from('backup-key-wrapping-v1'),
    32
  ));
}

/**
 * Encrypt `plaintext` with AES-256-GCM using `key`.
 * Returns { ciphertext, iv, tag } all as Buffers.
 */
function aesGcmEncrypt(
  plaintext: Buffer,
  key: Buffer
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Create a full encrypted backup zip.
 *
 * Steps:
 *  1. Collect backup entries (logical files).
 *  2. Compute SHA-256 Merkle root of all entries.
 *  3. Generate a random 32-byte AES-256-GCM data-encryption key.
 *  4. Encrypt the backup payload with that key.
 *  5. Wrap (encrypt) the data key with a key derived from the ed25519 signing key.
 *  6. Sign the wrapped-key bytes (ciphertext || iv || tag) with ed25519.
 *  7. Write a JSON-envelope backup file containing the manifest + ciphertext.
 */
export async function fullBackup(options: FullBackupOptions): Promise<FullBackupResult> {
  try {
    ensureBackupsDir();

    const {
      agentName,
      outputPath,
      includeConfig = true,
      canisterId,
      includeCanisterState = false,
      signingKeyPath = path.join(AGENTVAULT_DIR, SIGNING_KEY_FILENAME),
    } = options;

    const { ed25519 } = await import('@noble/curves/ed25519');

    // ------------------------------------------------------------------
    // 1. Load or create ed25519 signing key
    // ------------------------------------------------------------------
    const { privateKey, publicKey } = await loadOrCreateSigningKey(signingKeyPath);

    // ------------------------------------------------------------------
    // 2. Collect backup entries
    // ------------------------------------------------------------------
    const entries: MerkleEntry[] = [];
    const components: string[] = [];

    // Config / agent identity entry (stub – real config loader can be wired in)
    if (includeConfig) {
      const configPayload = JSON.stringify({ agentName, canisterId: canisterId ?? agentName }, null, 2);
      entries.push({ path: 'config.json', content: Buffer.from(configPayload, 'utf8') });
      components.push('config');
    }

    // Optional live canister state
    let canisterState: CanisterState | undefined;
    if (includeCanisterState && canisterId) {
      const state = await fetchCanisterState(canisterId);
      if (state) {
        canisterState = state;
        const statePayload = JSON.stringify(state, null, 2);
        entries.push({ path: 'canister-state.json', content: Buffer.from(statePayload, 'utf8') });
        components.push('canister-state');
      }
    }

    // ------------------------------------------------------------------
    // 3. Compute Merkle root & per-file leaf hashes
    // ------------------------------------------------------------------
    const merkleRoot = computeMerkleRoot(entries);
    const leafHashes = computeLeafHashes(entries);

    // ------------------------------------------------------------------
    // 4. Build manifest (without size yet)
    // ------------------------------------------------------------------
    const now = new Date();
    const manifest: BackupManifest = {
      version: '2.0',
      agentName,
      timestamp: now,
      created: now,
      canisterId: canisterId ?? agentName,
      canisterState,
      checksums: leafHashes,
      size: 0,
      components,
      merkleRoot,
      ed25519PublicKey: publicKey.toString('hex'),
    };

    // ------------------------------------------------------------------
    // 5. Encrypt the payload (all entries as a single JSON bundle)
    // ------------------------------------------------------------------
    const payloadObj: Record<string, string> = {};
    for (const entry of entries) {
      payloadObj[entry.path] = entry.content.toString('base64');
    }
    const payloadJson = Buffer.from(JSON.stringify(payloadObj), 'utf8');

    const dataKey = crypto.randomBytes(32);
    const {
      ciphertext: encPayload,
      iv: payloadIv,
      tag: payloadTag,
    } = aesGcmEncrypt(payloadJson, dataKey);

    // ------------------------------------------------------------------
    // 6. Wrap the data key with HKDF-derived wrapping key
    // ------------------------------------------------------------------
    const wrappingKey = deriveWrappingKey(privateKey);
    const {
      ciphertext: wrappedKeyCt,
      iv: wrapIv,
      tag: wrapTag,
    } = aesGcmEncrypt(dataKey, wrappingKey);

    // ------------------------------------------------------------------
    // 7. Sign the wrapped-key envelope bytes with ed25519
    // ------------------------------------------------------------------
    const wrappedKeyBytes = Buffer.concat([wrappedKeyCt, wrapIv, wrapTag]);
    const signature = Buffer.from(ed25519.sign(wrappedKeyBytes, privateKey));

    manifest.encryptedKey = {
      ciphertext: wrappedKeyCt.toString('hex'),
      iv: wrapIv.toString('hex'),
      tag: wrapTag.toString('hex'),
    };
    manifest.keySignature = signature.toString('hex');

    // ------------------------------------------------------------------
    // 8. Serialise to disk as a JSON-envelope ".zip" file
    // ------------------------------------------------------------------
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const filename = outputPath
      ? path.basename(outputPath)
      : `${agentName}-${timestamp}-full.zip`;
    const filePath = outputPath || path.join(BACKUPS_DIR, filename);

    const archive = {
      format: 'agentvault-full-backup-v1',
      manifest,
      encryptedPayload: {
        ciphertext: encPayload.toString('hex'),
        iv: payloadIv.toString('hex'),
        tag: payloadTag.toString('hex'),
      },
    };

    // SEC-17: atomic write prevents a partial backup file on crash
    atomicWriteFileSync(filePath, JSON.stringify(archive, null, 2), { encoding: 'utf8' });

    const stats = fs.statSync(filePath);
    manifest.size = stats.size;

    return {
      success: true,
      path: filePath,
      sizeBytes: stats.size,
      manifest,
      merkleRoot,
      ed25519PublicKey: publicKey.toString('hex'),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function exportBackup(options: BackupOptions): Promise<BackupResult> {
  try {
    ensureBackupsDir();

    const { agentName, outputPath, includeConfig = true, canisterId, includeCanisterState = true } = options;

    const timestamp = new Date();
    const created = new Date();
    const filename = `${agentName}-${timestamp.toISOString().replace(/[:.]/g, '-')}.json`;
    const filePath = outputPath || path.join(BACKUPS_DIR, filename);

    const components: string[] = [];
    if (includeConfig) {
      components.push('config');
    }

    const manifest: BackupManifest = {
      version: '1.1',
      agentName,
      timestamp,
      created,
      checksums: {},
      size: 0,
      components,
    };

    if (includeConfig) {
      manifest.canisterId = canisterId || agentName;
    }

    if (includeCanisterState && canisterId) {
      const canisterState = await fetchCanisterState(canisterId);
      if (canisterState) {
        manifest.canisterState = canisterState;
        manifest.canisterId = canisterId;
        components.push('canister-state');
      }
    }

    const content = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    manifest.checksums[filename] = checksum;

    // SEC-17: atomic write prevents a partial backup file on crash
    atomicWriteFileSync(filePath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });

    const stats = fs.statSync(filePath);
    manifest.size = stats.size;

    return {
      success: true,
      path: filePath,
      sizeBytes: stats.size,
      manifest,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Export a full-state encrypted backup (.zip.enc).
 *
 * Stages agent state, encrypted keys, logs, dependencies and an optional WASM
 * module, zips the payload, encrypts it with AES-256-GCM (PBKDF2-SHA256 key
 * derivation) and writes SHA-256 checksums.  The encrypted zip stays local;
 * when an Arweave JWK is provided only the manifest + zip hash are uploaded.
 * A plaintext sidecar manifest (.manifest.json) is written next to the zip so
 * listing/preview keep working.
 */
export async function exportEncryptedBackup(options: EncryptedBackupOptions): Promise<BackupResult> {
  try {
    ensureBackupsDir();

    const {
      agentName,
      outputPath,
      includeConfig = true,
      canisterId,
      includeCanisterState = true,
      passphrase,
      arweaveJwkPath,
      wasmPath,
    } = options;

    const timestamp = new Date();
    const created = new Date();
    const basename = `${agentName}-${timestamp.toISOString().replace(/[:.]/g, '-')}`;
    const encryptedPath = outputPath || path.join(BACKUPS_DIR, `${basename}.zip.enc`);

    const components: string[] = [];
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-backup-'));
    const stagedRoot = path.join(tempRoot, 'payload');
    fs.mkdirSync(stagedRoot, { recursive: true });

    try {
      const vaultAgentDir = path.join(AGENTVAULT_DIR, 'agents', agentName);
      if (safeCopyDir(vaultAgentDir, path.join(stagedRoot, 'state', 'agents', agentName))) {
        components.push('state');
      }

      const walletsDir = path.join(AGENTVAULT_DIR, 'wallets', agentName);
      if (safeCopyDir(walletsDir, path.join(stagedRoot, 'encrypted-keys', 'wallets', agentName))) {
        components.push('encrypted-keys');
      }

      const logsDir = path.join(AGENTVAULT_DIR, 'logs');
      if (safeCopyDir(logsDir, path.join(stagedRoot, 'logs'))) {
        components.push('logs');
      }

      const depsDir = path.join(process.cwd(), 'node_modules');
      if (safeCopyDir(depsDir, path.join(stagedRoot, 'deps', 'node_modules'))) {
        components.push('deps');
      }

      if (wasmPath && fs.existsSync(wasmPath)) {
        fs.mkdirSync(path.join(stagedRoot, 'deployment'), { recursive: true });
        fs.copyFileSync(wasmPath, path.join(stagedRoot, 'deployment', path.basename(wasmPath)));
        components.push('wasm');
      }

      const manifest: BackupManifest = {
        version: '2.0',
        agentName,
        timestamp,
        created,
        checksums: {},
        size: 0,
        components,
      };

      if (includeConfig) {
        manifest.canisterId = canisterId || agentName;
      }

      if (includeCanisterState && canisterId) {
        const canisterState = await fetchCanisterState(canisterId);
        if (canisterState) {
          manifest.canisterState = canisterState;
          manifest.canisterId = canisterId;
          if (!components.includes('canister-state')) {
            components.push('canister-state');
          }
        }
      }

      const manifestPath = path.join(stagedRoot, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const rawZipPath = path.join(tempRoot, `${basename}.zip`);
      await execa('zip', ['-r', rawZipPath, '.'], { cwd: stagedRoot });

      const encrypted = writeEncryptedFile(rawZipPath, encryptedPath, passphrase);
      manifest.localEncryptedZipPath = encryptedPath;
      manifest.encryptedZipSha256 = encrypted.sha256;
      manifest.size = encrypted.size;
      manifest.checksums[path.basename(encryptedPath)] = encrypted.sha256;

      const txId = await uploadManifestToArweave(manifest, encrypted.sha256, arweaveJwkPath);
      if (txId) {
        manifest.arweaveManifestTxId = txId;
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      const localManifestPath = encryptedPath.replace(/\.zip\.enc$/, '.manifest.json');
      fs.writeFileSync(localManifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      return {
        success: true,
        path: encryptedPath,
        sizeBytes: encrypted.size,
        manifest,
      };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function restoreFromEncryptedZip(options: FullRestoreOptions): Promise<FullRestoreResult> {
  const { zipPath, passphrase, network = 'local' } = options;
  try {
    if (!fs.existsSync(zipPath)) {
      return { success: false, error: `Backup zip not found: ${zipPath}` };
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-restore-'));
    const decryptedZip = path.join(tempRoot, 'payload.zip');
    const extractedDir = path.join(tempRoot, 'extracted');
    fs.mkdirSync(extractedDir, { recursive: true });

    try {
      decryptToZip(zipPath, decryptedZip, passphrase);
      await execa('unzip', ['-o', decryptedZip, '-d', extractedDir]);

      const payloadRoot = extractedDir;
      const stateDir = path.join(payloadRoot, 'state');
      if (fs.existsSync(stateDir)) {
        fs.cpSync(stateDir, AGENTVAULT_DIR, { recursive: true, force: true });
      }

      const deploymentDir = path.join(payloadRoot, 'deployment');
      const wasmCandidates = fs.existsSync(deploymentDir)
        ? fs.readdirSync(deploymentDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.wasm'))
          .map((entry) => path.join(deploymentDir, entry.name))
        : [];

      const wasmPath = wasmCandidates[0];
      if (!wasmPath) {
        return {
          success: false,
          error: 'No WASM module found in decrypted backup; cannot deploy fresh canister',
        };
      }

      const deployResult = await deployAgent({
        wasmPath,
        network,
        mode: 'install',
      });

      return {
        success: true,
        deployedCanisterId: deployResult.canister.canisterId,
        restoredPath: extractedDir,
      };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function previewBackup(inputPath: string): Promise<BackupManifest | null> {
  try {
    if (!fs.existsSync(inputPath)) {
      return null;
    }

    const content = fs.readFileSync(inputPath, 'utf8');
    const manifest = JSON.parse(content) as BackupManifest;

    return manifest;
  } catch (error) {
    console.error('Failed to preview backup:', error);
    return null;
  }
}

export async function importBackup(options: ImportOptions): Promise<ImportResult> {
  try {
    const { inputPath, targetAgentName, overwrite } = options;

    if (!fs.existsSync(inputPath)) {
      return {
        success: false,
        agentName: undefined,
        components: [],
        warnings: [],
        error: `Backup file not found: ${inputPath}`,
      };
    }

    const manifest = await previewBackup(inputPath);
    if (!manifest) {
      return {
        success: false,
        agentName: undefined,
        components: [],
        warnings: [],
        error: 'Invalid backup file',
      };
    }

    const targetName = targetAgentName || manifest.agentName;
    const warnings: string[] = [];

    if (!overwrite) {
      warnings.push('Using dry-run mode; no changes will be made');
    }

    return {
      success: true,
      agentName: targetName,
      components: manifest.components,
      warnings,
    };
  } catch (error) {
    return {
      success: false,
      agentName: undefined,
      components: [],
      warnings: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function listBackups(agentName?: string): Promise<BackupManifest[]> {
  ensureBackupsDir();
  const backups: BackupManifest[] = [];

  if (!fs.existsSync(BACKUPS_DIR)) {
    return backups;
  }

  const files = fs.readdirSync(BACKUPS_DIR);
  for (const file of files) {
    if ((!agentName || file.startsWith(agentName)) && file.endsWith('.json')) {
      const filePath = path.join(BACKUPS_DIR, file);
      try {
        const manifest = await previewBackup(filePath);
        if (manifest && (!agentName || manifest.agentName === agentName)) {
          backups.push(manifest);
        }
      } catch (error) {
        console.error(`Failed to read backup ${file}:`, error);
      }
    }
  }

  backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return backups;
}

export async function deleteBackup(filePath: string): Promise<boolean> {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to delete backup:', error);
    return false;
  }
}

export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
