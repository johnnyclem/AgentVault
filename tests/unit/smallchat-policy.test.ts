import { describe, it, expect, beforeEach } from 'vitest';
import { SmallChatBridge } from '../../src/orchestration/smallchat-bridge.js';
import { SmallChatPolicyEngine } from '../../src/orchestration/smallchat-policy.js';

describe('SmallChatPolicyEngine', () => {
  let bridge: SmallChatBridge;
  let policy: SmallChatPolicyEngine;

  function makeToolCall(selector: string, params: Record<string, unknown> = {}) {
    const result = bridge.dispatch(selector, params);
    if (!result.success || !result.toolCall) {
      throw new Error(`Failed to create tool call for '${selector}': ${result.error}`);
    }
    return result.toolCall;
  }

  beforeEach(() => {
    bridge = new SmallChatBridge({ enableCache: false });
    policy = new SmallChatPolicyEngine();
  });

  describe('basic allow/deny', () => {
    it('allows a low-risk query tool call', () => {
      const toolCall = makeToolCall('getCanisterStatus');
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('allow');
    });

    it('requires MFA for critical-risk tools by default', () => {
      const toolCall = makeToolCall('bootstrap', {
        name: 'test',
        agentType: 'bot',
        version: '1.0.0',
      });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('require_mfa');
      expect(result.mfaChallengeId).toBeDefined();
    });
  });

  describe('blocked categories', () => {
    it('blocks tool calls in a blocked category', () => {
      policy = new SmallChatPolicyEngine({
        blockedCategories: ['transaction'],
      });

      const toolCall = makeToolCall('queueTransaction', {
        walletId: 'w1',
        action: 'send_funds',
        parameters: { to: 'abc', amount: '100' },
      });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('blocked');
    });

    it('can block and unblock categories at runtime', () => {
      policy.blockCategory('wallet');
      const toolCall = makeToolCall('registerWallet', {
        id: 'w1',
        agentId: 'a1',
        chain: 'icp',
        address: 'abc',
      });
      let result = policy.evaluate(toolCall);
      expect(result.decision).toBe('deny');

      policy.unblockCategory('wallet');
      result = policy.evaluate(toolCall);
      expect(result.decision).toBe('allow');
    });
  });

  describe('rate limiting', () => {
    it('enforces global rate limit', () => {
      policy = new SmallChatPolicyEngine({
        rateLimit: { maxCalls: 3, windowMs: 60_000 },
        dedup: { windowMs: 0 }, // disable dedup for rate limit test
        mfaRequiredRiskLevels: [], // disable MFA for this test
      });

      // First 3 should pass (use different params to avoid dedup)
      for (let i = 0; i < 3; i++) {
        const toolCall = makeToolCall('getWallet', { walletId: `w${i}` });
        const result = policy.evaluate(toolCall);
        expect(result.decision).toBe('allow');
      }

      // 4th should be rate limited
      const toolCall = makeToolCall('getWallet', { walletId: 'w99' });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('rate limit');
    });

    it('enforces per-selector rate limits', () => {
      policy = new SmallChatPolicyEngine({
        rateLimit: {
          maxCalls: 100, // high global limit
          windowMs: 60_000,
          perSelector: {
            getMetrics: { maxCalls: 2, windowMs: 60_000 },
          },
        },
        mfaRequiredRiskLevels: [],
      });

      policy.evaluate(makeToolCall('getMetrics'));
      policy.evaluate(makeToolCall('getMetrics'));
      const result = policy.evaluate(makeToolCall('getMetrics'));
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('getMetrics');
    });

    it('resets rate limits', () => {
      policy = new SmallChatPolicyEngine({
        rateLimit: { maxCalls: 1, windowMs: 60_000 },
        dedup: { windowMs: 0 },
        mfaRequiredRiskLevels: [],
      });

      policy.evaluate(makeToolCall('getWallet', { walletId: 'w1' }));
      let result = policy.evaluate(makeToolCall('getWallet', { walletId: 'w2' }));
      expect(result.decision).toBe('deny');

      policy.resetRateLimits();
      result = policy.evaluate(makeToolCall('getWallet', { walletId: 'w3' }));
      expect(result.decision).toBe('allow');
    });
  });

  describe('semantic deduplication', () => {
    it('blocks duplicate dispatch within dedup window', () => {
      policy = new SmallChatPolicyEngine({
        dedup: { windowMs: 10_000 },
        mfaRequiredRiskLevels: [],
      });

      const toolCall = makeToolCall('getCanisterStatus');
      const first = policy.evaluate(toolCall);
      expect(first.decision).toBe('allow');

      const second = policy.evaluate(toolCall);
      expect(second.decision).toBe('deny');
      expect(second.reason).toContain('Duplicate dispatch');
    });

    it('allows same selector with different parameters', () => {
      policy = new SmallChatPolicyEngine({
        dedup: { windowMs: 10_000 },
        mfaRequiredRiskLevels: [],
      });

      policy.evaluate(makeToolCall('getWallet', { walletId: 'w1' }));
      const result = policy.evaluate(makeToolCall('getWallet', { walletId: 'w2' }));
      expect(result.decision).toBe('allow');
    });

    it('exempts specified selectors from dedup', () => {
      policy = new SmallChatPolicyEngine({
        dedup: { windowMs: 10_000, exemptSelectors: ['getCanisterStatus'] },
        mfaRequiredRiskLevels: [],
      });

      policy.evaluate(makeToolCall('getCanisterStatus'));
      const result = policy.evaluate(makeToolCall('getCanisterStatus'));
      expect(result.decision).toBe('allow');
    });

    it('clears dedup history', () => {
      policy = new SmallChatPolicyEngine({
        dedup: { windowMs: 10_000 },
        mfaRequiredRiskLevels: [],
      });

      policy.evaluate(makeToolCall('getCanisterStatus'));
      policy.clearDedupHistory();
      const result = policy.evaluate(makeToolCall('getCanisterStatus'));
      expect(result.decision).toBe('allow');
    });
  });

  describe('MFA gating', () => {
    it('requires MFA for configured risk levels', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: ['high', 'critical'],
      });

      const toolCall = makeToolCall('queueTransaction', {
        walletId: 'w1',
        action: 'send_funds',
        parameters: { to: 'abc', amount: '100' },
      });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('require_mfa');
    });

    it('requires MFA for explicitly listed selectors', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: [],
        mfaRequiredSelectors: ['getCanisterStatus'],
      });

      const result = policy.evaluate(makeToolCall('getCanisterStatus'));
      expect(result.decision).toBe('require_mfa');
      expect(result.reason).toContain('explicitly configured');
    });
  });

  describe('custom policy rules', () => {
    it('applies custom deny rules', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: [],
        rules: [
          {
            id: 'block-deploys',
            description: 'Block contract deployments during maintenance',
            selectors: ['queueTransaction'],
            action: 'deny',
            enabled: true,
          },
        ],
      });

      const toolCall = makeToolCall('queueTransaction', {
        walletId: 'w1',
        action: 'deploy_contract',
        parameters: {},
      });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('deny');
    });

    it('applies custom require_approval rules', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: [],
        rules: [
          {
            id: 'approve-secrets',
            description: 'Require approval for secret operations',
            categories: ['secret'],
            action: 'require_approval',
            enabled: true,
          },
        ],
      });

      const toolCall = makeToolCall('storeEncryptedSecret', {
        id: 's1',
        ciphertext: 'abcd',
        iv: '1234',
        tag: '5678',
      });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('require_approval');
      expect(result.approvalRequestId).toBeDefined();
    });

    it('skips disabled rules', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: [],
        rules: [
          {
            id: 'disabled-rule',
            description: 'This is disabled',
            action: 'deny',
            enabled: false,
          },
        ],
      });

      const result = policy.evaluate(makeToolCall('getCanisterStatus'));
      expect(result.decision).toBe('allow');
    });

    it('can add and remove rules at runtime', () => {
      policy = new SmallChatPolicyEngine({ mfaRequiredRiskLevels: [] });

      policy.addRule({
        id: 'temp-block',
        description: 'Temporary block',
        selectors: ['getMetrics'],
        action: 'deny',
        enabled: true,
      });

      let result = policy.evaluate(makeToolCall('getMetrics'));
      expect(result.decision).toBe('deny');

      policy.removeRule('temp-block');
      result = policy.evaluate(makeToolCall('getMetrics'));
      expect(result.decision).toBe('allow');
    });
  });

  describe('parameter size limits', () => {
    it('rejects oversized parameters', () => {
      policy = new SmallChatPolicyEngine({
        maxParameterSize: 100,
        mfaRequiredRiskLevels: [],
      });

      const toolCall = makeToolCall('getWallet', { walletId: 'x'.repeat(200) });
      const result = policy.evaluate(toolCall);
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('exceeds maximum');
    });
  });

  describe('audit trail', () => {
    it('records every policy evaluation', () => {
      policy = new SmallChatPolicyEngine({ mfaRequiredRiskLevels: [] });

      policy.evaluate(makeToolCall('getCanisterStatus'));
      policy.evaluate(makeToolCall('getMetrics'));

      const log = policy.getAuditLog();
      expect(log).toHaveLength(2);
      expect(log[0]!.selector).toBe('getCanisterStatus');
      expect(log[1]!.selector).toBe('getMetrics');
    });

    it('records caller identity', () => {
      policy = new SmallChatPolicyEngine({ mfaRequiredRiskLevels: [] });

      policy.evaluate(makeToolCall('getCanisterStatus'), 'user-123');
      const log = policy.getAuditLog();
      expect(log[0]!.callerId).toBe('user-123');
    });

    it('filters audit log by decision', () => {
      policy = new SmallChatPolicyEngine({
        mfaRequiredRiskLevels: ['critical'],
      });

      policy.evaluate(makeToolCall('getCanisterStatus'));
      policy.evaluate(makeToolCall('bootstrap', {
        name: 'test',
        agentType: 'bot',
        version: '1.0.0',
      }));

      const allowed = policy.getAuditByDecision('allow');
      const mfaRequired = policy.getAuditByDecision('require_mfa');
      expect(allowed).toHaveLength(1);
      expect(mfaRequired).toHaveLength(1);
    });

    it('clears audit log', () => {
      policy = new SmallChatPolicyEngine({ mfaRequiredRiskLevels: [] });
      policy.evaluate(makeToolCall('getCanisterStatus'));
      expect(policy.getAuditLog()).toHaveLength(1);

      policy.clearAuditLog();
      expect(policy.getAuditLog()).toHaveLength(0);
    });
  });
});
