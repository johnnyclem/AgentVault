/**
 * Backup System
 *
 * Portable JSON format backup with embedded manifest and checksums
 * Stores backups in ~/.agentvault/backups/
 * CLE-101: Enhanced to include real canister state
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { AgentConfig } from '../packaging/types.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const BACKUPS_DIR = path.join(AGENTVAULT_DIR, 'backups');

function ensureBackupsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
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
}

export interface BackupOptions {
  agentName: string;
  outputPath?: string;
  includeConfig?: boolean;
  canisterId?: string;
  includeCanisterState?: boolean;
}

export interface ImportOptions {
  inputPath: string;
  targetAgentName?: string;
  overwrite?: boolean;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  error?: string;
  sizeBytes?: number;
  manifest?: BackupManifest;
}

export interface ImportResult {
  success: boolean;
  agentName?: string;
  error?: string;
  components: string[];
  warnings: string[];
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
    
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    
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

export async function listBackups(agentName: string): Promise<BackupManifest[]> {
  ensureBackupsDir();
  const backups: BackupManifest[] = [];
  
  if (!fs.existsSync(BACKUPS_DIR)) {
    return backups;
  }
  
  const files = fs.readdirSync(BACKUPS_DIR);
  for (const file of files) {
    if (file.startsWith(agentName) && file.endsWith('.json')) {
      const filePath = path.join(BACKUPS_DIR, file);
      try {
        const manifest = await previewBackup(filePath);
        if (manifest && manifest.agentName === agentName) {
          backups.push(manifest);
        }
      } catch (error) {
        console.error(`Failed to read backup ${file}:`, error);
      }
    }
  }
  
  backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
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
