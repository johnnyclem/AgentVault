/**
 * Tests for SecretLeakDetector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecretLeakDetector } from '../../src/vault/secret-leak-detector.js';

describe('SecretLeakDetector', () => {
  let detector: SecretLeakDetector;
  const secrets = new Map<string, string>([
    ['api_key', 'sk-live-abc123xyz'],
    ['db_pass', 'super-secret-password'],
  ]);

  beforeEach(() => {
    detector = new SecretLeakDetector({ autoRemediate: true });
  });

  afterEach(() => {
    detector.dispose();
  });

  describe('tracking', () => {
    it('should track and untrack secrets', () => {
      detector.track('key', 'value');
      detector.untrack('key');
      // No errors
    });
  });

  describe('environment scanning', () => {
    it('should detect secrets in environment variables', () => {
      // Temporarily set an env var with the secret value
      process.env.TEST_LEAK_VAR = 'sk-live-abc123xyz';

      const events = detector.scanEnvironment(secrets);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.source).toBe('env');
      expect(events[0]!.severity).toBe('critical');
      expect(events[0]!.secretKey).toBe('api_key');

      // Auto-remediation should have removed it
      expect(process.env.TEST_LEAK_VAR).toBeUndefined();
    });

    it('should not detect when env is clean', () => {
      // Ensure no test env vars contain our secrets
      delete process.env.TEST_LEAK_VAR;
      const events = detector.scanEnvironment(new Map([['test_key', 'unique-value-not-in-env-9999']]));
      expect(events).toHaveLength(0);
    });
  });

  describe('string scanning', () => {
    it('should detect secrets in log output', () => {
      const logLine = 'Connecting to API with key sk-live-abc123xyz...';
      const events = detector.scanString(logLine, 'log', secrets);

      expect(events).toHaveLength(1);
      expect(events[0]!.secretKey).toBe('api_key');
      expect(events[0]!.source).toBe('log');
    });

    it('should detect multiple secrets in one string', () => {
      const text = `Keys: sk-live-abc123xyz and super-secret-password`;
      const events = detector.scanString(text, 'stdout', secrets);

      expect(events).toHaveLength(2);
    });

    it('should not flag strings without secrets', () => {
      const safe = 'This is a safe log line with no secrets.';
      const events = detector.scanString(safe, 'log', secrets);
      expect(events).toHaveLength(0);
    });
  });

  describe('process argument scanning', () => {
    it('should detect secrets in process.argv', () => {
      // Store original argv
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--token=sk-live-abc123xyz'];

      const events = detector.scanProcessArguments(secrets);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.source).toBe('process-args');

      // Restore
      process.argv = originalArgv;
    });
  });

  describe('event management', () => {
    it('should collect events', () => {
      detector.scanString('sk-live-abc123xyz', 'log', secrets);
      const events = detector.getEvents();
      expect(events).toHaveLength(1);
    });

    it('should filter by severity', () => {
      detector.scanString('sk-live-abc123xyz', 'log', secrets);
      const critical = detector.getEventsBySeverity('critical');
      expect(critical).toHaveLength(1);
    });

    it('should clear events', () => {
      detector.scanString('sk-live-abc123xyz', 'log', secrets);
      detector.clearEvents();
      expect(detector.getEvents()).toHaveLength(0);
    });
  });

  describe('leak callback', () => {
    it('should invoke callback on leak detection', () => {
      const leaks: string[] = [];
      const callbackDetector = new SecretLeakDetector({
        onLeak: (event) => leaks.push(event.secretKey),
      });

      callbackDetector.scanString('sk-live-abc123xyz', 'log', secrets);
      expect(leaks).toEqual(['api_key']);

      callbackDetector.dispose();
    });
  });

  describe('auto-remediation', () => {
    it('should not remediate when disabled', () => {
      const noRemediate = new SecretLeakDetector({ autoRemediate: false });
      process.env.LEAK_TEST_NO_REMEDIATE = 'sk-live-abc123xyz';

      const events = noRemediate.scanEnvironment(secrets);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.remediated).toBe(false);
      // Variable should still exist
      expect(process.env.LEAK_TEST_NO_REMEDIATE).toBe('sk-live-abc123xyz');

      delete process.env.LEAK_TEST_NO_REMEDIATE;
      noRemediate.dispose();
    });
  });
});
