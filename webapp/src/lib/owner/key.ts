import { Ed25519KeyIdentity } from '@dfinity/identity'

/*
 * Reads the owner's key in the browser. The key is parsed here and held by the page that asked,
 * in memory only: nothing in this file stores it, sends it anywhere, or puts any part of it in
 * an error message. It reads the two Ed25519 layouts the CLI reads (src/canister/identity.ts,
 * which needs node:crypto and so cannot run in a page). Imports are packages only, so the root
 * test suite loads this file by path.
 */

/** Why a key could not be used, in words a person can act on. Never contains key material. */
export class OwnerKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerKeyError'
  }
}

const hex = (value: string): Uint8Array => Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16))

// PKCS#8 Ed25519. Version 1 is the algorithm and the 32-byte seed; version 2, which older dfx
// wrote, follows the seed with the public key. The seed is the 32 bytes after the prefix.
const V1_PREFIX = hex('302e020100300506032b657004220420')
const V2_PREFIX = hex('3053020101300506032b657004220420')
const V2_PUBLIC = hex('a123032100')
const SEED_BYTES = 32

const startsWith = (bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean =>
  prefix.every((byte, index) => bytes[at + index] === byte)

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

/** The seed in a PKCS#8 Ed25519 key, plus the public key a version 2 layout carries; null for any other layout. */
function readSeed(der: Uint8Array): { seed: Uint8Array; embeddedPublicKey?: Uint8Array } | null {
  const seedAt = V1_PREFIX.length
  if (der.length === seedAt + SEED_BYTES && startsWith(der, V1_PREFIX)) {
    return { seed: der.slice(seedAt, seedAt + SEED_BYTES) }
  }
  const publicAt = V2_PREFIX.length + SEED_BYTES + V2_PUBLIC.length
  if (
    der.length === publicAt + SEED_BYTES &&
    startsWith(der, V2_PREFIX) &&
    startsWith(der, V2_PUBLIC, V2_PREFIX.length + SEED_BYTES)
  ) {
    return { seed: der.slice(V2_PREFIX.length, V2_PREFIX.length + SEED_BYTES), embeddedPublicKey: der.slice(publicAt) }
  }
  return null
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g

/**
 * The signing identity for the PEM text a person pasted or chose as a file. Accepts the key the way
 * it is stored on one line, with spaces for line breaks, or with literal "\n" sequences.
 *
 * @throws OwnerKeyError for anything that is not an unencrypted Ed25519 private key
 */
export function parseOwnerKey(text: string): Ed25519KeyIdentity {
  const pem = !text.includes('\n') && text.includes('\\n') ? text.replace(/\\n/g, '\n') : text
  const blocks = [...pem.replace(/\r\n/g, '\n').matchAll(PEM_BLOCK)].map((match) => ({
    label: match[1] ?? '',
    body: (match[2] ?? '').replace(/\s+/g, ''),
  }))

  if (blocks.some((block) => block.label === 'ENCRYPTED PRIVATE KEY') || /Proc-Type:\s*4,ENCRYPTED/.test(pem)) {
    throw new OwnerKeyError('This key is encrypted. Use an unencrypted copy of it.')
  }
  if (blocks.some((block) => block.label === 'EC PRIVATE KEY') && !blocks.some((block) => block.label === 'PRIVATE KEY')) {
    throw new OwnerKeyError('This is not an Ed25519 key. The panel signs with Ed25519 keys only.')
  }
  const key = blocks.find((block) => block.label === 'PRIVATE KEY')
  if (!key) {
    throw new OwnerKeyError('No private key found. Use the whole PEM, from its BEGIN line to its END line.')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key.body)) {
    throw new OwnerKeyError('That key is damaged: it is not valid base64.')
  }

  const der = Uint8Array.from(atob(key.body), (character) => character.charCodeAt(0))
  const parsed = readSeed(der)
  der.fill(0)
  if (!parsed) {
    throw new OwnerKeyError('That is not an Ed25519 key in a layout the panel reads.')
  }

  const identity = Ed25519KeyIdentity.fromSecretKey(parsed.seed)
  // A version 2 key states its public key too; one that does not belong to the seed is damaged.
  if (parsed.embeddedPublicKey && !sameBytes(new Uint8Array(identity.getPublicKey().rawKey), parsed.embeddedPublicKey)) {
    throw new OwnerKeyError('That key is damaged: its public half does not match.')
  }
  return identity
}
