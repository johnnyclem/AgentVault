import {
  AgentError,
  CborDecodeErrorCode,
  Certificate,
  CertificateNotAuthorizedErrorCode,
  CertificateVerificationErrorCode,
  IC_REQUEST_DOMAIN_SEPARATOR,
  IC_ROOT_KEY,
  LookupPathStatus,
  TrustError,
  lookupResultToBuffer,
} from '@dfinity/agent'
import { IDL } from '@dfinity/candid'
import { Principal } from '@dfinity/principal'
import { ed25519 } from '@noble/curves/ed25519'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { IcpWriteReceipt } from '@/lib/types'
import { hexToBytes, isRecord, readReceipt, type DecodedWrite } from './icp-receipt-read'

export { MAX_ARG_BYTES, MAX_CERT_BYTES, readReceipt } from './icp-receipt-read'
export type { DecodedWrite, ReadReceipt, WriteMethod } from './icp-receipt-read'

/*
 * Checks one signed memory_repo write receipt in the browser, from the bytes
 * the receipt carries and the memory_repo canister id the server names, and
 * nothing else: no network, no clock, and no verdict from the server.
 * 'verified' needs every one of these to pass:
 *   1. the request signature verifies over '\x0Aic-request' || request id,
 *      where the request id is recomputed here from the recorded call;
 *   2. the sender is the self-authenticating principal of the signing key;
 *   3. the call went to the canister the server names as its memory_repo;
 *   4. the certificate verifies against the IC mainnet root key built into
 *      this page (through a subnet delegation whose canister ranges include
 *      that canister);
 *   5. that certificate records this request id as replied;
 *   6. the certified reply decodes to { ok } equal to the result the server
 *      recorded.
 * The only `state: 'verified'` is the last return; every early return is
 * another state, and any exception becomes 'check-failed', so nothing that
 * goes wrong can read as verified. Error text from the libraries never leaves
 * this file except through the console: results carry only fixed reasons.
 * Imports other than packages and icp-receipt-read are type-only, so the root
 * test suite runs this file unchanged under node. Pages run it in a worker
 * (icp-receipt-worker.ts), so its curve code stays out of every other page.
 */

export type KeyType = 'ed25519' | 'secp256k1'

export type NotRepliedStatus =
  | 'rejected'
  | 'received'
  | 'processing'
  | 'done'
  /** The certificate records the call as replied but leaves the reply out */
  | 'replied-without-reply'
  | 'absent'
  | 'unreadable'

/** Why a certificate did not verify, as a fixed reason the page words itself; library error text never reaches the page. */
export type CertificateFailure = 'not-cbor' | 'bad-signature' | 'canister-not-covered' | 'malformed'

/** The certified reply decoded as the method's result; null when it is not one. */
export type CertifiedReply = { ok: string } | { err: string } | null

export type IcpReceiptCheck =
  /** Page only: the check has not finished */
  | { state: 'checking' }
  /** Page only: a write too large to check without being asked; argBytes is the size of its signed argument */
  | { state: 'large-unchecked'; argBytes: number }
  | { state: 'verified'; keyType: KeyType; write: DecodedWrite; certifiedAt: Date; subnetId: string | null }
  /** The signature, sender and canister passed, but the write went to a local replica, so nothing anchors it to the IC */
  | { state: 'not-anchored'; keyType: KeyType; write: DecodedWrite }
  /** The signature and sender passed, but the call went to a canister other than the memory_repo the server names */
  | { state: 'other-canister'; keyType: KeyType; write: DecodedWrite; expected: string }
  /** The signature and sender passed, but the server named no memory_repo canister to hold the call to */
  | { state: 'canister-unknown'; keyType: KeyType; write: DecodedWrite }
  | { state: 'signature-invalid'; keyType: KeyType }
  | { state: 'principal-mismatch'; recorded: string; derived: string }
  | { state: 'certificate-invalid'; reason: CertificateFailure }
  | { state: 'not-replied'; status: NotRepliedStatus; rejectCode?: number; rejectMessage?: string }
  | { state: 'reply-mismatch'; recorded: string; certified: CertifiedReply }
  | { state: 'unsupported-key-type' }
  /** signatureChecked: the signature and sender passed before the check stopped */
  | { state: 'check-failed'; reason: string; signatureChecked?: true }

/** Every state the checker returns: all but the two the page shows before or instead of a check. */
export type IcpReceiptCheckResult = Exclude<IcpReceiptCheck, { state: 'checking' } | { state: 'large-unchecked' }>

export interface IcpReceiptCheckOptions {
  /**
   * The DER root key certificates must chain to. Pages pass nothing and get
   * the IC mainnet key compiled into this file; tests pass a key they minted.
   * Never pass a key that came from the server or a receipt: the server could
   * then certify its own receipts.
   */
  rootKey?: Uint8Array
}

export const IC_MAINNET_ROOT_KEY: Uint8Array = hexToBytes(IC_ROOT_KEY)

// DER SubjectPublicKeyInfo prefixes for the two key types an ICP PEM identity holds.
const ED25519_SPKI_PREFIX = hexToBytes('302a300506032b6570032100') // + 32-byte key
const SECP256K1_SPKI_PREFIX = hexToBytes('3056301006072a8648ce3d020106052b8104000a034200') // + 65-byte uncompressed point

const TEXT_RESULT = IDL.Variant({ ok: IDL.Text, err: IDL.Text })

const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * @param expectedCanisterId The memory_repo canister id the server names
 *   (GET /api/memory-repo/receipts' canisterId). A receipt for any other
 *   canister, or any receipt when this is null, is never verified.
 */
export async function checkIcpReceipt(
  receipt: IcpWriteReceipt,
  expectedCanisterId: string | null,
  options: IcpReceiptCheckOptions = {}
): Promise<IcpReceiptCheckResult> {
  const rootKey = options.rootKey ?? IC_MAINNET_ROOT_KEY
  try {
    const read = readReceipt(receipt)
    if ('error' in read) return failed(read.error)
    const { rid, write, network, senderPubkey, senderSig, certificate } = read

    // 1. Request signature
    const key = keyOf(senderPubkey)
    if (!key) return { state: 'unsupported-key-type' }
    if (!verifySignature(key, senderSig, concat(IC_REQUEST_DOMAIN_SEPARATOR, rid))) {
      return { state: 'signature-invalid', keyType: key.type }
    }

    // 2. Sender principal
    const derived = Principal.selfAuthenticating(senderPubkey).toText()
    if (derived !== write.sender) return { state: 'principal-mismatch', recorded: write.sender, derived }

    // Looked at only now, so changed argument bytes read as a bad signature above, not as unreadable.
    if (!write.argReadable) {
      return { ...failed(`The signed argument is not a ${write.method} call this page can read.`), signatureChecked: true }
    }

    // 3. The canister the server names as its memory_repo, so a genuine write to any other canister is not passed off as one
    const expected = namedCanister(expectedCanisterId)
    if (!expected) return { state: 'canister-unknown', keyType: key.type, write }
    if (write.canisterId !== expected.toText()) {
      return { state: 'other-canister', keyType: key.type, write, expected: expected.toText() }
    }

    // A local replica's certificate can only be checked with a key that replica
    // hands out, which proves nothing to anyone else, so it is never checked.
    if (network === 'local') return { state: 'not-anchored', keyType: key.type, write }

    // 4. Certificate, against the trusted root key only, for the memory_repo canister
    let cert: Certificate
    try {
      cert = await Certificate.create({
        certificate,
        rootKey,
        canisterId: expected,
        // Receipts are checked long after the write; the default five-minute freshness would reject every one.
        disableTimeVerification: true,
      })
    } catch (error) {
      console.debug('Signed memory write receipt: the certificate did not verify.', error)
      return { state: 'certificate-invalid', reason: certificateFailureOf(error) }
    }

    // 5. The status of this request id, recomputed above, never taken from the receipt
    const path = ['request_status', rid]
    const status = cert.lookup_path([...path, 'status'])
    if (status.status !== LookupPathStatus.Found) {
      return { state: 'not-replied', status: status.status === LookupPathStatus.Absent ? 'absent' : 'unreadable' }
    }
    const statusText = textOf(lookupResultToBuffer(status))
    if (statusText === 'rejected') {
      const code = lookupResultToBuffer(cert.lookup_path([...path, 'reject_code']))
      const message = textOf(lookupResultToBuffer(cert.lookup_path([...path, 'reject_message'])))
      return {
        state: 'not-replied',
        status: 'rejected',
        ...(code ? { rejectCode: Number(lebDecode(code)) } : {}),
        ...(message !== null ? { rejectMessage: message } : {}),
      }
    }
    if (statusText !== 'replied') {
      const pending: NotRepliedStatus[] = ['received', 'processing', 'done']
      return { state: 'not-replied', status: pending.find((known) => known === statusText) ?? 'unreadable' }
    }

    // 6. The certified reply is the result the server recorded
    const reply = lookupResultToBuffer(cert.lookup_path([...path, 'reply']))
    // Replied, but the certificate leaves the reply out: it shows only that the call finished.
    if (!reply) return { state: 'not-replied', status: 'replied-without-reply' }
    const certified = decodeTextResult(reply)
    if (!certified || !('ok' in certified) || certified.ok !== write.recordedResult) {
      return { state: 'reply-mismatch', recorded: write.recordedResult, certified }
    }

    const time = lookupResultToBuffer(cert.lookup_path(['time']))
    if (!time) return { state: 'certificate-invalid', reason: 'malformed' }
    const delegation = cert.cert.delegation

    return {
      state: 'verified',
      keyType: key.type,
      write,
      certifiedAt: new Date(Number(lebDecode(time) / 1_000_000n)),
      subnetId: delegation ? Principal.fromUint8Array(new Uint8Array(delegation.subnet_id)).toText() : null,
    }
  } catch (error) {
    console.debug('Signed memory write receipt: the check did not finish.', error)
    return failed('The check did not finish.')
  }
}

/** The canister the server names; null when it names none, or names something that is not a principal. */
function namedCanister(text: string | null): Principal | null {
  if (typeof text !== 'string' || text === '') return null
  try {
    return Principal.fromText(text)
  } catch {
    return null
  }
}

function certificateFailureOf(error: unknown): CertificateFailure {
  if (!(error instanceof AgentError)) return 'malformed'
  if (error.hasCode(CborDecodeErrorCode)) return 'not-cbor'
  if (error.hasCode(CertificateNotAuthorizedErrorCode)) return 'canister-not-covered'
  // Raised as a TrustError only for a signature that does not verify; a certificate without a time raises it as a ProtocolError.
  if (error instanceof TrustError && error.hasCode(CertificateVerificationErrorCode)) return 'bad-signature'
  return 'malformed'
}

interface PublicKey {
  type: KeyType
  raw: Uint8Array
}

function keyOf(der: Uint8Array): PublicKey | null {
  if (der.length === ED25519_SPKI_PREFIX.length + 32 && startsWith(der, ED25519_SPKI_PREFIX)) {
    return { type: 'ed25519', raw: der.slice(ED25519_SPKI_PREFIX.length) }
  }
  if (der.length === SECP256K1_SPKI_PREFIX.length + 65 && startsWith(der, SECP256K1_SPKI_PREFIX)) {
    return { type: 'secp256k1', raw: der.slice(SECP256K1_SPKI_PREFIX.length) }
  }
  return null
}

function verifySignature(key: PublicKey, sig: Uint8Array, message: Uint8Array): boolean {
  if (sig.length !== 64) return false
  try {
    // Ed25519 with RFC 8032 strict decoding, so it accepts no more than the IC does.
    if (key.type === 'ed25519') return ed25519.verify(sig, message, key.raw, { zip215: false })
    // ECDSA over SHA-256 of the message, 64-byte r || s, low S only, as agent-js signs.
    return secp256k1.verify(sig, message, key.raw, { prehash: true, lowS: true, format: 'compact' })
  } catch {
    return false
  }
}

function decodeTextResult(bytes: Uint8Array): CertifiedReply {
  try {
    const decoded = IDL.decode([TEXT_RESULT], bytes)
    if (decoded.length !== 1 || !isRecord(decoded[0])) return null
    const { ok, err } = decoded[0]
    if (typeof ok === 'string') return { ok }
    if (typeof err === 'string') return { err }
    return null
  } catch {
    return null
  }
}

function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

/** Unsigned LEB128, as the certificate encodes its time and reject codes. */
function lebDecode(bytes: Uint8Array): bigint {
  let value = 0n
  let shift = 0n
  for (const byte of bytes) {
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
    shift += 7n
  }
  throw new Error('The certificate holds a number that does not end.')
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, i) => bytes[i] === byte)
}

function failed(reason: string): Extract<IcpReceiptCheckResult, { state: 'check-failed' }> {
  return { state: 'check-failed', reason }
}
