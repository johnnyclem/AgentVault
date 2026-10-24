/**
 * The cards on the webapp's /wallets page
 * (webapp/src/app/(dashboard)/wallets/wallet-card.ts). GET /api/wallets sends
 * id, agentId, chain, address and createdAt but no balance, so a card must
 * leave the balance out (it used to print "NaN T") and lead with the agent
 * and chain, the same pair a /vault wallet row shows, so a user who follows
 * that row can pick the wallet out here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

interface WalletCardView {
  chain: string;
  agent: string | null;
  address: string | null;
  balance: number | null;
}

interface WalletCardModule {
  describeWallet: (wallet: Record<string, unknown>) => WalletCardView;
}

interface VaultItemsModule {
  walletToItem: (wallet: Record<string, unknown>) => { title: string; subtitle: string };
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const DASHBOARD = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', '(dashboard)');
let cards: WalletCardModule;
let vault: VaultItemsModule;

beforeAll(async () => {
  cards = (await import(join(DASHBOARD, 'wallets', 'wallet-card.ts'))) as WalletCardModule;
  vault = (await import(join(DASHBOARD, 'vault', 'vault-items.ts'))) as VaultItemsModule;
});

const PRINCIPAL = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

/** The shape GET /api/wallets really returns: no balance, no status. */
function wallet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wallet-1',
    agentId: 'research-agent',
    chain: 'icp',
    address: PRINCIPAL,
    principal: PRINCIPAL,
    type: 'local',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('describeWallet', () => {
  it('leads with the agent and chain and has no balance when the API sends none', () => {
    expect(cards.describeWallet(wallet())).toEqual({
      chain: 'ICP',
      agent: 'research-agent',
      address: PRINCIPAL,
      balance: null,
    });
  });

  it('names every chain the wallet store supports and passes an unknown one through', () => {
    const labels = ['icp', 'cketh', 'solana', 'polkadot', 'arweave', 'ICP', 'tezos'].map(
      (chain) => cards.describeWallet(wallet({ chain })).chain,
    );

    expect(labels).toEqual(['ICP', 'ckETH', 'Solana', 'Polkadot', 'Arweave', 'ICP', 'tezos']);
  });

  it('never reports a balance that is not a real number', () => {
    for (const balance of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc']) {
      expect(cards.describeWallet(wallet({ balance })).balance).toBeNull();
    }
  });

  it('keeps a balance the API does report, whether a number, a bigint or a numeric string', () => {
    expect(cards.describeWallet(wallet({ balance: 0 })).balance).toBe(0);
    expect(cards.describeWallet(wallet({ balance: 2_500_000 })).balance).toBe(2_500_000);
    expect(cards.describeWallet(wallet({ balance: 3_000_000_000_000n })).balance).toBe(3_000_000_000_000);
    expect(cards.describeWallet(wallet({ balance: '42' })).balance).toBe(42);
  });

  it('falls back to the principal and generic labels when fields are missing', () => {
    expect(
      cards.describeWallet(wallet({ chain: undefined, agentId: '  ', address: undefined })),
    ).toEqual({ chain: 'Wallet', agent: null, address: PRINCIPAL, balance: null });
    expect(cards.describeWallet(wallet({ address: '', principal: '' })).address).toBeNull();
  });

  it('shows the same agent and chain as the /vault row that links to /wallets', () => {
    for (const chain of ['icp', 'cketh', 'solana', 'polkadot', 'arweave']) {
      const w = wallet({ chain, agentId: `agent-${chain}` });
      const card = cards.describeWallet(w);
      const row = vault.walletToItem(w);

      expect(row.title).toBe(card.agent);
      expect(row.subtitle.startsWith(`${card.chain} `)).toBe(true);
    }
  });
});
