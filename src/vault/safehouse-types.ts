/**
 * Types for the Agent Safehouse Secret Management Layer
 *
 * Inspired by Agent Safehouse's deny-first sandboxing philosophy, applied to
 * secret management: every secret access is denied by default and must be
 * explicitly permitted by a scope policy.
 */

// ---------------------------------------------------------------------------
// Secret Scope & Policy
// ---------------------------------------------------------------------------

/**
 * Access level for a secret within a sandbox scope.
 */
export type SecretAccessLevel = 'none' | 'read' | 'write' | 'admin';

/**
 * A single permission grant within a sandbox scope.
 */
export interface SecretScopeGrant {
  /** Glob pattern matching secret keys (e.g. "api_*", "db_password") */
  keyPattern: string;
  /** Access level */
  access: SecretAccessLevel;
  /** Optional TTL override (seconds) for secrets matching this grant */
  ttlSeconds?: number;
  /** Maximum number of reads before the grant is revoked */
  maxReads?: number;
}

/**
 * A sandbox scope defines the complete set of secret permissions for one agent
 * execution. Follows the deny-first principle: anything not explicitly granted
 * is denied.
 */
export interface SecretSandboxScope {
  /** Unique scope identifier */
  scopeId: string;
  /** Agent this scope applies to */
  agentId: string;
  /** Human-readable label */
  label?: string;
  /** Explicit grants (deny-first: only these are allowed) */
  grants: SecretScopeGrant[];
  /** When this scope was created */
  createdAt: string;
  /** When this scope expires (ISO-8601). Null = session-scoped. */
  expiresAt: string | null;
  /** Whether this scope has been revoked */
  revoked: boolean;
  /** Maximum total secrets accessible through this scope */
  maxSecrets?: number;
  /** Whether to allow accessing secrets from other agents' namespaces */
  allowCrossAgent: boolean;
}

// ---------------------------------------------------------------------------
// Encrypted Memory Store
// ---------------------------------------------------------------------------

/**
 * A secret value held in the encrypted memory store.
 * The plaintext is encrypted in-memory with an ephemeral key.
 */
export interface EncryptedMemoryEntry {
  /** Original secret key */
  key: string;
  /** AES-256-GCM encrypted value (base64) */
  ciphertext: string;
  /** Initialization vector (base64) */
  iv: string;
  /** Auth tag (base64) */
  authTag: string;
  /** When this entry was cached */
  cachedAt: number;
  /** TTL in milliseconds. 0 = no expiry (session-scoped). */
  ttlMs: number;
  /** Number of times this entry has been read */
  readCount: number;
  /** Maximum reads allowed. 0 = unlimited. */
  maxReads: number;
}

// ---------------------------------------------------------------------------
// Secret Rotation
// ---------------------------------------------------------------------------

export type RotationStrategy = 'periodic' | 'on-access' | 'manual';

/**
 * Configuration for automatic secret rotation.
 */
export interface SecretRotationConfig {
  /** Secret key to rotate */
  key: string;
  /** Rotation strategy */
  strategy: RotationStrategy;
  /** For periodic: interval in seconds */
  intervalSeconds?: number;
  /** For on-access: rotate after N reads */
  rotateAfterReads?: number;
  /** Callback that produces a new secret value */
  generator: () => Promise<string>;
  /** Notification callback on rotation */
  onRotated?: (key: string, version: number) => void;
}

export interface SecretRotationState {
  key: string;
  currentVersion: number;
  lastRotatedAt: string;
  totalRotations: number;
  nextRotationAt?: string;
  readsSinceRotation: number;
}

// ---------------------------------------------------------------------------
// Leak Detection
// ---------------------------------------------------------------------------

export type LeakSeverity = 'info' | 'warning' | 'critical';

export interface LeakDetectionEvent {
  /** When the leak was detected */
  detectedAt: string;
  /** Severity level */
  severity: LeakSeverity;
  /** Description of the leak vector */
  description: string;
  /** The secret key that was leaked (NOT the value) */
  secretKey: string;
  /** Where the leak was detected */
  source: 'env' | 'log' | 'process-args' | 'file' | 'network' | 'stdout';
  /** Whether the leak was automatically remediated */
  remediated: boolean;
  /** Remediation action taken */
  remediationAction?: string;
}

// ---------------------------------------------------------------------------
// Secret Injection
// ---------------------------------------------------------------------------

export type InjectionMethod = 'memory-fd' | 'tmpfs-file' | 'env-scoped' | 'callback';

/**
 * Configuration for injecting secrets into an agent's execution context.
 */
export interface SecretInjectionConfig {
  /** Injection method */
  method: InjectionMethod;
  /** For tmpfs-file: directory to use (default: auto-detect tmpfs) */
  tmpfsPath?: string;
  /** For env-scoped: prefix for environment variable names */
  envPrefix?: string;
  /** Auto-cleanup after injection (default: true) */
  autoCleanup?: boolean;
  /** Maximum time (ms) the injection remains valid */
  maxLifetimeMs?: number;
}

export interface InjectedSecret {
  /** Secret key */
  key: string;
  /** How it was injected */
  method: InjectionMethod;
  /** Reference for retrieval (fd number, file path, env name, etc.) */
  reference: string;
  /** When the injection was created */
  injectedAt: string;
  /** When the injection expires */
  expiresAt: string | null;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'secret.read'
  | 'secret.write'
  | 'secret.delete'
  | 'secret.list'
  | 'secret.rotate'
  | 'secret.inject'
  | 'secret.leak_detected'
  | 'scope.create'
  | 'scope.revoke'
  | 'scope.deny'
  | 'sandbox.enter'
  | 'sandbox.exit';

export interface SecretAuditEntry {
  /** Unique entry ID */
  id: string;
  /** Timestamp */
  timestamp: string;
  /** Action performed */
  action: AuditAction;
  /** Agent performing the action */
  agentId: string;
  /** Scope ID under which the action was performed */
  scopeId: string;
  /** Secret key involved (if applicable) */
  secretKey?: string;
  /** Whether the action was allowed or denied */
  allowed: boolean;
  /** Reason for denial (if denied) */
  denialReason?: string;
  /** Additional metadata */
  metadata?: Record<string, string>;
  /** SHA-256 hash of previous entry (chain integrity) */
  previousHash?: string;
  /** SHA-256 hash of this entry */
  entryHash: string;
}

// ---------------------------------------------------------------------------
// Secret Management Layer (unified orchestrator)
// ---------------------------------------------------------------------------

export interface SecretManagementLayerConfig {
  /** Default TTL for cached secrets (seconds). Default: 300 (5 minutes). */
  defaultTtlSeconds?: number;
  /** Enable leak detection. Default: true. */
  leakDetection?: boolean;
  /** Enable audit trail. Default: true. */
  auditEnabled?: boolean;
  /** Maximum number of secrets an agent can access per session. Default: 100. */
  maxSecretsPerSession?: number;
  /** Secret injection method. Default: 'memory-fd'. */
  injectionMethod?: InjectionMethod;
  /** Secret provider backend */
  backend?: 'hashicorp' | 'bitwarden' | 'memory';
  /** Auto-wipe interval for expired entries (ms). Default: 30000. */
  autoWipeIntervalMs?: number;
}

export interface SecretManagementStats {
  /** Total secrets currently cached */
  cachedSecrets: number;
  /** Total read operations */
  totalReads: number;
  /** Total write operations */
  totalWrites: number;
  /** Total denied operations */
  totalDenied: number;
  /** Total leak events */
  totalLeaks: number;
  /** Total rotations performed */
  totalRotations: number;
  /** Active scopes */
  activeScopes: number;
  /** Uptime in ms */
  uptimeMs: number;
}
