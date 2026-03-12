/**
 * Secret Access Audit Trail
 *
 * Maintains a tamper-evident, hash-chained log of every secret operation.
 * Each entry includes a SHA-256 hash of the previous entry, forming an
 * append-only chain that can be verified for integrity.
 *
 * The audit trail can be:
 * - Kept in memory for the session
 * - Flushed to a YAML file on disk
 * - Forwarded to an ICP canister for permanent storage
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SecretAuditEntry, AuditAction } from './safehouse-types.js';

const AUDIT_DIR = path.join(os.homedir(), '.agentvault', 'audit');
const AUDIT_FILE = 'secret-audit.jsonl';

export class SecretAccessAudit {
  private readonly entries: SecretAuditEntry[] = [];
  private lastHash: string = '0'.repeat(64); // genesis hash
  private readonly persistToDisk: boolean;
  private readonly auditFilePath: string;

  constructor(options?: { persistToDisk?: boolean; auditDir?: string }) {
    this.persistToDisk = options?.persistToDisk ?? false;
    const dir = options?.auditDir ?? AUDIT_DIR;
    this.auditFilePath = path.join(dir, AUDIT_FILE);

    if (this.persistToDisk) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Load last hash from existing file
      this.loadLastHash();
    }
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record a new audit entry.
   */
  record(params: {
    action: AuditAction;
    agentId: string;
    scopeId: string;
    secretKey?: string;
    allowed: boolean;
    denialReason?: string;
    metadata?: Record<string, string>;
  }): SecretAuditEntry {
    const entry: SecretAuditEntry = {
      id: `audit_${crypto.randomBytes(8).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: params.action,
      agentId: params.agentId,
      scopeId: params.scopeId,
      secretKey: params.secretKey,
      allowed: params.allowed,
      denialReason: params.denialReason,
      metadata: params.metadata,
      previousHash: this.lastHash,
      entryHash: '', // filled below
    };

    // Compute hash of this entry (excluding entryHash itself)
    entry.entryHash = this.computeHash(entry);
    this.lastHash = entry.entryHash;
    this.entries.push(entry);

    // Persist if enabled
    if (this.persistToDisk) {
      this.appendToDisk(entry);
    }

    return entry;
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  /**
   * Get all audit entries.
   */
  getEntries(): SecretAuditEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries for a specific agent.
   */
  getEntriesByAgent(agentId: string): SecretAuditEntry[] {
    return this.entries.filter(e => e.agentId === agentId);
  }

  /**
   * Get entries for a specific scope.
   */
  getEntriesByScope(scopeId: string): SecretAuditEntry[] {
    return this.entries.filter(e => e.scopeId === scopeId);
  }

  /**
   * Get denied operations only.
   */
  getDeniedEntries(): SecretAuditEntry[] {
    return this.entries.filter(e => !e.allowed);
  }

  /**
   * Get entries by action type.
   */
  getEntriesByAction(action: AuditAction): SecretAuditEntry[] {
    return this.entries.filter(e => e.action === action);
  }

  /**
   * Get the total number of entries.
   */
  get count(): number {
    return this.entries.length;
  }

  // -----------------------------------------------------------------------
  // Integrity verification
  // -----------------------------------------------------------------------

  /**
   * Verify the integrity of the entire audit chain.
   * Returns true if the chain is valid (no tampering detected).
   */
  verifyChain(): { valid: boolean; brokenAt?: number; reason?: string } {
    if (this.entries.length === 0) {
      return { valid: true };
    }

    let previousHash = '0'.repeat(64);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;

      // Check previous hash link
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i}: previousHash mismatch (expected ${previousHash.slice(0, 16)}..., got ${(entry.previousHash ?? '').slice(0, 16)}...)`,
        };
      }

      // Verify entry hash
      const computed = this.computeHash(entry);
      if (computed !== entry.entryHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Entry ${i}: entryHash mismatch (computed ${computed.slice(0, 16)}..., stored ${entry.entryHash.slice(0, 16)}...)`,
        };
      }

      previousHash = entry.entryHash;
    }

    return { valid: true };
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Export the audit trail as JSON Lines.
   */
  exportAsJsonl(): string {
    return this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  }

  /**
   * Summary statistics.
   */
  summary(): {
    totalEntries: number;
    allowed: number;
    denied: number;
    byAction: Record<string, number>;
    byAgent: Record<string, number>;
    chainValid: boolean;
  } {
    const byAction: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    let allowed = 0;
    let denied = 0;

    for (const entry of this.entries) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      byAgent[entry.agentId] = (byAgent[entry.agentId] ?? 0) + 1;
      if (entry.allowed) allowed++;
      else denied++;
    }

    return {
      totalEntries: this.entries.length,
      allowed,
      denied,
      byAction,
      byAgent,
      chainValid: this.verifyChain().valid,
    };
  }

  /**
   * Clear all in-memory entries (does NOT erase disk).
   */
  clear(): void {
    this.entries.length = 0;
    this.lastHash = '0'.repeat(64);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private computeHash(entry: SecretAuditEntry): string {
    const payload = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      agentId: entry.agentId,
      scopeId: entry.scopeId,
      secretKey: entry.secretKey,
      allowed: entry.allowed,
      denialReason: entry.denialReason,
      metadata: entry.metadata,
      previousHash: entry.previousHash,
    });

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private appendToDisk(entry: SecretAuditEntry): void {
    try {
      fs.appendFileSync(this.auditFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Non-fatal: disk write failure shouldn't break the audit trail
    }
  }

  private loadLastHash(): void {
    try {
      if (!fs.existsSync(this.auditFilePath)) return;

      const content = fs.readFileSync(this.auditFilePath, 'utf-8').trim();
      if (!content) return;

      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      const lastEntry = JSON.parse(lastLine) as SecretAuditEntry;
      this.lastHash = lastEntry.entryHash;
    } catch {
      // Start fresh if we can't parse existing audit file
    }
  }
}
