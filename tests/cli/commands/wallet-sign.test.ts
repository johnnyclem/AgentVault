/**
 * `agentvault wallet sign` reports "Transaction signed" and offers to save a
 * signed-tx file only when the provider returned a chain signature. ICP and
 * Arweave providers cannot sign, so for those wallets it fails and saves
 * nothing.
 *
 * The wallet store, prompts and spinner are faked; the providers are real
 * (signing needs no network).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';

const fakes = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  answers: {} as Record<string, unknown>,
  spinner: { succeed: [] as string[], fail: [] as string[] },
  provider: null as null | { connect: () => Promise<void>; signTransaction: (tx: unknown, key: string) => Promise<unknown> },
}));

vi.mock('../../../src/wallet/index.js', async () => {
  const { createWalletProvider } = await vi.importActual<typeof import('../../../src/wallet/providers/provider-factory.js')>(
    '../../../src/wallet/providers/provider-factory.js',
  );
  return {
    listAgentWallets: () => [fakes.wallet['id']],
    getWallet: () => fakes.wallet,
    createWalletProvider: (chain: string) => fakes.provider ?? createWalletProvider(chain, { rpcUrl: 'http://127.0.0.1:9' }),
  };
});

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(async (questions: Array<{ name: string }>) =>
      Object.fromEntries(questions.map((q) => [q.name, fakes.answers[q.name]])),
    ),
  },
}));

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      start: () => spinner,
      succeed: (text: string) => { fakes.spinner.succeed.push(text); return spinner; },
      fail: (text: string) => { fakes.spinner.fail.push(text); return spinner; },
    };
    return spinner;
  },
}));

import { handleSign } from '../../../cli/commands/wallet-sign.js';

const ETH_KEY = `0x${'11'.repeat(32)}`;
const ETH_RECIPIENT = '0x0987654321fedcba0987654321fedcba09876543';

let projectDir: string;
let printed: string[];

function savedFiles(): string[] {
  const dir = join(projectDir, '.agentvault', 'signed-txs');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'av-wallet-sign-'));
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  fakes.spinner.succeed = [];
  fakes.spinner.fail = [];
  fakes.provider = null;
  fakes.answers = { walletId: 'w1', amount: '1.5', gasPrice: '', gasLimit: '', memo: '', confirm: true, save: true };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('wallet sign', () => {
  it.each([
    ['icp', 'aaaaa-aa', 'Signing ICP transactions is not implemented by this wallet provider'],
    ['arweave', 'a'.repeat(43), 'Signing Arweave transactions is not implemented by this wallet provider'],
  ])('refuses to sign for a %s wallet and saves nothing', async (chain, to, reason) => {
    fakes.wallet = { id: 'w1', chain, address: to, privateKey: 'secret' };
    fakes.answers['to'] = to;

    await handleSign('agent-1');

    expect(fakes.spinner.succeed).not.toContain('Transaction signed');
    expect(fakes.spinner.fail).toEqual([`Failed to sign transaction: ${reason}`]);
    expect(savedFiles()).toEqual([]);
  });

  it('refuses a provider result without a chain signature and saves nothing', async () => {
    fakes.wallet = { id: 'w1', chain: 'cketh', address: '0x1', privateKey: ETH_KEY };
    fakes.answers['to'] = ETH_RECIPIENT;
    fakes.provider = {
      connect: async () => undefined,
      signTransaction: async (tx) => ({ txHash: '0x0', signedTx: '0x', signature: '0x', request: tx }),
    };

    await handleSign('agent-1');

    expect(fakes.spinner.succeed).not.toContain('Transaction signed');
    expect(fakes.spinner.fail).toEqual(['Failed to sign transaction: the wallet provider returned no chain signature']);
    expect(savedFiles()).toEqual([]);
  });

  it('signs a ckETH transfer with a real signature and saves it', async () => {
    const wallet = new ethers.Wallet(ETH_KEY);
    fakes.wallet = { id: 'w1', chain: 'cketh', address: wallet.address, privateKey: ETH_KEY };
    fakes.answers['to'] = ETH_RECIPIENT;
    // connect() would query the RPC for the chain id; signing itself is offline
    const { CkEthProvider } = await import('../../../src/wallet/providers/cketh-provider.js');
    const cketh = new CkEthProvider({ chain: 'cketh', rpcUrl: 'http://127.0.0.1:9' });
    fakes.provider = { connect: async () => undefined, signTransaction: (tx, key) => cketh.signTransaction(tx, key) };

    await handleSign('agent-1');

    expect(fakes.spinner.succeed).toEqual(['Transaction signed']);
    expect(savedFiles()).toHaveLength(1);
    const signatureLine = printed.find((line) => line.includes('Signature:'));
    const signature = signatureLine?.split('Signature:')[1]?.trim() ?? '';
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
