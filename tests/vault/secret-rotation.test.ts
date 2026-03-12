/**
 * Tests for SecretRotationManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecretRotationManager } from '../../src/vault/secret-rotation.js';
import { MemorySecretProvider } from '../../src/vault/memory-provider.js';

describe('SecretRotationManager', () => {
  let provider: MemorySecretProvider;
  let rotation: SecretRotationManager;
  let rotatedEvents: Array<{ key: string; version: number }>;

  beforeEach(async () => {
    provider = new MemorySecretProvider();
    rotatedEvents = [];

    rotation = new SecretRotationManager(provider, (key, version) => {
      rotatedEvents.push({ key, version });
    });

    await provider.storeSecret('api_key', 'v1-secret');
  });

  afterEach(() => {
    rotation.dispose();
  });

  describe('registration', () => {
    it('should register a rotation config', () => {
      let counter = 0;
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => `v${++counter}`,
      });

      const state = rotation.getState('api_key');
      expect(state).not.toBeNull();
      expect(state!.key).toBe('api_key');
      expect(state!.currentVersion).toBe(0);
    });

    it('should unregister a config', () => {
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => 'new',
      });

      rotation.unregister('api_key');
      expect(rotation.getState('api_key')).toBeNull();
    });
  });

  describe('manual rotation', () => {
    it('should rotate a secret and update state', async () => {
      let counter = 1;
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => `v${++counter}-secret`,
      });

      const state = await rotation.rotate('api_key');
      expect(state.currentVersion).toBe(1);
      expect(state.totalRotations).toBe(1);
      expect(state.readsSinceRotation).toBe(0);

      // Verify the new value was stored in the provider
      const newValue = await provider.getSecret('api_key');
      expect(newValue).toBe('v2-secret');
    });

    it('should fire rotation callback', async () => {
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => 'rotated',
      });

      await rotation.rotate('api_key');
      expect(rotatedEvents).toHaveLength(1);
      expect(rotatedEvents[0]).toEqual({ key: 'api_key', version: 1 });
    });

    it('should fire per-config onRotated callback', async () => {
      let configCallbackFired = false;
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => 'new',
        onRotated: (key, version) => {
          configCallbackFired = true;
          expect(key).toBe('api_key');
          expect(version).toBe(1);
        },
      });

      await rotation.rotate('api_key');
      expect(configCallbackFired).toBe(true);
    });

    it('should throw for unregistered key', async () => {
      await expect(rotation.rotate('missing')).rejects.toThrow('No rotation config');
    });
  });

  describe('on-access rotation', () => {
    it('should rotate after N reads', async () => {
      let counter = 1;
      rotation.register({
        key: 'api_key',
        strategy: 'on-access',
        rotateAfterReads: 3,
        generator: async () => `v${++counter}`,
      });

      expect(await rotation.recordRead('api_key')).toBe(false);
      expect(await rotation.recordRead('api_key')).toBe(false);
      expect(await rotation.recordRead('api_key')).toBe(true); // triggers rotation

      const state = rotation.getState('api_key')!;
      expect(state.currentVersion).toBe(1);
      expect(state.readsSinceRotation).toBe(0);
    });

    it('should not rotate for manual strategy', async () => {
      rotation.register({
        key: 'api_key',
        strategy: 'manual',
        generator: async () => 'new',
      });

      for (let i = 0; i < 10; i++) {
        expect(await rotation.recordRead('api_key')).toBe(false);
      }
    });
  });

  describe('listStates', () => {
    it('should list all rotation states', () => {
      rotation.register({
        key: 'a',
        strategy: 'manual',
        generator: async () => 'x',
      });
      rotation.register({
        key: 'b',
        strategy: 'manual',
        generator: async () => 'y',
      });

      const states = rotation.listStates();
      expect(states).toHaveLength(2);
      expect(states.map(s => s.key).sort()).toEqual(['a', 'b']);
    });
  });

  describe('recordRead for unregistered key', () => {
    it('should return false for unregistered key', async () => {
      expect(await rotation.recordRead('unknown')).toBe(false);
    });
  });
});
