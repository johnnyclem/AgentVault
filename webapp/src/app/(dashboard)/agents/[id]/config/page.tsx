'use client'

import { use, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Settings } from 'lucide-react'
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
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error || !agent) {
    return (
      <div className="page">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </Link>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error?.message || `Agent '${id}' not found`}
        </div>
      </div>
    )
  }

  return (
    <div className="page max-w-2xl">
      <Link
        href={`/agents/${id}`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {agent.name}
      </Link>

      <h1 className="page-title flex items-center gap-2">
        <Settings className="w-6 h-6 text-muted-foreground" />
        Configure {agent.name}
      </h1>

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
