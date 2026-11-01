'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { useAgentList } from '@/hooks/useAgentList'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { formatTimestamp } from '@/lib/utils'

export default function AgentsPage() {
  const { agents, isLoading, error, refetch } = useAgentList()
  const [searchQuery, setSearchQuery] = useState('')

  const filteredAgents = agents.filter((agent) =>
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.id.toLowerCase().includes(searchQuery.toLowerCase())
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Agents</h1>
        <p className="page-subtitle">Each agent and the canister it runs in</p>
      </div>

      {error ? (
        <ErrorNotice title="Couldn't load agents." message={error.message} onRetry={refetch} />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              placeholder="Search"
              aria-label="Search agents"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-full max-w-xs rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredAgents.length === 0 ? (
              <div className="col-span-full py-12 text-center text-sm text-muted-foreground">
                No agents found
              </div>
            ) : (
              filteredAgents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className="surface block min-w-0 p-4 transition-colors hover:border-primary/40"
                >
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <h3 className="min-w-0 truncate font-medium">{agent.name}</h3>
                    <StatusBadge status={agent.status} className="shrink-0" />
                  </div>
                  <dl className="space-y-2 text-sm">
                    <div className="kv">
                      <dt className="text-muted-foreground">Agent</dt>
                      <dd className="min-w-0">
                        <span className="tag" title={agent.id}>{agent.id}</span>
                      </dd>
                    </div>
                    <div className="kv">
                      <dt className="text-muted-foreground">Canister</dt>
                      <dd className="min-w-0">
                        {agent.canisterId ? (
                          <span className="tag" title={agent.canisterId}>{agent.canisterId}</span>
                        ) : (
                          <span className="text-muted-foreground">Not deployed</span>
                        )}
                      </dd>
                    </div>
                    <div className="kv">
                      <dt className="text-muted-foreground">Memory</dt>
                      <dd className="tabular-nums">{agent.config.memory} MB</dd>
                    </div>
                    <div className="kv">
                      <dt className="text-muted-foreground">Created</dt>
                      <dd>{formatTimestamp(agent.createdAt)}</dd>
                    </div>
                  </dl>
                </Link>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
