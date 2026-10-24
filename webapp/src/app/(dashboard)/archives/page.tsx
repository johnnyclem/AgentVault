'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { useArchives } from '@/hooks/useArchives'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { apiClient } from '@/lib/api-client'
import type { Archive as ArchiveModel } from '@/lib/types'
import { formatBytes, formatTimestamp, truncatePrincipal } from '@/lib/utils'

export default function ArchivesPage() {
  const { archives, isLoading, error, refetch } = useArchives()
  const [deleteInProgress, setDeleteInProgress] = useState<string | null>(null)
  const scrolledToHash = useRef(false)

  const arweaveUrl = (txId?: string): string | undefined =>
    txId ? `https://arweave.net/${txId}` : undefined

  const canisterUrl = (canisterId: string): string =>
    `https://dashboard.internetcomputer.org/canister/${canisterId}`

  const totalSize = useMemo(() => {
    const total = archives.reduce((sum, archive) => sum + Number(archive.size || 0), 0)
    return formatBytes(total)
  }, [archives])

  const handleDelete = async (archiveId: string) => {
    setDeleteInProgress(archiveId)
    try {
      await apiClient.delete<{ id: string }>(`/archives?id=${archiveId}`)
      await refetch()
    } finally {
      setDeleteInProgress(null)
    }
  }

  // Links such as the agent archive receipt point at /archives#<id>. Records load
  // after the browser's own hash scroll, so scroll to the target once they render.
  useEffect(() => {
    if (scrolledToHash.current || isLoading || archives.length === 0) return
    scrolledToHash.current = true
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [archives, isLoading])

  const canShow = archives.length > 0

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Archives</h1>
          <p className="page-subtitle">Manage secure backups, on-chain records, and Arweave receipts</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Total {archives.length} • {totalSize}
          </p>
          <button
            onClick={() => refetch()}
            className="chip px-3 py-1.5 text-sm"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="surface flex items-center justify-center p-8">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive">
          {error.message}
        </div>
      ) : !canShow ? (
        <div className="surface p-10 text-center">
          <Archive className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">No archives yet</p>
          <p className="text-sm text-muted-foreground">Run an archive workflow from an agent to create your first backup.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Manage Agents
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {archives.map((archive: ArchiveModel) => (
            <div
              key={archive.id}
              id={archive.id}
              className="surface scroll-mt-6 p-4"
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="mb-1 font-semibold">{archive.id}</h2>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>Canister {truncatePrincipal(archive.canisterId, 10)}</span>
                    <span>•</span>
                    <span>{formatTimestamp(archive.timestamp)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={archive.status} />
                  <a
                    href={canisterUrl(archive.canisterId)}
                    target="_blank"
                    rel="noreferrer"
                    className="chip"
                  >
                    Canister
                  </a>
                  {archive.arweaveTxId ? (
                    <a
                      href={arweaveUrl(archive.arweaveTxId)!}
                      target="_blank"
                      rel="noreferrer"
                      className="chip"
                    >
                      Arweave
                    </a>
                  ) : null}
                </div>
              </div>

              <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <p>
                  <span className="text-muted-foreground">Status:</span> {archive.status}
                </p>
                <p>
                  <span className="text-muted-foreground">Size:</span> {formatBytes(Number(archive.size || 0))}
                </p>
                {/* A sha256 is one unbreakable 64-char token; truncating it keeps
                    the card (and <main>) from scrolling sideways on phones. */}
                <p className="min-w-0 truncate" title={archive.checksum || undefined}>
                  <span className="text-muted-foreground">Checksum:</span>{' '}
                  {archive.checksum || 'pending'}
                </p>
                <p>
                  <span className="text-muted-foreground">Cost:</span> {archive.cost || 'n/a'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                {archive.arweaveTxId ? (
                  <a
                    href={arweaveUrl(archive.arweaveTxId)!}
                    target="_blank"
                    rel="noreferrer"
                    className="chip"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View Arweave Receipt
                  </a>
                ) : null}

                <button
                  onClick={() => handleDelete(archive.id)}
                  disabled={deleteInProgress === archive.id}
                  className="chip text-destructive hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {deleteInProgress === archive.id ? 'Removing...' : 'Delete Record'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
