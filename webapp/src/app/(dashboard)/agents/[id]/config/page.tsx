'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AgentConfigForm } from '@/components/agents/AgentConfigForm'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useAgent } from '@/hooks/useAgent'
import { apiClient } from '@/lib/api-client'
import type { Agent, AgentConfig } from '@/lib/types'

export default function AgentConfigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { agent, isLoading, error } = useAgent(id)
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleSave = async (config: AgentConfig) => {
    setSaveError(null)
    try {
      // bigint is not JSON-serializable; send cycles as a string
      const response = await apiClient.put<Agent>(`/agents/${id}`, {
        config: { ...config, cycles: config.cycles?.toString() },
      })
      if (response.success) {
        router.push(`/agents/${id}`)
      } else {
        setSaveError(response.error?.message || 'Failed to save configuration')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save configuration')
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center p-6">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error || !agent) {
    return (
      <div className="page">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to agents
        </Link>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error?.message || `Agent '${id}' not found`}
        </div>
      </div>
    )
  }

  return (
    <div className="page [&>*]:max-w-2xl">
      <Link
        href={`/agents/${id}`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to {agent.name}
      </Link>

      <h1 className="page-title">Configure {agent.name}</h1>

      {saveError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <AgentConfigForm
        config={agent.config}
        onSave={handleSave}
        onCancel={() => router.push(`/agents/${id}`)}
      />
    </div>
  )
}
