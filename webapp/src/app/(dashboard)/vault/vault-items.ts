import type { Agent, Archive, Wallet } from '@/lib/types'

/*
 * The /vault list is assembled from three endpoints the dashboard already has:
 * wallets, archives and agents (each agent has a compliance proof page). The
 * mapping lives apart from the page so the masking rules can be tested without
 * a browser. Imports from '@/' stay type-only: the root test suite loads this
 * file directly and cannot resolve the webapp's aliases at runtime.
 */

export type VaultCategory = 'wallets' | 'archives' | 'proofs'
export type VaultFilter = 'all' | VaultCategory

export const VAULT_CATEGORIES: readonly VaultCategory[] = ['wallets', 'archives', 'proofs']

export const VAULT_FILTERS: readonly { id: VaultFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'archives', label: 'Archives' },
  { id: 'proofs', label: 'Proofs' },
]

export interface VaultItem {
  key: string
  category: VaultCategory
  title: string
  /** Shown under the title; never carries a full address or transaction id */
  subtitle: string
  href: string
  /** ISO time used for ordering, present only when it parses */
  timestamp?: string
  /** Ticker on a wallet's tile; other tiles use an icon */
  monogram?: string
}

const CHAINS: Record<string, { label: string; ticker: string }> = {
  icp: { label: 'ICP', ticker: 'ICP' },
  cketh: { label: 'ckETH', ticker: 'ckETH' },
  solana: { label: 'Solana', ticker: 'SOL' },
  polkadot: { label: 'Polkadot', ticker: 'DOT' },
  arweave: { label: 'Arweave', ticker: 'AR' },
}

/** Unknown values (a typo in ?filter=, or none) fall back to showing everything. */
export function parseVaultFilter(value: string | null | undefined): VaultFilter {
  return VAULT_FILTERS.find((filter) => filter.id === value)?.id ?? 'all'
}

/**
 * '•••• 3f9a': the last few letters and digits only. ICP principals are
 * dash-separated groups, so separators are skipped rather than counted.
 */
export function maskTail(value: string, visible = 4): string {
  const tail = value.replace(/[^a-zA-Z0-9]/g, '').slice(-visible)
  return tail ? `•••• ${tail}` : '••••'
}

function validTimestamp(value: string | undefined): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined
}

export function walletToItem(wallet: Wallet): VaultItem {
  const chain = wallet.chain ? CHAINS[wallet.chain.toLowerCase()] : undefined
  const label = chain?.label ?? (wallet.chain || 'Wallet')
  const address = wallet.address || wallet.principal

  return {
    key: `wallet:${wallet.id}`,
    category: 'wallets',
    title: wallet.agentId || 'Wallet',
    subtitle: address ? `${label} ${maskTail(address)}` : label,
    // There is no per-wallet page; the wallets page lists them all.
    href: '/wallets',
    timestamp: validTimestamp(wallet.createdAt),
    monogram: chain?.ticker,
  }
}

export function archiveToItem(archive: Archive): VaultItem {
  const date = validTimestamp(archive.timestamp)

  return {
    key: `archive:${archive.id}`,
    category: 'archives',
    title: archive.agentName || (date ? `Archive · ${new Date(date).toLocaleDateString()}` : 'Archive'),
    subtitle: archive.arweaveTxId
      ? `Arweave · tx ${maskTail(archive.arweaveTxId)}`
      : `Local · ${archive.status}`,
    // Each card on /archives carries its archive id, and the page scrolls to the hash once loaded.
    href: `/archives#${archive.id}`,
    timestamp: date,
  }
}

export function agentToProofItem(agent: Agent): VaultItem {
  return {
    key: `proof:${agent.id}`,
    category: 'proofs',
    title: agent.name || agent.id,
    subtitle: `Compliance proof · ${agent.status}`,
    href: `/vault/${agent.id}/proof`,
    timestamp: validTimestamp(agent.updatedAt),
  }
}

/** Newest first; items without a usable time sink to the end in their original order. */
export function sortByRecent(items: readonly VaultItem[]): VaultItem[] {
  const time = (item: VaultItem) => (item.timestamp ? Date.parse(item.timestamp) : -Infinity)
  return [...items].sort((a, b) => time(b) - time(a) || 0)
}

export function buildVaultItems(sources: {
  wallets: readonly Wallet[]
  archives: readonly Archive[]
  agents: readonly Agent[]
}): VaultItem[] {
  return sortByRecent([
    ...sources.wallets.map(walletToItem),
    ...sources.archives.map(archiveToItem),
    ...sources.agents.map(agentToProofItem),
  ])
}

export function countByCategory(items: readonly VaultItem[]): Record<VaultFilter, number> {
  const counts: Record<VaultFilter, number> = { all: items.length, wallets: 0, archives: 0, proofs: 0 }
  for (const item of items) counts[item.category] += 1
  return counts
}

/** Where one endpoint behind the list stands: still fetching, or failed with an error. */
export interface SourceStatus {
  pending: boolean
  error: unknown
}

/**
 * The number a filter pill shows, or null while it is not known. A count is
 * known only once every source the filter covers has loaded. All covers every
 * source, so a single failed one hides its total too: a failed source's rows
 * are missing (or stale) in `counts`, and "All 0" beside an error would read
 * as an empty vault. Pills for the sources that did load keep their own counts.
 */
export function knownCount(
  filter: VaultFilter,
  counts: Record<VaultFilter, number>,
  sources: Record<VaultCategory, SourceStatus>
): number | null {
  const covered = filter === 'all' ? VAULT_CATEGORIES : [filter]
  return covered.some((category) => sources[category].pending || sources[category].error) ? null : counts[filter]
}
