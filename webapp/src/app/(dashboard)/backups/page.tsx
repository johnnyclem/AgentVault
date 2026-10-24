'use client'

import { useState } from 'react'
import { Archive as ArchiveIcon, Cloud, Download, Trash2, CheckCircle2, Clock, XCircle, Upload, RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { formatBytes, formatCycles } from '@/lib/utils'
import { useArchives } from '@/hooks/useArchives'
import type { Archive } from '@/lib/types'

export default function BackupsPage() {
  const { archives, isLoading, error, refetch } = useArchives()
  const [selectedCanister, setSelectedCanister] = useState('')
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

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
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div>
          <h1 className="page-title">Backups & Archives</h1>
          <p className="text-sm text-destructive">{error.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Backups & Archives</h1>
          <p className="page-subtitle">
            Manage canister backups and Arweave archival storage
          </p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button className="flex items-center gap-2 px-3.5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
            <Upload className="w-4 h-4" />
            Create Backup
          </button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="surface p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <ArchiveIcon className="w-5 h-5 text-muted-foreground" />
            Quick Backup
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Canister ID
              </label>
              <input
                type="text"
                placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai"
                value={selectedCanister}
                onChange={(e) => setSelectedCanister(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => handleQuickBackup('download')}
                disabled={!selectedCanister || actionInProgress?.startsWith('quick')}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionInProgress === 'quick-download' ? <LoadingSpinner size="sm" /> : <Download className="w-4 h-4" />}
                Download
              </button>
              <button 
                onClick={() => handleQuickBackup('archive')}
                disabled={!selectedCanister || actionInProgress?.startsWith('quick')}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium border bg-card rounded-lg hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionInProgress === 'quick-archive' ? <LoadingSpinner size="sm" /> : <Cloud className="w-4 h-4" />}
                Archive
              </button>
            </div>
          </div>
        </div>

        <div className="surface p-6">
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <Cloud className="w-5 h-5 text-muted-foreground" />
            Archive Storage
          </h2>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Archived</span>
              <span className="font-semibold">{archives.length} canisters</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Size</span>
              <span className="font-semibold">{formatBytes(totalSize)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Cost</span>
              <span className="font-semibold">{formatCycles(totalCost)}</span>
            </div>
            <div className="pt-3 border-t">
              <button className="w-full px-4 py-2 text-sm font-medium border rounded-lg hover:bg-muted transition-colors">
                Manage Archive Settings
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Archives</h2>
        {archives.length === 0 ? (
          <div className="surface p-8 text-center text-sm text-muted-foreground">
            <ArchiveIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No archives yet</p>
            <p className="text-sm mt-2">Create a backup to see it here</p>
          </div>
        ) : (
          <div className="surface divide-y">
            {archives.map((archive) => (
              <div key={archive.id} className="p-4">
                {/* Wraps on phones: the canister id truncates and the icons and time keep their size. */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {archive.status === 'completed' && <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />}
                    {archive.status === 'uploading' && <Clock className="h-5 w-5 shrink-0 text-primary" />}
                    {archive.status === 'prepared' && <Clock className="h-5 w-5 shrink-0 text-warning" />}
                    {archive.status === 'failed' && <XCircle className="h-5 w-5 shrink-0 text-destructive" />}
                    <span className="min-w-0 truncate font-mono text-sm" title={archive.canisterId || undefined}>{archive.canisterId}</span>
                    <StatusBadge status={archive.status} />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <TimeAgo timestamp={archive.timestamp} className="whitespace-nowrap" />
                    <button 
                      onClick={() => handleDownload(archive)}
                      disabled={archive.status !== 'completed' || actionInProgress === `download-${archive.id}`}
                      className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {actionInProgress === `download-${archive.id}` ? <LoadingSpinner size="sm" /> : <Download className="w-4 h-4 text-muted-foreground" />}
                    </button>
                    <button 
                      onClick={() => handleDelete(archive)}
                      disabled={actionInProgress === `delete-${archive.id}`}
                      className="p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {actionInProgress === `delete-${archive.id}` ? <LoadingSpinner size="sm" /> : <Trash2 className="w-4 h-4 text-destructive" />}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Size: </span>
                    <span className="font-medium">{formatBytes(archive.size)}</span>
                  </div>
                  {archive.checksum && (
                    <div>
                      <span className="text-muted-foreground">Checksum: </span>
                      <span className="font-mono">{archive.checksum.slice(0, 12)}...</span>
                    </div>
                  )}
                  {archive.arweaveTxId && (
                    <div>
                      <span className="text-muted-foreground">Arweave: </span>
                      <span className="font-mono">{archive.arweaveTxId.slice(0, 12)}...</span>
                    </div>
                  )}
                  {archive.cost && (
                    <div>
                      <span className="text-muted-foreground">Cost: </span>
                      <span className="font-medium">{formatCycles(archive.cost)}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
