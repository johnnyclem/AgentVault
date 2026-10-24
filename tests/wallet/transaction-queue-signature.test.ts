import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wallet/wallet-manager.js', () => ({
  getWallet: () => ({ id: 'w1', chain: 'icp' }),
}));

import { TransactionQueueProcessor, type QueuedTransaction } from '../../src/wallet/transaction-queue.js';

function queued(): QueuedTransaction {
  return {
    id: 'tx-1',
    action: { walletId: 'w1', action: 'send_funds', parameters: [['to', 'abc'], ['amount', '1']], priority: 'normal', threshold: [] },
    status: 'pending',
    retryCount: 0,
    createdAt: 0,
  } as unknown as QueuedTransaction;
}

function actor() {
  return {
    getPendingTransactions: vi.fn(async () => [queued()]),
    markTransactionSigned: vi.fn(async () => ({ ok: null })),
    markTransactionFailed: vi.fn(async () => ({ ok: null })),
    retryTransaction: vi.fn(async () => ({ ok: null })),
  };
}

describe('TransactionQueueProcessor signing', () => {
  for (const [label, signature] of [
    ['no signature', undefined],
    ['an empty signature', ''],
    ['a bare 0x', '0x'],
    ['an HMAC-sized placeholder', 'ab'.repeat(32)],
  ] as const) {
    it(`fails the transaction for ${label}`, async () => {
      const a = actor();
      const processor = new TransactionQueueProcessor('canister', a);
      const [result] = await processor.processPendingTransactions(async () => ({ txHash: 'h', signature } as never));
      expect(result?.success).toBe(false);
      expect(a.markTransactionSigned).not.toHaveBeenCalled();
      expect(a.markTransactionFailed).toHaveBeenCalledWith('tx-1', 'Signing failed');
    });
  }

  it('records a chain-shaped signature as signed', async () => {
    const a = actor();
    const processor = new TransactionQueueProcessor('canister', a);
    const signature = 'cd'.repeat(64);
    const [result] = await processor.processPendingTransactions(async () => ({ txHash: 'h', signature } as never));
    expect(result?.success).toBe(true);
    expect(a.markTransactionSigned).toHaveBeenCalledWith('tx-1', signature);
  });
});
