'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Activity, Search } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useAgentList } from '@/hooks/useAgentList'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'
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

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-destructive">
          <Activity className="w-12 h-12 mx-auto mb-4" />
          <p>{error.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Agents</h1>
        <p className="page-subtitle">
          Manage and monitor your AI agents
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search agents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredAgents.length === 0 ? (
          <div className="col-span-full text-center py-12 text-sm text-muted-foreground">
            No agents found
          </div>
        ) : (
          filteredAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="surface block p-4 transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold">{agent.name}</h3>
                <StatusBadge status={agent.status} />
              </div>
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>ID: {agent.id.slice(0, 8)}...</p>
                <p>Canister: {agent.canisterId ? agent.canisterId.slice(0, 8) + '...' : 'Not deployed'}</p>
                <p>Memory: {agent.config.memory} MB</p>
                <p>Created: {formatTimestamp(agent.createdAt)}</p>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
