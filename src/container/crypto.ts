/**
 * AVENC1: the one at-rest encryption format for container snapshots AND the
 * local secret store.
 *
 * Why this exists: the repo has eleven independent AES-GCM copies (see
 * SECURITY_AUDIT_2026_08_16, "cryptographic sprawl"), and the existing
 * CanisterEncryption is string-only (about 384 MiB cap), takes its algorithm
 * from the untrusted ciphertext container and uses a static salt (audit C-9).
 * Volume tars are binary and large, so this module streams and is the single
 * shared helper; do not add another scheme next to it.
 *
 * Layout (all integers big-endian):
 *   "AVENC1\n" | u32 headerLength | header JSON | ciphertext ... | 16-byte GCM tag
 * Header: {"v":1,"alg":"aes-256-gcm","kdf":"pbkdf2-sha256","iter":N,"salt":b64(32),"iv":b64(12)}
 * The ENTIRE prefix (magic + length + header JSON) is the GCM AAD, so no
 * header byte can change without failing authentication. A fresh random salt
 * and IV are drawn per file and live in the header (audit H-2: never lose them).
 *
 * Optional context: a caller may pass a `context` string that is appended to
 * the AAD as `u32 length | UTF-8 bytes`. It is NOT stored in the file: the
 * reader must supply the very same string or authentication fails. That is what
 * lets a snapshot bind each volume file to its agent, snapshot id and volume key,
 * so a ciphertext cannot be moved to another place in a manifest that no key
 * protects. With no context the AAD is the prefix alone, byte for byte as before
 * (the secret store passes none and its files are unchanged).
 *
 * Security stance:
 *  - No header field ever selects behaviour. alg and kdf are compared with
 *    pinned constants, iterations must lie in [KDF_ITERATIONS_MIN,
 *    KDF_ITERATIONS_MAX], and all of that is checked by validateHeader() (a
 *    pure function) BEFORE any key is derived. That blocks a downgrade to a
 *    cheap KDF and a DoS through an absurd iteration count.
 *  - Streaming decryption releases plaintext before the tag is checked, which
 *    is audit C-1 in streaming form. decryptFile() therefore writes a 0600
 *    spool and only RESOLVES after the tag verified; on any failure it deletes
 *    the spool. Callers must not read the destination until the promise
 *    resolves, and should put it in a private 0700 directory because a crash
 *    mid-decrypt can leave unauthenticated plaintext behind.
 *  - A wrong passphrase and any tampering are indistinguishable by design:
 *    both throw ContainerError('INTEGRITY', 'wrong passphrase or the file was
 *    modified'). Structural header problems carry the same message and a
 *    non-secret `details.reason` for diagnostics.
 *  - The passphrase is used as its UTF-8 bytes (no Unicode normalisation) and
 *    is never placed in an error message, a log line or argv.
 */

import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes } from 'node:crypto';
import type { Hash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { ContainerError } from './types.js';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

export const AVENC_MAGIC: Buffer = Buffer.from('AVENC1\n', 'latin1');
export const AVENC_VERSION = 1 as const;
export const AVENC_ALG = 'aes-256-gcm' as const;
export const AVENC_KDF = 'pbkdf2-sha256' as const;

export const KDF_ITERATIONS_DEFAULT = 210_000;
export const KDF_ITERATIONS_MIN = 210_000;
export const KDF_ITERATIONS_MAX = 2_000_000;

export const MAX_HEADER_BYTES = 4096;
export const SALT_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const KEY_BYTES = 32;
const LENGTH_FIELD_BYTES = 4;

/** NIST SP 800-38D: one (key, IV) pair may protect at most 2^39 - 256 bits. */
export const MAX_PLAINTEXT_BYTES = 2 ** 36 - 32;
export const MIN_PASSPHRASE_CHARS = 8;
export const MAX_CONTEXT_BYTES = 64 * 1024;

const CHUNK_BYTES = 1024 * 1024;
const INTEGRITY_MESSAGE = 'wrong passphrase or the file was modified';

const pbkdf2Async = promisify(pbkdf2);

// ---------------------------------------------------------------------------
// Errors and small validators
// ---------------------------------------------------------------------------

/** The one error for wrong passphrase and for tampering. `reason` is structural, never secret. */
function integrity(reason?: string): ContainerError {
  return new ContainerError('INTEGRITY', INTEGRITY_MESSAGE, reason !== undefined ? { reason } : undefined);
}

function invalid(message: string): ContainerError {
  return new ContainerError('INVALID_INPUT', message);
}

export function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_CHARS) {
    // Never echo the value: it is the secret.
    throw invalid(`The passphrase must be a string of at least ${MIN_PASSPHRASE_CHARS} characters`);
  }
}

function contextBytes(context: string | undefined): Buffer | undefined {
  if (context === undefined) return undefined;
  const bytes = Buffer.from(context, 'utf8');
  // An empty context would authenticate as little as none while looking bound.
  if (bytes.length === 0 || bytes.length > MAX_CONTEXT_BYTES) {
    throw invalid(`The context must be between 1 and ${MAX_CONTEXT_BYTES} bytes`);
  }
  return bytes;
}

/** What GCM authenticates besides the ciphertext: the prefix, then the caller's context if there is one. */
function buildAad(prefix: Buffer, context: string | undefined): Buffer {
  const bytes = contextBytes(context);
  if (bytes === undefined) return prefix;
  const length = Buffer.alloc(LENGTH_FIELD_BYTES);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([prefix, length, bytes]);
}

function assertIterations(iterations: number): void {
  if (!Number.isSafeInteger(iterations) || iterations < KDF_ITERATIONS_MIN || iterations > KDF_ITERATIONS_MAX) {
    throw invalid(`PBKDF2 iterations must be an integer between ${KDF_ITERATIONS_MIN} and ${KDF_ITERATIONS_MAX}`);
  }
}

// ---------------------------------------------------------------------------
// Key derivation (a seam so tests can prove validation runs first)
// ---------------------------------------------------------------------------

export function deriveKey(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return pbkdf2Async(Buffer.from(passphrase, 'utf8'), salt, iterations, KEY_BYTES, 'sha256');
}

/**
 * Encrypt and decrypt call the KDF through this object. It exists so a test
 * can spy on it and assert that a hostile header is rejected BEFORE any key
 * derivation. Not for production use.
 */
export const internals = { deriveKey };

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface AvencHeader {
  v: typeof AVENC_VERSION;
  alg: typeof AVENC_ALG;
  kdf: typeof AVENC_KDF;
  iter: number;
  /** base64, 32 bytes */
  salt: string;
  /** base64, 12 bytes */
  iv: string;
}

export interface ValidatedHeader {
  iterations: number;
  salt: Buffer;
  iv: Buffer;
}

const HEADER_KEYS: readonly string[] = ['alg', 'iter', 'iv', 'kdf', 'salt', 'v'];

function decodeExactBase64(value: unknown, bytes: number, reason: string): Buffer {
  if (typeof value !== 'string') throw integrity(reason);
  const decoded = Buffer.from(value, 'base64');
  // Reject non-canonical encodings so one header has exactly one meaning.
  if (decoded.length !== bytes || decoded.toString('base64') !== value) throw integrity(reason);
  return decoded;
}

/**
 * Pure: checks a parsed header against the pinned parameters. Throws before
 * any key is derived. Unknown keys are refused (a future format bumps `v`).
 */
export function validateHeader(raw: unknown): ValidatedHeader {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw integrity('header_shape');
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== HEADER_KEYS.length || keys.some((k, i) => k !== HEADER_KEYS[i])) throw integrity('header_keys');
  if (record['v'] !== AVENC_VERSION) throw integrity('unsupported_version');
  if (record['alg'] !== AVENC_ALG) throw integrity('unsupported_algorithm');
  if (record['kdf'] !== AVENC_KDF) throw integrity('unsupported_kdf');
  const iter = record['iter'];
  if (typeof iter !== 'number' || !Number.isSafeInteger(iter) || iter < KDF_ITERATIONS_MIN || iter > KDF_ITERATIONS_MAX) {
    throw integrity('iterations_out_of_range');
  }
  return {
    iterations: iter,
    salt: decodeExactBase64(record['salt'], SALT_BYTES, 'bad_salt'),
    iv: decodeExactBase64(record['iv'], IV_BYTES, 'bad_iv'),
  };
}

function parseHeaderBytes(bytes: Buffer): ValidatedHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw integrity('header_not_json');
  }
  return validateHeader(raw);
}

/** Validate the length field read from a file or buffer. */
function checkHeaderLength(length: number): void {
  if (length === 0 || length > MAX_HEADER_BYTES) throw integrity('header_length');
}

function buildPrefix(iterations: number, salt: Buffer, iv: Buffer): Buffer {
  const header: AvencHeader = {
    v: AVENC_VERSION,
    alg: AVENC_ALG,
    kdf: AVENC_KDF,
    iter: iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(LENGTH_FIELD_BYTES);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([AVENC_MAGIC, length, json]);
}

interface SealContext {
  /** The AAD: the prefix written to the file, plus the caller's context (not written). */
  aad: Buffer;
  prefix: Buffer;
  key: Buffer;
  iv: Buffer;
}

async function newSealContext(passphrase: string, iterations: number, context: string | undefined): Promise<SealContext> {
  assertPassphrase(passphrase);
  assertIterations(iterations);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const prefix = buildPrefix(iterations, salt, iv);
  const aad = buildAad(prefix, context);
  const key = await internals.deriveKey(passphrase, salt, iterations);
  return { aad, prefix, key, iv };
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

export interface EncryptOptions {
  /** PBKDF2 iterations, within [KDF_ITERATIONS_MIN, KDF_ITERATIONS_MAX]. */
  iterations?: number;
  /** Extra GCM AAD the reader must repeat (see the file header). 1 to MAX_CONTEXT_BYTES bytes. */
  context?: string;
}

export interface DecryptOptions {
  /** The context the file was encrypted with; omit it only for a file encrypted without one. */
  context?: string;
}

/** Cancellation for the streaming file operations (buffers are in memory and finish at once). */
export interface FileOperationOptions {
  /** Aborting rejects with the signal's reason and leaves no partial file behind. */
  signal?: AbortSignal;
}

/** Encrypt a small payload (the whole thing is held in memory). */
export async function encryptBuffer(
  plaintext: Buffer | Uint8Array,
  passphrase: string,
  options: EncryptOptions = {}
): Promise<Buffer> {
  const { aad, prefix, key, iv } = await newSealContext(passphrase, options.iterations ?? KDF_ITERATIONS_DEFAULT, options.context);
  const cipher = createCipheriv(AVENC_ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([prefix, body, cipher.getAuthTag()]);
}

/** Decrypt a payload produced by encryptBuffer(). Throws INTEGRITY on any failure. */
export async function decryptBuffer(blob: Buffer | Uint8Array, passphrase: string, options: DecryptOptions = {}): Promise<Buffer> {
  assertPassphrase(passphrase);
  const context = options.context;
  contextBytes(context); // reject an unusable context before touching the data
  const data = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const fixed = AVENC_MAGIC.length + LENGTH_FIELD_BYTES;
  if (data.length < fixed + 1 + TAG_BYTES) throw integrity('too_short');
  if (!data.subarray(0, AVENC_MAGIC.length).equals(AVENC_MAGIC)) throw integrity('bad_magic');
  const headerLength = data.readUInt32BE(AVENC_MAGIC.length);
  checkHeaderLength(headerLength);
  const prefixLength = fixed + headerLength;
  if (data.length < prefixLength + TAG_BYTES) throw integrity('too_short');

  const prefix = data.subarray(0, prefixLength);
  const header = parseHeaderBytes(prefix.subarray(fixed));
  const tag = data.subarray(data.length - TAG_BYTES);
  const ciphertext = data.subarray(prefixLength, data.length - TAG_BYTES);

  const key = await internals.deriveKey(passphrase, header.salt, header.iterations);
  const decipher = createDecipheriv(AVENC_ALG, key, header.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(buildAad(prefix, context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw integrity();
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface EncryptFileResult {
  plaintextSha256: string;
  plaintextBytes: number;
  ciphertextSha256: string;
  ciphertextBytes: number;
}

export interface DecryptFileResult {
  plaintextSha256: string;
  plaintextBytes: number;
}

function tempSibling(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing useful to do; the caller is already reporting the real error
  }
}

async function fsyncPath(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stream-encrypt `src` into `dest` (0600). The ciphertext is written to a
 * hidden sibling and renamed into place only when complete, so `dest` is
 * never a partial file. Memory use is bounded by the chunk size.
 */
export async function encryptFile(
  src: string,
  dest: string,
  passphrase: string,
  options: EncryptOptions & FileOperationOptions = {}
): Promise<EncryptFileResult> {
  assertPassphrase(passphrase);
  const iterations = options.iterations ?? KDF_ITERATIONS_DEFAULT;
  assertIterations(iterations);
  if (path.resolve(src) === path.resolve(dest)) throw invalid('Refusing to encrypt a file onto itself');

  const stat = await fs.promises.stat(src);
  if (!stat.isFile()) throw invalid('The file to encrypt must be a regular file');
  if (stat.size > MAX_PLAINTEXT_BYTES) throw invalid('The file is too large for a single AES-GCM message (limit 64 GiB)');

  const { signal } = options;
  signal?.throwIfAborted();
  const { aad, prefix, key, iv } = await newSealContext(passphrase, iterations, options.context);
  const cipher = createCipheriv(AVENC_ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const plainHash: Hash = createHash('sha256');
  const cipherHash: Hash = createHash('sha256');
  let plaintextBytes = 0;
  let ciphertextBytes = 0;

  async function* sealed(): AsyncGenerator<Buffer> {
    cipherHash.update(prefix);
    ciphertextBytes += prefix.length;
    yield prefix;
    for await (const chunk of fs.createReadStream(src, { highWaterMark: CHUNK_BYTES })) {
      signal?.throwIfAborted();
      const plain = chunk as Buffer;
      plaintextBytes += plain.length;
      if (plaintextBytes > MAX_PLAINTEXT_BYTES) throw invalid('The file grew past the AES-GCM message limit while encrypting');
      plainHash.update(plain);
      const out = cipher.update(plain);
      if (out.length > 0) {
        cipherHash.update(out);
        ciphertextBytes += out.length;
        yield out;
      }
    }
    const last = cipher.final();
    if (last.length > 0) {
      cipherHash.update(last);
      ciphertextBytes += last.length;
      yield last;
    }
    const tag = cipher.getAuthTag();
    cipherHash.update(tag);
    ciphertextBytes += tag.length;
    yield tag;
  }

  const tmp = tempSibling(dest);
  try {
    // 'wx': never follow a planted symlink and never overwrite someone's file.
    await pipeline(sealed(), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    await fs.promises.chmod(tmp, 0o600);
    await fsyncPath(tmp);
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
  return {
    plaintextSha256: plainHash.digest('hex'),
    plaintextBytes,
    ciphertextSha256: cipherHash.digest('hex'),
    ciphertextBytes,
  };
}

async function readExactly(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(out, done, length - done, position + done);
    if (bytesRead === 0) throw integrity('truncated');
    done += bytesRead;
  }
  return out;
}

async function writeAll(handle: fs.promises.FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    offset += bytesWritten;
  }
}

/**
 * Stream-decrypt `src` into `dest`.
 *
 * `dest` must not exist. It is created 0600 and holds UNAUTHENTICATED plaintext
 * until the GCM tag has been verified; the returned promise resolves only
 * after that. On ANY failure `dest` is deleted. Callers must not read, hash
 * for trust, validate or extract `dest` until this promise resolves.
 */
export async function decryptFile(
  src: string,
  dest: string,
  passphrase: string,
  options: DecryptOptions & FileOperationOptions = {}
): Promise<DecryptFileResult> {
  assertPassphrase(passphrase);
  contextBytes(options.context); // reject an unusable context before touching the data
  if (path.resolve(src) === path.resolve(dest)) throw invalid('Refusing to decrypt a file onto itself');
  const { signal } = options;
  signal?.throwIfAborted();

  const input = await fs.promises.open(src, 'r');
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw invalid('The file to decrypt must be a regular file');
    const fixed = AVENC_MAGIC.length + LENGTH_FIELD_BYTES;
    if (stat.size < fixed + 1 + TAG_BYTES) throw integrity('too_short');

    const lead = await readExactly(input, fixed, 0);
    if (!lead.subarray(0, AVENC_MAGIC.length).equals(AVENC_MAGIC)) throw integrity('bad_magic');
    const headerLength = lead.readUInt32BE(AVENC_MAGIC.length);
    checkHeaderLength(headerLength);
    const prefixLength = fixed + headerLength;
    if (stat.size < prefixLength + TAG_BYTES) throw integrity('too_short');

    const headerBytes = await readExactly(input, headerLength, fixed);
    const prefix = Buffer.concat([lead, headerBytes]);
    const header = parseHeaderBytes(headerBytes);
    const tag = await readExactly(input, TAG_BYTES, stat.size - TAG_BYTES);

    const key = await internals.deriveKey(passphrase, header.salt, header.iterations);
    const decipher = createDecipheriv(AVENC_ALG, key, header.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(prefix, options.context));
    decipher.setAuthTag(tag);
    signal?.throwIfAborted();

    let out: fs.promises.FileHandle;
    try {
      out = await fs.promises.open(dest, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw invalid('The decryption destination already exists');
      throw err;
    }
    const plainHash = createHash('sha256');
    let plaintextBytes = 0;
    try {
      await out.chmod(0o600);
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const end = stat.size - TAG_BYTES;
      let position = prefixLength;
      while (position < end) {
        signal?.throwIfAborted();
        const want = Math.min(CHUNK_BYTES, end - position);
        const { bytesRead } = await input.read(buffer, 0, want, position);
        if (bytesRead === 0) throw integrity('truncated');
        position += bytesRead;
        const plain = decipher.update(buffer.subarray(0, bytesRead));
        if (plain.length > 0) {
          plainHash.update(plain);
          plaintextBytes += plain.length;
          await writeAll(out, plain);
        }
      }
      try {
        decipher.final();
      } catch {
        throw integrity();
      }
      await out.sync();
      await out.close();
    } catch (err) {
      await out.close().catch(() => undefined);
      removeQuietly(dest);
      throw err;
    }
    return { plaintextSha256: plainHash.digest('hex'), plaintextBytes };
  } finally {
    await input.close().catch(() => undefined);
  }
}
