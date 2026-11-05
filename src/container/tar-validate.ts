/**
 * Streaming tar validator: decide whether an archive is safe to hand to
 * `tar -x` inside the restore helper, WITHOUT extracting anything.
 *
 * Why this exists: a snapshot restore feeds attacker-influenced bytes (a
 * snapshot file from elsewhere) to an extractor that runs as root in the
 * helper container. tar creates entries in archive order, so the classic
 * write-through-symlink attack (a symlink entry, then a file whose path goes
 * through it) cannot be caught by scanning the result: the check has to walk
 * the headers first. There is no tar library in this repo and none may be
 * added, so this parses ustar, GNU long names ('L', 'K') and pax ('x', 'g')
 * headers itself. Only headers are read; file data is skipped by seeking, so
 * a 64 GiB archive costs a few MB of reads.
 *
 * Security stance:
 *  - Parser differentials are the real enemy. BusyBox tar (the extractor)
 *    and GNU tar disagree about several edge cases, verified on busybox:1.37:
 *    it applies the ustar prefix even to GNU-magic headers; it ignores a pax
 *    `size` record; it does not skip data after a directory/link header that
 *    declares a size; it continues past a lone zero block; and when both a GNU
 *    'L' name and a pax `path` precede an entry, the LATER one wins. Anything
 *    that a different parser could read differently is REJECTED rather than
 *    interpreted, so the bytes that were validated are the bytes that are
 *    extracted.
 *  - Allowed entries: regular file, directory, symlink, hardlink. Everything
 *    else (devices, FIFOs, sparse, multi-volume, ...) is rejected.
 *  - Names are handled as bytes (latin1 strings) so two names are equal only
 *    if their bytes are equal; they are decoded as UTF-8 only for messages.
 *  - Known limitation: a symlink whose target is lexically inside the root
 *    but passes through a symlink that appears LATER in the archive is not
 *    detected as an escape. It cannot be written through (no entry may pass
 *    through an earlier symlink, and '..' components are rejected), so it can
 *    only matter to a process that later follows it inside the container.
 */

import * as fs from 'node:fs';
import { ContainerError } from './types.js';

export interface TarPolicy {
  /** Real entries (extended headers do not count). Default 200000. */
  maxEntries: number;
  /** Sum of regular-file sizes. Default 64 GiB. */
  maxBytes: number;
  /** Longest accepted entry or link name in bytes. Default 4096. */
  maxNameBytes: number;
  /** Cap on memory spent remembering names. Default 128 MiB. */
  maxTrackedNameBytes: number;
}

export const DEFAULT_TAR_POLICY: Readonly<TarPolicy> = {
  maxEntries: 200_000,
  maxBytes: 64 * 1024 ** 3,
  maxNameBytes: 4096,
  maxTrackedNameBytes: 128 * 1024 * 1024,
};

export interface TarSummary {
  /** Real entries: files + directories + symlinks + hardlinks. */
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  hardlinks: number;
  /** Sum of regular-file sizes in bytes. */
  totalBytes: number;
}

const BLOCK = 512;
const WINDOW_BYTES = 256 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_PAX_BYTES = 1024 * 1024;
const MAX_DISPLAY_CHARS = 120;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

type Kind = 'file' | 'dir' | 'symlink' | 'hardlink';
type Magic = 'posix' | 'gnu' | 'v7';

interface Pax {
  path?: string;
  linkpath?: string;
  size?: number;
}

interface Pending {
  longName?: string;
  longLink?: string;
  pax?: Pax;
}

interface RawHeader {
  /** Header name field with the ustar prefix applied (latin1). */
  name: string;
  link: string;
  mode: number;
  size: number;
  type: string;
  magic: Magic;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function show(binary: string): string {
  const text = Buffer.from(binary, 'latin1').toString('utf8');
  return JSON.stringify(text.length > MAX_DISPLAY_CHARS ? `${text.slice(0, MAX_DISPLAY_CHARS)}...` : text);
}

function fail(reason: string, entry?: string): never {
  const where = entry !== undefined ? ` entry ${show(entry)}` : '';
  throw new ContainerError('INTEGRITY', `Unsafe tar archive${where}: ${reason}`, {
    reason,
    ...(entry !== undefined ? { entry: show(entry) } : {}),
  });
}

function describeType(type: string): string {
  const known: Record<string, string> = {
    '3': 'character device',
    '4': 'block device',
    '6': 'FIFO',
    '7': 'contiguous file',
    S: 'sparse file',
    D: 'GNU directory dump',
    V: 'volume label',
    M: 'multi-volume continuation',
    N: 'old GNU long name',
    X: 'Solaris extended header',
  };
  return known[type] ?? `type 0x${type.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Header field parsing
// ---------------------------------------------------------------------------

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Octal ASCII or GNU base-256. Returns null for an all-blank field. */
function parseNumber(field: Buffer, what: string): number | null {
  const first = field[0] ?? 0;
  if ((first & 0x80) !== 0) {
    if (first === 0xff) fail(`negative number in the ${what} field`);
    let value = BigInt(first & 0x7f);
    for (let i = 1; i < field.length; i += 1) value = value * 256n + BigInt(field[i] ?? 0);
    if (value > MAX_SAFE) fail(`the ${what} field is too large`);
    return Number(value);
  }
  let i = 0;
  while (i < field.length && field[i] === 0x20) i += 1;
  let value = 0;
  let digits = 0;
  while (i < field.length && (field[i] ?? 0) >= 0x30 && (field[i] ?? 0) <= 0x37) {
    value = value * 8 + ((field[i] ?? 0) - 0x30);
    digits += 1;
    i += 1;
  }
  for (; i < field.length; i += 1) {
    if (field[i] !== 0 && field[i] !== 0x20) fail(`malformed number in the ${what} field`);
  }
  if (digits === 0) return null;
  if (!Number.isSafeInteger(value)) fail(`the ${what} field is too large`);
  return value;
}

/** NUL-terminated field. Bytes after the first NUL must be NUL (no hidden payload). */
function cString(block: Buffer, offset: number, length: number, what: string): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  if (end === -1) return field.toString('latin1');
  for (let i = end; i < field.length; i += 1) {
    if (field[i] !== 0) fail(`non-zero bytes after the terminator in the ${what} field`);
  }
  return field.subarray(0, end).toString('latin1');
}

function verifyChecksum(block: Buffer): void {
  const stored = parseNumber(block.subarray(148, 156), 'checksum');
  if (stored === null) fail('bad header checksum (empty)');
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const v = i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
    unsigned += v;
    signed += v > 127 ? v - 256 : v;
  }
  if (stored !== unsigned && stored !== signed) fail('bad header checksum');
}

function detectMagic(block: Buffer): Magic {
  const magic = block.subarray(257, 263);
  const version = block.subarray(263, 265);
  if (magic.equals(Buffer.from('ustar\0', 'latin1')) && version.equals(Buffer.from('00', 'latin1'))) return 'posix';
  if (magic.equals(Buffer.from('ustar ', 'latin1')) && version.equals(Buffer.from(' \0', 'latin1'))) return 'gnu';
  if (isZeroBlock(block.subarray(257, 265))) return 'v7';
  return fail('unrecognised archive format (bad magic)');
}

function parseHeader(block: Buffer): RawHeader {
  verifyChecksum(block);
  const magic = detectMagic(block);
  let name = cString(block, 0, 100, 'name');
  const prefixRegion = block.subarray(345, 500);
  if (magic === 'posix') {
    const prefix = cString(block, 345, 155, 'prefix');
    if (prefix.length > 0) name = `${prefix}/${name}`;
  } else if (!isZeroBlock(prefixRegion)) {
    // BusyBox prepends this region as a prefix, GNU tar treats it as atime/ctime/sparse data.
    fail('non-ustar header carries data in the prefix region (parsers disagree)', name);
  }
  const mode = parseNumber(block.subarray(100, 108), 'mode') ?? 0;
  const size = parseNumber(block.subarray(124, 136), 'size') ?? 0;
  return {
    name,
    link: cString(block, 157, 100, 'linkname'),
    mode,
    size,
    type: String.fromCharCode(block[156] ?? 0),
    magic,
  };
}

// ---------------------------------------------------------------------------
// Extended headers
// ---------------------------------------------------------------------------

/** GNU long name data: a C string whose tail (if any) is only NUL padding. */
function parseLongName(data: Buffer, what: string): string {
  const end = data.indexOf(0);
  if (end === -1) return data.toString('latin1');
  for (let i = end; i < data.length; i += 1) {
    if (data[i] !== 0) fail(`NUL inside a GNU long ${what}`);
  }
  return data.subarray(0, end).toString('latin1');
}

function parsePax(data: Buffer, global: boolean): Pax {
  const out: Pax = {};
  let p = 0;
  while (p < data.length) {
    let q = p;
    while (q < data.length && (data[q] ?? 0) >= 0x30 && (data[q] ?? 0) <= 0x39) q += 1;
    if (q === p || q - p > 10 || data[q] !== 0x20) fail('malformed pax record (bad length prefix)');
    const length = Number(data.subarray(p, q).toString('latin1'));
    if (length < q - p + 4 || p + length > data.length) fail('malformed pax record (bad length)');
    if (data[p + length - 1] !== 0x0a) fail('malformed pax record (missing newline)');
    const body = data.subarray(q + 1, p + length - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) fail('malformed pax record (no key)');
    const key = body.subarray(0, eq).toString('latin1');
    const value = body.subarray(eq + 1);
    p += length;

    if (key.startsWith('GNU.sparse')) fail('sparse files are not supported');
    if (key !== 'path' && key !== 'linkpath' && key !== 'size') continue;
    if (global) fail(`a global pax header sets "${key}" (parsers disagree)`);
    if (out[key] !== undefined) fail(`duplicate pax "${key}" record`);
    if (key === 'size') {
      const text = value.toString('latin1');
      if (!/^[0-9]{1,16}$/.test(text)) fail('malformed pax size');
      out.size = Number(text);
    } else {
      if (value.includes(0)) fail(`NUL in the pax ${key}`);
      if (value.length === 0) fail(`empty pax ${key}`);
      out[key] = value.toString('latin1');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

/** Components of a relative in-archive path; rejects absolute names and "..". */
function pathParts(name: string, what: string, entry: string): string[] {
  if (name.length === 0) fail(`empty ${what}`, entry);
  if (name.startsWith('/')) fail(`absolute ${what}`, entry);
  const parts: string[] = [];
  for (const part of name.split('/')) {
    if (part === '..') fail(`".." component in the ${what}`, entry);
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  return parts;
}

class Reader {
  private window = Buffer.alloc(WINDOW_BYTES);
  private windowStart = -1;
  private windowLength = 0;

  constructor(
    private readonly handle: fs.promises.FileHandle,
    readonly size: number
  ) {}

  /** A header block. Valid only until the next call. Caller guarantees position + 512 <= size. */
  async block(position: number): Promise<Buffer> {
    const inWindow = this.windowStart >= 0 && position >= this.windowStart && position + BLOCK <= this.windowStart + this.windowLength;
    if (!inWindow) {
      const want = Math.min(WINDOW_BYTES, this.size - position);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await this.handle.read(this.window, got, want - got, position + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      this.windowStart = position;
      this.windowLength = got;
      if (got < BLOCK) fail('truncated archive (partial header block)');
    }
    const offset = position - this.windowStart;
    return this.window.subarray(offset, offset + BLOCK);
  }

  async bytes(position: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(out, done, length - done, position + done);
      if (bytesRead === 0) fail('truncated archive (extended header data)');
      done += bytesRead;
    }
    return out;
  }

  async assertZeroFrom(position: number): Promise<void> {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let at = position;
    while (at < this.size) {
      const want = Math.min(SCAN_CHUNK_BYTES, this.size - at);
      const { bytesRead } = await this.handle.read(chunk, 0, want, at);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] !== 0) fail('data after the end-of-archive marker');
      }
      at += bytesRead;
    }
  }
}

function paddedLength(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export async function validateTarArchive(file: string, policy: Partial<TarPolicy> = {}): Promise<TarSummary> {
  const limits: TarPolicy = { ...DEFAULT_TAR_POLICY, ...policy };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ContainerError('INVALID_INPUT', `Invalid tar policy ${key}: must be a positive integer`);
    }
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ContainerError('NOT_FOUND', 'The tar file does not exist');
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('not a regular file');
    if (stat.size === 0) fail('empty file (no end-of-archive marker)');
    if (stat.size % BLOCK !== 0) fail('truncated archive (length is not a multiple of 512 bytes)');
    return await scan(new Reader(handle, stat.size), limits);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function scan(reader: Reader, limits: TarPolicy): Promise<TarSummary> {
  const summary: TarSummary = { entries: 0, files: 0, directories: 0, symlinks: 0, hardlinks: 0, totalBytes: 0 };
  /** Normalised path -> what it is. Parents of entries are recorded as directories. */
  const kinds = new Map<string, Kind>();
  let trackedBytes = 0;
  let pending: Pending = {};
  let headers = 0;
  const maxHeaders = limits.maxEntries * 4 + 64;
  let position = 0;

  const track = (key: string, kind: Kind): void => {
    trackedBytes += key.length + 64;
    if (trackedBytes > limits.maxTrackedNameBytes) fail('the archive has too many or too long names to validate');
    kinds.set(key, kind);
  };

  const hasPending = (): boolean => pending.longName !== undefined || pending.longLink !== undefined || pending.pax !== undefined;

  for (;;) {
    if (position >= reader.size) fail('missing end-of-archive marker (the archive ends without two zero blocks)');
    const block = await reader.block(position);

    if (isZeroBlock(block)) {
      if (hasPending()) fail('an extended header is not followed by an entry');
      if (position + 2 * BLOCK > reader.size) fail('truncated archive (a lone zero block; the end marker needs two)');
      const second = await reader.block(position + BLOCK);
      if (!isZeroBlock(second)) fail('a lone zero block is followed by more data (parsers disagree on this)');
      await reader.assertZeroFrom(position + 2 * BLOCK);
      return summary;
    }

    headers += 1;
    if (headers > maxHeaders) fail('too many headers');
    const header = parseHeader(block);
    const next = position + BLOCK;

    // ---- extended headers: they describe the NEXT entry and are not entries ----
    if (header.type === 'L' || header.type === 'K' || header.type === 'x' || header.type === 'g') {
      if (header.magic === 'v7') fail('extended header in a header without ustar magic', header.name);
      const isName = header.type === 'L' || header.type === 'K';
      const cap = isName ? limits.maxNameBytes + 1 : MAX_PAX_BYTES;
      if (header.size > cap) fail(`extended header is too large (${header.size} bytes)`, header.name);
      const end = next + paddedLength(header.size);
      if (end > reader.size) fail('truncated archive (extended header data)', header.name);
      const data = header.size > 0 ? await reader.bytes(next, header.size) : Buffer.alloc(0);
      if (header.type === 'L') {
        if (pending.longName !== undefined) fail('two GNU long-name headers for one entry (parsers disagree on which wins)');
        pending.longName = parseLongName(data, 'name');
      } else if (header.type === 'K') {
        if (pending.longLink !== undefined) fail('two GNU long-link headers for one entry (parsers disagree on which wins)');
        pending.longLink = parseLongName(data, 'link name');
      } else if (header.type === 'x') {
        if (pending.pax !== undefined) fail('two pax headers for one entry');
        pending.pax = parsePax(data, false);
      } else {
        parsePax(data, true);
      }
      position = end;
      continue;
    }

    // ---- a real entry ----
    let kind: Kind;
    switch (header.type) {
      case '0':
      case '\0':
        kind = 'file';
        break;
      case '1':
        kind = 'hardlink';
        break;
      case '2':
        kind = 'symlink';
        break;
      case '5':
        kind = 'dir';
        break;
      default:
        return fail(`unsupported entry type: ${describeType(header.type)}`, header.name);
    }

    const pax = pending.pax;
    const longName = pending.longName;
    const longLink = pending.longLink;
    pending = {};

    if (pax?.path !== undefined && longName !== undefined) {
      fail('both a GNU long name and a pax path precede the entry (parsers disagree on which wins)', header.name);
    }
    if (pax?.linkpath !== undefined && longLink !== undefined) {
      fail('both a GNU long link and a pax linkpath precede the entry (parsers disagree on which wins)', header.name);
    }
    const name = pax?.path ?? longName ?? header.name;
    const link = pax?.linkpath ?? longLink ?? header.link;
    if (name.length > limits.maxNameBytes) fail(`name is longer than ${limits.maxNameBytes} bytes`, name);
    if (link.length > limits.maxNameBytes) fail(`link target is longer than ${limits.maxNameBytes} bytes`, name);

    // Size: never trust a source another parser ignores.
    if (pax?.size !== undefined && pax.size !== header.size) {
      fail('pax size differs from the header size (parsers disagree)', name);
    }
    if (kind !== 'file' && header.size !== 0) {
      fail(`${kind === 'dir' ? 'directory' : kind} header declares data (parsers disagree on whether it is skipped)`, name);
    }
    if (Math.floor(header.mode / 512) % 8 !== 0) fail('setuid, setgid or sticky mode bits', name);

    const parts = pathParts(name, 'name', name);
    if (kind === 'file' && name.endsWith('/')) fail('regular file whose name ends with "/" (parsers treat it as a directory)', name);
    if (parts.length === 0 && kind !== 'dir') fail('entry would replace the extraction root', name);

    if (parts.length > 0) {
      // No entry may pass through an earlier symlink, and no parent may be a non-directory.
      let ancestor = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        ancestor = ancestor.length === 0 ? (parts[i] ?? '') : `${ancestor}/${parts[i] ?? ''}`;
        const seen = kinds.get(ancestor);
        if (seen === 'symlink') fail(`path passes through the earlier symlink ${show(ancestor)}`, name);
        if (seen === 'file' || seen === 'hardlink') fail(`parent ${show(ancestor)} is not a directory`, name);
        if (seen === undefined) track(ancestor, 'dir');
      }
      // Judge the link target before this entry itself exists, so a link cannot vouch for itself.
      if (kind === 'hardlink') checkHardlink(link, name, kinds);
      const key = parts.join('/');
      const previous = kinds.get(key);
      if (previous !== undefined && previous !== kind) fail(`duplicate path with different types (${previous} then ${kind})`, name);
      if (previous === undefined) track(key, kind);
    }

    if (kind === 'symlink') {
      checkSymlink(link, parts, name, kinds);
      summary.symlinks += 1;
    } else if (kind === 'hardlink') {
      summary.hardlinks += 1;
    } else if (kind === 'dir') {
      summary.directories += 1;
    } else {
      summary.files += 1;
      summary.totalBytes += header.size;
      if (summary.totalBytes > limits.maxBytes) fail(`archive holds more than ${limits.maxBytes} bytes of file data`, name);
    }
    summary.entries += 1;
    if (summary.entries > limits.maxEntries) fail(`archive has more than ${limits.maxEntries} entries`, name);

    const end = next + (kind === 'file' ? paddedLength(header.size) : 0);
    if (end > reader.size) fail('truncated archive (entry data extends past the end)', name);
    position = end;
  }
}

function checkSymlink(target: string, parts: readonly string[], entry: string, kinds: ReadonlyMap<string, Kind>): void {
  if (target.length === 0) fail('symlink with an empty target', entry);
  if (target.startsWith('/')) fail('symlink with an absolute target', entry);
  // Resolve lexically from the directory that holds the link.
  const stack = parts.slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) fail('symlink target escapes the extraction root', entry);
      // Lexical ".." is only sound when the component being popped is not itself a symlink.
      if (kinds.get(stack.join('/')) === 'symlink') fail('symlink target applies ".." after another symlink', entry);
      stack.pop();
    } else {
      stack.push(part);
    }
  }
}

function checkHardlink(target: string, entry: string, kinds: ReadonlyMap<string, Kind>): void {
  if (target.length === 0) fail('hardlink with an empty target', entry);
  const parts = pathParts(target, 'hardlink target', entry);
  if (parts.length === 0) fail('hardlink target is the extraction root', entry);
  let ancestor = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    ancestor = ancestor.length === 0 ? (parts[i] ?? '') : `${ancestor}/${parts[i] ?? ''}`;
    if (kinds.get(ancestor) === 'symlink') fail(`hardlink target passes through the earlier symlink ${show(ancestor)}`, entry);
  }
  const seen = kinds.get(parts.join('/'));
  if (seen === undefined) fail('hardlink target has not appeared earlier in the archive', entry);
  if (seen !== 'file' && seen !== 'hardlink') fail(`hardlink target is a ${seen}, not a regular file`, entry);
}
