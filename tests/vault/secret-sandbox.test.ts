/**
 * Tests for SecretSandbox – deny-first access control
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SecretSandbox } from '../../src/vault/secret-sandbox.js';
import { MemorySecretProvider } from '../../src/vault/memory-provider.js';
import type { AuditAction } from '../../src/vault/safehouse-types.js';

describe('SecretSandbox', () => {
  let provider: MemorySecretProvider;
  let sandbox: SecretSandbox;
  let auditLog: Array<{ action: AuditAction; key?: string; allowed: boolean; reason?: string }>;

  beforeEach(async () => {
    provider = new MemorySecretProvider();
    auditLog = [];

    // Seed some secrets in the provider
    await provider.storeSecret('api_key', 'sk-12345');
    await provider.storeSecret('db_password', 'pg-secret');
    await provider.storeSecret('internal_token', 'tok-xyz');

    sandbox = new SecretSandbox(provider, (action, key, allowed, reason) => {
      auditLog.push({ action, key, allowed, reason });
    });
  });

  describe('scope lifecycle', () => {
    it('should create a scope', () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      expect(scope.scopeId).toMatch(/^scope_/);
      expect(scope.agentId).toBe('test-agent');
      expect(scope.revoked).toBe(false);
    });

    it('should enter and exit a scope', () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sandbox.enterScope(scope.scopeId);
      expect(sandbox.getActiveScope()?.scopeId).toBe(scope.scopeId);

      sandbox.exitScope();
      expect(sandbox.getActiveScope()).toBeNull();
    });

    it('should reject entering a revoked scope', () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });

      sandbox.revokeScope(scope.scopeId);
      expect(() => sandbox.enterScope(scope.scopeId)).toThrow('revoked');
    });

    it('should reject entering an expired scope', () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
        expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
      });

      expect(() => sandbox.enterScope(scope.scopeId)).toThrow('expired');
    });

    it('should reject entering a non-existent scope', () => {
      expect(() => sandbox.enterScope('fake-id')).toThrow('does not exist');
    });

    it('should list all scopes', () => {
      sandbox.createScope({ agentId: 'a', grants: [] });
      sandbox.createScope({ agentId: 'b', grants: [] });
      expect(sandbox.listScopes()).toHaveLength(2);
    });
  });

  describe('deny-first access control', () => {
    it('should deny read without a scope', async () => {
      await expect(sandbox.getSecret('api_key')).rejects.toThrow('No active sandbox scope');
    });

    it('should deny read without matching grant', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'other_*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      await expect(sandbox.getSecret('api_key')).rejects.toThrow('Access denied');

      const denied = auditLog.filter(e => !e.allowed);
      expect(denied.length).toBeGreaterThan(0);
    });

    it('should allow read with matching grant', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      const value = await sandbox.getSecret('api_key');
      expect(value).toBe('sk-12345');
    });

    it('should deny write when only read access is granted', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      await expect(sandbox.storeSecret('new_key', 'value')).rejects.toThrow('Access denied');
    });

    it('should allow write with write grant', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'write' }],
      });
      sandbox.enterScope(scope.scopeId);

      await sandbox.storeSecret('new_key', 'new_value');
      expect(await provider.getSecret('new_key')).toBe('new_value');
    });

    it('should deny delete without admin grant', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'write' }],
      });
      sandbox.enterScope(scope.scopeId);

      await expect(sandbox.deleteSecret('api_key')).rejects.toThrow('Access denied');
    });

    it('should allow delete with admin grant', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'admin' }],
      });
      sandbox.enterScope(scope.scopeId);

      await sandbox.deleteSecret('api_key');
      expect(await provider.getSecret('api_key')).toBeNull();
    });
  });

  describe('pattern matching', () => {
    it('should match wildcard patterns', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      expect(await sandbox.getSecret('api_key')).toBe('sk-12345');
      await expect(sandbox.getSecret('db_password')).rejects.toThrow('Access denied');
    });

    it('should match exact patterns', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_key', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      expect(await sandbox.getSecret('api_key')).toBe('sk-12345');
      await expect(sandbox.getSecret('api_other')).rejects.toThrow('Access denied');
    });

    it('should match question mark patterns', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'db_?assword', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      expect(await sandbox.getSecret('db_password')).toBe('pg-secret');
    });
  });

  describe('maxSecrets limit', () => {
    it('should enforce maxSecrets', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
        maxSecrets: 2,
      });
      sandbox.enterScope(scope.scopeId);

      await sandbox.getSecret('api_key');
      await sandbox.getSecret('db_password');
      await expect(sandbox.getSecret('internal_token')).rejects.toThrow('limit');
    });
  });

  describe('list filtering', () => {
    it('should filter listed keys by grants', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'api_*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      const keys = await sandbox.listSecrets();
      expect(keys).toContain('api_key');
      expect(keys).not.toContain('db_password');
    });

    it('should deny listing when no grants', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'none' }],
      });
      sandbox.enterScope(scope.scopeId);

      await expect(sandbox.listSecrets()).rejects.toThrow('Access denied');
    });
  });

  describe('health check', () => {
    it('should pass through health check without scope', async () => {
      const result = await sandbox.healthCheck();
      expect(result.healthy).toBe(true);
    });
  });

  describe('audit callback', () => {
    it('should fire audit events on access', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: '*', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);
      await sandbox.getSecret('api_key');
      sandbox.exitScope();

      const actions = auditLog.map(e => e.action);
      expect(actions).toContain('scope.create');
      expect(actions).toContain('sandbox.enter');
      expect(actions).toContain('secret.read');
      expect(actions).toContain('sandbox.exit');
    });

    it('should fire deny events on denied access', async () => {
      const scope = sandbox.createScope({
        agentId: 'test-agent',
        grants: [{ keyPattern: 'other', access: 'read' }],
      });
      sandbox.enterScope(scope.scopeId);

      try { await sandbox.getSecret('api_key'); } catch { /* expected */ }

      const denied = auditLog.filter(e => e.action === 'scope.deny');
      expect(denied.length).toBeGreaterThan(0);
      expect(denied[0]!.allowed).toBe(false);
    });
  });
});
