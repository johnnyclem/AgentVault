/**
 * Archive Manager
 *
 * Manages archiving of agent data to Arweave.
 * Handles metadata tracking, batch uploads, and retrieval.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const ARCHIVES_DIR = path.join(AGENTVAULT_DIR, 'archives');
const ARCHIVE_INDEX_PATH = path.join(ARCHIVES_DIR, 'index.yaml');

export interface ArchiveMetadata {
  id: string;
  agentName: string;
  agentVersion: string;
  transactionId?: string;
  timestamp: Date;
  sizeBytes: number;
  checksum: string;
  tags: Record<string, string>;
  status: 'pending' | 'uploading' | 'confirmed' | 'failed';
  blockHeight?: number;
}

export interface ArchiveOptions {
  includeConfig?: boolean;
  includeLogs?: boolean;
  includeMetrics?: boolean;
  tags?: Record<string, string>;
}

export interface ArchiveResult {
  success: boolean;
  archiveId?: string;
  transactionId?: string;
  error?: string;
}

function ensureArchivesDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(ARCHIVES_DIR)) {
    fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
  }
}

function getIndex(): ArchiveMetadata[] {
  if (!fs.existsSync(ARCHIVE_INDEX_PATH)) {
    return [];
  }

  try {
    const content = fs.readFileSync(ARCHIVE_INDEX_PATH, 'utf8');
    const parsed = parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        ...item,
        timestamp: new Date(item.timestamp),
      })) as ArchiveMetadata[];
    }

    return [];
  } catch (error) {
    console.error('Failed to load archive index:', error);
    return [];
  }
}

function saveIndex(index: ArchiveMetadata[]): void {
  ensureArchivesDir();
  fs.writeFileSync(ARCHIVE_INDEX_PATH, stringify(index), 'utf8');
}

function generateChecksum(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function generateArchiveId(): string {
  return `archive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Archive agent data to local storage (for later upload)
 */
export function prepareArchive(
  agentName: string,
  agentVersion: string,
  data: Record<string, any>,
  options: ArchiveOptions = {},
): ArchiveResult {
  try {
    ensureArchivesDir();

    const archiveId = generateArchiveId();
    const timestamp = new Date();
    const dataStr = JSON.stringify(data);
    const checksum = generateChecksum(dataStr);

    const metadata: ArchiveMetadata = {
      id: archiveId,
      agentName,
      agentVersion,
      timestamp,
      sizeBytes: Buffer.byteLength(dataStr),
      checksum,
      tags: {
        'agent-name': agentName,
        'agent-version': agentVersion,
        'content-type': 'application/json',
        ...options.tags,
      },
      status: 'pending',
    };

    const archivePath = path.join(ARCHIVES_DIR, `${archiveId}.json`);
    fs.writeFileSync(archivePath, dataStr, 'utf8');

    const index = getIndex();
    index.push(metadata);
    saveIndex(index);

    return {
      success: true,
      archiveId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Mark archive as uploading
 */
export function markArchiveUploading(archiveId: string): boolean {
  try {
    const index = getIndex();
    const archive = index.find((a) => a.id === archiveId);

    if (!archive) {
      return false;
    }

    archive.status = 'uploading';
    saveIndex(index);

    return true;
  } catch (error) {
    console.error('Failed to mark archive as uploading:', error);
    return false;
  }
}

/**
 * Record the transaction ID a node accepted. The archive stays 'pending':
 * acceptance is not mining, and nothing here has checked the chain.
 */
export function updateArchiveTransaction(
  archiveId: string,
  transactionId: string,
): boolean {
  try {
    const index = getIndex();
    const archive = index.find((a) => a.id === archiveId);

    if (!archive) {
      return false;
    }

    archive.transactionId = transactionId;
    archive.status = 'pending';
    saveIndex(index);

    return true;
  } catch (error) {
    console.error('Failed to update archive transaction:', error);
    return false;
  }
}

/**
 * Mark archive as confirmed. Call this only after the gateway reports the
 * transaction mined (ArweaveClient.getTransactionStatus returned
 * 'confirmed'): a successful POST only means a node accepted it, and an
 * accepted transaction can still be dropped.
 */
export function confirmArchive(
  archiveId: string,
  blockHeight?: number,
): boolean {
  try {
    const index = getIndex();
    const archive = index.find((a) => a.id === archiveId);

    if (!archive) {
      return false;
    }

    archive.status = 'confirmed';
    if (blockHeight) {
      archive.blockHeight = blockHeight;
    }
    saveIndex(index);

    return true;
  } catch (error) {
    console.error('Failed to confirm archive:', error);
    return false;
  }
}

/**
 * Mark archive as failed
 */
export function failArchive(archiveId: string, error?: string): boolean {
  try {
    const index = getIndex();
    const archive = index.find((a) => a.id === archiveId);

    if (!archive) {
      return false;
    }

    archive.status = 'failed';
    if (error) {
      archive.tags['error'] = error;
    }
    saveIndex(index);

    return true;
  } catch (err) {
    console.error('Failed to mark archive as failed:', err);
    return false;
  }
}

/**
 * Get archive metadata by ID
 */
export function getArchive(archiveId: string): ArchiveMetadata | null {
  try {
    const index = getIndex();
    return index.find((a) => a.id === archiveId) || null;
  } catch (error) {
    console.error('Failed to get archive:', error);
    return null;
  }
}

/**
 * List all archives for an agent
 */
export function listArchives(agentName?: string): ArchiveMetadata[] {
  try {
    const index = getIndex();
    if (agentName) {
      return index.filter((a) => a.agentName === agentName);
    }
    return index;
  } catch (error) {
    console.error('Failed to list archives:', error);
    return [];
  }
}

/**
 * List pending archives that are ready for upload. A record that already has
 * a transaction ID was uploaded (it stays 'pending' until someone checks it
 * was mined), so it is left out: uploading it again would pay twice.
 */
export function listPendingArchives(): ArchiveMetadata[] {
  try {
    const index = getIndex();
    return index.filter((a) => a.status === 'pending' && !a.transactionId);
  } catch (error) {
    console.error('Failed to list pending archives:', error);
    return [];
  }
}

/**
 * Get archive data by ID
 */
export function getArchiveData(archiveId: string): Record<string, any> | null {
  try {
    const archivePath = path.join(ARCHIVES_DIR, `${archiveId}.json`);
    if (!fs.existsSync(archivePath)) {
      return null;
    }

    const content = fs.readFileSync(archivePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to get archive data:', error);
    return null;
  }
}

/**
 * Delete archive (local storage only, does not affect Arweave)
 */
export function deleteArchive(archiveId: string): boolean {
  try {
    const index = getIndex();
    const archiveIndex = index.findIndex((a) => a.id === archiveId);

    if (archiveIndex === -1) {
      return false;
    }

    const archivePath = path.join(ARCHIVES_DIR, `${archiveId}.json`);
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    index.splice(archiveIndex, 1);
    saveIndex(index);

    return true;
  } catch (error) {
    console.error('Failed to delete archive:', error);
    return false;
  }
}

/**
 * Get absolute path for a stored archive payload.
 */
export function getArchivePath(archiveId: string): string {
  return path.join(ARCHIVES_DIR, `${archiveId}.json`);
}

/**
 * How to describe a record's status to a person.
 *  - 'pending': prepared locally, not uploaded (no transaction ID).
 *  - 'submitted': a node accepted the upload and its transaction ID was
 *    recorded. Nothing here has checked that it was mined. Earlier versions
 *    stored 'confirmed' straight after the upload, without checking either,
 *    so a stored 'confirmed' also reads as 'submitted'.
 *  - 'uploading' and 'failed' as stored.
 */
export type ArchiveDisplayStatus = 'pending' | 'uploading' | 'submitted' | 'failed';

export function archiveDisplayStatus(
  archive: Pick<ArchiveMetadata, 'status' | 'transactionId'>,
): ArchiveDisplayStatus {
  if (archive.status === 'pending' || archive.status === 'confirmed') {
    return archive.transactionId ? 'submitted' : 'pending';
  }
  return archive.status;
}

/**
 * Get archive statistics, counted by archiveDisplayStatus
 */
export function getArchiveStats(agentName?: string): {
  total: number;
  submitted: number;
  pending: number;
  uploading: number;
  failed: number;
  totalBytes: number;
} {
  const archives = listArchives(agentName);
  const count = (status: ArchiveDisplayStatus): number =>
    archives.filter((a) => archiveDisplayStatus(a) === status).length;

  return {
    total: archives.length,
    submitted: count('submitted'),
    pending: count('pending'),
    uploading: count('uploading'),
    failed: count('failed'),
    totalBytes: archives.reduce((sum, a) => sum + a.sizeBytes, 0),
  };
}

/**
 * Re-hash the local payload copy and compare it with the recorded checksum.
 * This checks the file under ~/.agentvault/archives only; it says nothing
 * about what is stored on Arweave.
 */
export function verifyArchive(archiveId: string): boolean {
  try {
    const metadata = getArchive(archiveId);
    if (!metadata) {
      return false;
    }

    const data = getArchiveData(archiveId);
    if (!data) {
      return false;
    }

    const actualChecksum = generateChecksum(JSON.stringify(data));
    return actualChecksum === metadata.checksum;
  } catch (error) {
    console.error('Failed to verify archive:', error);
    return false;
  }
}
