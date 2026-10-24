/**
 * The webapp's /vault list (webapp/src/app/(dashboard)/vault/vault-items.ts):
 * wallets, archives and agent proofs mapped to one kind of row. Subtitles are
 * masked the way the page shows them ("ICP •••• 3f9a"), so a full address or
 * transaction id never reaches the list; each row links to a page that exists.
 * A filter pill shows a count only once every source it covers has loaded.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

type VaultFilter = 'all' | 'wallets' | 'archives' | 'proofs';

interface VaultItem {
  key: string;
  category: Exclude<VaultFilter, 'all'>;
  title: string;
  subtitle: string;
  href: string;
  timestamp?: string;
  monogram?: string;
}

interface SourceStatus {
  pending: boolean;
  error: unknown;
}

type Sources = Record<Exclude<VaultFilter, 'all'>, SourceStatus>;

interface VaultItemsModule {
  parseVaultFilter: (value: string | null | undefined) => VaultFilter;
  maskTail: (value: string, visible?: number) => string;
  walletToItem: (wallet: Record<string, unknown>) => VaultItem;
  archiveToItem: (archive: Record<string, unknown>) => VaultItem;
  agentToProofItem: (agent: Record<string, unknown>) => VaultItem;
  buildVaultItems: (sources: { wallets: unknown[]; archives: unknown[]; agents: unknown[] }) => VaultItem[];
  countByCategory: (items: VaultItem[]) => Record<VaultFilter, number>;
  knownCount: (filter: VaultFilter, counts: Record<VaultFilter, number>, sources: Sources) => number | null;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', '(dashboard)', 'vault', 'vault-items.ts');
let vault: VaultItemsModule;

beforeAll(async () => {
  vault = (await import(MODULE)) as VaultItemsModule;
});

const PRINCIPAL = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const TX_ID = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';

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

function archive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'archive-1761300000000-1a2b3c4d',
    agentName: 'research-agent',
    status: 'completed',
    canisterId: '',
    timestamp: '2026-10-22T10:00:00.000Z',
    size: 2048,
    checksum: 'abc123',
    arweaveTxId: TX_ID,
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'research-agent',
    name: 'Research agent',
    status: 'active',
    config: { entry: 'index.js', memory: 128, compute: 'medium' },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

describe('maskTail', () => {
  it('keeps the last four letters and digits, skipping a principal\'s dashes', () => {
    expect(vault.maskTail(PRINCIPAL)).toBe('•••• qcai');
    expect(vault.maskTail('0x3F9A')).toBe('•••• 3F9A');
  });

  it('shows only the bullets when nothing alphanumeric is left', () => {
    expect(vault.maskTail('---')).toBe('••••');
  });
});

describe('walletToItem', () => {
  it('titles the row with the agent and masks the address under the chain name', () => {
    const item = vault.walletToItem(wallet());

    expect(item).toMatchObject({
      key: 'wallet:wallet-1',
      category: 'wallets',
      title: 'research-agent',
      subtitle: 'ICP •••• qcai',
      href: '/wallets',
      monogram: 'ICP',
      timestamp: '2026-10-20T10:00:00.000Z',
    });
    expect(item.subtitle).not.toContain(PRINCIPAL);
  });

  it('names every chain the wallet store supports', () => {
    const labels = ['icp', 'cketh', 'solana', 'polkadot', 'arweave'].map(
      (chain) => vault.walletToItem(wallet({ chain, address: 'abcd1234' })).subtitle,
    );

    expect(labels).toEqual(['ICP •••• 1234', 'ckETH •••• 1234', 'Solana •••• 1234', 'Polkadot •••• 1234', 'Arweave •••• 1234']);
  });

  it('falls back to the principal, a generic label and an icon tile when fields are missing', () => {
    const item = vault.walletToItem(wallet({ chain: undefined, agentId: undefined, address: undefined }));

    expect(item.title).toBe('Wallet');
    expect(item.subtitle).toBe('Wallet •••• qcai');
    expect(item.monogram).toBeUndefined();
  });
});

describe('archiveToItem', () => {
  it('titles the row with the agent and masks the Arweave transaction', () => {
    const item = vault.archiveToItem(archive());

    expect(item).toMatchObject({
      category: 'archives',
      title: 'research-agent',
      subtitle: 'Arweave · tx •••• tDtU',
      href: '/archives#archive-1761300000000-1a2b3c4d',
    });
    expect(item.subtitle).not.toContain(TX_ID);
  });

  it('shows the local status before upload, and a dated title when the server sends no agent name', () => {
    const item = vault.archiveToItem(archive({ arweaveTxId: undefined, status: 'prepared', agentName: undefined }));

    expect(item.subtitle).toBe('Local · prepared');
    expect(item.title.startsWith('Archive · ')).toBe(true);
  });
});

describe('agentToProofItem', () => {
  it('links each agent to its compliance proof page', () => {
    expect(vault.agentToProofItem(agent())).toMatchObject({
      key: 'proof:research-agent',
      category: 'proofs',
      title: 'Research agent',
      subtitle: 'Compliance proof · active',
      href: '/vault/research-agent/proof',
      timestamp: '2026-10-21T10:00:00.000Z',
    });
  });
});

describe('buildVaultItems and countByCategory', () => {
  it('lists newest first, puts rows without a usable time last, and counts each filter', () => {
    const items = vault.buildVaultItems({
      wallets: [wallet(), wallet({ id: 'wallet-2', createdAt: 'not a date' })],
      archives: [archive()],
      agents: [agent()],
    });

    expect(items.map((item) => item.key)).toEqual([
      'archive:archive-1761300000000-1a2b3c4d',
      'proof:research-agent',
      'wallet:wallet-1',
      'wallet:wallet-2',
    ]);
    expect(items[3]?.timestamp).toBeUndefined();
    expect(vault.countByCategory(items)).toEqual({ all: 4, wallets: 2, archives: 1, proofs: 1 });
  });
});

describe('knownCount', () => {
  // What the page holds when wallets failed (the hooks keep an empty list on error) and the rest loaded
  const counts = { all: 4, wallets: 0, archives: 1, proofs: 3 };
  const loaded: SourceStatus = { pending: false, error: null };
  const sources = (overrides: Partial<Sources> = {}): Sources => ({
    wallets: loaded,
    archives: loaded,
    proofs: loaded,
    ...overrides,
  });

  it('shows every count once all three sources have loaded', () => {
    expect(['all', 'wallets', 'archives', 'proofs'].map((filter) => vault.knownCount(filter as VaultFilter, counts, sources())))
      .toEqual([4, 0, 1, 3]);
  });

  it('shows no count for a filter, or for All, while a source it covers is loading', () => {
    const loading = sources({ archives: { pending: true, error: null } });

    expect(vault.knownCount('archives', counts, loading)).toBeNull();
    expect(vault.knownCount('all', counts, loading)).toBeNull();
    expect(vault.knownCount('proofs', counts, loading)).toBe(3);
  });

  it('gives All no total when any source failed, so a short or zero total never reads as complete', () => {
    const walletsFailed = sources({ wallets: { pending: false, error: new Error('Missing Authorization header') } });

    expect(vault.knownCount('all', counts, walletsFailed)).toBeNull();
    expect(vault.knownCount('wallets', counts, walletsFailed)).toBeNull();
    expect(vault.knownCount('archives', counts, walletsFailed)).toBe(1);
    expect(vault.knownCount('proofs', counts, walletsFailed)).toBe(3);
  });

  it('shows no counts at all when every source failed, rather than All 0', () => {
    const failed: SourceStatus = { pending: false, error: new Error('Missing Authorization header') };
    const none = { all: 0, wallets: 0, archives: 0, proofs: 0 };

    expect(['all', 'wallets', 'archives', 'proofs'].map((filter) =>
      vault.knownCount(filter as VaultFilter, none, sources({ wallets: failed, archives: failed, proofs: failed }))))
      .toEqual([null, null, null, null]);
  });
});

describe('parseVaultFilter', () => {
  it('accepts the four filters and falls back to all for anything else', () => {
    expect(['all', 'wallets', 'archives', 'proofs'].map((value) => vault.parseVaultFilter(value)))
      .toEqual(['all', 'wallets', 'archives', 'proofs']);
    expect(vault.parseVaultFilter('backups')).toBe('all');
    expect(vault.parseVaultFilter(null)).toBe('all');
  });
});
