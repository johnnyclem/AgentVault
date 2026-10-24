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
        <h3 className="font-medium">Arweave Archive</h3>
        {conceptId && (
          <button
            onClick={handleArchive}
            disabled={loading}
            className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Archiving...
              </span>
            ) : (
              'Archive Now'
            )}
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {error}
        </div>
      )}

      {success && (
        <div className="p-3 bg-success/10 border border-success/30 rounded-lg text-sm text-success">
          {success}
        </div>
      )}

      {!conceptId && (
        <div className="p-4 bg-muted/50 border rounded-lg text-center text-muted-foreground text-sm">
          Select a concept to archive it to Arweave permanent storage
        </div>
      )}

      {receipts.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-medium mb-3">
            Archive Receipts
          </h4>
          <div className="space-y-2">
            {receipts.map((receipt) => (
              <div
                key={receipt.txId}
                className="p-3 bg-muted/50 border rounded-lg"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">
                      {receipt.conceptName}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {new Date(receipt.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <a
                    href={receipt.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline text-sm"
                  >
                    View on Arweave →
                  </a>
                </div>
                <div className="mt-2 font-mono text-xs text-muted-foreground break-all">
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
