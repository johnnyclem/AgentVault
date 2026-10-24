import type { CheckTone } from './describe-check'
import type {
  CertificateFailure,
  CertifiedReply,
  DecodedWrite,
  IcpReceiptCheck,
  KeyType,
  NotRepliedStatus,
} from './icp-receipt-check'

/*
 * The words, tone and icon a signed memory write shows for each check state,
 * kept apart from the components so the root test suite can hold them to one
 * rule: only a verified receipt gets the success tone and the shield-check
 * icon. A check that ran and failed is 'danger'; anything that was not, or
 * could not be, checked stays 'neutral', and so does a receipt for a canister
 * other than the one the server names. The check is local and deterministic
 * (the same bytes always give the same answer), so no state offers a retry.
 */

/** One per kind of outcome, so no state is told apart by colour alone; the card maps each to an icon component */
export type IcpCheckIcon =
  | 'spinner'
  | 'shield-check'
  | 'shield-question'
  | 'x-circle'
  | 'user-x'
  | 'shield-x'
  | 'message-x'
  | 'search-x'
  | 'file-x'
  | 'key'
  | 'alert'
  | 'package-x'
  | 'package-search'
  | 'pause'

export interface IcpCheckView {
  tone: CheckTone
  icon: IcpCheckIcon
  title: string
  detail: string
}

export type StepId = 'signature' | 'principal' | 'canister' | 'certificate' | 'status' | 'reply'
/** 'not-confirmed': looked at, but it neither passed nor showed anything wrong, as under a neutral state */
export type StepOutcome = 'passed' | 'failed' | 'not-confirmed' | 'not-checked'

/** One line of "What was checked" */
export interface StepView {
  id: StepId
  label: string
  outcome: StepOutcome
  detail: string
}

/** How a key type is written on the page */
export const KEY_NAME: Record<KeyType, string> = { ed25519: 'Ed25519', secp256k1: 'secp256k1' }

const NOT_ANCHORED = 'Signature checked, not anchored to the Internet Computer'

const ROOT_KEY = 'the Internet Computer root key built into this page'

const NAMED_CANISTER = 'the memory_repo canister this server names'

export function describeIcpCheck(check: IcpReceiptCheck): IcpCheckView {
  switch (check.state) {
    case 'checking':
      return view('neutral', 'spinner', 'Checking…', 'Checking the request signature and the Internet Computer certificate in your browser.')
    case 'large-unchecked':
      return view(
        'neutral',
        'pause',
        'Not checked yet (large write)',
        `This write’s signed argument is ${kib(check.argBytes)}, so it is not checked automatically. Select Check to ` +
          'check it in your browser.'
      )
    case 'verified':
      return view(
        'success',
        'shield-check',
        'Verified',
        `Signed by principal ${shortPrincipal(check.write.sender)}. An Internet Computer certificate, checked against ` +
          `${ROOT_KEY}, shows canister ${check.write.canisterId}, ${NAMED_CANISTER}, accepted this call and replied ` +
          `${replied(check.write)}.`
      )
    case 'other-canister':
      return view(
        'neutral',
        'package-x',
        'Written to another canister',
        `The ${KEY_NAME[check.keyType]} signature is valid for principal ${shortPrincipal(check.write.sender)}, but the ` +
          `call went to canister ${check.write.canisterId}, not ${check.expected}, ${NAMED_CANISTER}. It was not checked further.`
      )
    case 'canister-unknown':
      return view(
        'neutral',
        'package-search',
        'Canister not confirmed',
        `The ${KEY_NAME[check.keyType]} signature is valid for principal ${shortPrincipal(check.write.sender)}, but this ` +
          `server names no memory_repo canister, so this page cannot tell whether canister ${check.write.canisterId} is ` +
          'the one it writes to. It was not checked further.'
      )
    case 'not-anchored':
      return view(
        'neutral',
        'shield-question',
        NOT_ANCHORED,
        `The ${KEY_NAME[check.keyType]} signature is valid for principal ${shortPrincipal(check.write.sender)}. ` +
          'This server recorded the write as going to a local replica, whose certificate can only be checked with a key ' +
          'that replica hands out, so nothing here shows that the Internet Computer accepted it.'
      )
    case 'signature-invalid':
      return view(
        'danger',
        'x-circle',
        'Signature does not match',
        `The ${KEY_NAME[check.keyType]} signature does not verify over this request: the request was changed after it ` +
          'was signed, or the signature belongs to a different request.'
      )
    case 'principal-mismatch':
      return view(
        'danger',
        'user-x',
        'Sender does not match the signing key',
        `The request names sender ${shortPrincipal(check.recorded)}, but the key that signed it belongs to ${shortPrincipal(check.derived)}.`
      )
    case 'certificate-invalid':
      return view(
        'danger',
        'shield-x',
        'Certificate does not verify',
        `The certificate recorded with this write does not chain to ${ROOT_KEY} for this canister.`
      )
    case 'not-replied':
      if (check.status === 'rejected') {
        return view(
          'danger',
          'message-x',
          'The canister rejected this call',
          `The certificate shows the call was rejected${check.rejectMessage ? `: ${quote(check.rejectMessage)}` : ''}. ` +
            'The server recorded it as a successful write.'
        )
      }
      if (check.status === 'absent') {
        return view(
          'danger',
          'search-x',
          'Certificate is for another request',
          `The certificate chains to ${ROOT_KEY}, but it does not mention this request.`
        )
      }
      return view(
        'neutral',
        'message-x',
        'Answer not in the certificate',
        `The certificate chains to ${ROOT_KEY}, but it does not hold the canister’s answer to this call, so the ` +
          'recorded result cannot be compared.'
      )
    case 'reply-mismatch':
      return view(
        'danger',
        'file-x',
        'Reply differs from the recorded result',
        `The server recorded ${quote(check.recorded)}; the certified reply is ${replyPhrase(check.certified)}.`
      )
    case 'unsupported-key-type':
      return view(
        'neutral',
        'key',
        'Key type not supported here',
        'This page checks Ed25519 and secp256k1 signatures. This receipt names another kind of key, so it was not checked.'
      )
    case 'check-failed':
      return view('neutral', 'alert', 'Could not check', check.reason)
  }
}

const STEPS: ReadonlyArray<[StepId, string]> = [
  ['signature', 'Request signature'],
  ['principal', 'Sender principal'],
  ['canister', 'Canister'],
  ['certificate', 'Internet Computer certificate'],
  ['status', 'Call answered'],
  ['reply', 'Reply matches the record'],
]

/**
 * What each check covered, in the order they run: the steps before the one a
 * check stopped at passed, that step failed (or, under a neutral state, was
 * not confirmed), and the rest were not checked. Only a verified receipt
 * passes all six; a local replica receipt passes the first three.
 */
export function describeIcpSteps(check: IcpReceiptCheck): StepView[] {
  const passed = passedDetails(check)
  const stop = stopOf(check)
  return STEPS.map(([id, label], index): StepView => {
    if (index < passed.length) return { id, label, outcome: 'passed', detail: passed[index] }
    if (stop?.at === id) return { id, label, outcome: stop.outcome, detail: stop.detail }
    return { id, label, outcome: 'not-checked', detail: notCheckedDetail(id, check) }
  })
}

const SIGNATURE_PASSED = 'The signature verifies over the request id computed in your browser.'
const PRINCIPAL_PASSED = 'The sender is the principal derived from the signing key.'
const CANISTER_PASSED = `The call went to ${NAMED_CANISTER}.`
const CERTIFICATE_PASSED = `Chains to ${ROOT_KEY}.`
const STATUS_PASSED = 'The certificate records this request as replied.'
const PASSED_BEFORE_REPLY = [SIGNATURE_PASSED, PRINCIPAL_PASSED, CANISTER_PASSED, CERTIFICATE_PASSED, STATUS_PASSED]

/** The details of the steps that passed, which are always the first ones */
function passedDetails(check: IcpReceiptCheck): string[] {
  switch (check.state) {
    case 'verified':
      return [
        SIGNATURE_PASSED,
        PRINCIPAL_PASSED,
        CANISTER_PASSED,
        check.subnetId ? `Chains to ${ROOT_KEY}, through subnet ${shortPrincipal(check.subnetId)}, which hosts this canister.` : CERTIFICATE_PASSED,
        STATUS_PASSED,
        `The certified reply is ${quote(check.write.recordedResult)}, as the server recorded.`,
      ]
    case 'principal-mismatch':
      return PASSED_BEFORE_REPLY.slice(0, 1)
    case 'other-canister':
    case 'canister-unknown':
      return PASSED_BEFORE_REPLY.slice(0, 2)
    case 'check-failed':
      // Only an argument that is not the method's Candid stops the check after the signature and sender passed.
      return check.signatureChecked ? PASSED_BEFORE_REPLY.slice(0, 2) : []
    case 'not-anchored':
    case 'certificate-invalid':
      return PASSED_BEFORE_REPLY.slice(0, 3)
    case 'not-replied':
      return PASSED_BEFORE_REPLY.slice(0, 4)
    case 'reply-mismatch':
      return PASSED_BEFORE_REPLY.slice(0, 5)
    default:
      return []
  }
}

/** The step a check stopped at, how, and why; null when it stopped at none */
function stopOf(check: IcpReceiptCheck): { at: StepId; outcome: StepOutcome; detail: string } | null {
  switch (check.state) {
    case 'signature-invalid':
      return { at: 'signature', outcome: 'failed', detail: 'The signature does not verify over the request id computed in your browser.' }
    case 'principal-mismatch':
      return { at: 'principal', outcome: 'failed', detail: 'The sender is not the principal derived from the signing key.' }
    case 'other-canister':
      return {
        at: 'canister',
        outcome: 'not-confirmed',
        detail: `The call went to canister ${check.write.canisterId}; this server names ${check.expected} as its memory_repo canister.`,
      }
    case 'canister-unknown':
      return {
        at: 'canister',
        outcome: 'not-confirmed',
        detail: `The call went to canister ${check.write.canisterId}; this server names no memory_repo canister to compare it with.`,
      }
    case 'certificate-invalid':
      return { at: 'certificate', outcome: 'failed', detail: CERTIFICATE_FAILURE[check.reason] }
    case 'not-replied':
      // Rejected, or about another request, is a failure; a certificate that only leaves the answer out shows nothing wrong.
      return {
        at: 'status',
        outcome: check.status === 'rejected' || check.status === 'absent' ? 'failed' : 'not-confirmed',
        detail: statusDetail(check.status, check.rejectCode),
      }
    case 'reply-mismatch':
      return {
        at: 'reply',
        outcome: 'failed',
        detail: `The certified reply is ${replyPhrase(check.certified)}; the server recorded ${quote(check.recorded)}.`,
      }
    default:
      return null
  }
}

/** Fixed words for each way a certificate fails; no library error text reaches the page. */
const CERTIFICATE_FAILURE: Record<CertificateFailure, string> = {
  'bad-signature': `Does not chain to ${ROOT_KEY}: its signature does not verify.`,
  'canister-not-covered': 'The certificate’s subnet delegation does not cover this canister, so it says nothing about this call.',
  'not-cbor': 'The recorded certificate is not readable CBOR.',
  malformed: 'The recorded certificate is not one this page can read.',
}

function notCheckedDetail(id: StepId, check: IcpReceiptCheck): string {
  if (check.state === 'checking') return 'Checking…'
  if (check.state === 'large-unchecked') return 'Not checked yet.'
  if (check.state === 'not-anchored' && id === 'certificate') {
    return 'Not checked: this server recorded the write as going to a local replica.'
  }
  return 'Not checked.'
}

function statusDetail(status: NotRepliedStatus, rejectCode: number | undefined): string {
  switch (status) {
    case 'rejected':
      return `The certificate records this request as rejected${rejectCode === undefined ? '' : ` (reject code ${rejectCode})`}.`
    case 'absent':
      return 'The certificate has no entry for this request.'
    case 'unreadable':
      return 'The certificate’s entry for this request cannot be read.'
    case 'replied-without-reply':
      return 'The certificate records this request as replied but leaves out the reply.'
    default:
      return `The certificate records this request as ${status}, without its reply.`
  }
}

/** The row's one-line summary of the signed call. Not evidence on its own. */
export function summarizeWrite(write: DecodedWrite): string {
  if (!write.argReadable) return write.kind === 'branch' ? 'New branch (argument not readable)' : 'Commit (argument not readable)'
  if (write.kind === 'branch') return `New branch ${write.branch} from ${write.baseBranch}`
  if (write.kind === 'tombstone') return `Deletion marker on ${write.branch}`
  return `Commit to ${write.branch}`
}

/**
 * "abcde-…-wqe": the first and last groups of a principal, enough to tell
 * self-authenticating principals apart at a glance. Not for canister ids,
 * whose last group is always "cai": those are shown in full.
 */
export function shortPrincipal(principal: string): string {
  const groups = principal.split('-')
  return groups.length > 3 ? `${groups[0]}-…-${groups[groups.length - 1]}` : principal
}

function replied(write: DecodedWrite): string {
  return write.method === 'commitToBranch' ? `with commit ${write.recordedResult}` : quote(write.recordedResult)
}

function replyPhrase(reply: CertifiedReply): string {
  if (!reply) return 'not a result this page can read'
  return 'ok' in reply ? quote(reply.ok) : `an error, ${quote(reply.err)}`
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString('en-US')} KiB`
}

function quote(text: string): string {
  return `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`
}

function view(tone: CheckTone, icon: IcpCheckIcon, title: string, detail: string): IcpCheckView {
  return { tone, icon, title, detail }
}
