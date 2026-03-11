/**
 * Secret Rotation Manager
 *
 * Handles automatic secret rotation with zero-downtime semantics:
 * - Periodic rotation on a timer
 * - On-access rotation after N reads
 * - Manual rotation triggered by API
 *
 * During rotation the old value remains accessible until the new value is
 * confirmed stored in the backend.
 */

import type { SecretProvider } from './provider.js';
import type { SecretRotationConfig, SecretRotationState } from './safehouse-types.js';

export class SecretRotationManager {
  private readonly provider: SecretProvider;
  private readonly configs = new Map<string, SecretRotationConfig>();
  private readonly states = new Map<string, SecretRotationState>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  /** Callback invoked on any rotation event */
  private readonly onRotated: ((key: string, version: number) => void) | null;

  constructor(provider: SecretProvider, onRotated?: (key: string, version: number) => void) {
    this.provider = provider;
    this.onRotated = onRotated ?? null;
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /**
   * Register a secret for automatic rotation.
   */
  register(config: SecretRotationConfig): void {
    this.configs.set(config.key, config);

    // Initialize state
    if (!this.states.has(config.key)) {
      this.states.set(config.key, {
        key: config.key,
        currentVersion: 0,
        lastRotatedAt: new Date().toISOString(),
        totalRotations: 0,
        readsSinceRotation: 0,
      });
    }

    // Start periodic timer if applicable
    if (config.strategy === 'periodic' && config.intervalSeconds) {
      this.startPeriodicTimer(config.key, config.intervalSeconds);
    }
  }

  /**
   * Unregister a secret from automatic rotation.
   */
  unregister(key: string): void {
    this.stopTimer(key);
    this.configs.delete(key);
    this.states.delete(key);
  }

  // -----------------------------------------------------------------------
  // Rotation triggers
  // -----------------------------------------------------------------------

  /**
   * Record a read and trigger on-access rotation if configured.
   * Returns true if a rotation was triggered.
   */
  async recordRead(key: string): Promise<boolean> {
    const config = this.configs.get(key);
    const state = this.states.get(key);
    if (!config || !state) return false;

    state.readsSinceRotation++;

    if (
      config.strategy === 'on-access' &&
      config.rotateAfterReads &&
      state.readsSinceRotation >= config.rotateAfterReads
    ) {
      await this.rotate(key);
      return true;
    }

    return false;
  }

  /**
   * Manually rotate a secret.
   */
  async rotate(key: string): Promise<SecretRotationState> {
    const config = this.configs.get(key);
    if (!config) {
      throw new Error(`No rotation config registered for key "${key}"`);
    }

    const state = this.states.get(key)!;

    // Generate new value
    const newValue = await config.generator();

    // Store in backend (old value remains until this completes)
    await this.provider.storeSecret(key, newValue);

    // Update state
    state.currentVersion++;
    state.lastRotatedAt = new Date().toISOString();
    state.totalRotations++;
    state.readsSinceRotation = 0;

    if (config.strategy === 'periodic' && config.intervalSeconds) {
      state.nextRotationAt = new Date(
        Date.now() + config.intervalSeconds * 1000,
      ).toISOString();
    }

    // Notify
    if (config.onRotated) config.onRotated(key, state.currentVersion);
    if (this.onRotated) this.onRotated(key, state.currentVersion);

    return { ...state };
  }

  /**
   * Get the current rotation state for a key.
   */
  getState(key: string): SecretRotationState | null {
    const state = this.states.get(key);
    return state ? { ...state } : null;
  }

  /**
   * Get all rotation states.
   */
  listStates(): SecretRotationState[] {
    return [...this.states.values()].map(s => ({ ...s }));
  }

  /**
   * Stop all timers and clean up.
   */
  dispose(): void {
    for (const key of this.timers.keys()) {
      this.stopTimer(key);
    }
    this.configs.clear();
    this.states.clear();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private startPeriodicTimer(key: string, intervalSeconds: number): void {
    this.stopTimer(key);

    const timer = setInterval(async () => {
      try {
        await this.rotate(key);
      } catch {
        // Rotation failure is non-fatal; it will retry next interval
      }
    }, intervalSeconds * 1000);

    if (timer.unref) timer.unref();
    this.timers.set(key, timer);

    // Set next rotation time
    const state = this.states.get(key);
    if (state) {
      state.nextRotationAt = new Date(
        Date.now() + intervalSeconds * 1000,
      ).toISOString();
    }
  }

  private stopTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }
}
