/**
 * The webapp's /vault list (webapp/src/app/(dashboard)/vault/vault-items.ts):
 * wallets, archives and each agent's evidence mapped to one kind of row.
 * Subtitles are masked the way the page shows them ("ICP •••• 3f9a"), so a
 * full address or transaction id never reaches the list; each row links to a
 * page that exists. An agent's row counts its Arweave receipts from the
 * archives, and says so when the archives are not loaded rather than claiming
 * there are none. A filter pill shows a count only once every source it
 * covers has loaded, and a filter reports every source its rows depend on.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

type VaultFilter = 'all' | 'wallets' | 'archives' | 'evidence';

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

type ReceiptCount = number | 'loading' | 'unavailable';

interface VaultItemsModule {
  parseVaultFilter: (value: string | null | undefined) => VaultFilter;
  maskTail: (value: string, visible?: number) => string;
  walletToItem: (wallet: Record<string, unknown>) => VaultItem;
  archiveToItem: (archive: Record<string, unknown>) => VaultItem;
  agentToEvidenceItem: (agent: Record<string, unknown>, receipts: ReceiptCount) => VaultItem;
  countReceipts: (archives: Array<Record<string, unknown>>) => Map<string, number>;
  receiptSubtitle: (count: ReceiptCount) => string;
  buildVaultItems: (sources: {
    wallets: unknown[];
    archives: unknown[];
    agents: unknown[];
    archivesStatus: SourceStatus;
  }) => VaultItem[];
  countByCategory: (items: VaultItem[]) => Record<VaultFilter, number>;
  knownCount: (filter: VaultFilter, counts: Record<VaultFilter, number>, sources: Sources) => number | null;
  sourcesFor: (filter: VaultFilter) => readonly Exclude<VaultFilter, 'all'>[];
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
    status: 'submitted',
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

describe('agentToEvidenceItem', () => {
  it('links each agent to its evidence page, which kept its /proof path', () => {
    expect(vault.agentToEvidenceItem(agent(), 2)).toMatchObject({
      key: 'evidence:research-agent',
      category: 'evidence',
      title: 'Research agent',
      subtitle: '2 Arweave receipts',
      href: '/vault/research-agent/proof',
      timestamp: '2026-10-21T10:00:00.000Z',
    });
  });
});

describe('receiptSubtitle', () => {
  it('counts receipts, and says plainly when there are none', () => {
    expect([0, 1, 3].map((count) => vault.receiptSubtitle(count))).toEqual([
      'No receipts yet',
      '1 Arweave receipt',
      '3 Arweave receipts',
    ]);
  });

  it('says the count is not known while the archives load or after they fail', () => {
    expect(vault.receiptSubtitle('loading')).toBe('Loading receipts…');
    expect(vault.receiptSubtitle('unavailable')).toBe('Receipts not loaded');
  });
});

describe('countReceipts', () => {
  it('counts archives with an Arweave transaction under the agent id they were recorded with', () => {
    const counts = vault.countReceipts([
      archive({ id: 'a1' }),
      archive({ id: 'a2', arweaveTxId: 'tDHtC3A3H8mdz7OQh7gDs2LFKWr4vVQtnIjxs7WUaoQ' }),
      archive({ id: 'a3', arweaveTxId: undefined, status: 'prepared' }),
      archive({ id: 'a4', arweaveTxId: '', status: 'failed' }),
      archive({ id: 'a5', agentName: 'support-agent' }),
      archive({ id: 'a6', agentName: undefined }),
    ]);

    expect([...counts]).toEqual([
      ['research-agent', 2],
      ['support-agent', 1],
    ]);
  });

  it('matches the agent id, not its display name', () => {
    const counts = vault.countReceipts([archive({ agentName: 'Research agent' })]);

    expect(counts.get('research-agent')).toBeUndefined();
  });
});

describe('buildVaultItems and countByCategory', () => {
  const loaded: SourceStatus = { pending: false, error: null };

  it('lists newest first, puts rows without a usable time last, and counts each filter', () => {
    const items = vault.buildVaultItems({
      wallets: [wallet(), wallet({ id: 'wallet-2', createdAt: 'not a date' })],
      archives: [archive()],
      agents: [agent()],
      archivesStatus: loaded,
    });

    expect(items.map((item) => item.key)).toEqual([
      'archive:archive-1761300000000-1a2b3c4d',
      'evidence:research-agent',
      'wallet:wallet-1',
      'wallet:wallet-2',
    ]);
    expect(items[3]?.timestamp).toBeUndefined();
    expect(vault.countByCategory(items)).toEqual({ all: 4, wallets: 2, archives: 1, evidence: 1 });
  });

  it('gives each agent row its own receipt count from the loaded archives', () => {
    const items = vault.buildVaultItems({
      wallets: [],
      archives: [
        archive({ id: 'a1' }),
        archive({ id: 'a2' }),
        archive({ id: 'a3', arweaveTxId: undefined, status: 'prepared' }),
      ],
      agents: [agent(), agent({ id: 'support-agent', name: 'Support agent' })],
      archivesStatus: loaded,
    });
    const subtitles = Object.fromEntries(
      items.filter((item) => item.category === 'evidence').map((item) => [item.key, item.subtitle]),
    );

    expect(subtitles).toEqual({
      'evidence:research-agent': '2 Arweave receipts',
      'evidence:support-agent': 'No receipts yet',
    });
  });

  it('never says "No receipts yet" for archives it has not loaded', () => {
    const subtitle = (archivesStatus: SourceStatus) =>
      vault.buildVaultItems({ wallets: [], archives: [archive()], agents: [agent()], archivesStatus })
        .find((item) => item.category === 'evidence')?.subtitle;

    expect(subtitle({ pending: true, error: null })).toBe('Loading receipts…');
    expect(subtitle({ pending: false, error: new Error('Missing Authorization header') })).toBe('Receipts not loaded');
  });
});

describe('knownCount', () => {
  // What the page holds when wallets failed (the hooks keep an empty list on error) and the rest loaded
  const counts = { all: 4, wallets: 0, archives: 1, evidence: 3 };
  const loaded: SourceStatus = { pending: false, error: null };
  const sources = (overrides: Partial<Sources> = {}): Sources => ({
    wallets: loaded,
    archives: loaded,
    evidence: loaded,
    ...overrides,
  });

  it('shows every count once all three sources have loaded', () => {
    expect(['all', 'wallets', 'archives', 'evidence'].map((filter) => vault.knownCount(filter as VaultFilter, counts, sources())))
      .toEqual([4, 0, 1, 3]);
  });

  it('shows no count for a filter, or for All, while a source it covers is loading', () => {
    const loading = sources({ archives: { pending: true, error: null } });

    expect(vault.knownCount('archives', counts, loading)).toBeNull();
    expect(vault.knownCount('all', counts, loading)).toBeNull();
    expect(vault.knownCount('evidence', counts, loading)).toBe(3);
  });

  it('gives All no total when any source failed, so a short or zero total never reads as complete', () => {
    const walletsFailed = sources({ wallets: { pending: false, error: new Error('Missing Authorization header') } });

    expect(vault.knownCount('all', counts, walletsFailed)).toBeNull();
    expect(vault.knownCount('wallets', counts, walletsFailed)).toBeNull();
    expect(vault.knownCount('archives', counts, walletsFailed)).toBe(1);
    expect(vault.knownCount('evidence', counts, walletsFailed)).toBe(3);
  });

  it('shows no counts at all when every source failed, rather than All 0', () => {
    const failed: SourceStatus = { pending: false, error: new Error('Missing Authorization header') };
    const none = { all: 0, wallets: 0, archives: 0, evidence: 0 };

    expect(['all', 'wallets', 'archives', 'evidence'].map((filter) =>
      vault.knownCount(filter as VaultFilter, none, sources({ wallets: failed, archives: failed, evidence: failed }))))
      .toEqual([null, null, null, null]);
  });
});

describe('sourcesFor', () => {
  it('reports the archives under Evidence too, since each agent row counts its receipts from them', () => {
    // Otherwise a failed archives request leaves every row saying "Receipts not loaded" with no error or Retry.
    expect(vault.sourcesFor('evidence')).toEqual(['evidence', 'archives']);
  });

  it('reports every source under All, and only its own source under Wallets or Archives', () => {
    expect(vault.sourcesFor('all')).toEqual(['wallets', 'archives', 'evidence']);
    expect(vault.sourcesFor('wallets')).toEqual(['wallets']);
    expect(vault.sourcesFor('archives')).toEqual(['archives']);
  });
});

describe('parseVaultFilter', () => {
  it('accepts the four filters and falls back to all for anything else', () => {
    expect(['all', 'wallets', 'archives', 'evidence'].map((value) => vault.parseVaultFilter(value)))
      .toEqual(['all', 'wallets', 'archives', 'evidence']);
    expect(vault.parseVaultFilter('backups')).toBe('all');
    expect(vault.parseVaultFilter(null)).toBe('all');
  });

  it('shows everything for an old ?filter=proofs link', () => {
    expect(vault.parseVaultFilter('proofs')).toBe('all');
  });
});
