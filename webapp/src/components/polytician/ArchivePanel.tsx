'use client'

import { useState } from 'react'

interface ArweaveReceipt {
  txId: string
  url: string
  timestamp: string
  conceptId: string
  conceptName: string
}

interface ArchivePanelProps {
  agentId: string
  conceptId?: string
  conceptName?: string
  onArchived?: (receipt: ArweaveReceipt) => void
}

export function ArchivePanel({
  agentId,
  conceptId,
  conceptName,
  onArchived,
}: ArchivePanelProps) {
  const [receipts, setReceipts] = useState<ArweaveReceipt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleArchive = async () => {
    if (!conceptId) return

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const res = await fetch(`/api/polytician/${agentId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN || ''}`,
        },
        body: JSON.stringify({ conceptId }),
      })

      if (!res.ok) {
        throw new Error(`Archive failed: ${res.status}`)
      }

      const data = await res.json()
      if (data.success && data.data) {
        const receipt: ArweaveReceipt = {
          txId: data.data.txId || 'pending',
          url: data.data.url || `https://viewblock.io/arweave/tx/${data.data.txId}`,
          timestamp: new Date().toISOString(),
          conceptId,
          conceptName: conceptName || conceptId,
        }

        setReceipts((prev) => [receipt, ...prev])
        setSuccess(`Concept archived to Arweave: ${receipt.txId.slice(0, 12)}...`)
        onArchived?.(receipt)
      } else {
        setError(data.error?.message || 'Archive failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900">Arweave Archive</h3>
        {conceptId && (
          <button
            onClick={handleArchive}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Archiving...
              </span>
            ) : (
              'Archive Now'
            )}
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">
          {success}
        </div>
      )}

      {!conceptId && (
        <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-gray-500 text-sm">
          Select a concept to archive it to Arweave permanent storage
        </div>
      )}

      {receipts.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-medium text-gray-700 mb-3">
            Archive Receipts
          </h4>
          <div className="space-y-2">
            {receipts.map((receipt) => (
              <div
                key={receipt.txId}
                className="p-3 bg-gray-50 border border-gray-200 rounded-lg"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium text-gray-900">
                      {receipt.conceptName}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {new Date(receipt.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <a
                    href={receipt.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-700 text-sm"
                  >
                    View on Arweave →
                  </a>
                </div>
                <div className="mt-2 font-mono text-xs text-gray-600 break-all">
                  {receipt.txId}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
