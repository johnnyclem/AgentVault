import { ARWEAVE_GATEWAY_HOST, type ReceiptCheck } from './arweave-check'

/*
 * The words, tone and icon a receipt card shows for each check state, kept
 * apart from the component so the root test suite can hold them to one rule:
 * only a confirmed check gets the success tone and the check icon. Failures
 * are 'danger'; anything that could not be checked stays 'neutral'.
 */

export type CheckTone = 'success' | 'warning' | 'danger' | 'neutral'

/** One per state, so no state is told apart by colour alone; the card maps each to an icon component */
export type CheckIcon = 'spinner' | 'check' | 'clock' | 'search-x' | 'file-warning' | 'file-x' | 'ban' | 'alert'

export interface CheckView {
  tone: CheckTone
  icon: CheckIcon
  title: string
  detail: string
  /** States that can change on a later attempt: the network, the gateway's answer, or a transaction still being mined */
  canRetry: boolean
}

const PERSISTS = `If this persists, what ${ARWEAVE_GATEWAY_HOST} serves for this transaction is not what the server recorded uploading.`

export function describeCheck(check: ReceiptCheck): CheckView {
  switch (check.state) {
    case 'checking':
      return view('neutral', 'spinner', 'Checking…', `Asking ${ARWEAVE_GATEWAY_HOST} for the transaction and its content.`)
    case 'confirmed':
      return view(
        'success',
        'check',
        'Confirmed',
        `Mined in block #${check.blockHeight.toLocaleString('en-US')} with ${plural(check.confirmations, 'confirmation')}. ` +
          'The SHA-256 of the content matches the hash recorded at upload.'
      )
    case 'pending':
      return view(
        'warning',
        'clock',
        'Not confirmed yet',
        `${ARWEAVE_GATEWAY_HOST} knows this transaction, but it is not in a confirmed block yet. Check again in a few minutes.`,
        true
      )
    case 'not-found':
      return view(
        'danger',
        'search-x',
        'Not found',
        `${ARWEAVE_GATEWAY_HOST} has no transaction with this id. It may have been dropped before it was mined.`,
        true
      )
    // A gateway can briefly serve an incomplete body after mining, so a mismatch
    // may be asked again; a retry hashes fresh bytes and cannot turn one green.
    case 'size-mismatch':
      return view(
        'danger',
        'file-warning',
        'Size differs',
        `${ARWEAVE_GATEWAY_HOST} served ${plural(check.actual, 'byte')}; the server recorded ${plural(check.expected, 'byte')}. ` +
          PERSISTS,
        true
      )
    case 'content-mismatch':
      return view(
        'danger',
        'file-x',
        'Content differs',
        `The SHA-256 of the content ${ARWEAVE_GATEWAY_HOST} served does not match the hash recorded at upload. ${PERSISTS}`,
        true
      )
    case 'too-large':
      return view(
        'neutral',
        'ban',
        'Too large to check here',
        `The content is over ${Math.round(check.maxBytes / (1024 * 1024))} MB, more than this page downloads to check.`
      )
    case 'check-failed':
      return view('neutral', 'alert', 'Could not check', check.reason, check.retryable)
  }
}

function view(tone: CheckTone, icon: CheckIcon, title: string, detail: string, canRetry = false): CheckView {
  return { tone, icon, title, detail, canRetry }
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
}
