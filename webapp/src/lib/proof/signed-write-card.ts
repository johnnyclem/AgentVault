import type { IcpReceiptCheck } from './icp-receipt-check'
import { readReceipt, type ReadReceipt } from './icp-receipt-read'
import {
  KEY_NAME,
  describeIcpCheck,
  describeIcpSteps,
  shortPrincipal,
  summarizeWrite,
  type IcpCheckView,
  type StepView,
} from './describe-icp-check'

/*
 * Everything one signed memory write card shows, worked out apart from the
 * component so the root test suite can load it by path. The call's fields are
 * decoded in the browser from the signed request, never taken from the
 * server's own summary, and every field says where it comes from: only a
 * verified check lets them read as certified.
 */

export interface DetailRow {
  label: string
  value: string
  /** Ids and principals: monospace, wrapping in the details instead of scrolling */
  mono?: boolean
}

export interface SignedWriteCard {
  view: IcpCheckView
  summary: string
  /** The recorded result: the commit id, or createBranchFrom's reply text */
  result: { label: 'Commit' | 'Reply'; value: string } | null
  /** The sender principal, and the short form the collapsed row shows */
  sender: { full: string; short: string } | null
  network: string | null
  /** The certified time when verified, otherwise the server's own clock */
  time: { label: 'Certified' | 'Recorded'; iso: string; text: string } | null
  /** Where the decoded fields come from, given what the check found */
  provenance: string
  details: DetailRow[]
  steps: StepView[]
}

const CALL: Record<'commit' | 'tombstone' | 'branch', string> = {
  commit: 'commitToBranch (commit)',
  tombstone: 'commitToBranch (deletion marker)',
  branch: 'createBranchFrom (new branch)',
}

/**
 * @param read The receipt as readReceipt reads it, when the caller already
 *   has it: decoding a large signed argument is the costly part, so the card
 *   component reads each receipt once rather than on every check result.
 */
export function signedWriteCard(
  receipt: unknown,
  check: IcpReceiptCheck,
  read: ReadReceipt | { error: string } = readReceipt(receipt)
): SignedWriteCard {
  const view = describeIcpCheck(check)
  const steps = describeIcpSteps(check)
  const recordedAt = recordedTime(receipt)
  const recordedRow: DetailRow[] = recordedAt ? [{ label: 'Recorded by this server (its own clock)', value: recordedAt.text }] : []

  if ('error' in read) {
    return {
      view,
      steps,
      summary: 'Receipt this page cannot read',
      result: null,
      sender: null,
      network: null,
      time: recordedAt && { label: 'Recorded', ...recordedAt },
      provenance: 'As recorded by this server. Not verified.',
      details: recordedRow,
    }
  }

  const { write, network } = read
  const verified = check.state === 'verified' ? check : null
  const signedWith = passedSignature(check) ? ` (${KEY_NAME[check.keyType]} key)` : ''
  const resultLabel = write.method === 'commitToBranch' ? 'Commit id' : 'Reply'
  const certifiedAt = verified && timeOf(verified.certifiedAt)

  const details: DetailRow[] = [
    { label: 'Call', value: CALL[write.kind] },
    ...(write.branch !== undefined ? [{ label: 'Branch', value: write.branch }] : []),
    ...(write.baseBranch !== undefined ? [{ label: 'From branch', value: write.baseBranch }] : []),
    ...(write.message !== undefined ? [{ label: 'Message', value: write.message }] : []),
    ...(write.tags !== undefined ? [{ label: 'Tags', value: write.tags.length ? write.tags.join(', ') : 'None' }] : []),
    ...(write.entryKeys !== undefined && write.entryCount !== undefined
      ? [{ label: 'Entry keys', value: entryKeys(write.entryKeys, write.entryCount) }]
      : []),
    ...(write.diffBytes !== undefined
      ? [{ label: 'Entry data', value: `${write.diffBytes.toLocaleString('en-US')} bytes in the signed request (not shown)` }]
      : []),
    { label: verified ? `${resultLabel}, certified` : `${resultLabel}, as recorded`, value: write.recordedResult, mono: true },
    { label: 'Canister', value: write.canisterId, mono: true },
    { label: 'Sender', value: `${write.sender}${signedWith}`, mono: true },
    { label: 'Network', value: networkDetail(network, verified !== null) },
    { label: 'Request id, computed in your browser', value: write.requestId, mono: true },
    ...(certifiedAt ? [{ label: 'Certified at', value: certifiedAt.text }] : []),
    ...recordedRow,
  ]

  return {
    view,
    steps,
    summary: summarizeWrite(write),
    result: { label: write.method === 'commitToBranch' ? 'Commit' : 'Reply', value: write.recordedResult },
    sender: { full: write.sender, short: shortPrincipal(write.sender) },
    network: verified ? 'IC mainnet' : network === 'ic' ? 'IC mainnet, as recorded' : 'Local replica, as recorded',
    time: certifiedAt ? { label: 'Certified', ...certifiedAt } : recordedAt && { label: 'Recorded', ...recordedAt },
    provenance: provenanceOf(check),
    details,
  }
}

/** The states in which the signature and sender passed, so the signing key's type can be named */
function passedSignature(
  check: IcpReceiptCheck
): check is Extract<IcpReceiptCheck, { state: 'verified' | 'not-anchored' | 'other-canister' | 'canister-unknown' }> {
  return check.state === 'verified' || check.state === 'not-anchored' || check.state === 'other-canister' || check.state === 'canister-unknown'
}

function provenanceOf(check: IcpReceiptCheck): string {
  switch (check.state) {
    case 'verified':
      return 'Decoded in your browser from the signed request. The certificate shows the canister accepted it.'
    case 'not-anchored':
    case 'other-canister':
    case 'canister-unknown':
      return 'Decoded in your browser from the signed request. Nothing here shows the canister accepted it.'
    case 'checking':
      return 'As recorded by this server, until the check finishes.'
    case 'large-unchecked':
      return 'As recorded by this server, until it is checked.'
    default:
      return 'As recorded by this server. Not verified.'
  }
}

function networkDetail(network: 'ic' | 'local', verified: boolean): string {
  if (verified) return 'Internet Computer mainnet (the certificate chains to its root key)'
  return network === 'ic' ? 'Internet Computer mainnet, as recorded' : 'Local replica, as recorded'
}

function entryKeys(keys: string[], count: number): string {
  if (count === 0) return 'None'
  const more = count - keys.length
  return more > 0 ? `${keys.join(', ')} and ${more.toLocaleString('en-US')} more` : keys.join(', ')
}

function recordedTime(receipt: unknown): { iso: string; text: string } | null {
  if (!receipt || typeof receipt !== 'object') return null
  const { recordedAt } = receipt as Record<string, unknown>
  return typeof recordedAt === 'string' ? timeOf(new Date(recordedAt)) : null
}

function timeOf(time: Date): { iso: string; text: string } | null {
  if (Number.isNaN(time.getTime())) return null
  return { iso: time.toISOString(), text: time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) }
}
