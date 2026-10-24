/**
 * `agentvault wallet process-queue` records a transaction as signed only when
 * the wallet provider returned a chain signature. Threshold signing is not
 * implemented, so a transaction that asks for a threshold above 1 is failed
 * (before any wallet key is loaded) instead of being marked signed with an
 * empty signature.
 *
 * The canister actor, wallet store and chain provider are faked so the
 * command runs in-process and the canister calls can be inspected. The
 * threshold arrives as Candid `opt nat`, which the agent decodes as [] or
 * [bigint].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { IcpProvider } from '../../../src/wallet/providers/icp-provider.js';
import { CkEthProvider } from '../../../src/wallet/providers/cketh-provider.js';

const fakes = vi.hoisted(() => ({
  actor: {} as Record<string, ReturnType<typeof vi.fn>>,
  getWallet: vi.fn(),
  provider: {
    signTransaction: vi.fn(),
    sendTransaction: vi.fn(),
  },
}));

vi.mock('../../../src/canister/actor.js', () => ({
  createAnonymousAgent: () => ({}),
  createActor: () => fakes.actor,
}));

vi.mock('../../../src/wallet/wallet-manager.js', () => ({
  getWallet: fakes.getWallet,
}));

vi.mock('../../../src/wallet/index.js', () => ({
  createWalletProvider: () => fakes.provider,
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn().mockResolvedValue({ processAll: true }) },
}));

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      text: '',
      start: () => spinner,
      succeed: () => spinner,
      fail: () => spinner,
      warn: () => spinner,
    };
    return spinner;
  },
}));

import { handleProcessQueue } from '../../../cli/commands/wallet-process-queue.js';

const WALLET = { id: 'w1', chain: 'icp', address: 'addr-1', privateKey: 'key' };
const ETH_KEY = `0x${'11'.repeat(32)}`;
const ETH_RECIPIENT = '0x0987654321fedcba0987654321fedcba09876543';
const REAL_SIGNATURE = `0x${'ab'.repeat(65)}`;

function queuedTx(id: string, threshold: [] | [bigint] = [], to = 'addr-2') {
  return {
    id,
    action: {
      walletId: WALLET.id,
      action: { send_funds: null },
      parameters: [['to', to], ['amount', '1']] as [string, string][],
      priority: { normal: null },
      threshold,
    },
    status: { pending: null },
    retryCount: 0,
  };
}

function useQueue(transactions: ReturnType<typeof queuedTx>[]) {
  fakes.actor = {
    getTransactionQueueStats: vi.fn().mockResolvedValue({
      total: transactions.length, pending: transactions.length, queued: 0, signed: 0, completed: 0, failed: 0,
    }),
    getPendingTransactions: vi.fn().mockResolvedValue(transactions),
    markTransactionFailed: vi.fn().mockResolvedValue({ ok: 'failed' }),
    markTransactionSigned: vi.fn().mockResolvedValue({ ok: 'signed' }),
    markTransactionCompleted: vi.fn().mockResolvedValue({ ok: 'completed' }),
  };
}

describe('wallet process-queue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fakes.getWallet.mockReset().mockReturnValue(WALLET);
    fakes.provider.signTransaction.mockReset();
    fakes.provider.sendTransaction.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails a threshold transaction instead of marking it signed', async () => {
    useQueue([queuedTx('tx-threshold', [2n])]);

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionFailed).toHaveBeenCalledWith(
      'tx-threshold',
      'Threshold signing is not implemented; transaction tx-threshold was not signed',
    );
    expect(fakes.actor.markTransactionSigned).not.toHaveBeenCalled();
    expect(fakes.actor.markTransactionCompleted).not.toHaveBeenCalled();
    expect(fakes.getWallet).not.toHaveBeenCalled();
    expect(fakes.provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('signs a transaction with no threshold ([]) or a threshold of 1', async () => {
    useQueue([queuedTx('tx-none', []), queuedTx('tx-one', [1n])]);
    fakes.provider.signTransaction.mockResolvedValue({ txHash: 'h', signedTx: 'raw', signature: REAL_SIGNATURE });
    fakes.provider.sendTransaction.mockResolvedValue({ hash: 'chain-hash' });

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionSigned).toHaveBeenCalledWith('tx-none', REAL_SIGNATURE);
    expect(fakes.actor.markTransactionSigned).toHaveBeenCalledWith('tx-one', REAL_SIGNATURE);
    expect(fakes.actor.markTransactionFailed).not.toHaveBeenCalled();
  });

  it('records the wallet signature and the sent transaction hash', async () => {
    useQueue([queuedTx('tx-single')]);
    fakes.provider.signTransaction.mockResolvedValue({ txHash: 'h', signedTx: 'raw', signature: REAL_SIGNATURE });
    fakes.provider.sendTransaction.mockResolvedValue({ hash: 'chain-hash' });

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionSigned).toHaveBeenCalledWith('tx-single', REAL_SIGNATURE);
    expect(fakes.actor.markTransactionCompleted).toHaveBeenCalledWith('tx-single', 'chain-hash');
    expect(fakes.actor.markTransactionFailed).not.toHaveBeenCalled();
  });

  it('records the real ckETH signature, which recovers to the wallet address', async () => {
    const wallet = new ethers.Wallet(ETH_KEY);
    fakes.getWallet.mockReturnValue({ id: 'w1', chain: 'cketh', address: wallet.address, privateKey: ETH_KEY });
    const cketh = new CkEthProvider({ chain: 'cketh', rpcUrl: 'http://127.0.0.1:9' });
    fakes.provider.signTransaction.mockImplementation((tx, key) => cketh.signTransaction(tx, key));
    fakes.provider.sendTransaction.mockResolvedValue({ hash: 'chain-hash' });
    useQueue([queuedTx('tx-eth', [], ETH_RECIPIENT)]);

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionSigned).toHaveBeenCalledTimes(1);
    const [id, signature] = fakes.actor.markTransactionSigned!.mock.calls[0]!;
    expect(id).toBe('tx-eth');
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const signed = await fakes.provider.signTransaction.mock.results[0]!.value;
    const parsed = ethers.Transaction.from(signed.signedTx);
    expect(ethers.recoverAddress(parsed.unsignedHash, signature)).toBe(wallet.address);
    expect(parsed.value).toBe(ethers.parseEther('1'));
  });

  it.each([
    ['no signature', { txHash: 'h', signedTx: 'raw' }],
    ['the old ckETH placeholder "0x"', { txHash: '0x0', signedTx: 'raw', signature: '0x' }],
    ['an HMAC-sized placeholder', { txHash: 'h', signedTx: 'raw', signature: 'ab'.repeat(32) }],
  ])('fails a transaction whose signing produced %s', async (_label, signed) => {
    useQueue([queuedTx('tx-unsigned', [1n])]);
    fakes.provider.signTransaction.mockResolvedValue(signed);

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionFailed).toHaveBeenCalledWith(
      'tx-unsigned',
      'Signing failed: the wallet provider returned no chain signature',
    );
    expect(fakes.actor.markTransactionSigned).not.toHaveBeenCalled();
    expect(fakes.provider.sendTransaction).not.toHaveBeenCalled();
  });

  it('fails an ICP transaction with the provider\'s reason instead of recording an HMAC', async () => {
    const icp = new IcpProvider({ chain: 'icp' });
    fakes.provider.signTransaction.mockImplementation((tx, key) => icp.signTransaction(tx, key));
    useQueue([queuedTx('tx-icp')]);

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionFailed).toHaveBeenCalledWith(
      'tx-icp',
      'Signing ICP transactions is not implemented by this wallet provider',
    );
    expect(fakes.actor.markTransactionSigned).not.toHaveBeenCalled();
  });

  it('fails a transaction whose threshold cannot be read', async () => {
    useQueue([{ ...queuedTx('tx-odd'), action: { ...queuedTx('tx-odd').action, threshold: [2n, 3n] as unknown as [] } }]);

    await handleProcessQueue('agent-1', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(fakes.actor.markTransactionFailed).toHaveBeenCalledWith(
      'tx-odd',
      'Unreadable signing threshold; transaction tx-odd was not signed',
    );
    expect(fakes.getWallet).not.toHaveBeenCalled();
  });
});

describe('readThreshold', () => {
  it('decodes Candid opt nat', async () => {
    const { readThreshold } = await import('../../../src/wallet/transaction-queue.js');
    expect(readThreshold([])).toBe(1);
    expect(readThreshold([1n])).toBe(1);
    expect(readThreshold([2n])).toBe(2);
    expect(readThreshold(undefined)).toBe(1);
    expect(readThreshold([2n, 3n])).toBeNull();
    expect(readThreshold([undefined])).toBeNull();
    expect(readThreshold(null)).toBeNull();
    expect(readThreshold(['2'])).toBeNull();
    expect(readThreshold(1.5)).toBeNull();
  });
});
