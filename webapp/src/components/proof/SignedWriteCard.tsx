'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleHelp,
  CirclePause,
  FileX2,
  KeyRound,
  Loader2,
  MessageSquareX,
  PackageSearch,
  PackageX,
  SearchX,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  UserX,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { CheckTone } from '@/lib/proof/describe-check'
import type { IcpCheckIcon, StepOutcome } from '@/lib/proof/describe-icp-check'
import type { IcpReceiptCheck } from '@/lib/proof/icp-receipt-check'
import { readReceipt } from '@/lib/proof/icp-receipt-read'
import { signedWriteCard } from '@/lib/proof/signed-write-card'
import { SIGNED_WRITES_COPY } from '@/lib/proof/signed-writes'
import { cn } from '@/lib/utils'
import type { IcpWriteReceipt } from '@/lib/types'

// describeIcpCheck gives each state its icon key; only 'shield-check' (verified) is the success icon.
const ICONS: Record<IcpCheckIcon, LucideIcon> = {
  spinner: Loader2,
  'shield-check': ShieldCheck,
  'shield-question': ShieldQuestion,
  'x-circle': XCircle,
  'user-x': UserX,
  'shield-x': ShieldX,
  'message-x': MessageSquareX,
  'search-x': SearchX,
  'file-x': FileX2,
  key: KeyRound,
  alert: AlertCircle,
  'package-x': PackageX,
  'package-search': PackageSearch,
  pause: CirclePause,
}

const TONE_TEXT: Record<CheckTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
}

const STEP_ICON: Record<StepOutcome, { icon: LucideIcon; word: string; tone: string }> = {
  passed: { icon: CheckCircle2, word: 'Passed', tone: 'text-success' },
  failed: { icon: XCircle, word: 'Failed', tone: 'text-destructive' },
  'not-confirmed': { icon: CircleHelp, word: 'Not confirmed', tone: 'text-muted-foreground' },
  'not-checked': { icon: CircleDashed, word: 'Not checked', tone: 'text-muted-foreground' },
}

/**
 * One signed memory write: what the server recorded, and what this browser's
 * check of it found. The check is run by the page; this card only shows it,
 * and for a large write offers to ask for it (onCheck).
 */
export function SignedWriteCard({
  receipt,
  check,
  onCheck,
}: {
  receipt: IcpWriteReceipt
  check: IcpReceiptCheck
  onCheck: () => void
}) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  // Decoding the signed argument can mean megabytes of hex, so it is done once per receipt, not once per check result.
  const read = useMemo(() => readReceipt(receipt), [receipt])
  const card = useMemo(() => signedWriteCard(receipt, check, read), [receipt, check, read])
  const Icon = ICONS[card.view.icon]

  // The Check button goes once it is used; focus then moves to Details rather than falling back to the page.
  const waiting = check.state === 'large-unchecked'
  const detailsButton = useRef<HTMLButtonElement>(null)
  const checkAsked = useRef(false)
  useEffect(() => {
    if (waiting || !checkAsked.current) return
    checkAsked.current = false
    if (!document.activeElement || document.activeElement === document.body) detailsButton.current?.focus()
  }, [waiting])

  return (
    <li className="surface space-y-3 p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <p className="min-w-0 break-words text-sm font-medium">{card.summary}</p>
        <p className={cn('flex shrink-0 items-center gap-1.5 text-sm font-medium', TONE_TEXT[card.view.tone])}>
          <Icon
            className={cn('h-4 w-4 shrink-0', card.view.icon === 'spinner' && 'motion-safe:animate-spin')}
            aria-hidden="true"
          />
          {card.view.title}
        </p>
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {card.result && (
          <Meta label={card.result.label}>
            <code className="block max-w-[16rem] truncate font-mono" title={card.result.value}>
              {card.result.value}
            </code>
          </Meta>
        )}
        {card.sender && (
          <Meta label="Sender">
            <code className="font-mono" title={card.sender.full}>
              {card.sender.short}
            </code>
          </Meta>
        )}
        {card.network && <Meta label="Network">{card.network}</Meta>}
        {card.time && (
          <Meta label={card.time.label}>
            <time dateTime={card.time.iso}>{card.time.text}</time>
          </Meta>
        )}
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row">
        {waiting && (
          <button
            type="button"
            aria-label={`${SIGNED_WRITES_COPY.checkLarge} ${card.summary}${card.result ? `, ${card.result.value}` : ''}`}
            onClick={() => {
              checkAsked.current = true
              onCheck()
            }}
            className="chip min-h-11 w-full justify-center sm:w-auto"
          >
            {SIGNED_WRITES_COPY.checkLarge}
          </button>
        )}
        <button
          ref={detailsButton}
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`${open ? 'Hide details' : 'Details'} for ${card.summary}${card.result ? `, ${card.result.value}` : ''}`}
          onClick={() => setOpen((value) => !value)}
          className="chip min-h-11 w-full justify-center sm:w-auto"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>

      {/* Kept in the page while hidden, so the button's aria-controls always names an element. */}
      <div id={detailsId} hidden={!open} className="space-y-4 border-t border-border pt-3 text-sm">
        <div className="space-y-1">
          <p className="break-words">{card.view.detail}</p>
          <p className="text-xs text-muted-foreground">{card.provenance}</p>
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[max-content_1fr]">
          {card.details.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className={cn('mb-1.5 min-w-0 break-words sm:mb-0', row.mono && 'break-all font-mono')}>{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2">
          <h2 className="text-xs font-semibold">What was checked</h2>
          <ul className="space-y-2 text-xs">
            {card.steps.map((step) => {
              const outcome = STEP_ICON[step.outcome]
              const StepIcon = outcome.icon
              return (
                <li key={step.id} className="flex items-start gap-2">
                  <StepIcon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', outcome.tone)} aria-hidden="true" />
                  <div className="min-w-0">
                    <p>
                      <span className="font-medium">{step.label}</span>
                      <span className={cn('ml-1.5', outcome.tone)}>{outcome.word}</span>
                    </p>
                    <p className="break-words text-muted-foreground">{step.detail}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </li>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt>{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  )
}
