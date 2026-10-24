import { requestIdOf } from '@dfinity/agent'
import { IDL } from '@dfinity/candid'
import { Principal } from '@dfinity/principal'
import type { IcpWriteReceipt } from '@/lib/types'

/*
 * Reads one signed memory_repo write receipt: validates its fields, rebuilds
 * the request id from the signed call, and decodes the call's argument. It
 * checks nothing; icp-receipt-check.ts does that. It is kept apart from the
 * checker so the page can label a row from the signed request without
 * loading the signature and certificate code, which runs in a worker
 * (icp-receipt-worker.ts). Imports other than packages are type-only, so the
 * root test suite runs this file unchanged under node.
 */

export type WriteMethod = 'commitToBranch' | 'createBranchFrom'

/**
 * The call, decoded in the browser from the receipt's signed request. It is
 * only as trustworthy as the check result it comes with.
 */
export interface DecodedWrite {
  /** A commit, a deletion marker (the tombstone route's commit), or a new branch */
  kind: 'commit' | 'tombstone' | 'branch'
  method: WriteMethod
  canisterId: string
  sender: string
  /** Hex request id, recomputed here from the signed fields */
  requestId: string
  /** The reply the server recorded: the commit id, or createBranchFrom's reply text */
  recordedResult: string
  /** False when the argument is not the method's Candid; the fields below are then absent */
  argReadable: boolean
  branch?: string
  /** commitToBranch only */
  message?: string
  /** commitToBranch only */
  tags?: string[]
  /** commitToBranch only: the diff's size in UTF-8 bytes */
  diffBytes?: number
  /** commitToBranch only: how many entries the diff names */
  entryCount?: number
  /** commitToBranch only: the first keys the diff names, each cut to a readable length */
  entryKeys?: string[]
  /** createBranchFrom only */
  baseBranch?: string
}

export interface ReadReceipt {
  /** The request id of the call content as agent-js signs it, rebuilt from validated fields only */
  rid: Uint8Array
  write: DecodedWrite
  network: 'ic' | 'local'
  senderPubkey: Uint8Array
  senderSig: Uint8Array
  certificate: Uint8Array
}

/** The IC's ingress limit is 2 MiB, so a larger argument cannot be a real call. */
export const MAX_ARG_BYTES = 2 * 1024 * 1024

/** Mainnet certificates with a subnet delegation carry canister ranges; this leaves room for them. */
export const MAX_CERT_BYTES = 256 * 1024

/** The receipt version this page reads (RECEIPT_VERSION in src/canister/memory-repo-receipts-types.ts). */
const READABLE_VERSION: IcpWriteReceipt['version'] = 1

/** The fields of a version 1 receipt's request; another field would change the request id. */
const REQUEST_FIELDS = new Set(['canisterId', 'methodName', 'arg', 'sender', 'ingressExpiry', 'nonce'])

const COMMIT_ARGS = [IDL.Text, IDL.Text, IDL.Text, IDL.Vec(IDL.Text)]
const BRANCH_FROM_ARGS = [IDL.Text, IDL.Text]

const MAX_ENTRY_KEYS = 20
const MAX_KEY_CHARS = 200

/**
 * The receipt's fields, validated and decoded, or why they cannot be read.
 * The page uses this to label a row before its check finishes; until that
 * check says otherwise, what it returns is only what the server recorded.
 */
export function readReceipt(receipt: unknown): ReadReceipt | { error: string } {
  if (!isRecord(receipt)) return { error: 'This is not a receipt this page can read.' }
  if (receipt.version !== READABLE_VERSION) return { error: 'This page cannot read this version of receipt.' }
  const { network, request, result } = receipt
  if (network !== 'ic' && network !== 'local') return { error: 'The receipt does not say which network the write went to.' }
  if (!isRecord(request)) return { error: 'The receipt has no signed request.' }
  if (Object.keys(request).some((field) => !REQUEST_FIELDS.has(field))) {
    return { error: 'The receipt’s request has a field this page does not know, so its request id cannot be rebuilt.' }
  }

  const canister = principalOf(request.canisterId)
  const sender = principalOf(request.sender)
  if (!canister || !sender) return { error: 'The receipt names a canister or sender that is not a principal.' }
  const method = request.methodName
  if (method !== 'commitToBranch' && method !== 'createBranchFrom') {
    return { error: 'This page reads receipts for commitToBranch and createBranchFrom calls only.' }
  }
  const arg = hexOf(request.arg, MAX_ARG_BYTES)
  if (!arg) return { error: 'The receipt’s argument is not hex bytes this page can read.' }
  if (typeof request.ingressExpiry !== 'string' || !/^[0-9]{1,20}$/.test(request.ingressExpiry)) {
    return { error: 'The receipt has no usable ingress expiry.' }
  }
  const nonce = request.nonce === null ? null : hexOf(request.nonce, 64)
  if (request.nonce !== null && !nonce) return { error: 'The receipt’s nonce is not hex bytes this page can read.' }

  const senderPubkey = hexOf(receipt.senderPubkey, 1024)
  const senderSig = hexOf(receipt.senderSig, 1024)
  if (!senderPubkey || !senderSig) return { error: 'The receipt’s public key or signature is not hex bytes this page can read.' }
  if (typeof receipt.certificate === 'string' && receipt.certificate.length > MAX_CERT_BYTES * 2) {
    return { error: `The receipt’s certificate is larger than the ${MAX_CERT_BYTES / 1024} KiB this page checks.` }
  }
  const certificate = hexOf(receipt.certificate, MAX_CERT_BYTES)
  if (!certificate) return { error: 'The receipt’s certificate is not hex bytes this page can read.' }
  if (!isRecord(result) || typeof result.ok !== 'string') return { error: 'The receipt has no recorded result.' }

  // Exactly the fields agent-js signs for an update call; nothing else from the receipt reaches the hash.
  const content: Record<string, unknown> = {
    request_type: 'call',
    canister_id: canister,
    method_name: method,
    arg,
    sender,
    ingress_expiry: BigInt(request.ingressExpiry),
    ...(nonce === null ? {} : { nonce }),
  }

  const rid = requestIdOf(content)
  return {
    rid,
    network,
    senderPubkey,
    senderSig,
    certificate,
    write: {
      ...decodeArg(method, arg),
      method,
      canisterId: canister.toText(),
      sender: sender.toText(),
      requestId: toHex(rid),
      recordedResult: result.ok,
    },
  }
}

/** The size of a receipt's signed argument in bytes, from its hex alone; 0 when it has none to measure. */
export function argBytesOf(receipt: unknown): number {
  if (!isRecord(receipt) || !isRecord(receipt.request)) return 0
  const { arg } = receipt.request
  return typeof arg === 'string' ? Math.floor(arg.length / 2) : 0
}

type ArgFields = Omit<DecodedWrite, 'method' | 'canisterId' | 'sender' | 'requestId' | 'recordedResult'>

function decodeArg(method: WriteMethod, arg: Uint8Array): ArgFields {
  try {
    if (method === 'createBranchFrom') {
      const [branch, baseBranch] = IDL.decode(BRANCH_FROM_ARGS, arg) as [string, string]
      return { kind: 'branch', argReadable: true, branch, baseBranch }
    }
    const [branch, message, diff, tags] = IDL.decode(COMMIT_ARGS, arg) as [string, string, string, string[]]
    const diffFields = readDiff(diff)
    return {
      kind: diffFields.deleted ? 'tombstone' : 'commit',
      argReadable: true,
      branch,
      message,
      tags,
      diffBytes: new TextEncoder().encode(diff).byteLength,
      ...(diffFields.keys ? { entryCount: diffFields.keys.length, entryKeys: shortKeys(diffFields.keys) } : {}),
    }
  } catch {
    return { kind: method === 'createBranchFrom' ? 'branch' : 'commit', argReadable: false }
  }
}

/**
 * The keys a diff names: the commits route signs a JSON array of {key, data,
 * tags}, the tombstone route a single {deleted: key}. Anything else names no
 * keys, which is shown as such rather than guessed at.
 */
function readDiff(diff: string): { keys?: string[]; deleted?: true } {
  let value: unknown
  try {
    value = JSON.parse(diff)
  } catch {
    return {}
  }
  if (Array.isArray(value)) {
    const keys = value.map((entry) => (isRecord(entry) ? entry.key : undefined))
    return keys.every((key): key is string => typeof key === 'string') ? { keys } : {}
  }
  if (isRecord(value) && typeof value.deleted === 'string' && Object.keys(value).length === 1) {
    return { keys: [value.deleted], deleted: true }
  }
  return {}
}

function shortKeys(keys: string[]): string[] {
  return keys.slice(0, MAX_ENTRY_KEYS).map((key) => (key.length > MAX_KEY_CHARS ? `${key.slice(0, MAX_KEY_CHARS)}…` : key))
}

/** A principal whose text is exactly its canonical form, so two spellings cannot name one principal. */
export function principalOf(text: unknown): Principal | null {
  if (typeof text !== 'string') return null
  try {
    const principal = Principal.fromText(text)
    return principal.toText() === text ? principal : null
  } catch {
    return null
  }
}

/** Lowercase hex of at most maxBytes bytes, as the capture code writes it; anything else is null. */
function hexOf(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length % 2 !== 0 || value.length > maxBytes * 2) return null
  if (!/^[0-9a-f]*$/.test(value)) return null
  return hexToBytes(value)
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
