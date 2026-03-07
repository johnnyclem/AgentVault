'use client'

import { useState, useEffect, useCallback } from 'react'

interface Concept {
  id: string
  name: string
  representation?: string
  tags?: string[]
  createdAt?: string
  updatedAt?: string
}

interface ConceptListProps {
  agentId: string
  onSelect?: (concept: Concept) => void
  limit?: number
}

export function ConceptList({ agentId, onSelect, limit = 50 }: ConceptListProps) {
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)

  const fetchConcepts = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(
        `/api/polytician/${agentId}/concepts?limit=${limit}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN || ''}`,
          },
        }
      )

      if (!res.ok) {
        throw new Error(`Failed to fetch concepts: ${res.status}`)
      }

      const data = await res.json()
      if (data.success) {
        setConcepts(data.data.concepts || [])
        setTotal(data.data.total || 0)
      } else {
        setError(data.error?.message || 'Failed to load concepts')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [agentId, limit, offset])

  useEffect(() => {
    fetchConcepts()
  }, [fetchConcepts])

  const repIcons: Record<string, string> = {
    text: '📝',
    embedding: '🧮',
    graph: '🔗',
    structured: '📊',
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 bg-gray-200 rounded" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700">
        {error}
        <button
          onClick={fetchConcepts}
          className="ml-2 text-red-600 underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (concepts.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        No concepts found. Start by creating one or syncing from memory_repo.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">
          {total} concept{total !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="overflow-hidden rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-left font-medium">Tags</th>
              <th className="px-4 py-2 text-left font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {concepts.map((concept) => (
              <tr
                key={concept.id}
                onClick={() => onSelect?.(concept)}
                className={`hover:bg-gray-50 ${onSelect ? 'cursor-pointer' : ''}`}
              >
                <td className="px-4 py-3 font-medium text-gray-900">
                  {concept.name}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1">
                    {repIcons[concept.representation || 'text'] || '📄'}
                    <span className="text-gray-600">
                      {concept.representation || 'text'}
                    </span>
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(concept.tags || []).slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                    {(concept.tags?.length || 0) > 3 && (
                      <span className="text-gray-400 text-xs">
                        +{concept.tags!.length - 3}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {concept.updatedAt
                    ? new Date(concept.updatedAt).toLocaleDateString()
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > limit && (
        <div className="flex justify-between items-center pt-4">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">
            {offset + 1}-{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={offset + limit >= total}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
