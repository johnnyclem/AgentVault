'use client'

import { useState } from 'react'
import { Share2, Link2, Printer, Check, X, Loader2 } from 'lucide-react'
import type { ShareProofResult } from '@/lib/types'

interface ShareProofButtonProps {
  onShare: () => Promise<ShareProofResult | null>
  vaultId: string
}

export function ShareProofButton({ onShare, vaultId }: ShareProofButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [shareResult, setShareResult] = useState<ShareProofResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handleShare = async () => {
    setState('loading')
    setErrorMsg('')
    try {
      const result = await onShare()
      setShareResult(result)
      setState('done')
      setOpen(true)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to share')
      setState('error')
    }
  }

  const copyLink = async () => {
    if (!shareResult) return
    await navigator.clipboard.writeText(shareResult.shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const printProof = () => {
    window.print()
  }

  const reset = () => {
    setState('idle')
    setOpen(false)
    setShareResult(null)
    setErrorMsg('')
  }

  return (
    <div className="relative">
      {!open ? (
        <button
          type="button"
          onClick={handleShare}
          disabled={state === 'loading'}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {state === 'loading' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Share2 className="w-4 h-4" />
          )}
          {state === 'loading' ? 'Generating…' : 'Share Proof'}
        </button>
      ) : (
        <div className="surface bg-popover text-popover-foreground shadow-lg p-4 w-[340px] max-w-[calc(100vw-2rem)] space-y-3 absolute right-0 top-0 z-10">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Proof link generated</span>
            <button
              type="button"
              onClick={reset}
              aria-label="Close"
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {shareResult && (
            <>
              <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                <code className="text-xs font-mono text-foreground flex-1 truncate">
                  {shareResult.shareUrl}
                </code>
                <button
                  type="button"
                  onClick={copyLink}
                  aria-label="Copy link"
                  className="shrink-0 p-1 rounded hover:bg-background transition-colors text-muted-foreground hover:text-foreground"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-success" />
                  ) : (
                    <Link2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <p className="text-xs text-muted-foreground">
                Link valid until{' '}
                <span className="text-foreground">
                  {new Date(shareResult.expiresAt).toLocaleDateString()}
                </span>
              </p>
            </>
          )}

          <button
            type="button"
            onClick={printProof}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs border border-border hover:bg-muted transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
            Export as PDF (browser print)
          </button>
        </div>
      )}

      {state === 'error' && (
        <p className="text-xs text-destructive mt-1">{errorMsg}</p>
      )}
    </div>
  )
}
