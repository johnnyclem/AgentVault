'use client'

import { useEffect, useState } from 'react'
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

  const deployedAgents = agents.filter((agent) => !!agent.canisterId)

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
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">On-Chain</h1>
          <p className="text-muted-foreground">Monitor deployed canister states and network links</p>
        </div>
        <button
          onClick={refreshAll}
          className="retro-chip inline-flex items-center gap-2 rounded-md px-3 py-2"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded border border-rose-300 bg-rose-500/10 p-4 text-rose-300">
          {error.message}
        </div>
      ) : null}

      {deployedAgents.length === 0 ? (
        <div className="rounded border border-zinc-200/20 bg-zinc-950/25 p-10 text-center text-zinc-400">
          <Blocks className="mx-auto mb-3 h-12 w-12" />
          <p className="text-lg font-semibold">No deployed agents yet</p>
          <p className="text-sm">Deploy an agent to start tracking canister state.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
          >
            Go to Agents
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => {
            const hasCanister = entry.canister
            const canisterStatus = hasCanister ? entry.canister.status : 'unknown'

            return (
              <div
                key={entry.agentId}
                className="border border-zinc-200/20 bg-zinc-950/20 p-4"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">{entry.agentName}</h2>
                    <p className="text-sm text-zinc-400">Agent {entry.agentId}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={hasCanister ? canisterStatus : 'error'} />
                    <a
                      href={toExplorer(entry.canisterId)}
                      target="_blank"
                      rel="noreferrer"
                      className="retro-chip rounded-md px-2 py-1 text-xs"
                    >
                      ICP Explorer
                    </a>
                  </div>
                </div>

                {hasCanister ? (
                  <div className="grid gap-2 text-sm text-zinc-300 sm:grid-cols-2 lg:grid-cols-4">
                    <p>
                      <span className="text-zinc-500">Canister:</span>{' '}
                      <span className="font-mono">{entry.canisterId}</span>
                    </p>
                    <p>
                      <span className="text-zinc-500">Cycles:</span>{' '}
                      {formatCycles(entry.canister.cycles)}
                    </p>
                    <p>
                      <span className="text-zinc-500">Memory:</span>{' '}
                      {formatBytes(entry.canister.memory)}
                    </p>
                    <p>
                      <span className="text-zinc-500">Controller:</span>{' '}
                      <span className="font-mono">{entry.canister.controller.slice(0, 12)}...</span>
                    </p>
                    <p>
                      <span className="text-zinc-500">Updated:</span>{' '}
                      {formatTimestamp(entry.canister.updatedAt)}
                    </p>
                    <p>
                      <span className="text-zinc-500">Status:</span> {canisterStatus}
                    </p>
                    <p>
                      <span className="text-zinc-500">Error:</span>{' '}
                      {entry.status === 'error' ? 'unable to fetch status' : 'none'}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400">
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
