/**
 * Tests for SecretInjector
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { SecretInjector } from '../../src/vault/secret-injector.js';

describe('SecretInjector', () => {
  let injector: SecretInjector;

  afterEach(async () => {
    await injector?.dispose();
  });

  describe('env-scoped injection', () => {
    it('should inject a secret as an env-scoped reference', async () => {
      injector = new SecretInjector({ method: 'env-scoped', envPrefix: 'TEST_' });
      const injection = await injector.inject('api_key', 'sk-secret-123');

      expect(injection.method).toBe('env-scoped');
      expect(injection.reference).toBe('TEST_API_KEY');
      expect(injection.key).toBe('api_key');
      expect(injection.injectedAt).toBeTruthy();
    });

    it('should NOT set the value in process.env', async () => {
      injector = new SecretInjector({ method: 'env-scoped', envPrefix: 'SAFE_' });
      await injector.inject('api_key', 'sk-secret-123');

      // The value should NOT be in the parent process.env
      expect(process.env.SAFE_API_KEY).toBeUndefined();
    });

    it('should include injected secrets in buildChildEnv', async () => {
      injector = new SecretInjector({ method: 'env-scoped', envPrefix: 'AV_' });
      await injector.inject('api_key', 'sk-secret-123');

      const env = injector.buildChildEnv({ HOME: '/home/test' });
      expect(env.HOME).toBe('/home/test');
      expect(env.AV_API_KEY).toBe('sk-secret-123');
    });
  });

  describe('callback injection', () => {
    it('should inject via callback token', async () => {
      injector = new SecretInjector({ method: 'callback' });
      const injection = await injector.inject('db_pass', 'pg-secret');

      expect(injection.method).toBe('callback');
      expect(injection.reference).toMatch(/^cb_/);
    });

    it('should retrieve callback secret once', async () => {
      injector = new SecretInjector({ method: 'callback' });
      const injection = await injector.inject('db_pass', 'pg-secret');

      // First retrieval succeeds
      const value = injector.retrieveCallback(injection.reference);
      expect(value).toBe('pg-secret');

      // Second retrieval returns null (one-time read)
      expect(injector.retrieveCallback(injection.reference)).toBeNull();
    });
  });

  describe('tmpfs-file injection', () => {
    it('should inject via tmpfs file', async () => {
      injector = new SecretInjector({ method: 'tmpfs-file' });
      const injection = await injector.inject('secret', 'file-based-secret');

      expect(injection.method).toBe('tmpfs-file');
      expect(injection.reference).toContain('av_secret_');

      // File should exist and contain the secret
      const content = fs.readFileSync(injection.reference, 'utf-8');
      expect(content).toBe('file-based-secret');

      // Cleanup should remove the file
      await injector.cleanup('secret');
      expect(fs.existsSync(injection.reference)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up a specific injection', async () => {
      injector = new SecretInjector({ method: 'callback' });
      await injector.inject('a', 'val-a');
      await injector.inject('b', 'val-b');

      await injector.cleanup('a');
      const injections = injector.listInjections();
      expect(injections).toHaveLength(1);
      expect(injections[0]!.key).toBe('b');
    });

    it('should clean up all on dispose', async () => {
      injector = new SecretInjector({ method: 'callback' });
      await injector.inject('a', 'val-a');
      await injector.inject('b', 'val-b');

      await injector.dispose();
      expect(injector.listInjections()).toHaveLength(0);
    });
  });

  describe('expiry', () => {
    it('should set expiresAt based on maxLifetimeMs', async () => {
      injector = new SecretInjector({ method: 'callback', maxLifetimeMs: 60_000 });
      const injection = await injector.inject('key', 'value');

      expect(injection.expiresAt).toBeTruthy();
      const expiry = new Date(injection.expiresAt!).getTime();
      const now = Date.now();
      expect(expiry).toBeGreaterThan(now);
      expect(expiry).toBeLessThanOrEqual(now + 61_000);
    });
  });

  describe('listInjections', () => {
    it('should list all active injections', async () => {
      injector = new SecretInjector({ method: 'callback' });
      await injector.inject('a', '1');
      await injector.inject('b', '2');

      const list = injector.listInjections();
      expect(list).toHaveLength(2);
      expect(list.map(i => i.key).sort()).toEqual(['a', 'b']);
    });
  });
});
