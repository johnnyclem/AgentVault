/**
 * Encrypted in-memory secret store
 *
 * Secrets are encrypted with an ephemeral AES-256-GCM key that exists only in
 * process memory.  The store provides:
 *
 * - Automatic expiry (TTL per entry)
 * - Read-count limits
 * - Periodic wipe of expired entries
 * - Secure zeroization on dispose
 *
 * This module is intentionally self-contained – it uses only Node.js builtins.
 */

import * as crypto from 'node:crypto';
import type { EncryptedMemoryEntry } from './safehouse-types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export class EncryptedMemoryStore {
  /** Ephemeral encryption key – never leaves process memory */
  private readonly ephemeralKey: Buffer;

  /** Encrypted entries keyed by secret name */
  private readonly entries = new Map<string, EncryptedMemoryEntry>();

  /** Periodic wipe timer */
  private wipeTimer: ReturnType<typeof setInterval> | null = null;

  /** Default TTL in ms (0 = no expiry) */
  private readonly defaultTtlMs: number;

  /** Maximum entries allowed */
  private readonly maxEntries: number;

  constructor(options?: { defaultTtlMs?: number; maxEntries?: number; autoWipeIntervalMs?: number }) {
    this.ephemeralKey = crypto.randomBytes(KEY_LENGTH);
    this.defaultTtlMs = options?.defaultTtlMs ?? 0;
    this.maxEntries = options?.maxEntries ?? 1000;

    const wipeInterval = options?.autoWipeIntervalMs ?? 30_000;
    if (wipeInterval > 0) {
      this.wipeTimer = setInterval(() => this.purgeExpired(), wipeInterval);
      // Allow the process to exit even if the timer is still running
      if (this.wipeTimer.unref) {
        this.wipeTimer.unref();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Store a secret value.  The plaintext is encrypted immediately and the
   * original buffer is zeroed.
   */
  set(key: string, plaintext: string, options?: { ttlMs?: number; maxReads?: number }): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      throw new Error(`EncryptedMemoryStore: max entries (${this.maxEntries}) reached`);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.ephemeralKey, iv);

    const ptBuf = Buffer.from(plaintext, 'utf-8');
    const encrypted = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Zeroize plaintext buffer
    ptBuf.fill(0);

    this.entries.set(key, {
      key,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      cachedAt: Date.now(),
      ttlMs: options?.ttlMs ?? this.defaultTtlMs,
      readCount: 0,
      maxReads: options?.maxReads ?? 0,
    });
  }

  /**
   * Retrieve and decrypt a secret.  Returns `null` if the key does not exist,
   * has expired, or has exceeded its read limit.
   */
  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // Check TTL
    if (entry.ttlMs > 0 && Date.now() - entry.cachedAt > entry.ttlMs) {
      this.delete(key);
      return null;
    }

    // Check read limit
    if (entry.maxReads > 0 && entry.readCount >= entry.maxReads) {
      this.delete(key);
      return null;
    }

    // Decrypt
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.ephemeralKey,
      Buffer.from(entry.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(entry.authTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'base64')),
      decipher.final(),
    ]);

    // Increment read count
    entry.readCount++;

    const result = decrypted.toString('utf-8');
    decrypted.fill(0);
    return result;
  }

  /**
   * Check whether a key exists and is still valid (not expired, not exhausted).
   */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.ttlMs > 0 && Date.now() - entry.cachedAt > entry.ttlMs) return false;
    if (entry.maxReads > 0 && entry.readCount >= entry.maxReads) return false;
    return true;
  }

  /**
   * Securely delete a single entry.
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Return all stored keys (without values).
   */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Number of entries currently stored (including potentially expired ones).
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Purge all expired or read-exhausted entries.
   * Returns the number of entries removed.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [key, entry] of this.entries) {
      const expired = entry.ttlMs > 0 && now - entry.cachedAt > entry.ttlMs;
      const exhausted = entry.maxReads > 0 && entry.readCount >= entry.maxReads;

      if (expired || exhausted) {
        this.entries.delete(key);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Securely wipe every entry and destroy the ephemeral key.
   * After calling this, the store is no longer usable.
   */
  dispose(): void {
    if (this.wipeTimer) {
      clearInterval(this.wipeTimer);
      this.wipeTimer = null;
    }

    this.entries.clear();
    this.ephemeralKey.fill(0);
  }

  /**
   * Return read-only metadata about entries (no values).
   */
  inspect(): Array<{ key: string; cachedAt: number; ttlMs: number; readCount: number; maxReads: number }> {
    return [...this.entries.values()].map(e => ({
      key: e.key,
      cachedAt: e.cachedAt,
      ttlMs: e.ttlMs,
      readCount: e.readCount,
      maxReads: e.maxReads,
    }));
  }
}
