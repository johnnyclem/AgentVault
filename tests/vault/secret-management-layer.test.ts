/**
 * Tests for the unified SecretManagementLayer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecretManagementLayer } from '../../src/vault/secret-management-layer.js';
import { MemorySecretProvider } from '../../src/vault/memory-provider.js';

describe('SecretManagementLayer', () => {
  let sml: SecretManagementLayer;
  let provider: MemorySecretProvider;

  beforeEach(async () => {
    provider = new MemorySecretProvider();
    await provider.storeSecret('api_key', 'sk-12345');
    await provider.storeSecret('db_password', 'pg-secret');
    await provider.storeSecret('internal_token', 'tok-xyz');

    sml = SecretManagementLayer.createWithProvider(provider, {
      leakDetection: true,
      auditEnabled: true,
      defaultTtlSeconds: 60,
      autoWipeIntervalMs: 0, // disable auto-wipe for tests
    });
  });

  afterEach(async () => {
    await sml.dispose();
  });

  describe('factory', () => {
    it('should create with memory backend', async () => {
      const layer = SecretManagementLayer.create({ backend: 'memory' });
      const health = await layer.healthCheck();
      expect(health.healthy).toBe(true);
      await layer.dispose();
    });

    it('should create with custom provider', async () => {
      const layer = SecretManagementLayer.createWithProvider(provider);
      const health = await layer.healthCheck();
      expect(health.healthy).toBe(true);
      await layer.dispose();
    });
  });

  describe('scope + read workflow', () => {
    it('should allow reading with proper scope', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      const value = await sml.getSecret('api_key');
      expect(value).toBe('sk-12345');
      sml.exitScope();
    });

    it('should deny reading without proper grant', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'other_*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await expect(sml.getSecret('api_key')).rejects.toThrow('Access denied');
      sml.exitScope();
    });

    it('should cache secrets in encrypted memory', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');

      // Second read should come from cache
      const cached = await sml.getSecret('api_key');
      expect(cached).toBe('sk-12345');
      sml.exitScope();
    });
  });

  describe('scope + write workflow', () => {
    it('should allow writing with write grant', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'write' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.storeSecret('new_key', 'new_value');
      const value = await sml.getSecret('new_key');
      expect(value).toBe('new_value');
      sml.exitScope();
    });
  });

  describe('scope + delete workflow', () => {
    it('should allow deleting with admin grant', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'admin' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.deleteSecret('api_key');
      const value = await provider.getSecret('api_key');
      expect(value).toBeNull();
      sml.exitScope();
    });
  });

  describe('listing', () => {
    it('should filter listed secrets by scope', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      const keys = await sml.listSecrets();
      expect(keys).toContain('api_key');
      expect(keys).not.toContain('db_password');
      sml.exitScope();
    });
  });

  describe('secret injection', () => {
    it('should inject a secret for agent execution', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      const injection = await sml.injectSecret('api_key', 'env-scoped');
      expect(injection.method).toBe('env-scoped');
      expect(injection.key).toBe('api_key');
      sml.exitScope();
    });

    it('should fail to inject non-existent secret', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await expect(sml.injectSecret('missing_key')).rejects.toThrow('not found');
      sml.exitScope();
    });
  });

  describe('rotation', () => {
    it('should rotate a secret', async () => {
      let counter = 0;
      sml.registerRotation({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => `rotated-${++counter}`,
      });

      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });
      sml.enterScope(scope.scopeId);

      const state = await sml.rotateSecret('api_key');
      expect(state.currentVersion).toBe(1);

      // Next read should get the new value
      const value = await sml.getSecret('api_key');
      expect(value).toBe('rotated-1');
      sml.exitScope();
    });
  });

  describe('leak detection', () => {
    it('should detect leaks in scanned text', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');

      const events = sml.scanText('Log: api_key=sk-12345', 'log');
      expect(events).toHaveLength(1);
      expect(events[0]!.secretKey).toBe('api_key');
      sml.exitScope();
    });

    it('should return leak events', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');
      sml.scanText('sk-12345', 'log');

      expect(sml.getLeakEvents().length).toBeGreaterThan(0);
      sml.exitScope();
    });
  });

  describe('audit trail', () => {
    it('should record audit entries for operations', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');
      sml.exitScope();

      const entries = sml.getAuditEntries();
      expect(entries.length).toBeGreaterThan(0);

      const actions = entries.map(e => e.action);
      expect(actions).toContain('scope.create');
      expect(actions).toContain('sandbox.enter');
      expect(actions).toContain('secret.read');
    });

    it('should record denied operations', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'other_*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      try { await sml.getSecret('api_key'); } catch { /* expected */ }
      sml.exitScope();

      const entries = sml.getAuditEntries();
      const denied = entries.filter(e => !e.allowed);
      expect(denied.length).toBeGreaterThan(0);
    });

    it('should verify audit chain integrity', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');
      sml.exitScope();

      const result = sml.verifyAuditChain();
      expect(result.valid).toBe(true);
    });
  });

  describe('statistics', () => {
    it('should track operational stats', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'write' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.getSecret('api_key');
      await sml.storeSecret('new', 'value');
      sml.exitScope();

      const stats = sml.stats();
      expect(stats.totalReads).toBe(1);
      expect(stats.totalWrites).toBe(1);
      expect(stats.cachedSecrets).toBeGreaterThan(0);
      expect(stats.activeScopes).toBeGreaterThanOrEqual(1);
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should track denied operations', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'nope', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      try { await sml.getSecret('api_key'); } catch { /* expected */ }
      sml.exitScope();

      expect(sml.stats().totalDenied).toBeGreaterThan(0);
    });
  });

  describe('health check', () => {
    it('should report healthy for memory backend', async () => {
      const health = await sml.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });

  describe('scope revocation', () => {
    it('should prevent access after revocation', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      sml.revokeScope(scope.scopeId);

      await expect(sml.getSecret('api_key')).rejects.toThrow();
    });
  });

  describe('child environment', () => {
    it('should build a child environment with injected secrets', async () => {
      const scope = sml.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sml.enterScope(scope.scopeId);
      await sml.injectSecret('api_key', 'env-scoped');

      const env = sml.buildChildEnv({ PATH: '/usr/bin' });
      expect(env.PATH).toBe('/usr/bin');
      // The injected key should be available in the child env
      expect(Object.keys(env).some(k => k.includes('API_KEY'))).toBe(true);
      sml.exitScope();
    });
  });
});
