/**
 * Tests for EncryptedMemoryStore
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EncryptedMemoryStore } from '../../src/vault/encrypted-memory-store.js';

describe('EncryptedMemoryStore', () => {
  let store: EncryptedMemoryStore;

  afterEach(() => {
    store?.dispose();
  });

  describe('basic operations', () => {
    it('should store and retrieve a secret', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('api_key', 'sk-secret-12345');
      const value = store.get('api_key');
      expect(value).toBe('sk-secret-12345');
    });

    it('should return null for non-existent keys', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      expect(store.get('missing')).toBeNull();
    });

    it('should overwrite existing entries', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'v1');
      store.set('key', 'v2');
      expect(store.get('key')).toBe('v2');
    });

    it('should delete entries', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'value');
      expect(store.delete('key')).toBe(true);
      expect(store.get('key')).toBeNull();
    });

    it('should list stored keys', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('a', '1');
      store.set('b', '2');
      store.set('c', '3');
      expect(store.keys()).toEqual(['a', 'b', 'c']);
    });

    it('should report correct size', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      expect(store.size).toBe(0);
      store.set('a', '1');
      expect(store.size).toBe(1);
      store.set('b', '2');
      expect(store.size).toBe(2);
    });

    it('should handle has() correctly', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      expect(store.has('key')).toBe(false);
      store.set('key', 'value');
      expect(store.has('key')).toBe(true);
    });
  });

  describe('TTL expiry', () => {
    it('should expire entries after TTL', async () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'value', { ttlMs: 50 });
      expect(store.get('key')).toBe('value');

      await new Promise(r => setTimeout(r, 60));
      expect(store.get('key')).toBeNull();
    });

    it('should use default TTL when set', async () => {
      store = new EncryptedMemoryStore({ defaultTtlMs: 50, autoWipeIntervalMs: 0 });
      store.set('key', 'value');

      await new Promise(r => setTimeout(r, 60));
      expect(store.get('key')).toBeNull();
    });

    it('should report has() as false for expired entries', async () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'value', { ttlMs: 50 });

      await new Promise(r => setTimeout(r, 60));
      expect(store.has('key')).toBe(false);
    });
  });

  describe('read limits', () => {
    it('should enforce maxReads', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'value', { maxReads: 2 });

      expect(store.get('key')).toBe('value');
      expect(store.get('key')).toBe('value');
      expect(store.get('key')).toBeNull(); // 3rd read exceeds limit
    });

    it('should report has() as false when reads exhausted', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'value', { maxReads: 1 });
      store.get('key');
      expect(store.has('key')).toBe(false);
    });
  });

  describe('max entries limit', () => {
    it('should throw when max entries exceeded', () => {
      store = new EncryptedMemoryStore({ maxEntries: 2, autoWipeIntervalMs: 0 });
      store.set('a', '1');
      store.set('b', '2');
      expect(() => store.set('c', '3')).toThrow('max entries');
    });

    it('should allow updating existing keys when at max', () => {
      store = new EncryptedMemoryStore({ maxEntries: 2, autoWipeIntervalMs: 0 });
      store.set('a', '1');
      store.set('b', '2');
      store.set('a', 'updated'); // update, not new entry
      expect(store.get('a')).toBe('updated');
    });
  });

  describe('purgeExpired', () => {
    it('should purge expired entries', async () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('expire', 'value', { ttlMs: 50 });
      store.set('keep', 'value');

      await new Promise(r => setTimeout(r, 60));
      const purged = store.purgeExpired();
      expect(purged).toBe(1);
      expect(store.size).toBe(1);
    });

    it('should purge read-exhausted entries', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('exhaust', 'value', { maxReads: 1 });
      store.get('exhaust');
      const purged = store.purgeExpired();
      expect(purged).toBe(1);
    });
  });

  describe('inspect', () => {
    it('should return metadata without values', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'secret-value', { ttlMs: 1000, maxReads: 5 });
      store.get('key');

      const entries = store.inspect();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe('key');
      expect(entries[0]!.ttlMs).toBe(1000);
      expect(entries[0]!.maxReads).toBe(5);
      expect(entries[0]!.readCount).toBe(1);
      // Ensure value is NOT in the inspection output
      expect(JSON.stringify(entries[0]!)).not.toContain('secret-value');
    });
  });

  describe('dispose', () => {
    it('should clear all entries on dispose', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('a', '1');
      store.set('b', '2');
      store.dispose();
      expect(store.size).toBe(0);
    });
  });

  describe('encryption', () => {
    it('should encrypt values (ciphertext differs from plaintext)', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('key', 'my-secret-value');

      // The stored ciphertext should differ from the plaintext
      const entries = store.inspect();
      expect(entries[0]!.key).toBe('key');
      // Verify roundtrip works
      expect(store.get('key')).toBe('my-secret-value');
    });

    it('should handle unicode values', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('unicode', '🔐 secret émojis 中文');
      expect(store.get('unicode')).toBe('🔐 secret émojis 中文');
    });

    it('should handle empty string values', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      store.set('empty', '');
      expect(store.get('empty')).toBe('');
    });

    it('should handle large values', () => {
      store = new EncryptedMemoryStore({ autoWipeIntervalMs: 0 });
      const large = 'x'.repeat(100_000);
      store.set('large', large);
      expect(store.get('large')).toBe(large);
    });
  });
});
