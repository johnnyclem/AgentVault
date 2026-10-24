'use client'

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Archive, ChevronRight, Receipt, Wallet } from 'lucide-react'
import { useAgentList } from '@/hooks/useAgentList'
import { useArchives } from '@/hooks/useArchives'
import { useWallets } from '@/hooks/useWallets'
import { cn, formatTimestamp } from '@/lib/utils'
import {
  VAULT_CATEGORIES,
  VAULT_FILTERS,
  buildVaultItems,
  countByCategory,
  knownCount,
  parseVaultFilter,
  sourcesFor,
  type SourceStatus,
  type VaultCategory,
  type VaultFilter,
  type VaultItem,
} from './vault-items'

interface Source extends SourceStatus {
  /** Lower-case noun for messages: "Couldn't load wallets" */
  noun: string
  error: Error | null
  retry: () => void
}

const TILE_ICONS = { wallets: Wallet, archives: Archive, evidence: Receipt } as const

const LIST_FORMAT = new Intl.ListFormat('en', { type: 'conjunction' })

const EMPTY_COPY: Record<VaultFilter, ReactNode> = {
  all: 'Nothing here yet. Add an agent, a wallet or an archive and it shows up here.',
  wallets: (
    <>
      No wallets yet. Create one with{' '}
      <code className="font-mono text-foreground">agentvault wallet create --agent-id &lt;agent&gt; --chain icp</code>.
    </>
  ),
  archives: 'No archives yet. Archive an agent from its page to keep a copy here.',
  evidence: 'No agents yet. Once you add one, its Arweave receipts can be checked here.',
}

export default function VaultPage() {
  const wallets = useWallets()
  const archives = useArchives()
  const agents = useAgentList()
  const [filter, setFilter] = useState<VaultFilter>('all')
  const [mounted, setMounted] = useState(false)

  // Until mount every source counts as loading: the hooks only start fetching
  // in their own effects, so their first render would otherwise look empty.
  useEffect(() => {
    setMounted(true)
  }, [])

  const sources: Record<VaultCategory, Source> = {
    wallets: { noun: 'wallets', pending: !mounted || wallets.isLoading, error: wallets.error, retry: wallets.refetch },
    archives: { noun: 'archives', pending: !mounted || archives.isLoading, error: archives.error, retry: archives.refetch },
    evidence: { noun: 'agents', pending: !mounted || agents.isLoading, error: agents.error, retry: agents.refetch },
  }

  const archivesPending = sources.archives.pending
  const archivesError = sources.archives.error
  const items = useMemo(
    () =>
      buildVaultItems({
        wallets: wallets.wallets,
        archives: archives.archives,
        agents: agents.agents,
        archivesStatus: { pending: archivesPending, error: archivesError },
      }),
    [wallets.wallets, archives.archives, agents.agents, archivesPending, archivesError]
  )
  const counts = countByCategory(items)

  // The categories whose rows the filter lists, and every source those rows are built from.
  const relevant: readonly VaultCategory[] = filter === 'all' ? VAULT_CATEGORIES : [filter]
  const dependsOn = sourcesFor(filter)
  const visible = filter === 'all' ? items : items.filter((item) => item.category === filter)
  const pending = dependsOn.filter((category) => sources[category].pending)
  const failed = dependsOn.filter((category) => !sources[category].pending && sources[category].error)

  const selectFilter = (id: VaultFilter) => {
    setFilter(id)
    replaceFilterInUrl(id)
  }

  return (
    <div className="page max-w-3xl">
      <div className="space-y-1">
        <h1 className="page-title">Vault</h1>
        <p className="page-subtitle">
          Wallets, archives and Arweave receipts for every agent you run: Claude Code, Goose, OpenCode, OpenClaw or your own stack.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter the vault">
        {VAULT_FILTERS.map(({ id, label }) => {
          const count = knownCount(id, counts, sources)
          return (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => selectFilter(id)}
              className={cn('chip text-sm', filter === id && 'chip-active')}
            >
              {label}
              {count !== null && <span className="font-normal tabular-nums">{count}</span>}
            </button>
          )
        })}
      </div>

      {/* Signed memory writes belong to the deployment, not to an agent, so they get one page instead of a row per agent. */}
      {filter === 'evidence' && (
        <p className="text-xs text-muted-foreground">
          Each agent&apos;s Evidence lists its Arweave receipts. The memory writes this server signs are not tied to any one
          agent:{' '}
          <Link href="/vault/memory-writes" className="font-medium text-foreground underline-offset-4 hover:underline">
            Signed memory writes
          </Link>{' '}
          lists them for the whole deployment.
        </p>
      )}

      {failed.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm" role="alert">
          {failed.map((category) => (
            <div key={category} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-destructive">Couldn&apos;t load {sources[category].noun}.</span>
              <span className="min-w-0 break-words text-muted-foreground">{sources[category].error?.message}</span>
              <button
                type="button"
                onClick={sources[category].retry}
                className="ml-auto text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Retry
              </button>
            </div>
          ))}
        </div>
      )}

      {visible.length > 0 ? (
        <ul className="surface divide-y divide-border overflow-hidden">
          {visible.map((item) => (
            <VaultRow key={item.key} item={item} />
          ))}
          {pending.length > 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground">
              Loading {LIST_FORMAT.format(pending.map((category) => sources[category].noun))}…
            </li>
          )}
        </ul>
      ) : pending.length > 0 ? (
        <ul className="surface divide-y divide-border overflow-hidden" aria-busy="true" aria-label="Loading the vault">
          {[0, 1, 2].map((row) => (
            <li key={row} className="flex items-center gap-3 px-4 py-3">
              <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-muted" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-32 animate-pulse rounded bg-muted" />
                <span className="block h-3 w-24 animate-pulse rounded bg-muted" />
              </span>
            </li>
          ))}
        </ul>
      ) : relevant.some((category) => !sources[category].error) ? (
        <p className="surface px-4 py-10 text-center text-sm text-muted-foreground">{EMPTY_COPY[filter]}</p>
      ) : null}

      {/* Last child: during the static render React leaves a placeholder element here, which space-y would otherwise count. */}
      <Suspense fallback={null}>
        <FilterFromUrl onFilter={setFilter} />
      </Suspense>
    </div>
  )
}

/** Writes the filter into ?filter= without a navigation; All leaves the parameter out. */
function replaceFilterInUrl(filter: VaultFilter) {
  const url = new URL(window.location.href)
  if (filter === 'all') url.searchParams.delete('filter')
  else url.searchParams.set('filter', filter)
  window.history.replaceState(null, '', url)
}

/**
 * Keeps the selected pill in step with ?filter=. A soft navigation to this
 * same page (the sidebar's plain /vault link) does not remount it, so reading
 * the address bar once on mount would leave the old pill pressed; the search
 * params follow every navigation, and Next.js routes history.replaceState
 * through them too. It renders nothing and sits in its own Suspense boundary,
 * so only this empty component waits for the browser and the rest of the page
 * still prerenders.
 */
function FilterFromUrl({ onFilter }: { onFilter: (filter: VaultFilter) => void }) {
  const router = useRouter()
  const value = useSearchParams().get('filter')

  useEffect(() => {
    const filter = parseVaultFilter(value)
    onFilter(filter)
    // An unknown value (or an explicit "all") shows everything, so the address
    // bar should say so too. This can run while the page is still hydrating,
    // before Next.js has hooked history.replaceState, so it goes through the
    // router instead.
    if (value !== null && filter === 'all') {
      const url = new URL(window.location.href)
      url.searchParams.delete('filter')
      router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false })
    }
  }, [value, onFilter, router])

  return null
}

function VaultRow({ item }: { item: VaultItem }) {
  const Icon = TILE_ICONS[item.category]

  return (
    <li>
      <Link
        href={item.href}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            item.category === 'wallets' ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground'
          )}
        >
          {item.monogram ? (
            <span className="text-[10px] font-semibold tracking-tight">{item.monogram}</span>
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
        </span>
        {item.timestamp && (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{formatTimestamp(item.timestamp)}</span>
        )}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  )
}
