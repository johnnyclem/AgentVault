'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { useNetworks } from '@/hooks/useNetworks'
import type { Network } from '@/lib/types'

export default function NetworksPage() {
  const { networks, isLoading, error, refetch } = useNetworks()
  const [connectingTo, setConnectingTo] = useState<string | null>(null)
  const [newNetwork, setNewNetwork] = useState({ name: '', url: '' })

  const handleConnect = async (networkName: string) => {
    setConnectingTo(networkName)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setConnectingTo(null)
    refetch()
  }

  const handleAddNetwork = async () => {
    if (!newNetwork.name || !newNetwork.url) return
    setNewNetwork({ name: '', url: '' })
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center p-6">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div>
          <h1 className="page-title">Networks</h1>
          <p className="page-subtitle">View and manage ICP network connections</p>
        </div>
        <ErrorNotice title="Couldn't load networks." message={error.message} onRetry={refetch} />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Networks</h1>
          <p className="page-subtitle">View and manage ICP network connections</p>
        </div>
        <button type="button" onClick={() => refetch()} className="chip">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {networks.map((network) => (
          <div key={network.name} className="surface min-w-0 p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="min-w-0 truncate font-medium">{network.name}</h3>
              <StatusBadge status={network.status} className="shrink-0" />
            </div>

            <dl className="space-y-3 text-sm">
              <div className="kv">
                <dt className="text-muted-foreground">URL</dt>
                <dd className="min-w-0">
                  <span className="tag" title={network.url}>{network.url}</span>
                </dd>
              </div>
              <div className="kv">
                <dt className="text-muted-foreground">Nodes</dt>
                <dd className="tabular-nums">{network.nodeCount}</dd>
              </div>
            </dl>

            <div className="mt-4 border-t pt-4">
              <button
                type="button"
                onClick={() => handleConnect(network.name)}
                disabled={connectingTo === network.name}
                className={`h-9 w-full rounded-lg px-4 text-sm font-medium transition-colors ${
                  network.status === 'connected'
                    ? 'bg-secondary text-foreground hover:bg-secondary/80'
                    : 'border hover:bg-muted'
                } ${connectingTo === network.name ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                {connectingTo === network.name ? 'Connecting…' : network.status === 'connected' ? 'Connected' : 'Connect'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="surface p-6">
        <h2 className="mb-4 text-base font-medium">Add network</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor="network-name" className="mb-1.5 block text-sm font-medium">
              Name
            </label>
            <input
              id="network-name"
              type="text"
              placeholder="staging"
              value={newNetwork.name}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="network-url" className="mb-1.5 block text-sm font-medium">
              URL
            </label>
            <input
              id="network-url"
              type="url"
              placeholder="https://replica.example.com"
              value={newNetwork.url}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, url: e.target.value }))}
              className="w-full px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={handleAddNetwork}
            disabled={!newNetwork.name || !newNetwork.url}
            className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add network
          </button>
        </div>
      </div>
    </div>
  )
}
