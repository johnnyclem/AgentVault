/**
 * Secret Sandbox – Deny-first secret access control
 *
 * Inspired by Agent Safehouse's kernel-level deny-first sandboxing, this module
 * enforces that every secret access is denied unless an explicit grant exists in
 * the active scope.  It wraps any `SecretProvider` and interposes policy checks
 * on every operation.
 *
 * Design:
 * - Scopes are created per agent-execution and carry a list of grants.
 * - Each grant is a key-pattern + access-level pair.
 * - Before any provider call, the sandbox checks the scope for a matching grant.
 * - Denied operations are logged to the audit trail.
 */

import * as crypto from 'node:crypto';
import type { SecretProvider } from './provider.js';
import type {
  SecretSandboxScope,
  SecretScopeGrant,
  SecretAccessLevel,
  AuditAction,
} from './safehouse-types.js';

/** Callback type for audit events */
export type AuditCallback = (
  action: AuditAction,
  secretKey: string | undefined,
  allowed: boolean,
  reason?: string,
) => void;

/**
 * Options for creating a sandbox scope.
 */
export interface CreateScopeOptions {
  agentId: string;
  label?: string;
  grants: SecretScopeGrant[];
  expiresAt?: string | null;
  maxSecrets?: number;
  allowCrossAgent?: boolean;
}

/**
 * Matches a secret key against a glob-like pattern.
 * Supports `*` (any chars) and `?` (single char).
 */
function matchKeyPattern(pattern: string, key: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(key);
}

export class SecretSandbox {
  private readonly provider: SecretProvider;
  private readonly scopes = new Map<string, SecretSandboxScope>();
  private activeScope: SecretSandboxScope | null = null;
  private readonly onAudit: AuditCallback | null;

  /** Count of secret keys accessed in the active scope */
  private accessedKeys = new Set<string>();

  constructor(provider: SecretProvider, onAudit?: AuditCallback) {
    this.provider = provider;
    this.onAudit = onAudit ?? null;
  }

  // -----------------------------------------------------------------------
  // Scope management
  // -----------------------------------------------------------------------

  /**
   * Create a new sandbox scope.  The scope is not activated until `enterScope`
   * is called.
   */
  createScope(options: CreateScopeOptions): SecretSandboxScope {
    const scope: SecretSandboxScope = {
      scopeId: `scope_${crypto.randomBytes(8).toString('hex')}`,
      agentId: options.agentId,
      label: options.label,
      grants: options.grants,
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresAt ?? null,
      revoked: false,
      maxSecrets: options.maxSecrets,
      allowCrossAgent: options.allowCrossAgent ?? false,
    };

    this.scopes.set(scope.scopeId, scope);
    this.audit('scope.create', undefined, true);
    return scope;
  }

  /**
   * Activate a scope.  All subsequent secret operations are checked against it.
   */
  enterScope(scopeId: string): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) throw new Error(`Scope "${scopeId}" does not exist`);
    if (scope.revoked) throw new Error(`Scope "${scopeId}" has been revoked`);

    if (scope.expiresAt && new Date(scope.expiresAt) < new Date()) {
      throw new Error(`Scope "${scopeId}" has expired`);
    }

    this.activeScope = scope;
    this.accessedKeys.clear();
    this.audit('sandbox.enter', undefined, true);
  }

  /**
   * Deactivate the current scope.
   */
  exitScope(): void {
    this.audit('sandbox.exit', undefined, true);
    this.activeScope = null;
    this.accessedKeys.clear();
  }

  /**
   * Revoke a scope, preventing any further use.
   */
  revokeScope(scopeId: string): void {
    const scope = this.scopes.get(scopeId);
    if (!scope) throw new Error(`Scope "${scopeId}" does not exist`);
    scope.revoked = true;
    if (this.activeScope?.scopeId === scopeId) {
      this.activeScope = null;
      this.accessedKeys.clear();
    }
    this.audit('scope.revoke', undefined, true);
  }

  /**
   * Get the currently active scope (or null).
   */
  getActiveScope(): SecretSandboxScope | null {
    return this.activeScope ? { ...this.activeScope } : null;
  }

  /**
   * List all scopes.
   */
  listScopes(): SecretSandboxScope[] {
    return [...this.scopes.values()].map(s => ({ ...s }));
  }

  // -----------------------------------------------------------------------
  // Sandboxed provider operations
  // -----------------------------------------------------------------------

  /**
   * Read a secret, subject to scope policy.
   */
  async getSecret(key: string): Promise<string | null> {
    this.requireScope();
    if (!this.checkAccess(key, 'read')) {
      this.audit('secret.read', key, false, 'No matching grant for read access');
      this.audit('scope.deny', key, false, `read denied for "${key}"`);
      throw new Error(`Access denied: no read grant for secret "${key}"`);
    }

    this.trackAccess(key);
    const value = await this.provider.getSecret(key);
    this.audit('secret.read', key, true);
    return value;
  }

  /**
   * Store a secret, subject to scope policy.
   */
  async storeSecret(key: string, value: string): Promise<void> {
    this.requireScope();
    if (!this.checkAccess(key, 'write')) {
      this.audit('secret.write', key, false, 'No matching grant for write access');
      this.audit('scope.deny', key, false, `write denied for "${key}"`);
      throw new Error(`Access denied: no write grant for secret "${key}"`);
    }

    this.trackAccess(key);
    await this.provider.storeSecret(key, value);
    this.audit('secret.write', key, true);
  }

  /**
   * Delete a secret, subject to scope policy.
   */
  async deleteSecret(key: string): Promise<void> {
    this.requireScope();
    if (!this.checkAccess(key, 'admin')) {
      this.audit('secret.delete', key, false, 'No matching grant for admin access');
      this.audit('scope.deny', key, false, `delete denied for "${key}"`);
      throw new Error(`Access denied: no admin grant for secret "${key}"`);
    }

    await this.provider.deleteSecret(key);
    this.audit('secret.delete', key, true);
  }

  /**
   * List secrets, subject to scope policy.
   */
  async listSecrets(): Promise<string[]> {
    this.requireScope();

    // List is allowed if ANY grant exists with read or higher access
    const hasAnyGrant = this.activeScope!.grants.some(g => g.access !== 'none');
    if (!hasAnyGrant) {
      this.audit('secret.list', undefined, false, 'No grants with read or higher access');
      throw new Error('Access denied: no grants permit listing secrets');
    }

    const allKeys = await this.provider.listSecrets();
    this.audit('secret.list', undefined, true);

    // Filter to only keys the scope can read
    return allKeys.filter(key => this.checkAccess(key, 'read'));
  }

  /**
   * Health check (always allowed, not scope-gated).
   */
  async healthCheck() {
    return this.provider.healthCheck();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private requireScope(): void {
    if (!this.activeScope) {
      throw new Error('No active sandbox scope. Call enterScope() first.');
    }
    if (this.activeScope.revoked) {
      throw new Error('Active scope has been revoked');
    }
    if (this.activeScope.expiresAt && new Date(this.activeScope.expiresAt) < new Date()) {
      this.activeScope = null;
      throw new Error('Active scope has expired');
    }
  }

  /**
   * Check whether the active scope grants the required access level for a key.
   */
  private checkAccess(key: string, required: SecretAccessLevel): boolean {
    if (!this.activeScope) return false;

    const levelOrder: Record<SecretAccessLevel, number> = {
      none: 0,
      read: 1,
      write: 2,
      admin: 3,
    };

    const requiredLevel = levelOrder[required];

    for (const grant of this.activeScope.grants) {
      if (matchKeyPattern(grant.keyPattern, key)) {
        if (levelOrder[grant.access] >= requiredLevel) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Track a key access against the scope's maxSecrets limit.
   */
  private trackAccess(key: string): void {
    this.accessedKeys.add(key);

    if (
      this.activeScope?.maxSecrets &&
      this.accessedKeys.size > this.activeScope.maxSecrets
    ) {
      this.audit('scope.deny', key, false, 'maxSecrets limit exceeded');
      throw new Error(
        `Access denied: scope limit of ${this.activeScope.maxSecrets} secrets exceeded`,
      );
    }
  }

  private audit(action: AuditAction, secretKey: string | undefined, allowed: boolean, reason?: string): void {
    if (this.onAudit) {
      this.onAudit(action, secretKey, allowed, reason);
    }
  }
}
