/**
 * Tests for SecretAccessAudit – tamper-evident audit trail
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SecretAccessAudit } from '../../src/vault/secret-audit.js';

describe('SecretAccessAudit', () => {
  let audit: SecretAccessAudit;

  beforeEach(() => {
    audit = new SecretAccessAudit();
  });

  describe('recording', () => {
    it('should record an audit entry', () => {
      const entry = audit.record({
        action: 'secret.read',
        agentId: 'agent-1',
        scopeId: 'scope-1',
        secretKey: 'api_key',
        allowed: true,
      });

      expect(entry.id).toMatch(/^audit_/);
      expect(entry.action).toBe('secret.read');
      expect(entry.agentId).toBe('agent-1');
      expect(entry.entryHash).toBeTruthy();
      expect(entry.previousHash).toBe('0'.repeat(64));
    });

    it('should chain hashes', () => {
      const e1 = audit.record({
        action: 'secret.read',
        agentId: 'agent-1',
        scopeId: 'scope-1',
        allowed: true,
      });

      const e2 = audit.record({
        action: 'secret.write',
        agentId: 'agent-1',
        scopeId: 'scope-1',
        allowed: true,
      });

      expect(e2.previousHash).toBe(e1.entryHash);
    });

    it('should record denial reasons', () => {
      const entry = audit.record({
        action: 'scope.deny',
        agentId: 'agent-1',
        scopeId: 'scope-1',
        secretKey: 'forbidden_key',
        allowed: false,
        denialReason: 'No matching grant',
      });

      expect(entry.allowed).toBe(false);
      expect(entry.denialReason).toBe('No matching grant');
    });

    it('should include metadata', () => {
      const entry = audit.record({
        action: 'secret.inject',
        agentId: 'agent-1',
        scopeId: 'scope-1',
        allowed: true,
        metadata: { method: 'env-scoped' },
      });

      expect(entry.metadata).toEqual({ method: 'env-scoped' });
    });
  });

  describe('querying', () => {
    beforeEach(() => {
      audit.record({ action: 'secret.read', agentId: 'a1', scopeId: 's1', allowed: true, secretKey: 'k1' });
      audit.record({ action: 'secret.write', agentId: 'a1', scopeId: 's1', allowed: true, secretKey: 'k2' });
      audit.record({ action: 'scope.deny', agentId: 'a2', scopeId: 's2', allowed: false, secretKey: 'k3' });
      audit.record({ action: 'secret.read', agentId: 'a2', scopeId: 's2', allowed: true, secretKey: 'k4' });
    });

    it('should get all entries', () => {
      expect(audit.getEntries()).toHaveLength(4);
    });

    it('should filter by agent', () => {
      const entries = audit.getEntriesByAgent('a1');
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.agentId === 'a1')).toBe(true);
    });

    it('should filter by scope', () => {
      const entries = audit.getEntriesByScope('s2');
      expect(entries).toHaveLength(2);
    });

    it('should filter denied entries', () => {
      const entries = audit.getDeniedEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.action).toBe('scope.deny');
    });

    it('should filter by action', () => {
      const entries = audit.getEntriesByAction('secret.read');
      expect(entries).toHaveLength(2);
    });

    it('should report count', () => {
      expect(audit.count).toBe(4);
    });
  });

  describe('chain verification', () => {
    it('should verify a valid chain', () => {
      audit.record({ action: 'secret.read', agentId: 'a', scopeId: 's', allowed: true });
      audit.record({ action: 'secret.write', agentId: 'a', scopeId: 's', allowed: true });
      audit.record({ action: 'secret.delete', agentId: 'a', scopeId: 's', allowed: true });

      const result = audit.verifyChain();
      expect(result.valid).toBe(true);
    });

    it('should verify empty chain as valid', () => {
      expect(audit.verifyChain().valid).toBe(true);
    });

    it('should maintain a valid chain across many entries', () => {
      for (let i = 0; i < 10; i++) {
        audit.record({ action: 'secret.read', agentId: `agent-${i}`, scopeId: 's', allowed: true });
      }

      const result = audit.verifyChain();
      expect(result.valid).toBe(true);

      // Verify hash chaining
      const entries = audit.getEntries();
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.previousHash).toBe(entries[i - 1]!.entryHash);
      }
    });
  });

  describe('summary', () => {
    it('should return correct summary', () => {
      audit.record({ action: 'secret.read', agentId: 'a1', scopeId: 's1', allowed: true });
      audit.record({ action: 'secret.read', agentId: 'a2', scopeId: 's2', allowed: true });
      audit.record({ action: 'scope.deny', agentId: 'a1', scopeId: 's1', allowed: false });

      const summary = audit.summary();
      expect(summary.totalEntries).toBe(3);
      expect(summary.allowed).toBe(2);
      expect(summary.denied).toBe(1);
      expect(summary.byAction['secret.read']).toBe(2);
      expect(summary.byAction['scope.deny']).toBe(1);
      expect(summary.byAgent['a1']).toBe(2);
      expect(summary.byAgent['a2']).toBe(1);
      expect(summary.chainValid).toBe(true);
    });
  });

  describe('exportAsJsonl', () => {
    it('should export as JSON Lines', () => {
      audit.record({ action: 'secret.read', agentId: 'a', scopeId: 's', allowed: true });
      audit.record({ action: 'secret.write', agentId: 'a', scopeId: 's', allowed: true });

      const jsonl = audit.exportAsJsonl();
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!);
      expect(first.action).toBe('secret.read');
    });
  });

  describe('clear', () => {
    it('should clear entries', () => {
      audit.record({ action: 'secret.read', agentId: 'a', scopeId: 's', allowed: true });
      audit.clear();
      expect(audit.count).toBe(0);
    });
  });
});
