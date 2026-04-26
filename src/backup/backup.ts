/**
 * Backup System
 *
 * Portable backup utilities for AgentVault.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execa } from 'execa';
import type { AgentConfig } from '../packaging/types.js';
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
  localEncryptedZipPath?: string;
  arweaveManifestTxId?: string;
  encryptedZipSha256?: string;
}

export interface BackupOptions {
  agentName: string;
  outputPath?: string;
  includeConfig?: boolean;
  canisterId?: string;
  includeCanisterState?: boolean;
  passphrase: string;
  arweaveJwkPath?: string;
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

    return state;
  } catch (error) {
    console.warn('Failed to fetch canister state:', error);
    return null;
  }
}

export async function exportBackup(options: BackupOptions): Promise<BackupResult> {
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

      if (wasmCandidates.length === 0) {
        return {
          success: false,
          error: 'No WASM module found in decrypted backup; cannot deploy fresh canister',
        };
      }

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
    if ((!agentName || file.startsWith(agentName)) && file.endsWith('.manifest.json')) {
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
