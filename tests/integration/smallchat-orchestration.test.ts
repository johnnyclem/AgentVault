import { describe, it, expect, beforeEach } from 'vitest';
import { SmallChatBridge } from '../../src/orchestration/smallchat-bridge.js';
import { SmallChatPolicyEngine } from '../../src/orchestration/smallchat-policy.js';
import { IntentCompressor } from '../../src/orchestration/smallchat-compression.js';
import {
  getAllToolDefinitions,
  getSuperclassChain,
  findToolClassForSelector,
  getMfaRequiredTools,
  getToolsByMinRisk,
} from '../../src/orchestration/smallchat-tools.js';

describe('SmallChat Integration — Full Pipeline', () => {
  let bridge: SmallChatBridge;
  let policy: SmallChatPolicyEngine;
  let compressor: IntentCompressor;

  beforeEach(() => {
    bridge = new SmallChatBridge({ enableCache: true });
    policy = new SmallChatPolicyEngine({
      mfaRequiredRiskLevels: ['critical'],
      rateLimit: { maxCalls: 100, windowMs: 60_000 },
      dedup: { windowMs: 2000, exemptSelectors: ['getCanisterStatus', 'getMetrics', 'getHealthStatus'] },
    });
    compressor = new IntentCompressor();
  });

  /**
   * Full pipeline: dispatch → policy → compress
   */
  function fullDispatch(selector: string, params: Record<string, unknown> = {}) {
    const dispatchResult = bridge.dispatch(selector, params);
    if (!dispatchResult.success || !dispatchResult.toolCall) {
      return { allowed: false, error: dispatchResult.error };
    }

    const policyResult = policy.evaluate(dispatchResult.toolCall);
    if (policyResult.decision !== 'allow') {
      return { allowed: false, decision: policyResult.decision, reason: policyResult.reason };
    }

    const compressed = compressor.encode(dispatchResult.toolCall);
    return {
      allowed: true,
      toolCall: dispatchResult.toolCall,
      compressed,
      policyDecision: policyResult.decision,
    };
  }

  it('processes a read-only query through the full pipeline', () => {
    const result = fullDispatch('getCanisterStatus');
    expect(result.allowed).toBe(true);
    expect(result.compressed).toBeDefined();
    expect(result.compressed!.bytes.length).toBe(38);
  });

  it('processes a wallet registration through the full pipeline', () => {
    const result = fullDispatch('registerWallet', {
      id: 'w1',
      agentId: 'agent1',
      chain: 'eth',
      address: '0xabc123',
    });
    expect(result.allowed).toBe(true);
    expect(result.toolCall!.resolvedMethod).toBe('registerWallet');
  });

  it('blocks critical operations without MFA', () => {
    const result = fullDispatch('bootstrap', {
      name: 'test',
      agentType: 'bot',
      version: '1.0.0',
    });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe('require_mfa');
  });

  it('rejects invalid parameters before reaching policy', () => {
    const result = fullDispatch('registerWallet', { id: 'w1' }); // missing required params
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Missing required parameter');
  });

  it('deduplicates repeated mutations', () => {
    const first = fullDispatch('registerWallet', {
      id: 'w1',
      agentId: 'agent1',
      chain: 'icp',
      address: 'abc',
    });
    expect(first.allowed).toBe(true);

    const second = fullDispatch('registerWallet', {
      id: 'w1',
      agentId: 'agent1',
      chain: 'icp',
      address: 'abc',
    });
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('Duplicate');
  });

  it('allows repeated reads (exempt from dedup)', () => {
    fullDispatch('getCanisterStatus');
    const second = fullDispatch('getCanisterStatus');
    expect(second.allowed).toBe(true);
  });

  it('leverages cache for repeated dispatches', () => {
    fullDispatch('getCanisterStatus');
    fullDispatch('getCanisterStatus');
    fullDispatch('getCanisterStatus');

    const stats = bridge.getStats();
    expect(stats.cacheHits).toBeGreaterThanOrEqual(2);
  });

  it('compresses a batch of tool calls efficiently', () => {
    const calls = [];
    for (let i = 0; i < 10; i++) {
      const result = bridge.dispatch('getWallet', { walletId: `w${i}` });
      if (result.success && result.toolCall) {
        calls.push(result.toolCall);
      }
    }

    const batch = compressor.encodeBatch(calls);
    expect(batch.length).toBe(10 * 38); // 380 bytes total

    // Compare to JSON encoding
    const jsonSize = calls.reduce((sum, c) => {
      return sum + JSON.stringify({ selector: c.selector, params: c.parameters }).length;
    }, 0);
    expect(batch.length).toBeLessThan(jsonSize);
  });
});

describe('SmallChat ToolClass Hierarchy', () => {
  it('has all expected tool definitions', () => {
    const allTools = getAllToolDefinitions();
    expect(allTools.size).toBeGreaterThan(20);

    // Core tools should exist
    expect(allTools.has('bootstrap')).toBe(true);
    expect(allTools.has('queueTransaction')).toBe(true);
    expect(allTools.has('registerWallet')).toBe(true);
    expect(allTools.has('storeEncryptedSecret')).toBe(true);
    expect(allTools.has('deriveVetKeysKey')).toBe(true);
  });

  it('resolves superclass chains correctly', () => {
    const chain = getSuperclassChain('TransactionTools');
    expect(chain).toEqual(['TransactionTools', 'WalletTools', 'BaseTools']);
  });

  it('finds tool classes for selectors', () => {
    const cls = findToolClassForSelector('queueTransaction');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('TransactionTools');
  });

  it('identifies MFA-required tools', () => {
    const mfaTools = getMfaRequiredTools();
    expect(mfaTools.length).toBeGreaterThan(5);

    const selectors = mfaTools.map((t) => t.selector);
    expect(selectors).toContain('bootstrap');
    expect(selectors).toContain('freeze');
    expect(selectors).toContain('queueTransaction');
    expect(selectors).toContain('storeEncryptedSecret');
  });

  it('filters tools by minimum risk level', () => {
    const highRisk = getToolsByMinRisk('high');
    expect(highRisk.length).toBeGreaterThan(5);

    for (const tool of highRisk) {
      expect(['high', 'critical']).toContain(tool.riskLevel);
    }
  });

  it('all tool selectors map to valid Candid methods', () => {
    const allTools = getAllToolDefinitions();
    for (const [selector, tool] of allTools) {
      expect(tool.candidMethod).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.category).toBeTruthy();
      expect(tool.riskLevel).toBeTruthy();
      // Selector should match or be related to the Candid method
      expect(selector).toBe(tool.selector);
    }
  });
});
