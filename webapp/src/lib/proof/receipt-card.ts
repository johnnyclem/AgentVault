import type { ArweaveReceipt } from '@/lib/types'
import type { ReceiptCheck, ReceiptCheckResult } from './arweave-check'
import { describeCheck } from './describe-check'

/*
 * The logic behind one receipt card, apart from the component so the root
 * test suite can load it by path: which check result the card shows, when it
 * may start another check, and the label that tells one card from the next.
 */

export interface ReceiptCardState {
  /** Counts the checks started; a result is shown only if it belongs to the latest one */
  attempt: number
  check: ReceiptCheck
}

export type ReceiptCardEvent =
  | { type: 'result'; attempt: number; result: ReceiptCheckResult }
  | { type: 'retry' }

export const INITIAL_CARD_STATE: ReceiptCardState = { attempt: 0, check: { state: 'checking' } }

export function nextCardState(state: ReceiptCardState, event: ReceiptCardEvent): ReceiptCardState {
  switch (event.type) {
    case 'result':
      // A result from an earlier attempt never replaces the newer check.
      return event.attempt === state.attempt ? { ...state, check: event.result } : state
    case 'retry':
      // Only where asking again could change the answer, and never while a check runs.
      return describeCheck(state.check).canRetry ? { attempt: state.attempt + 1, check: { state: 'checking' } } : state
  }
}

/**
 * "Arweave receipt · 22 Oct 2026, 10:00": the card's heading, and the prefix
 * of its status announcement, so a screen reader can tell several apart.
 * Falls back to the start of the transaction id when no time was recorded.
 */
export function receiptLabel(receipt: Pick<ArweaveReceipt, 'txId' | 'recordedAt'>): string {
  const time = receipt.recordedAt ? new Date(receipt.recordedAt) : null
  if (time && !Number.isNaN(time.getTime())) {
    return `Arweave receipt · ${time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
  }
  return `Arweave receipt · tx ${String(receipt.txId).slice(0, 8)}`
}
