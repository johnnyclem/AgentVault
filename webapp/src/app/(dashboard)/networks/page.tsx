'use client'

import { useState } from 'react'
import { Globe, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
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
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div>
          <h1 className="page-title">Networks</h1>
          <p className="text-sm text-destructive">{error.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Networks</h1>
          <p className="page-subtitle">
            View and manage ICP network connections
          </p>
        </div>
        <button 
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {networks.map((network) => (
          <div key={network.name} className="surface p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-muted-foreground" />
                <h3 className="font-semibold">{network.name}</h3>
              </div>
              {network.status === 'connected' && <CheckCircle2 className="w-5 h-5 text-success" />}
              {network.status === 'disconnected' && <XCircle className="w-5 h-5 text-muted-foreground" />}
              {network.status === 'degraded' && <AlertTriangle className="w-5 h-5 text-warning" />}
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <StatusBadge status={network.status} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">URL</p>
                <p className="text-sm font-mono">{network.url}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Nodes</p>
                <p className="text-sm">{network.nodeCount}</p>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t">
              <button 
                onClick={() => handleConnect(network.name)}
                disabled={connectingTo === network.name}
                className={`w-full px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  network.status === 'connected'
                    ? 'bg-success/10 text-success hover:bg-success/15'
                    : 'border hover:bg-muted'
                } ${connectingTo === network.name ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {connectingTo === network.name ? 'Connecting...' : network.status === 'connected' ? 'Connected' : 'Connect'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="surface p-6">
        <h2 className="text-lg font-semibold mb-4">Add Network</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Network Name
            </label>
            <input
              type="text"
              placeholder="My Custom Network"
              value={newNetwork.name}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Network URL
            </label>
            <input
              type="url"
              placeholder="https://..."
              value={newNetwork.url}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, url: e.target.value }))}
              className="w-full px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button 
            onClick={handleAddNetwork}
            disabled={!newNetwork.name || !newNetwork.url}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add Network
          </button>
        </div>
      </div>
    </div>
  )
}
