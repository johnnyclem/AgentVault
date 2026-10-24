import type { ArweaveReceipt } from '@/lib/types'

/*
 * Checks one Arweave receipt from the browser against a public gateway and
 * reports what that check found. 'confirmed' needs two things to pass: the
 * gateway reports the transaction mined with at least one confirmation, and
 * the SHA-256 of the bytes it serves equals the checksum the server recorded
 * at upload. Every other outcome, any thrown error included, is one of the
 * other states, so nothing that goes wrong can read as confirmed.
 *
 * The check trusts the gateway: it does not verify the transaction signature
 * or data root itself, which is why the page names the gateway it asked.
 * fetch and SubtleCrypto are passed in, and imports stay type-only, so the
 * root test suite runs this file unchanged under node.
 */

export const ARWEAVE_GATEWAY = 'https://arweave.net'
export const ARWEAVE_GATEWAY_HOST = new URL(ARWEAVE_GATEWAY).host

/** Deployment receipts are a few kilobytes; anything past this is not downloaded. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** How long the whole check may take before it stops waiting for the gateway. */
export const DEFAULT_TIMEOUT_MS = 20_000

export type ReceiptCheck =
  | { state: 'checking' }
  | { state: 'confirmed'; confirmations: number; blockHeight: number; blockHash: string }
  | { state: 'pending' }
  | { state: 'not-found' }
  | { state: 'size-mismatch'; expected: number; actual: number }
  | { state: 'content-mismatch'; expected: string; actual: string }
  | { state: 'too-large'; maxBytes: number }
  /** retryable is false where asking again cannot change the answer: a malformed receipt, or no WebCrypto */
  | { state: 'check-failed'; reason: string; retryable: boolean }

/** Every state but 'checking', which only the page shows while a check runs. */
export type ReceiptCheckResult = Exclude<ReceiptCheck, { state: 'checking' }>

export interface ReceiptCheckOptions {
  fetch: typeof fetch
  /** Undefined where the browser offers no WebCrypto, as on a plain-http origin other than localhost */
  subtle: SubtleCrypto | undefined
  gateway?: string
  maxBytes?: number
  signal?: AbortSignal
  timeoutMs?: number
}

interface MinedStatus {
  blockHeight: number
  blockHash: string
  confirmations: number
}

const TX_ID = /^[A-Za-z0-9_-]{43}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const BLOCK_HASH = /^[A-Za-z0-9_-]{64}$/

/**
 * Runs the check, giving up after timeoutMs: a gateway that never answers
 * would otherwise leave the check, and the page, waiting forever. The time
 * limit and the caller's signal both abort the requests; the race also ends
 * the wait for a fetch, body or digest that ignores the abort.
 */
export async function checkReceipt(
  receipt: ArweaveReceipt,
  options: ReceiptCheckOptions
): Promise<ReceiptCheckResult> {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const controller = new AbortController()
  const abort = () => controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined

  const timedOut = new Promise<ReceiptCheckResult>((resolve) => {
    timer = setTimeout(() => {
      // Settled before aborting, so the abort's own error cannot win the race.
      resolve(failed(`The gateway did not answer within ${timeoutMs / 1000} seconds.`))
      controller.abort()
    }, timeoutMs)
  })

  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })

  try {
    return await Promise.race([runCheck(receipt, options, controller.signal), timedOut])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function runCheck(
  receipt: ArweaveReceipt,
  options: ReceiptCheckOptions,
  signal: AbortSignal
): Promise<ReceiptCheckResult> {
  // fetch is called as a plain function, not as options.fetch(...): a
  // browser's window.fetch throws "Illegal invocation" when called on another object.
  const { fetch: get, subtle, gateway = ARWEAVE_GATEWAY, maxBytes = DEFAULT_MAX_BYTES } = options

  try {
    // Asking again cannot fix a malformed receipt or a browser without WebCrypto.
    if (!isTxId(receipt.txId)) return failed('The recorded transaction id is not a valid Arweave id.', false)
    if (!isSha256Hex(receipt.checksum)) return failed('The recorded checksum is not a SHA-256 hex digest.', false)
    if (!isCount(receipt.sizeBytes)) return failed('The recorded size is not a byte count.', false)
    if (!subtle) {
      return failed(
        'This browser offers no WebCrypto on this page, so the content cannot be hashed. Open the dashboard over HTTPS or on localhost.',
        false
      )
    }

    const base = gateway.replace(/\/+$/, '')

    // The gateway caches status for a couple of minutes; a retry should ask again.
    const statusResponse = await get(`${base}/tx/${receipt.txId}/status`, { signal, cache: 'no-store' })
    if (statusResponse.status === 202) return { state: 'pending' }
    if (statusResponse.status === 404) return { state: 'not-found' }
    if (statusResponse.status !== 200) {
      return failed(`The gateway answered the status request with HTTP ${statusResponse.status}.`)
    }

    const status = parseStatus(await statusResponse.text())
    if (!status) return failed('The gateway sent a transaction status this page cannot read.')
    if (status.confirmations < 1) return { state: 'pending' }

    if (receipt.sizeBytes > maxBytes) return { state: 'too-large', maxBytes }

    const rawResponse = await get(`${base}/raw/${receipt.txId}`, { signal })
    if (rawResponse.status !== 200) {
      return failed(`The gateway answered the content request with HTTP ${rawResponse.status}.`)
    }

    const bytes = await readAtMost(rawResponse, maxBytes)
    if (!bytes) return { state: 'too-large', maxBytes }
    if (bytes.byteLength !== receipt.sizeBytes) {
      return { state: 'size-mismatch', expected: receipt.sizeBytes, actual: bytes.byteLength }
    }

    const actual = toHex(await subtle.digest('SHA-256', bytes))
    if (actual !== receipt.checksum) return { state: 'content-mismatch', expected: receipt.checksum, actual }

    return {
      state: 'confirmed',
      confirmations: status.confirmations,
      blockHeight: status.blockHeight,
      blockHash: status.blockHash,
    }
  } catch (error) {
    return failed(`The check did not finish: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function failed(reason: string, retryable = true): ReceiptCheckResult {
  return { state: 'check-failed', reason, retryable }
}

/** An Arweave transaction id: 43 base64url characters (a 32-byte hash). */
export function isTxId(value: unknown): value is string {
  return typeof value === 'string' && TX_ID.test(value)
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The gateway's 200 body: {block_height, block_indep_hash, number_of_confirmations}. */
function parseStatus(text: string): MinedStatus | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null

  const { block_height, block_indep_hash, number_of_confirmations } = body as Record<string, unknown>
  if (!isCount(block_height) || !isCount(number_of_confirmations)) return null
  if (typeof block_indep_hash !== 'string' || !BLOCK_HASH.test(block_indep_hash)) return null

  return { blockHeight: block_height, blockHash: block_indep_hash, confirmations: number_of_confirmations }
}

/**
 * The response body, or null once it passes maxBytes. Reading stops at the
 * limit, so a gateway that sends more than the receipt claims cannot make
 * the browser download it all.
 */
async function readAtMost(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
