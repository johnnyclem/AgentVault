'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvidence, ApiError } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

/**
 * Loads an agent's Arweave receipts once. The server sends only what it
 * recorded; each receipt is checked against the gateway by its own card.
 */
export function useProof(agentId: string) {
  const [evidence, setEvidence] = useState<AgentEvidence | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  // Only the newest request may update the page, so a slow answer for a
  // previous agent cannot replace the current one.
  const latestRequest = useRef(0)

  const fetchEvidence = useCallback(async () => {
    const request = ++latestRequest.current
    setIsLoading(true)
    setError(null)

    const res = await apiClient.get<AgentEvidence>(`/vault/${encodeURIComponent(agentId)}/proof`)
    if (request !== latestRequest.current) return

    const data = res.data
    if (res.success && data && Array.isArray(data.receipts)) {
      setEvidence(data)
    } else {
      setEvidence(null)
      setError(res.error ?? { message: 'The server sent evidence this page cannot read.' })
    }
    setIsLoading(false)
  }, [agentId])

  useEffect(() => {
    fetchEvidence()
  }, [fetchEvidence])

  return { evidence, isLoading, error, refetch: fetchEvidence }
}
