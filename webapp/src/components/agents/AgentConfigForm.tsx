'use client'

import { useState } from 'react'
import { Select } from '@/components/common/Select'
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

  const input =
    'h-9 w-full rounded-lg border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring'
  const label = 'mb-1.5 block text-sm font-medium'

  return (
    <form onSubmit={handleSubmit} className="surface space-y-6 p-6">
      <div>
        <label htmlFor="config-entry" className={label}>
          Entry point
        </label>
        <input
          id="config-entry"
          type="text"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          className={`${input} font-mono`}
          placeholder="src/index.ts"
        />
      </div>

      <div>
        <label htmlFor="config-memory" className={label}>
          Memory (MB)
        </label>
        <input
          id="config-memory"
          type="number"
          min="128"
          max="8192"
          step="128"
          value={memory}
          onChange={(e) => setMemory(parseInt(e.target.value))}
          className={`${input} tabular-nums`}
        />
      </div>

      <div>
        <label htmlFor="config-compute" className={label}>
          Compute
        </label>
        <Select id="config-compute" value={compute} onChange={(e) => setCompute(e.target.value)}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      </div>

      <div>
        <label htmlFor="config-cycles" className={label}>
          Cycles (optional)
        </label>
        <input
          id="config-cycles"
          type="text"
          value={cycles}
          onChange={(e) => setCycles(e.target.value)}
          className={`${input} font-mono`}
          placeholder="1000000000000"
        />
      </div>

      <div>
        <label htmlFor="config-routing" className={label}>
          Routing canisters (optional, comma-separated)
        </label>
        <input
          id="config-routing"
          type="text"
          value={routing}
          onChange={(e) => setRouting(e.target.value)}
          className={`${input} font-mono`}
          placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai, be2us-64aaa-aaaaa-qaaca-cai"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Save configuration
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-lg border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
