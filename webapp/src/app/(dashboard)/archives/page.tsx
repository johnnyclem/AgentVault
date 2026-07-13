'use client'

import { useMemo, useState } from 'react'
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

  const canShow = archives.length > 0

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Archives</h1>
          <p className="text-muted-foreground">Manage secure backups, on-chain records, and Arweave receipts</p>
        </div>
        <div className="flex items-center gap-3">
          <p className="rounded-md border border-zinc-200 bg-zinc-500/10 px-3 py-1 text-sm text-zinc-300">
            Total {archives.length} • {totalSize}
          </p>
          <button
            onClick={() => refetch()}
            className="retro-chip flex items-center gap-2 rounded-md px-3 py-2"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center rounded border border-zinc-200/20 bg-zinc-950/25 p-8">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="rounded border border-rose-300 bg-rose-500/10 p-6 text-rose-300">
          {error.message}
        </div>
      ) : !canShow ? (
        <div className="rounded border border-zinc-200/20 bg-zinc-950/25 p-10 text-center text-zinc-400">
          <Archive className="mx-auto mb-3 h-12 w-12" />
          <p className="text-lg font-medium">No archives yet</p>
          <p className="text-sm">Run an archive workflow from an agent to create your first backup.</p>
          <Link
            href="/agents"
            className="mt-4 inline-flex rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700"
          >
            Manage Agents
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {archives.map((archive: ArchiveModel) => (
            <div
              key={archive.id}
              className="border border-zinc-200/20 bg-zinc-950/20 p-4"
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="mb-2 text-lg font-semibold">{archive.id}</h2>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
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
                    className="retro-chip rounded-md px-2 py-1 text-xs"
                  >
                    Canister
                  </a>
                  {archive.arweaveTxId ? (
                    <a
                      href={arweaveUrl(archive.arweaveTxId)!}
                      target="_blank"
                      rel="noreferrer"
                      className="retro-chip rounded-md px-2 py-1 text-xs"
                    >
                      Arweave
                    </a>
                  ) : null}
                </div>
              </div>

              <div className="mb-3 grid gap-2 text-sm text-zinc-300 sm:grid-cols-2 lg:grid-cols-4">
                <p>
                  <span className="text-zinc-500">Status:</span> {archive.status}
                </p>
                <p>
                  <span className="text-zinc-500">Size:</span> {formatBytes(Number(archive.size || 0))}
                </p>
                <p>
                  <span className="text-zinc-500">Checksum:</span>{' '}
                  {archive.checksum || 'pending'}
                </p>
                <p>
                  <span className="text-zinc-500">Cost:</span> {archive.cost || 'n/a'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-zinc-700/40 pt-3">
                {archive.arweaveTxId ? (
                  <a
                    href={arweaveUrl(archive.arweaveTxId)!}
                    target="_blank"
                    rel="noreferrer"
                    className="retro-chip inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View Arweave Receipt
                  </a>
                ) : null}

                <button
                  onClick={() => handleDelete(archive.id)}
                  disabled={deleteInProgress === archive.id}
                  className="retro-chip inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-red-300"
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
