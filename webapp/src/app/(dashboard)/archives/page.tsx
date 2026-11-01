'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { useArchives } from '@/hooks/useArchives'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { apiClient } from '@/lib/api-client'
import type { Archive as ArchiveModel } from '@/lib/types'
import { formatBytes, formatCycles, formatTimestamp, truncatePrincipal } from '@/lib/utils'

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
          <p className="page-subtitle">Backups, on-chain records and Arweave receipts</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm tabular-nums text-muted-foreground">
            {archives.length} {archives.length === 1 ? 'archive' : 'archives'} · {totalSize}
          </p>
          <button type="button" onClick={() => refetch()} className="chip">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="surface flex items-center justify-center p-8">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <ErrorNotice title="Couldn't load archives." message={error.message} onRetry={refetch} />
      ) : !canShow ? (
        <div className="surface p-10 text-center">
          <Archive className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">No archives yet</p>
          <p className="text-sm text-muted-foreground">Run an archive workflow from an agent to create your first backup.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Manage agents
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {archives.map((archive: ArchiveModel) => (
            <div
              key={archive.id}
              id={archive.id}
              className="surface min-w-0 scroll-mt-6 p-4"
            >
              <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-medium">
                    <span className="tag">{archive.id}</span>
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span>Canister</span>
                    <span className="tag" title={archive.canisterId}>{truncatePrincipal(archive.canisterId)}</span>
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

              {/* The status badge above already says it, so it is not repeated as a field. */}
              <dl className="mb-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Size</dt>
                  <dd className="mt-1 tabular-nums">{formatBytes(Number(archive.size || 0))}</dd>
                </div>
                {/* A sha256 is one unbreakable 64-char token; truncating it keeps
                    the card (and <main>) from scrolling sideways on phones. */}
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Checksum</dt>
                  <dd className="mt-1">
                    {archive.checksum ? (
                      <span className="tag" title={archive.checksum}>{archive.checksum}</span>
                    ) : (
                      'pending'
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Cost</dt>
                  <dd className="mt-1 tabular-nums">{archive.cost ? formatCycles(archive.cost) : 'n/a'}</dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                {archive.arweaveTxId ? (
                  <a
                    href={arweaveUrl(archive.arweaveTxId)!}
                    target="_blank"
                    rel="noreferrer"
                    className="chip"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    View Arweave receipt
                  </a>
                ) : null}

                <button
                  type="button"
                  onClick={() => handleDelete(archive.id)}
                  disabled={deleteInProgress === archive.id}
                  className="chip text-destructive hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {deleteInProgress === archive.id ? 'Removing…' : 'Delete record'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
