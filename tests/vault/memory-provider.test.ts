/**
 * Tests for MemorySecretProvider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySecretProvider } from '../../src/vault/memory-provider.js';

describe('MemorySecretProvider', () => {
  let provider: MemorySecretProvider;

  beforeEach(() => {
    provider = new MemorySecretProvider();
  });

  it('should have the correct name', () => {
    expect(provider.name).toBe('In-Memory (ephemeral)');
  });

  it('should store and retrieve secrets', async () => {
    await provider.storeSecret('key', 'value');
    expect(await provider.getSecret('key')).toBe('value');
  });

  it('should return null for missing keys', async () => {
    expect(await provider.getSecret('missing')).toBeNull();
  });

  it('should list stored keys', async () => {
    await provider.storeSecret('a', '1');
    await provider.storeSecret('b', '2');
    const keys = await provider.listSecrets();
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('should delete secrets', async () => {
    await provider.storeSecret('key', 'value');
    await provider.deleteSecret('key');
    expect(await provider.getSecret('key')).toBeNull();
  });

  it('should throw when deleting non-existent key', async () => {
    await expect(provider.deleteSecret('missing')).rejects.toThrow('not found');
  });

  it('should report healthy', async () => {
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('should clear all secrets', async () => {
    await provider.storeSecret('a', '1');
    await provider.storeSecret('b', '2');
    provider.clear();
    expect(provider.size).toBe(0);
  });

  it('should report correct size', async () => {
    expect(provider.size).toBe(0);
    await provider.storeSecret('a', '1');
    expect(provider.size).toBe(1);
  });
});
