'use client'

import { useState } from 'react'
import { Anchor, ExternalLink, Copy, Check, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ArweaveAnchor } from '@/lib/types'

interface ArweaveAnchorCardProps {
  anchor: ArweaveAnchor
}

function CopyableCode({ value, truncate = 20 }: { value: string; truncate?: number }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const display = value.length > truncate ? `${value.slice(0, truncate)}…` : value

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-foreground hover:text-primary transition-colors"
      title={value}
    >
      <span>{display}</span>
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
    </button>
  )
}

export function ArweaveAnchorCard({ anchor }: ArweaveAnchorCardProps) {
  const statusColor = {
    confirmed: 'text-success bg-success/10 border-success/30',
    pending: 'text-warning bg-warning/10 border-warning/30',
    failed: 'text-destructive bg-destructive/10 border-destructive/30',
  }[anchor.status]

  return (
    <div className="surface p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">Arweave Anchor</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Permanent public proof · immutable ledger
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium capitalize',
            statusColor
          )}
        >
          <Anchor className="w-3 h-3" />
          {anchor.status}
        </span>
      </div>

      <div className="space-y-3">
        <Row label="Transaction ID">
          <CopyableCode value={anchor.txId} truncate={24} />
        </Row>
        <Row label="Block Height">
          <span className="font-mono text-xs text-foreground">
            #{anchor.blockHeight.toLocaleString()}
          </span>
        </Row>
        <Row label="Block Hash">
          <CopyableCode value={anchor.blockHash} truncate={20} />
        </Row>
        <Row label="Content Hash">
          <CopyableCode value={anchor.contentHash} truncate={26} />
        </Row>
        <Row label="Data Size">
          <span className="text-xs text-foreground">
            {(anchor.dataSize / 1024).toFixed(2)} KB
          </span>
        </Row>
        <Row label="Anchored At">
          <span className="text-xs text-foreground">
            {new Date(anchor.timestamp).toLocaleString()}
          </span>
        </Row>
      </div>

      <div className="pt-3 border-t border-border flex flex-wrap items-center gap-3">
        <a
          href={anchor.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          View on Arweave
        </a>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Database className="w-3 h-3" />
          Permaweb · immutable
        </span>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  )
}
