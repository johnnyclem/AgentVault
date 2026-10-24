'use client'

import { useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { SignedWriteCard } from '@/components/proof/SignedWriteCard'
import { useSignedWrites } from '@/hooks/useSignedWrites'
import { SIGNED_WRITES_COPY as COPY, checkAt, liveMessage } from '@/lib/proof/signed-writes'

/*
 * The memory_repo writes this webapp server signed, for the whole deployment.
 * Nothing in a write identifies the agent behind it (the server signs for
 * anyone holding the API token), so receipts live here rather than on any
 * agent's Evidence page. Each is checked in this browser.
 */
export default function SignedMemoryWritesPage() {
  const { state, retry, loadOlder, checkLarge } = useSignedWrites()
  const { status, error, receipts, nextCursor, older, skippedLines, writesConfigured, canisterId } = state

  // "Show older" stays focusable while it loads (aria-disabled, not disabled).
  // When it gives way to "no older receipts" or an error, or the error's Retry
  // gives way to it, focus moves to whichever took its place instead of
  // falling back to the page.
  const olderControl = useRef<HTMLElement | null>(null)
  const holdOlderControl = useCallback((element: HTMLElement | null) => {
    olderControl.current = element
  }, [])
  const olderFocus = useRef(false)
  const askForOlder = () => {
    olderFocus.current = true
    loadOlder()
  }
  useEffect(() => {
    if (!olderFocus.current) return
    const lost = !document.activeElement || document.activeElement === document.body
    if (lost) olderControl.current?.focus()
    if (older.status !== 'loading') olderFocus.current = false
  }, [older.status, nextCursor])

  return (
    <div className="page max-w-3xl">
      <div className="space-y-2">
        <Link
          href="/vault?filter=evidence"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Evidence
        </Link>
        <div className="space-y-1">
          <h1 className="page-title">{COPY.title}</h1>
          <p className="page-subtitle">{COPY.scope}</p>
          <p className="page-subtitle">{COPY.method}</p>
          {/* Every receipt is held to this canister; without one, none can be verified, which matters only when there are receipts. */}
          {status === 'ready' && canisterId && (
            <p className="page-subtitle">
              {COPY.canister} <code className="break-all font-mono text-foreground">{canisterId}</code>
            </p>
          )}
          {status === 'ready' && !canisterId && receipts.length > 0 && <p className="page-subtitle">{COPY.noCanister}</p>}
        </div>
      </div>

      {/* One announcement for the whole list; the cards themselves stay quiet. */}
      <p role="status" aria-live="polite" className="sr-only">
        {liveMessage(state)}
      </p>

      {status === 'loading' ? (
        <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-muted-foreground">
          <LoadingSpinner />
          {COPY.loading}
        </div>
      ) : status === 'error' ? (
        <ErrorLine message={COPY.loadError} detail={error?.message} onRetry={retry} />
      ) : receipts.length === 0 ? (
        <p className="surface px-4 py-10 text-center text-sm text-muted-foreground">
          {writesConfigured === false ? COPY.notConfigured : COPY.empty}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{COPY.showing(receipts.length)}</p>
          <ul role="list" className="space-y-3">
            {receipts.map((receipt, index) => (
              // The list is only ever appended to within one load, and a new load starts it afresh.
              <SignedWriteCard
                key={`${state.generation}:${index}`}
                receipt={receipt}
                check={checkAt(state, index)}
                onCheck={() => checkLarge(index)}
              />
            ))}
          </ul>
          {older.status === 'error' ? (
            <ErrorLine
              focusRef={holdOlderControl}
              message={COPY.loadOlderError}
              detail={older.error?.message}
              onRetry={askForOlder}
            />
          ) : nextCursor ? (
            <button
              ref={holdOlderControl}
              type="button"
              onClick={askForOlder}
              aria-disabled={older.status === 'loading'}
              aria-busy={older.status === 'loading'}
              className="chip min-h-11 w-full justify-center aria-disabled:cursor-wait sm:w-auto"
            >
              {older.status === 'loading' ? COPY.loadingOlder : COPY.showOlder}
            </button>
          ) : (
            <p ref={holdOlderControl} tabIndex={-1} className="text-xs text-muted-foreground">
              {COPY.noOlder}
            </p>
          )}
        </div>
      )}

      {status === 'ready' && skippedLines > 0 && <p className="text-xs text-muted-foreground">{COPY.skipped(skippedLines)}</p>}

      <p className="text-xs text-muted-foreground">{COPY.limits}</p>
    </div>
  )
}

function ErrorLine({
  message,
  detail,
  onRetry,
  focusRef,
}: {
  message: string
  detail: string | undefined
  onRetry: () => void
  /** Given when focus may be moved here, which makes the line focusable from script */
  focusRef?: (element: HTMLElement | null) => void
}) {
  return (
    <div
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
      role="alert"
    >
      <span className="font-medium text-destructive">{message}</span>
      {detail && <span className="min-w-0 break-words text-muted-foreground">{detail}</span>}
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        Retry
      </button>
    </div>
  )
}
