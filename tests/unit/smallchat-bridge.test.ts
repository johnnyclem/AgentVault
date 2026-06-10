import { describe, it, expect, beforeEach } from 'vitest';
import { SmallChatBridge } from '../../src/orchestration/smallchat-bridge.js';

describe('SmallChatBridge', () => {
  let bridge: SmallChatBridge;

  beforeEach(() => {
    bridge = new SmallChatBridge();
  });

  describe('selector interning', () => {
    it('assigns stable numeric IDs to selectors', () => {
      const id1 = bridge.getSelectorId('queueTransaction');
      const id2 = bridge.getSelectorId('queueTransaction');
      expect(id1).toBeDefined();
      expect(id1).toBe(id2);
    });

    it('assigns different IDs to different selectors', () => {
      const id1 = bridge.getSelectorId('queueTransaction');
      const id2 = bridge.getSelectorId('registerWallet');
      expect(id1).not.toBe(id2);
    });

    it('resolves IDs back to selector strings', () => {
      const id = bridge.getSelectorId('freeze');
      expect(id).toBeDefined();
      const resolved = bridge.resolveId(id!);
      expect(resolved).toBe('freeze');
    });

    it('registers all AgentVault tool selectors', () => {
      const entries = bridge.getSelectorEntries();
      expect(entries.length).toBeGreaterThan(20);

      const selectors = entries.map(([s]) => s);
      expect(selectors).toContain('bootstrap');
      expect(selectors).toContain('queueTransaction');
      expect(selectors).toContain('storeEncryptedSecret');
      expect(selectors).toContain('deriveVetKeysKey');
      expect(selectors).toContain('registerWallet');
    });
  });

  describe('dispatch', () => {
    it('resolves a known selector with valid parameters', () => {
      const result = bridge.dispatch('getCanisterStatus');
      expect(result.success).toBe(true);
      expect(result.toolCall).toBeDefined();
      expect(result.toolCall!.resolvedMethod).toBe('getCanisterStatus');
      expect(result.toolCall!.category).toBe('query');
      expect(result.toolCall!.riskLevel).toBe('low');
    });

    it('resolves a tool with parameters', () => {
      const result = bridge.dispatch('registerWallet', {
        id: 'w1',
        agentId: 'agent1',
        chain: 'icp',
        address: 'abc123',
      });
      expect(result.success).toBe(true);
      expect(result.toolCall!.resolvedMethod).toBe('registerWallet');
      expect(result.toolCall!.parameters).toEqual({
        id: 'w1',
        agentId: 'agent1',
        chain: 'icp',
        address: 'abc123',
      });
    });

    it('rejects missing required parameters', () => {
      const result = bridge.dispatch('registerWallet', { id: 'w1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter');
    });

    it('rejects invalid parameter types', () => {
      const result = bridge.dispatch('scheduleTransaction', {
        transactionId: 'tx1',
        executeAt: 'not-a-number',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('expected type');
    });

    it('rejects invalid enum values', () => {
      const result = bridge.dispatch('queueTransaction', {
        walletId: 'w1',
        action: 'invalid_action',
        parameters: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be one of');
    });

    it('returns error for unknown selectors', () => {
      const result = bridge.dispatch('nonExistentTool');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No tool found');
    });

    it('includes resolution path in tool call', () => {
      const result = bridge.dispatch('getCanisterStatus');
      expect(result.toolCall!.resolutionPath).toBeDefined();
      expect(result.toolCall!.resolutionPath.length).toBeGreaterThan(0);
    });

    it('generates a parameter hash', () => {
      const result = bridge.dispatch('getWallet', { walletId: 'w1' });
      expect(result.toolCall!.parameterHash).toBeDefined();
      expect(result.toolCall!.parameterHash).toHaveLength(64); // SHA-256 hex
    });
  });

  describe('resolution cache', () => {
    it('returns cached result on second dispatch with same params', () => {
      const first = bridge.dispatch('getCanisterStatus');
      const second = bridge.dispatch('getCanisterStatus');
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.toolCall!.cached).toBe(true);
    });

    it('does not cache when params differ', () => {
      bridge.dispatch('getWallet', { walletId: 'w1' });
      const second = bridge.dispatch('getWallet', { walletId: 'w2' });
      expect(second.toolCall!.cached).toBe(false);
    });

    it('can be disabled', () => {
      const noCacheBridge = new SmallChatBridge({ enableCache: false });
      noCacheBridge.dispatch('getCanisterStatus');
      const second = noCacheBridge.dispatch('getCanisterStatus');
      expect(second.toolCall!.cached).toBe(false);
    });

    it('can be invalidated', () => {
      bridge.dispatch('getCanisterStatus');
      bridge.invalidateCache();
      const second = bridge.dispatch('getCanisterStatus');
      expect(second.toolCall!.cached).toBe(false);
    });

    it('tracks cache hit rate in stats', () => {
      bridge.dispatch('getCanisterStatus');
      bridge.dispatch('getCanisterStatus');
      bridge.dispatch('getMetrics');

      const stats = bridge.getStats();
      expect(stats.totalDispatches).toBe(3);
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(2);
      expect(stats.cacheHitRate).toBeCloseTo(1 / 3);
    });
  });

  describe('system prompt header', () => {
    it('generates a compact tool description header', () => {
      const header = bridge.generateSystemPromptHeader();
      expect(header).toContain('# Available Agent Tools');
      expect(header).toContain('queueTransaction');
      expect(header).toContain('registerWallet');
      expect(header).toContain('bootstrap');
    });

    it('is significantly shorter than full JSON schemas', () => {
      const header = bridge.generateSystemPromptHeader();
      // The compact header should be much shorter than full JSON tool definitions
      // Full JSON for 30+ tools with schemas would be 10K+ characters
      expect(header.length).toBeLessThan(8000);
      expect(header.length).toBeGreaterThan(500);
    });

    it('includes parameter signatures', () => {
      const header = bridge.generateSystemPromptHeader();
      expect(header).toContain('walletId');
      expect(header).toContain('string');
    });
  });

  describe('tool definition access', () => {
    it('retrieves tool definitions by selector', () => {
      const tool = bridge.getToolDefinition('queueTransaction');
      expect(tool).toBeDefined();
      expect(tool!.candidMethod).toBe('queueTransaction');
      expect(tool!.category).toBe('transaction');
      expect(tool!.riskLevel).toBe('high');
    });

    it('returns undefined for unknown selectors', () => {
      const tool = bridge.getToolDefinition('nonExistent');
      expect(tool).toBeUndefined();
    });
  });
});
