'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Blocks, RefreshCw } from 'lucide-react'
import { useAgentList } from '@/hooks/useAgentList'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { apiClient } from '@/lib/api-client'
import { formatBytes, formatCycles, formatTimestamp } from '@/lib/utils'
import type { Canister } from '@/lib/types'

interface OnChainEntry {
  agentId: string
  agentName: string
  canisterId: string
  canister?: Canister
  status: 'loading' | 'error' | 'unavailable'
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 tabular-nums">{children}</dd>
    </div>
  )
}

export default function OnChainPage() {
  const { agents, isLoading, error, refetch } = useAgentList()
  const [entries, setEntries] = useState<OnChainEntry[]>([])

  // Memoised because the effect below depends on it: a fresh array every render
  // re-ran the effect, whose setEntries re-rendered, refetching canisters forever.
  const deployedAgents = useMemo(() => agents.filter((agent) => !!agent.canisterId), [agents])

  const refreshAll = async () => {
    await refetch()
  }

  useEffect(() => {
    let active = true

    const hydrate = async () => {
      if (!active) {
        return
      }

      const nextEntries: OnChainEntry[] = await Promise.all(deployedAgents.map(async (agent) => {
        if (!agent.canisterId) {
          return {
            agentId: agent.id,
            agentName: agent.name,
            canisterId: '',
            status: 'unavailable',
          }
        }

        const response = await apiClient.get<Canister>(`/canisters/${agent.canisterId}`)
        if (!response.success || !response.data) {
          return {
            agentId: agent.id,
            agentName: agent.name,
            canisterId: agent.canisterId,
            status: 'error',
          }
        }

        return {
          agentId: agent.id,
          agentName: agent.name,
          canisterId: agent.canisterId,
          canister: response.data,
          status: 'loading',
        }
      }))

      if (active) {
        setEntries(nextEntries)
      }
    }

    void hydrate()

    return () => {
      active = false
    }
  }, [deployedAgents])

  const toExplorer = (canisterId: string): string =>
    `https://dashboard.internetcomputer.org/canister/${canisterId}`

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-6">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">On-chain</h1>
          <p className="page-subtitle">Status, cycles and memory of each deployed canister</p>
        </div>
        <button type="button" onClick={refreshAll} className="chip">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error ? <ErrorNotice title="Couldn't load agents." message={error.message} onRetry={refreshAll} /> : null}

      {deployedAgents.length === 0 ? (
        <div className="surface p-10 text-center">
          <Blocks className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">No deployed agents yet</p>
          <p className="text-sm text-muted-foreground">Deploy an agent to start tracking canister state.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to agents
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const canister = entry.canister
            const canisterStatus = canister ? canister.status : 'unknown'

            return (
              <div
                key={entry.agentId}
                className="surface min-w-0 p-4"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{entry.agentName}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Agent <span className="tag ml-1" title={entry.agentId}>{entry.agentId}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={canister ? canisterStatus : 'error'} />
                    <a
                      href={toExplorer(entry.canisterId)}
                      target="_blank"
                      rel="noreferrer"
                      className="chip"
                    >
                      ICP Explorer
                    </a>
                  </div>
                </div>

                {canister ? (
                  <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <Fact label="Canister">
                      <span className="tag" title={entry.canisterId}>{entry.canisterId}</span>
                    </Fact>
                    <Fact label="Cycles">{formatCycles(canister.cycles)}</Fact>
                    <Fact label="Memory">{formatBytes(canister.memory)}</Fact>
                    <Fact label="Controller">
                      <span className="tag" title={canister.controller}>{canister.controller}</span>
                    </Fact>
                    <Fact label="Updated">{formatTimestamp(canister.updatedAt)}</Fact>
                    <Fact label="Error">{entry.status === 'error' ? 'unable to fetch status' : 'none'}</Fact>
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Canister metadata not available. Check ICP canister configuration.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
