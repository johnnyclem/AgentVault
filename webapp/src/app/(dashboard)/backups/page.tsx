'use client'

import { useRef, useState } from 'react'
import { Archive as ArchiveIcon, Cloud, Download, Trash2, Upload, RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorNotice } from '@/components/common/ErrorNotice'
import { formatBytes, formatCycles } from '@/lib/utils'
import { useArchives } from '@/hooks/useArchives'
import type { Archive } from '@/lib/types'

export default function BackupsPage() {
  const { archives, isLoading, error, refetch } = useArchives()
  const [selectedCanister, setSelectedCanister] = useState('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)
  const canisterInput = useRef<HTMLInputElement>(null)

  const handleDownload = async (archive: Archive) => {
    setActionInProgress(`download-${archive.id}`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setActionInProgress(null)
  }

  const handleArchive = async (archive: Archive) => {
    setActionInProgress(`archive-${archive.id}`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setActionInProgress(null)
  }

  const handleQuickBackup = async (action: 'download' | 'archive') => {
    if (!selectedCanister) return
    setActionInProgress(`quick-${action}`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setActionInProgress(null)
  }

  const handleDelete = async (archive: Archive) => {
    if (!confirm(`Delete archive for canister ${archive.canisterId}?`)) return
    setActionInProgress(`delete-${archive.id}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    refetch()
    setActionInProgress(null)
  }

  const totalSize = archives.reduce((acc, a) => acc + BigInt(a.size), 0n)
  const totalCost = archives.reduce((acc, a) => acc + BigInt(a.cost || 0), 0n)

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center p-6">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div>
          <h1 className="page-title">Backups &amp; archives</h1>
          <p className="page-subtitle">Manage canister backups and Arweave archival storage</p>
        </div>
        <ErrorNotice title="Couldn't load archives." message={error.message} onRetry={refetch} />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Backups &amp; archives</h1>
          <p className="page-subtitle">Manage canister backups and Arweave archival storage</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="chip">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
          {/* The backup form is on this page, so this goes to it; Download below stays the one primary action. */}
          <button type="button" onClick={() => canisterInput.current?.focus()} className="chip">
            <Upload className="h-4 w-4" aria-hidden="true" />
            Create Backup
          </button>
        </div>
      </div>

      {/* Side by side from 1024: with the sidebar, two cards at 768 leave ~170px for the two buttons. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="surface min-w-0 p-6">
          <h2 className="mb-4 text-base font-medium">Quick backup</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="quick-backup-canister" className="mb-1.5 block text-sm font-medium">
                Canister ID
              </label>
              <input
                id="quick-backup-canister"
                ref={canisterInput}
                type="text"
                placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai"
                value={selectedCanister}
                onChange={(e) => setSelectedCanister(e.target.value)}
                className="h-9 w-full rounded-lg border bg-background px-3 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleQuickBackup('download')}
                disabled={!selectedCanister || actionInProgress?.startsWith('quick')}
                className="flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionInProgress === 'quick-download' ? <LoadingSpinner size="sm" /> : <Download className="h-4 w-4" aria-hidden="true" />}
                Download
              </button>
              <button
                type="button"
                onClick={() => handleQuickBackup('archive')}
                disabled={!selectedCanister || actionInProgress?.startsWith('quick')}
                className="flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionInProgress === 'quick-archive' ? <LoadingSpinner size="sm" /> : <Cloud className="h-4 w-4" aria-hidden="true" />}
                Archive
              </button>
            </div>
          </div>
        </div>

        <div className="surface min-w-0 p-6">
          <h2 className="mb-4 text-base font-medium">Archive storage</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Total archived</dt>
              <dd className="font-medium tabular-nums">{archives.length} {archives.length === 1 ? 'canister' : 'canisters'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Total size</dt>
              <dd className="font-medium tabular-nums">{formatBytes(totalSize)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Total cost</dt>
              <dd className="font-medium tabular-nums">{formatCycles(totalCost)}</dd>
            </div>
          </dl>
          <div className="mt-4 border-t pt-4">
            {/* Not wired yet: drawn quietly and disabled rather than looking live. */}
            <button
              type="button"
              disabled
              title="Not available yet"
              className="h-9 w-full rounded-lg border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
            >
              Manage archive settings
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-base font-medium">Archives</h2>
        {archives.length === 0 ? (
          <div className="surface p-8 text-center text-sm text-muted-foreground">
            <ArchiveIcon className="mx-auto mb-3 h-8 w-8" aria-hidden="true" />
            <p>No archives yet</p>
            <p className="mt-1 text-sm">Create a backup to see it here</p>
          </div>
        ) : (
          <div className="surface divide-y">
            {archives.map((archive) => (
              <div key={archive.id} className="p-4">
                {/* Wraps on phones: the canister id truncates and the buttons and time keep their size. */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="tag" title={archive.canisterId || undefined}>{archive.canisterId}</span>
                    <StatusBadge status={archive.status} className="shrink-0" />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <TimeAgo timestamp={archive.timestamp} className="mr-2 whitespace-nowrap" />
                    <button
                      type="button"
                      aria-label={`Download archive for ${archive.canisterId}`}
                      onClick={() => handleDownload(archive)}
                      disabled={!isSubmitted(archive) || actionInProgress === `download-${archive.id}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {actionInProgress === `download-${archive.id}` ? <LoadingSpinner size="sm" /> : <Download className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete archive for ${archive.canisterId}`}
                      onClick={() => handleDelete(archive)}
                      disabled={actionInProgress === `delete-${archive.id}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {actionInProgress === `delete-${archive.id}` ? <LoadingSpinner size="sm" /> : <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />}
                    </button>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">Size</dt>
                    <dd className="mt-1 tabular-nums">{formatBytes(archive.size)}</dd>
                  </div>
                  {archive.checksum && (
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Checksum</dt>
                      <dd className="mt-1"><span className="tag" title={archive.checksum}>{archive.checksum}</span></dd>
                    </div>
                  )}
                  {archive.arweaveTxId && (
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Arweave</dt>
                      <dd className="mt-1"><span className="tag" title={archive.arweaveTxId}>{archive.arweaveTxId}</span></dd>
                    </div>
                  )}
                  {archive.cost && (
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Cost</dt>
                      <dd className="mt-1 tabular-nums">{formatCycles(archive.cost)}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function isSubmitted(archive: Archive): boolean {
  return archive.status === 'submitted' || archive.status === 'completed'
}
