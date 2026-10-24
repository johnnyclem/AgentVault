import type { ApiError, IcpWriteReceipt } from '@/lib/types'
import type { IcpReceiptCheck, IcpReceiptCheckResult } from './icp-receipt-check'
import { argBytesOf } from './icp-receipt-read'

/*
 * The state behind the Signed memory writes page, apart from the components
 * so the root test suite can load it by path: the pages of receipts loaded so
 * far, newest first, and the check result for each. Checks run one at a time
 * in list order, skipping large writes until the reader asks for them. Every
 * answer carries the load it belongs to and the receipt it is for, and one
 * from an earlier load, or for a receipt that is not the one being checked,
 * is dropped.
 */

/** How many receipts the page asks for at a time: the newest first, then this many older on request */
export const PAGE_SIZE = 10

/** A receipt whose signed argument is larger than this is checked only when the reader asks, so a page of them does not keep the browser busy */
export const AUTO_CHECK_MAX_ARG_BYTES = 256 * 1024

/** A page of GET /api/memory-repo/receipts, newest first; nextCursor is null when nothing older is kept */
export interface SignedWritesPage {
  receipts: IcpWriteReceipt[]
  nextCursor: string | null
  /** Stored lines the server passed over on this page because they were not readable receipts */
  skippedLines: number
  /** Whether the server has a memory_repo canister and signing identity set; null when it did not say */
  writesConfigured: boolean | null
  /** The memory_repo canister id the server names; null when it names none or did not say */
  canisterId: string | null
}

export interface SignedWritesState {
  /** Counts the loads started; answers for any other load are dropped */
  generation: number
  status: 'loading' | 'ready' | 'error'
  error: ApiError | null
  receipts: IcpWriteReceipt[]
  /** checks[i] is the result for receipts[i], or null until it has one */
  checks: Array<IcpReceiptCheckResult | null>
  /** The index of the receipt being checked now, if any */
  checking: number | null
  /** The large receipts the reader asked to check */
  requested: number[]
  nextCursor: string | null
  /** Unreadable stored lines across the pages loaded so far */
  skippedLines: number
  writesConfigured: boolean | null
  /** The memory_repo canister id the first page named, which every receipt in this load is checked against */
  canisterId: string | null
  older: { status: 'idle' | 'loading' | 'error'; error: ApiError | null }
}

export type SignedWritesEvent =
  | { type: 'load'; generation: number }
  | { type: 'loaded'; generation: number; page: SignedWritesPage }
  | { type: 'load-failed'; generation: number; error: ApiError }
  | { type: 'load-older'; generation: number; cursor: string }
  | { type: 'loaded-older'; generation: number; cursor: string; page: SignedWritesPage }
  | { type: 'older-failed'; generation: number; cursor: string; error: ApiError }
  | { type: 'check-requested'; generation: number; index: number }
  | { type: 'check-started'; generation: number; index: number }
  | { type: 'checked'; generation: number; index: number; result: IcpReceiptCheckResult }

export const INITIAL_SIGNED_WRITES: SignedWritesState = {
  generation: 0,
  status: 'loading',
  error: null,
  receipts: [],
  checks: [],
  checking: null,
  requested: [],
  nextCursor: null,
  skippedLines: 0,
  writesConfigured: null,
  canisterId: null,
  older: { status: 'idle', error: null },
}

export function nextSignedWritesState(state: SignedWritesState, event: SignedWritesEvent): SignedWritesState {
  if (event.type === 'load') return { ...INITIAL_SIGNED_WRITES, generation: event.generation }
  if (event.generation !== state.generation) return state

  switch (event.type) {
    case 'loaded':
      return {
        ...state,
        status: 'ready',
        receipts: event.page.receipts,
        checks: event.page.receipts.map(() => null),
        nextCursor: event.page.nextCursor,
        skippedLines: event.page.skippedLines,
        writesConfigured: event.page.writesConfigured,
        canisterId: event.page.canisterId,
      }
    case 'load-failed':
      return { ...state, status: 'error', error: event.error }
    case 'load-older':
      // One older page at a time, and only the one after the receipts already shown.
      if (state.older.status === 'loading' || event.cursor !== state.nextCursor) return state
      return { ...state, older: { status: 'loading', error: null } }
    case 'loaded-older':
      if (state.older.status !== 'loading' || event.cursor !== state.nextCursor) return state
      return {
        ...state,
        receipts: [...state.receipts, ...event.page.receipts],
        checks: [...state.checks, ...event.page.receipts.map(() => null)],
        nextCursor: event.page.nextCursor,
        skippedLines: state.skippedLines + event.page.skippedLines,
        older: { status: 'idle', error: null },
      }
    case 'older-failed':
      if (state.older.status !== 'loading' || event.cursor !== state.nextCursor) return state
      return { ...state, older: { status: 'error', error: event.error } }
    case 'check-requested':
      // Only a large receipt waits to be asked for, and asking twice changes nothing.
      if (state.checks[event.index] !== null || !waitsForReader(state.receipts[event.index])) return state
      if (state.requested.includes(event.index)) return state
      return { ...state, requested: [...state.requested, event.index] }
    case 'check-started':
      if (event.index !== nextToCheck(state)) return state
      return { ...state, checking: event.index }
    case 'checked':
      // Only the receipt being checked takes a result; anything else is a stale or repeated answer.
      if (event.index !== state.checking) return state
      return { ...state, checks: state.checks.map((check, i) => (i === event.index ? event.result : check)), checking: null }
  }
}

/** Whether a receipt is too large to check until the reader asks */
export function waitsForReader(receipt: unknown): boolean {
  return argBytesOf(receipt) > AUTO_CHECK_MAX_ARG_BYTES
}

/** The index of the receipt to check next: none while one is being checked, or once every receipt that may be checked has a result */
export function nextToCheck(state: SignedWritesState): number | null {
  if (state.checking !== null) return null
  const index = state.receipts.findIndex(
    (receipt, i) => state.checks[i] === null && (!waitsForReader(receipt) || state.requested.includes(i))
  )
  return index === -1 ? null : index
}

// One shared object, so a card waiting for its check keeps the same input across renders.
const CHECKING: IcpReceiptCheck = { state: 'checking' }

/** What receipt `index` shows: its result once checked, that it waits for the reader when large, otherwise that a check is under way */
export function checkAt(state: SignedWritesState, index: number): IcpReceiptCheck {
  const check = state.checks[index]
  if (check) return check
  const receipt = state.receipts[index]
  if (waitsForReader(receipt) && !state.requested.includes(index)) return { state: 'large-unchecked', argBytes: argBytesOf(receipt) }
  return CHECKING
}

/** How many loaded receipts wait for the reader to ask for their check */
function waitingCount(state: SignedWritesState): number {
  return state.receipts.filter((receipt, i) => state.checks[i] === null && waitsForReader(receipt) && !state.requested.includes(i)).length
}

/**
 * The receipts page from the API's data, or null when it is not one. Only the
 * envelope is checked here; each receipt is checked field by field in the
 * browser, so a malformed one shows as a receipt that could not be checked.
 * The two counts only add notes to the page, so one the server leaves out or
 * garbles is treated as not said rather than failing the page. So is the
 * canister id, which leaves every receipt unverified.
 */
export function readSignedWritesPage(data: unknown): SignedWritesPage | null {
  if (!data || typeof data !== 'object') return null
  const { receipts, nextCursor, skippedLines, writesConfigured, canisterId } = data as Record<string, unknown>
  if (!Array.isArray(receipts)) return null
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor === '')) return null
  return {
    receipts: receipts as IcpWriteReceipt[],
    nextCursor,
    skippedLines: typeof skippedLines === 'number' && Number.isSafeInteger(skippedLines) && skippedLines > 0 ? skippedLines : 0,
    writesConfigured: typeof writesConfigured === 'boolean' ? writesConfigured : null,
    canisterId: typeof canisterId === 'string' && canisterId !== '' ? canisterId : null,
  }
}

/** The one polite announcement for the whole list, so ten rows do not each announce themselves */
export function liveMessage(state: SignedWritesState): string {
  if (state.status !== 'ready' || state.receipts.length === 0) return ''
  if (state.checking !== null || nextToCheck(state) !== null) return SIGNED_WRITES_COPY.checking
  return SIGNED_WRITES_COPY.finished(state.checks.filter((check) => check !== null).length, waitingCount(state))
}

export const SIGNED_WRITES_COPY = {
  title: 'Signed memory writes',
  scope:
    'Whole deployment: the receipts this webapp server recorded for the memory_repo writes it signed through its ' +
    '/api/memory-repo routes (commits, deletion markers and new branches), for every agent. Nothing here links a ' +
    'write to an agent. This server keeps the list, so it may be incomplete.',
  method:
    'Each receipt is checked in your browser: the request signature, the sender’s key, that the call went to the ' +
    'memory_repo canister this server names, and the Internet Computer certificate, against the Internet Computer ' +
    'root key built into this page.',
  canister: 'memory_repo canister this server names:',
  noCanister: 'This server names no memory_repo canister, so no receipt here can be matched to it or verified.',
  limits:
    'A verified receipt shows that the principal it names signed this exact write to the memory_repo canister this ' +
    'server names, and that the Internet Computer certified the canister’s reply. It does not show which agent or ' +
    'person asked this server to write. This server stores the receipts, so it can leave some out and this list may ' +
    'be incomplete; a receipt cannot be made to verify without a write the Internet Computer accepted. Receipts exist ' +
    'only for writes made through this webapp since receipt capture was added; earlier writes and writes from the CLI ' +
    'have none. A receipt from a local replica is at most signature checked: its certificate can only be checked with ' +
    'a key that replica hands out.',
  loading: 'Loading signed memory writes…',
  loadingOlder: 'Loading older receipts…',
  loadError: 'Couldn’t load signed memory writes.',
  loadOlderError: 'Couldn’t load older signed memory writes.',
  empty:
    'No signed memory writes recorded yet. Receipts are recorded for writes made through this webapp from the time ' +
    'receipt capture was added.',
  notConfigured: 'This server has no memory_repo canister or signing identity configured, so it signs no memory writes.',
  skipped: (count: number) =>
    `${count} stored ${count === 1 ? 'line was' : 'lines were'} not readable as receipts and ${count === 1 ? 'is' : 'are'} not shown.`,
  checking: 'Checking signed memory writes…',
  finished: (count: number, waiting = 0) =>
    `Finished checking ${count} signed memory ${count === 1 ? 'write' : 'writes'}.` +
    (waiting > 0 ? ` ${waiting} large ${waiting === 1 ? 'write is' : 'writes are'} not checked yet.` : ''),
  showing: (count: number) => `Showing the ${count} most recent ${count === 1 ? 'receipt' : 'receipts'} recorded on this server.`,
  showOlder: `Show ${PAGE_SIZE} older`,
  noOlder: 'No older receipts are kept on this server.',
  checkLarge: 'Check',
  unreadablePage: 'The server sent receipts this page cannot read.',
}
