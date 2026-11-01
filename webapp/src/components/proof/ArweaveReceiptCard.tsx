'use client'

import { useEffect, useReducer, type ReactNode } from 'react'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileWarning,
  FileX,
  Loader2,
  RefreshCw,
  SearchX,
  type LucideIcon,
} from 'lucide-react'
import { ARWEAVE_GATEWAY, ARWEAVE_GATEWAY_HOST, checkReceipt, isTxId } from '@/lib/proof/arweave-check'
import { describeCheck, type CheckIcon, type CheckTone } from '@/lib/proof/describe-check'
import { INITIAL_CARD_STATE, nextCardState, receiptLabel } from '@/lib/proof/receipt-card'
import { cn } from '@/lib/utils'
import type { ArweaveReceipt } from '@/lib/types'

// describeCheck gives each state its own icon key; only 'check' (confirmed) is the success icon.
const ICONS: Record<CheckIcon, LucideIcon> = {
  spinner: Loader2,
  check: CheckCircle2,
  clock: Clock,
  'search-x': SearchX,
  'file-warning': FileWarning,
  'file-x': FileX,
  ban: Ban,
  alert: AlertCircle,
}

const TONE_TEXT: Record<CheckTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
}

// The verdict's surface: a hairline and a faint tint of its own tone, nothing more.
const VERDICT_SURFACE: Record<CheckTone, string> = {
  success: 'border-success/30 bg-success/10',
  warning: 'border-warning/30 bg-warning/10',
  danger: 'border-destructive/30 bg-destructive/10',
  neutral: 'border-border bg-muted/50',
}

/**
 * One Arweave receipt, checked in this browser against the gateway when the
 * card mounts. The server's own status is shown only as what it recorded.
 */
export function ArweaveReceiptCard({ receipt }: { receipt: ArweaveReceipt }) {
  const [{ attempt, check }, dispatch] = useReducer(nextCardState, INITIAL_CARD_STATE)

  useEffect(() => {
    const controller = new AbortController()
    checkReceipt(receipt, { fetch, subtle: globalThis.crypto?.subtle, signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) dispatch({ type: 'result', attempt, result })
    })
    return () => controller.abort()
  }, [receipt, attempt])

  const view = describeCheck(check)
  const Icon = ICONS[view.icon]
  const label = receiptLabel(receipt)

  return (
    <article className="surface space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{label}</h2>
          <p className="mt-1 text-xs text-muted-foreground">Checked in your browser against {ARWEAVE_GATEWAY_HOST}</p>
        </div>
        {view.canRetry && (
          <button type="button" onClick={() => dispatch({ type: 'retry' })} className="chip">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check again
          </button>
        )}
      </div>

      {/* The verdict leads the card: larger type on a surface tinted by the result, and the
          two hashes it compared right under it. Flat, one hairline, no glow. */}
      <div className={cn('rounded-lg border p-4', VERDICT_SURFACE[view.tone])}>
        <div role="status" aria-live="polite" className="flex items-start gap-3">
          <Icon
            className={cn('mt-1 h-4 w-4 shrink-0', TONE_TEXT[view.tone], view.icon === 'spinner' && 'motion-safe:animate-spin')}
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            {/* Screen readers announce the region's text, so it names its receipt. */}
            <p className={cn('text-base font-medium', TONE_TEXT[view.tone])}>
              <span className="sr-only">{label}: </span>
              {view.title}
            </p>
            <p className="break-words text-sm text-muted-foreground">{view.detail}</p>
          </div>
        </div>

        <dl className="mt-4 space-y-2 border-t border-foreground/10 pt-4 text-xs">
          <Row label="Transaction">
            <code className="tag whitespace-normal break-all sm:truncate sm:whitespace-nowrap" title={receipt.txId}>{receipt.txId}</code>
          </Row>
          <Row label="Recorded SHA-256">
            <code className="tag whitespace-normal break-all sm:truncate sm:whitespace-nowrap" title={receipt.checksum}>{receipt.checksum}</code>
          </Row>
          {check.state === 'content-mismatch' && (
            <Row label="SHA-256 served">
              <code className="tag whitespace-normal break-all text-destructive sm:truncate sm:whitespace-nowrap" title={check.actual}>{check.actual}</code>
            </Row>
          )}
        </dl>
      </div>

      <dl className="space-y-2 text-xs">
        <Row label="Recorded size">
          <span className="tabular-nums">
            {typeof receipt.sizeBytes === 'number' ? `${receipt.sizeBytes.toLocaleString('en-US')} bytes` : 'Unknown'}
          </span>
        </Row>
        <Row label="Recorded">
          <span className="tabular-nums">{receipt.recordedAt ? new Date(receipt.recordedAt).toLocaleString() : 'Unknown'}</span>
        </Row>
        <Row label="Server recorded">{receipt.recordedStatus}</Row>
      </dl>

      {/* Matches the payload runArchiveWorkflow posts (lib/server/archive-workflow.ts). */}
      <p className="text-xs text-muted-foreground">
        This receipt is a deployment record: the agent&apos;s id and name, its canister id and network, and each
        artifact&apos;s file name, with its size and SHA-256 except for the token file and folders. It holds no file
        contents or local paths. Like any Arweave transaction, the upload also shows the address of the wallet that paid
        for it.
      </p>

      {isTxId(receipt.txId) && (
        <a
          href={`${ARWEAVE_GATEWAY}/${receipt.txId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          Open the content on {ARWEAVE_GATEWAY_HOST}
        </a>
      )}
    </article>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:min-h-6 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      {/* A transaction id or hash is one unbreakable token: on phones it wraps under its label so it can be read in full; wider screens keep it on one line. */}
      <dd className="min-w-0 break-all text-foreground sm:truncate sm:text-right">{children}</dd>
    </div>
  )
}
