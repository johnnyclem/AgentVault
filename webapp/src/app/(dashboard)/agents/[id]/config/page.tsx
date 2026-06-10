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
      <div className="p-6 space-y-4">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </Link>
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error?.message || `Agent '${id}' not found`}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <Link
        href={`/agents/${id}`}
        className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to {agent.name}
      </Link>

      <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
        <Settings className="w-7 h-7" />
        Configure {agent.name}
      </h1>

      {saveError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
