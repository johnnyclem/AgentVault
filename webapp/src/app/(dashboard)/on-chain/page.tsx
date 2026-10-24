'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Blocks, RefreshCw } from 'lucide-react'
import { useAgentList } from '@/hooks/useAgentList'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
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
          <h1 className="page-title">On-Chain</h1>
          <p className="page-subtitle">Monitor deployed canister states and network links</p>
        </div>
        <button
          onClick={refreshAll}
          className="chip px-3 py-1.5 text-sm"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error.message}
        </div>
      ) : null}

      {deployedAgents.length === 0 ? (
        <div className="surface p-10 text-center">
          <Blocks className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">No deployed agents yet</p>
          <p className="text-sm text-muted-foreground">Deploy an agent to start tracking canister state.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to Agents
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
                className="surface p-4"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-semibold">{entry.agentName}</h2>
                    <p className="text-sm text-muted-foreground">Agent {entry.agentId}</p>
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
                  <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <p>
                      <span className="text-muted-foreground">Canister:</span>{' '}
                      <span className="font-mono">{entry.canisterId}</span>
                    </p>
                    <p>
                      <span className="text-muted-foreground">Cycles:</span>{' '}
                      {formatCycles(canister.cycles)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Memory:</span>{' '}
                      {formatBytes(canister.memory)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Controller:</span>{' '}
                      <span className="font-mono">{canister.controller.slice(0, 12)}...</span>
                    </p>
                    <p>
                      <span className="text-muted-foreground">Updated:</span>{' '}
                      {formatTimestamp(canister.updatedAt)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Status:</span> {canisterStatus}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Error:</span>{' '}
                      {entry.status === 'error' ? 'unable to fetch status' : 'none'}
                    </p>
                  </div>
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
