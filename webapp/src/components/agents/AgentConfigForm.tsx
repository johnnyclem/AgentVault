'use client'

import { useState } from 'react'
import type { AgentConfig } from '@/lib/types'

interface AgentConfigFormProps {
  config: AgentConfig
  onSave: (config: AgentConfig) => void
  onCancel: () => void
}

export function AgentConfigForm({ config, onSave, onCancel }: AgentConfigFormProps) {
  const [entry, setEntry] = useState(config.entry)
  const [memory, setMemory] = useState(config.memory)
  const [compute, setCompute] = useState(config.compute)
  const [cycles, setCycles] = useState<string>(config.cycles?.toString() || '')
  const [routing, setRouting] = useState(config.routing?.join(', ') || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const newConfig: AgentConfig = {
      entry,
      memory,
      compute,
      cycles: cycles ? BigInt(cycles) : undefined,
      routing: routing ? routing.split(',').map((s) => s.trim()) : undefined,
    }
    onSave(newConfig)
  }

  return (
    <form onSubmit={handleSubmit} className="surface space-y-5 p-6">
      <div>
        <label className="block text-sm font-medium mb-1.5">
          Entry Point
        </label>
        <input
          type="text"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          className="w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="src/index.ts"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">
          Memory (MB)
        </label>
        <input
          type="number"
          min="128"
          max="8192"
          step="128"
          value={memory}
          onChange={(e) => setMemory(parseInt(e.target.value))}
          className="w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">
          Compute
        </label>
        <select
          value={compute}
          onChange={(e) => setCompute(e.target.value)}
          className="w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">
          Cycles (optional)
        </label>
        <input
          type="text"
          value={cycles}
          onChange={(e) => setCycles(e.target.value)}
          className="w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="1000000000000"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">
          Routing Canisters (optional, comma-separated)
        </label>
        <input
          type="text"
          value={routing}
          onChange={(e) => setRouting(e.target.value)}
          className="w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai, be2us-64aaa-aaaaa-qaaca-cai"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          Save Configuration
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
