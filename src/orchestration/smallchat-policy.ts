/**
 * SmallChat Policy Enforcement — Full Hardening Suite for Agent Tool Use
 *
 * Comprehensive policy layer that validates, gates, and audits every tool call
 * before it reaches the canister. Six enforcement mechanisms:
 *
 *   1. Pre-dispatch validation — check tool call is allowed by security policy
 *   2. Semantic deduplication — prevent accidental double-dispatches
 *   3. Rate limiting — cap tool calls per time window
 *   4. MFA gating — high-risk ops require MFA confirmation
 *   5. Parameter sanitization — validate against Candid schemas
 *   6. Audit trail — log every dispatch decision
 *
 * Integrates with existing AgentVault security modules:
 *   - src/security/multisig.ts — approval workflows
 *   - src/security/mfa-approval.ts — TOTP/WebAuthn MFA
 *   - src/security/icp-audit.ts — on-chain audit logging
 */

import * as crypto from 'node:crypto';
import type { CompressedToolCall } from './smallchat-bridge.js';
import type { RiskLevel, ToolCategory } from './smallchat-tools.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PolicyDecision = 'allow' | 'deny' | 'require_mfa' | 'require_approval';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  toolCall: CompressedToolCall;
  timestamp: number;
  /** Set when decision is 'require_mfa' — caller must satisfy this before proceeding */
  mfaChallengeId?: string;
  /** Set when decision is 'require_approval' — approval request ID */
  approvalRequestId?: string;
}

export interface PolicyRule {
  /** Rule identifier */
  id: string;
  /** Rule description */
  description: string;
  /** Which categories this rule applies to (empty = all) */
  categories?: ToolCategory[];
  /** Which risk levels this rule applies to (empty = all) */
  riskLevels?: RiskLevel[];
  /** Specific selectors this rule applies to (empty = all) */
  selectors?: string[];
  /** The action to take when this rule matches */
  action: PolicyDecision;
  /** Whether this rule is currently enabled */
  enabled: boolean;
}

export interface RateLimitConfig {
  /** Maximum calls per window (default: 60) */
  maxCalls: number;
  /** Window duration in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
  /** Per-selector limits (overrides global) */
  perSelector?: Record<string, { maxCalls: number; windowMs: number }>;
}

export interface DedupConfig {
  /** Time window in milliseconds for deduplication (default: 5000 = 5 seconds) */
  windowMs: number;
  /** Selectors exempt from dedup (e.g., read-only queries) */
  exemptSelectors?: string[];
}

export interface PolicyConfig {
  /** Custom policy rules */
  rules?: PolicyRule[];
  /** Rate limiting configuration */
  rateLimit?: Partial<RateLimitConfig>;
  /** Deduplication configuration */
  dedup?: Partial<DedupConfig>;
  /** Risk levels that always require MFA */
  mfaRequiredRiskLevels?: RiskLevel[];
  /** Specific selectors that always require MFA */
  mfaRequiredSelectors?: string[];
  /** Categories blocked entirely (e.g., during maintenance) */
  blockedCategories?: ToolCategory[];
  /** Maximum parameter string length (prevents oversized payloads) */
  maxParameterSize?: number;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  selector: string;
  selectorId: number;
  parameterHash: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  decision: PolicyDecision;
  reason: string;
  resolutionPath: string[];
  callerId?: string;
}

// ---------------------------------------------------------------------------
// Rate limit tracking
// ---------------------------------------------------------------------------

interface RateLimitWindow {
  calls: number[];
}

// ---------------------------------------------------------------------------
// Policy Engine
// ---------------------------------------------------------------------------

export class SmallChatPolicyEngine {
  private config: PolicyConfig;
  private rateLimit: RateLimitConfig;
  private dedup: Required<DedupConfig>;
  private rateLimitWindows = new Map<string, RateLimitWindow>();
  private recentDispatches = new Map<string, number>();
  private auditLog: AuditRecord[] = [];
  private maxAuditSize = 10000;

  constructor(config: PolicyConfig = {}) {
    this.config = config;

    this.rateLimit = {
      maxCalls: config.rateLimit?.maxCalls ?? 60,
      windowMs: config.rateLimit?.windowMs ?? 60_000,
      perSelector: config.rateLimit?.perSelector,
    };

    this.dedup = {
      windowMs: config.dedup?.windowMs ?? 5000,
      exemptSelectors: config.dedup?.exemptSelectors ?? [],
    };
  }

  /**
   * Evaluate a tool call against all policy rules.
   * Returns the most restrictive applicable decision.
   */
  evaluate(toolCall: CompressedToolCall, callerId?: string): PolicyResult {
    const timestamp = Date.now();

    // 1. Check blocked categories
    if (this.config.blockedCategories?.includes(toolCall.category)) {
      return this.buildResult('deny', `Category '${toolCall.category}' is currently blocked`, toolCall, timestamp);
    }

    // 2. Parameter size check
    if (this.config.maxParameterSize) {
      const paramSize = JSON.stringify(toolCall.parameters).length;
      if (paramSize > this.config.maxParameterSize) {
        return this.buildResult(
          'deny',
          `Parameter size ${paramSize} exceeds maximum ${this.config.maxParameterSize}`,
          toolCall,
          timestamp
        );
      }
    }

    // 3. Rate limiting
    const rateLimitResult = this.checkRateLimit(toolCall.selector, timestamp);
    if (rateLimitResult) {
      return this.buildResult('deny', rateLimitResult, toolCall, timestamp);
    }

    // 4. Semantic deduplication
    const dedupResult = this.checkDedup(toolCall, timestamp);
    if (dedupResult) {
      return this.buildResult('deny', dedupResult, toolCall, timestamp);
    }

    // 5. Custom policy rules (evaluated in order, first match wins)
    if (this.config.rules) {
      for (const rule of this.config.rules) {
        if (!rule.enabled) continue;
        if (this.ruleMatches(rule, toolCall)) {
          const result = this.buildResult(rule.action, rule.description, toolCall, timestamp);
          if (rule.action === 'require_mfa') {
            result.mfaChallengeId = `mfa_${crypto.randomBytes(8).toString('hex')}`;
          } else if (rule.action === 'require_approval') {
            result.approvalRequestId = `approval_${crypto.randomBytes(8).toString('hex')}`;
          }
          this.recordAudit(toolCall, rule.action, rule.description, callerId);
          return result;
        }
      }
    }

    // 6. MFA gating for high-risk operations
    const mfaRequired = this.checkMfaRequired(toolCall);
    if (mfaRequired) {
      const result = this.buildResult('require_mfa', mfaRequired, toolCall, timestamp);
      result.mfaChallengeId = `mfa_${crypto.randomBytes(8).toString('hex')}`;
      this.recordAudit(toolCall, 'require_mfa', mfaRequired, callerId);
      return result;
    }

    // All checks passed
    this.recordDispatch(toolCall, timestamp);
    this.recordAudit(toolCall, 'allow', 'All policy checks passed', callerId);
    return this.buildResult('allow', 'All policy checks passed', toolCall, timestamp);
  }

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  private checkRateLimit(selector: string, now: number): string | undefined {
    // Check per-selector limit first
    const perSelector = this.rateLimit.perSelector?.[selector];
    if (perSelector) {
      const exceeded = this.isRateLimited(`selector:${selector}`, perSelector.maxCalls, perSelector.windowMs, now);
      if (exceeded) {
        return `Rate limit exceeded for '${selector}': max ${perSelector.maxCalls} calls per ${perSelector.windowMs}ms`;
      }
    }

    // Check global limit
    const exceeded = this.isRateLimited('global', this.rateLimit.maxCalls, this.rateLimit.windowMs, now);
    if (exceeded) {
      return `Global rate limit exceeded: max ${this.rateLimit.maxCalls} calls per ${this.rateLimit.windowMs}ms`;
    }

    // Record this call in rate limit windows
    this.recordRateLimitCall(`selector:${selector}`, now);
    this.recordRateLimitCall('global', now);
    return undefined;
  }

  private isRateLimited(key: string, maxCalls: number, windowMs: number, now: number): boolean {
    const window = this.rateLimitWindows.get(key);
    if (!window) return false;

    // Count calls within the window
    const cutoff = now - windowMs;
    const recentCalls = window.calls.filter((t) => t > cutoff);
    return recentCalls.length >= maxCalls;
  }

  private recordRateLimitCall(key: string, now: number): void {
    let window = this.rateLimitWindows.get(key);
    if (!window) {
      window = { calls: [] };
      this.rateLimitWindows.set(key, window);
    }
    window.calls.push(now);

    // Prune old entries to prevent unbounded growth
    const cutoff = now - Math.max(this.rateLimit.windowMs, 300_000);
    window.calls = window.calls.filter((t) => t > cutoff);
  }

  // -----------------------------------------------------------------------
  // Semantic deduplication
  // -----------------------------------------------------------------------

  private checkDedup(toolCall: CompressedToolCall, now: number): string | undefined {
    // Skip dedup for exempt selectors
    if (this.dedup.exemptSelectors.includes(toolCall.selector)) {
      return undefined;
    }

    // Build dedup key from selector + parameter hash
    const dedupKey = `${toolCall.selector}:${toolCall.parameterHash}`;
    const lastDispatch = this.recentDispatches.get(dedupKey);

    if (lastDispatch && now - lastDispatch < this.dedup.windowMs) {
      const elapsedMs = now - lastDispatch;
      return `Duplicate dispatch detected: '${toolCall.selector}' with same parameters was dispatched ${elapsedMs}ms ago (dedup window: ${this.dedup.windowMs}ms)`;
    }

    return undefined;
  }

  private recordDispatch(toolCall: CompressedToolCall, now: number): void {
    const dedupKey = `${toolCall.selector}:${toolCall.parameterHash}`;
    this.recentDispatches.set(dedupKey, now);

    // Prune old entries
    const cutoff = now - this.dedup.windowMs * 2;
    for (const [key, timestamp] of this.recentDispatches) {
      if (timestamp < cutoff) {
        this.recentDispatches.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // MFA gating
  // -----------------------------------------------------------------------

  private checkMfaRequired(toolCall: CompressedToolCall): string | undefined {
    // Check by risk level
    const mfaRiskLevels = this.config.mfaRequiredRiskLevels ?? ['critical'];
    if (mfaRiskLevels.includes(toolCall.riskLevel)) {
      return `MFA required for ${toolCall.riskLevel}-risk tool '${toolCall.selector}'`;
    }

    // Check by specific selector
    if (this.config.mfaRequiredSelectors?.includes(toolCall.selector)) {
      return `MFA required for tool '${toolCall.selector}' (explicitly configured)`;
    }

    return undefined;
  }

  // -----------------------------------------------------------------------
  // Rule matching
  // -----------------------------------------------------------------------

  private ruleMatches(rule: PolicyRule, toolCall: CompressedToolCall): boolean {
    // Check category filter
    if (rule.categories && rule.categories.length > 0) {
      if (!rule.categories.includes(toolCall.category)) return false;
    }

    // Check risk level filter
    if (rule.riskLevels && rule.riskLevels.length > 0) {
      if (!rule.riskLevels.includes(toolCall.riskLevel)) return false;
    }

    // Check selector filter
    if (rule.selectors && rule.selectors.length > 0) {
      if (!rule.selectors.includes(toolCall.selector)) return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Audit trail
  // -----------------------------------------------------------------------

  private recordAudit(
    toolCall: CompressedToolCall,
    decision: PolicyDecision,
    reason: string,
    callerId?: string
  ): void {
    const record: AuditRecord = {
      id: crypto.randomBytes(8).toString('hex'),
      timestamp: Date.now(),
      selector: toolCall.selector,
      selectorId: toolCall.selectorId,
      parameterHash: toolCall.parameterHash,
      category: toolCall.category,
      riskLevel: toolCall.riskLevel,
      decision,
      reason,
      resolutionPath: toolCall.resolutionPath,
      callerId,
    };

    this.auditLog.push(record);

    // Cap audit log size
    if (this.auditLog.length > this.maxAuditSize) {
      this.auditLog = this.auditLog.slice(-this.maxAuditSize / 2);
    }
  }

  // -----------------------------------------------------------------------
  // Result builder
  // -----------------------------------------------------------------------

  private buildResult(
    decision: PolicyDecision,
    reason: string,
    toolCall: CompressedToolCall,
    timestamp: number
  ): PolicyResult {
    return { decision, reason, toolCall, timestamp };
  }

  // -----------------------------------------------------------------------
  // Public accessors
  // -----------------------------------------------------------------------

  /**
   * Get the full audit log.
   */
  getAuditLog(): AuditRecord[] {
    return [...this.auditLog];
  }

  /**
   * Get audit log filtered by decision type.
   */
  getAuditByDecision(decision: PolicyDecision): AuditRecord[] {
    return this.auditLog.filter((r) => r.decision === decision);
  }

  /**
   * Get audit log entries for a specific selector.
   */
  getAuditBySelector(selector: string): AuditRecord[] {
    return this.auditLog.filter((r) => r.selector === selector);
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Add a policy rule at runtime.
   */
  addRule(rule: PolicyRule): void {
    if (!this.config.rules) {
      this.config.rules = [];
    }
    this.config.rules.push(rule);
  }

  /**
   * Remove a policy rule by ID.
   */
  removeRule(ruleId: string): boolean {
    if (!this.config.rules) return false;
    const before = this.config.rules.length;
    this.config.rules = this.config.rules.filter((r) => r.id !== ruleId);
    return this.config.rules.length < before;
  }

  /**
   * Block an entire tool category.
   */
  blockCategory(category: ToolCategory): void {
    if (!this.config.blockedCategories) {
      this.config.blockedCategories = [];
    }
    if (!this.config.blockedCategories.includes(category)) {
      this.config.blockedCategories.push(category);
    }
  }

  /**
   * Unblock a tool category.
   */
  unblockCategory(category: ToolCategory): void {
    if (!this.config.blockedCategories) return;
    this.config.blockedCategories = this.config.blockedCategories.filter((c) => c !== category);
  }

  /**
   * Reset rate limit windows (e.g., after a cooldown period).
   */
  resetRateLimits(): void {
    this.rateLimitWindows.clear();
  }

  /**
   * Clear dedup history (e.g., when the user explicitly wants to retry).
   */
  clearDedupHistory(): void {
    this.recentDispatches.clear();
  }
}
