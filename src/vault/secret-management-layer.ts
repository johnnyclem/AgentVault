/**
 * Secret Management Layer – Unified Orchestrator
 *
 * Brings together all Agent Safehouse-inspired components into a single
 * coherent API:
 *
 * - **SecretSandbox**: Deny-first access control with scoped grants
 * - **EncryptedMemoryStore**: AES-256-GCM encrypted in-memory cache
 * - **SecretRotationManager**: Automatic secret rotation
 * - **SecretLeakDetector**: Leak monitoring and auto-redaction
 * - **SecretInjector**: Safe secret delivery to agent processes
 * - **SecretAccessAudit**: Hash-chained tamper-evident audit trail
 *
 * Usage:
 * ```ts
 * const sml = SecretManagementLayer.create({
 *   backend: 'memory',   // or 'hashicorp' / 'bitwarden'
 *   leakDetection: true,
 *   auditEnabled: true,
 * });
 *
 * const scope = sml.createScope({
 *   agentId: 'my-agent',
 *   grants: [{ keyPattern: 'api_*', access: 'read' }],
 * });
 *
 * sml.enterScope(scope.scopeId);
 * const value = await sml.getSecret('api_key');
 * sml.exitScope();
 * sml.dispose();
 * ```
 */

import type { SecretProvider } from './provider.js';
import type {
  SecretManagementLayerConfig,
  SecretManagementStats,
  SecretSandboxScope,
  SecretRotationConfig,
  SecretRotationState,
  LeakDetectionEvent,
  SecretAuditEntry,
  InjectionMethod,
  InjectedSecret,
} from './safehouse-types.js';

import { SecretSandbox, type CreateScopeOptions } from './secret-sandbox.js';
import { EncryptedMemoryStore } from './encrypted-memory-store.js';
import { SecretRotationManager } from './secret-rotation.js';
import { SecretLeakDetector } from './secret-leak-detector.js';
import { SecretInjector } from './secret-injector.js';
import { SecretAccessAudit } from './secret-audit.js';
import { MemorySecretProvider } from './memory-provider.js';
import { HashiCorpVaultProvider } from './hashicorp-provider.js';
import { BitwardenProvider } from './bitwarden.js';

export class SecretManagementLayer {
  readonly sandbox: SecretSandbox;
  readonly memoryStore: EncryptedMemoryStore;
  readonly rotation: SecretRotationManager;
  readonly leakDetector: SecretLeakDetector;
  readonly injector: SecretInjector;
  readonly audit: SecretAccessAudit;

  private readonly config: Required<SecretManagementLayerConfig>;
  private readonly startedAt: number;

  /** Counters for stats */
  private totalReads = 0;
  private totalWrites = 0;
  private totalDenied = 0;

  /** Active secret values for leak detection (key -> plaintext) */
  private readonly activeSecrets = new Map<string, string>();

  private constructor(provider: SecretProvider, config: SecretManagementLayerConfig) {
    this.startedAt = Date.now();

    this.config = {
      defaultTtlSeconds: config.defaultTtlSeconds ?? 300,
      leakDetection: config.leakDetection ?? true,
      auditEnabled: config.auditEnabled ?? true,
      maxSecretsPerSession: config.maxSecretsPerSession ?? 100,
      injectionMethod: config.injectionMethod ?? 'env-scoped',
      backend: config.backend ?? 'memory',
      autoWipeIntervalMs: config.autoWipeIntervalMs ?? 30_000,
    };

    // Initialize components
    this.audit = new SecretAccessAudit();

    this.sandbox = new SecretSandbox(provider, (action, secretKey, allowed, reason) => {
      if (!allowed) this.totalDenied++;
      if (this.config.auditEnabled) {
        const scope = this.sandbox.getActiveScope();
        this.audit.record({
          action,
          agentId: scope?.agentId ?? 'unknown',
          scopeId: scope?.scopeId ?? 'none',
          secretKey,
          allowed,
          denialReason: reason,
        });
      }
    });

    this.memoryStore = new EncryptedMemoryStore({
      defaultTtlMs: this.config.defaultTtlSeconds * 1000,
      maxEntries: this.config.maxSecretsPerSession,
      autoWipeIntervalMs: this.config.autoWipeIntervalMs,
    });

    this.rotation = new SecretRotationManager(provider);

    this.leakDetector = new SecretLeakDetector({
      onLeak: (event) => {
        if (this.config.auditEnabled) {
          const scope = this.sandbox.getActiveScope();
          this.audit.record({
            action: 'secret.leak_detected',
            agentId: scope?.agentId ?? 'unknown',
            scopeId: scope?.scopeId ?? 'none',
            secretKey: event.secretKey,
            allowed: true,
            metadata: {
              severity: event.severity,
              source: event.source,
              description: event.description,
              remediated: String(event.remediated),
            },
          });
        }
      },
      autoRemediate: true,
    });

    this.injector = new SecretInjector({
      method: this.config.injectionMethod,
    });
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  /**
   * Create a new SecretManagementLayer with the specified configuration.
   */
  static create(config?: SecretManagementLayerConfig): SecretManagementLayer {
    const backend = config?.backend ?? 'memory';
    let provider: SecretProvider;

    switch (backend) {
      case 'hashicorp':
        provider = HashiCorpVaultProvider.forAgent('default');
        break;
      case 'bitwarden':
        provider = new BitwardenProvider({ agentId: 'default' });
        break;
      case 'memory':
      default:
        provider = new MemorySecretProvider();
        break;
    }

    return new SecretManagementLayer(provider, config ?? {});
  }

  /**
   * Create with a custom provider.
   */
  static createWithProvider(provider: SecretProvider, config?: SecretManagementLayerConfig): SecretManagementLayer {
    return new SecretManagementLayer(provider, config ?? {});
  }

  // -----------------------------------------------------------------------
  // Scope management (delegated to sandbox)
  // -----------------------------------------------------------------------

  createScope(options: CreateScopeOptions): SecretSandboxScope {
    return this.sandbox.createScope(options);
  }

  enterScope(scopeId: string): void {
    this.sandbox.enterScope(scopeId);

    // Install leak detection interceptors
    if (this.config.leakDetection && this.activeSecrets.size > 0) {
      this.leakDetector.installOutputInterceptors(this.activeSecrets);
    }
  }

  exitScope(): void {
    this.sandbox.exitScope();
    this.leakDetector.removeOutputInterceptors();
  }

  revokeScope(scopeId: string): void {
    this.sandbox.revokeScope(scopeId);
  }

  // -----------------------------------------------------------------------
  // Secret operations (sandbox + cache + leak detection)
  // -----------------------------------------------------------------------

  /**
   * Get a secret. The value is cached in the encrypted memory store.
   */
  async getSecret(key: string): Promise<string | null> {
    // Try cache first
    const cached = this.memoryStore.get(key);
    if (cached !== null) {
      this.totalReads++;
      await this.rotation.recordRead(key);
      return cached;
    }

    // Fetch through sandbox (enforces policy)
    const value = await this.sandbox.getSecret(key);
    this.totalReads++;

    if (value !== null) {
      // Cache it
      this.memoryStore.set(key, value, {
        ttlMs: this.config.defaultTtlSeconds * 1000,
      });

      // Track for leak detection
      this.activeSecrets.set(key, value);
      this.leakDetector.track(key, value);

      // Record read for rotation
      await this.rotation.recordRead(key);

      // Update leak detection interceptors
      if (this.config.leakDetection) {
        this.leakDetector.installOutputInterceptors(this.activeSecrets);
      }
    }

    return value;
  }

  /**
   * Store a secret through the sandbox.
   */
  async storeSecret(key: string, value: string): Promise<void> {
    await this.sandbox.storeSecret(key, value);
    this.totalWrites++;

    // Update cache
    this.memoryStore.set(key, value, {
      ttlMs: this.config.defaultTtlSeconds * 1000,
    });

    // Update leak tracking
    this.activeSecrets.set(key, value);
    this.leakDetector.track(key, value);
  }

  /**
   * Delete a secret through the sandbox.
   */
  async deleteSecret(key: string): Promise<void> {
    await this.sandbox.deleteSecret(key);

    // Remove from cache and tracking
    this.memoryStore.delete(key);
    this.activeSecrets.delete(key);
    this.leakDetector.untrack(key);
  }

  /**
   * List accessible secrets through the sandbox.
   */
  async listSecrets(): Promise<string[]> {
    return this.sandbox.listSecrets();
  }

  // -----------------------------------------------------------------------
  // Secret injection
  // -----------------------------------------------------------------------

  /**
   * Inject a secret for an agent execution context.
   */
  async injectSecret(key: string, method?: InjectionMethod): Promise<InjectedSecret> {
    const value = await this.getSecret(key);
    if (value === null) {
      throw new Error(`Secret "${key}" not found or not accessible`);
    }

    const injection = await this.injector.inject(key, value, method);

    if (this.config.auditEnabled) {
      const scope = this.sandbox.getActiveScope();
      this.audit.record({
        action: 'secret.inject',
        agentId: scope?.agentId ?? 'unknown',
        scopeId: scope?.scopeId ?? 'none',
        secretKey: key,
        allowed: true,
        metadata: { method: injection.method, reference: injection.reference },
      });
    }

    return injection;
  }

  /**
   * Build a child process environment with all env-scoped injected secrets.
   */
  buildChildEnv(baseEnv?: NodeJS.ProcessEnv): Record<string, string> {
    return this.injector.buildChildEnv(baseEnv);
  }

  // -----------------------------------------------------------------------
  // Rotation
  // -----------------------------------------------------------------------

  /**
   * Register a secret for automatic rotation.
   */
  registerRotation(config: SecretRotationConfig): void {
    this.rotation.register(config);
  }

  /**
   * Manually rotate a secret.
   */
  async rotateSecret(key: string): Promise<SecretRotationState> {
    const state = await this.rotation.rotate(key);

    // Invalidate cache so next read fetches the new value
    this.memoryStore.delete(key);
    this.activeSecrets.delete(key);

    if (this.config.auditEnabled) {
      const scope = this.sandbox.getActiveScope();
      this.audit.record({
        action: 'secret.rotate',
        agentId: scope?.agentId ?? 'unknown',
        scopeId: scope?.scopeId ?? 'none',
        secretKey: key,
        allowed: true,
        metadata: { version: String(state.currentVersion) },
      });
    }

    return state;
  }

  // -----------------------------------------------------------------------
  // Leak scanning
  // -----------------------------------------------------------------------

  /**
   * Run a full leak scan across environment, process args, and any custom text.
   */
  scanForLeaks(): LeakDetectionEvent[] {
    const events: LeakDetectionEvent[] = [];
    events.push(...this.leakDetector.scanEnvironment(this.activeSecrets));
    events.push(...this.leakDetector.scanProcessArguments(this.activeSecrets));
    return events;
  }

  /**
   * Scan a string for leaked secrets.
   */
  scanText(text: string, source: LeakDetectionEvent['source'] = 'log'): LeakDetectionEvent[] {
    return this.leakDetector.scanString(text, source, this.activeSecrets);
  }

  /**
   * Get all recorded leak events.
   */
  getLeakEvents(): LeakDetectionEvent[] {
    return this.leakDetector.getEvents();
  }

  // -----------------------------------------------------------------------
  // Statistics & health
  // -----------------------------------------------------------------------

  /**
   * Get operational statistics.
   */
  stats(): SecretManagementStats {
    return {
      cachedSecrets: this.memoryStore.size,
      totalReads: this.totalReads,
      totalWrites: this.totalWrites,
      totalDenied: this.totalDenied,
      totalLeaks: this.leakDetector.getEvents().length,
      totalRotations: this.rotation.listStates().reduce((sum, s) => sum + s.totalRotations, 0),
      activeScopes: this.sandbox.listScopes().filter(s => !s.revoked).length,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Check the health of the underlying provider.
   */
  async healthCheck() {
    return this.sandbox.healthCheck();
  }

  /**
   * Get the audit trail.
   */
  getAuditEntries(): SecretAuditEntry[] {
    return this.audit.getEntries();
  }

  /**
   * Verify audit chain integrity.
   */
  verifyAuditChain(): { valid: boolean; brokenAt?: number; reason?: string } {
    return this.audit.verifyChain();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Securely dispose of all components.
   * After calling this, the layer is no longer usable.
   */
  async dispose(): Promise<void> {
    this.sandbox.exitScope();
    this.memoryStore.dispose();
    this.rotation.dispose();
    this.leakDetector.dispose();
    await this.injector.dispose();
    this.activeSecrets.clear();
  }
}
