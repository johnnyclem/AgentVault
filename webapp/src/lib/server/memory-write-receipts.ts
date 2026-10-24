import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseReceiptLine } from '@/canister/memory-repo-receipts'
import type { IcpWriteReceipt } from '@/canister/memory-repo-receipts-types'

/*
 * The store for signed memory_repo write receipts: append-only JSONL, one
 * receipt per line, one file per UTC day (memory-repo-writes-YYYY-MM-DD.jsonl),
 * beside the archive index in ~/.agentvault. Files are never renamed or
 * deleted here; an operator may prune old days, which is one reason the page
 * never presents the list as complete.
 *
 * Each line goes to disk in one write() on a file opened O_APPEND. Writes
 * from several requests, or several server processes, then land whole and
 * never interleave on a local filesystem. fs.appendFile must not be used: it
 * splits anything over 512 KiB into several writes, which tore nearly every
 * large line when processes appended at once. Where a write still comes up
 * short (a full disk, a network filesystem), the reader skips the broken
 * line and counts it, and the next append starts on a fresh line.
 *
 * Receipts hold the memory content that was written, so the directory is
 * created 0700 and the files 0600.
 */

/** Where receipts are kept: AGENTVAULT_RECEIPTS_DIR, else ~/.agentvault/receipts. Read on every call, so it can change at runtime. */
export function receiptsDir(): string {
  const configured = process.env.AGENTVAULT_RECEIPTS_DIR
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.agentvault', 'receipts')
}

/**
 * The largest line accepted. The canister takes a diff of at most 1 MB and
 * an ingress message of at most 2 MiB, which comes to about 4 MiB as hex.
 */
export const MAX_LINE_BYTES = 5 * 1024 * 1024

/** A day's file moves to a new part (.1.jsonl, .2.jsonl, …) past this size, because the reader reads a part whole to serve a page. */
const PART_MAX_BYTES = 16 * 1024 * 1024

/** A page stops growing once its receipts reach this many bytes, so a few large receipts cannot make one huge response. */
const PAGE_MAX_BYTES = 4 * 1024 * 1024

const FILE_NAME = /^memory-repo-writes-(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d{0,3}))?\.jsonl$/
const NEWLINE = 0x0a

export interface ReceiptPage {
  /** Newest first */
  receipts: IcpWriteReceipt[]
  /** Pass back as `cursor` for the next older page; null when there is none */
  nextCursor: string | null
  /** Lines passed over on this page because they could not be read as receipts */
  skippedLines: number
  /** The UTC day of the oldest file kept, YYYY-MM-DD; null when there are none */
  oldestKept: string | null
}

/** A cursor this server did not issue, or one for a file no longer kept. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not one this server issued, or the receipts it points to are no longer kept. Reload to start from the newest.')
    this.name = 'InvalidCursorError'
  }
}

/**
 * While one append has been running this long, the disk is taken to be
 * stuck and further appends fail at once rather than queue behind it.
 */
export const APPEND_STALLED_MS = 10_000

// Appends from this process run one at a time, so two cannot pick the same
// part and both push it past PART_MAX_BYTES. That also means a stuck disk
// holds one of the few threads Node does file work on, not one per append:
// the same threads resolve host names for the canister calls.
let appendTail: Promise<unknown> = Promise.resolve()
/** When the append now running started (Date.now()); null when none is */
let runningSince: number | null = null

export function appendIcpWriteReceipt(
  receipt: IcpWriteReceipt,
  options: { dir?: string; partMaxBytes?: number } = {}
): Promise<void> {
  if (runningSince !== null && Date.now() - runningSince >= APPEND_STALLED_MS) {
    // Queued receipts (up to 5 MiB each) would pile up in memory behind it
    const seconds = Math.floor((Date.now() - runningSince) / 1000)
    return Promise.reject(new Error(`an earlier receipt append has not finished after ${seconds} s, so this one was not queued behind it`))
  }
  const run = async () => {
    runningSince = Date.now()
    try {
      await appendLine(receipt, options.dir ?? receiptsDir(), options.partMaxBytes ?? PART_MAX_BYTES)
    } finally {
      runningSince = null
    }
  }
  const appended = appendTail.then(run, run)
  appendTail = appended.catch(() => undefined)
  return appended
}

async function appendLine(receipt: IcpWriteReceipt, dir: string, partMaxBytes: number): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(receipt)}\n`)
  if (line.length > MAX_LINE_BYTES) {
    throw new Error(`receipt ${receipt.id} is ${line.length} bytes, over the ${MAX_LINE_BYTES}-byte line limit`)
  }
  const recordedAt = new Date(receipt.recordedAt)
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error(`receipt ${receipt.id} has no valid recordedAt`)
  }
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = await partFor(dir, recordedAt.toISOString().slice(0, 10), line.length, partMaxBytes)

  // 'a+' opens O_APPEND, and readable, to look at the last byte
  const handle = await fs.promises.open(file, 'a+', 0o600)
  try {
    // A write that came up short left a line without its newline. Starting
    // on a fresh line keeps that fragment from swallowing this receipt.
    const { size } = await handle.stat()
    const last = Buffer.alloc(1)
    const startsFresh = size === 0 || ((await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] === NEWLINE)
    const data = startsFresh ? line : Buffer.concat([Buffer.from('\n'), line])
    const { bytesWritten } = await handle.write(data, 0, data.length)
    if (bytesWritten !== data.length) {
      throw new Error(`receipt ${receipt.id}: wrote ${bytesWritten} of ${data.length} bytes to ${file}`)
    }
  } finally {
    await handle.close()
  }
}

/**
 * The day's newest part if the line fits, else the part after it. Never an
 * older part, even one with room: lines must only ever be added after the
 * newest, or a page would list a later receipt below an earlier one, and a
 * cursor for an older part would pick up receipts appended after it.
 */
async function partFor(dir: string, day: string, lineBytes: number, partMaxBytes: number): Promise<string> {
  const newest = Math.max(
    -1,
    ...(await fs.promises.readdir(dir)).flatMap((name) => {
      const match = FILE_NAME.exec(name)
      return match && match[1] === day ? [match[2] ? Number(match[2]) : 0] : []
    })
  )
  if (newest === -1) return partFile(dir, day, 0)
  const file = partFile(dir, day, newest)
  const { size } = await fs.promises.stat(file)
  // An empty part takes any line, so a line larger than a part still has a home
  return size === 0 || size + lineBytes <= partMaxBytes ? file : partFile(dir, day, newest + 1)
}

function partFile(dir: string, day: string, part: number): string {
  return path.join(dir, `memory-repo-writes-${day}${part === 0 ? '' : `.${part}`}.jsonl`)
}

interface ReceiptFile {
  name: string
  day: string
  part: number
}

interface Cursor {
  /** File name */
  s: string
  /** Read lines before this index; null for the whole file */
  l: number | null
}

/**
 * A page of receipts, newest first. A cursor names a file and a line index,
 * which stay valid because files only ever grow at the end. A page holds at
 * least one receipt when any remain, even one larger than PAGE_MAX_BYTES.
 */
export async function readIcpWriteReceiptPage(
  options: { cursor?: string | null; limit: number; maxBytes?: number; dir?: string }
): Promise<ReceiptPage> {
  const dir = options.dir ?? receiptsDir()
  const maxBytes = options.maxBytes ?? PAGE_MAX_BYTES
  const files = await listReceiptFiles(dir)
  const start = options.cursor ? decodeCursor(options.cursor, files) : null
  const first = start ? files.findIndex((file) => file.name === start.s) : 0

  const page: ReceiptPage = { receipts: [], nextCursor: null, skippedLines: 0, oldestKept: files.at(-1)?.day ?? null }
  let bytes = 0
  for (let index = first; index < files.length; index++) {
    const name = files[index]!.name
    const lines = await readLines(path.join(dir, name))
    const bound = index === first && start?.l != null ? Math.min(start.l, lines.length) : lines.length
    for (let line = bound - 1; line >= 0; line--) {
      const text = lines[line]!
      // A blank line is the fresh start an append made after a short write
      if (text.length === 0) continue
      const receipt = parseReceiptLine(text.toString('utf8'))
      if (!receipt) {
        page.skippedLines++
        continue
      }
      page.receipts.push(receipt)
      bytes += text.length
      if (page.receipts.length >= options.limit || bytes >= maxBytes) {
        page.nextCursor = line > 0
          ? encodeCursor({ s: name, l: line })
          : index + 1 < files.length ? encodeCursor({ s: files[index + 1]!.name, l: null }) : null
        return page
      }
    }
  }
  return page
}

/** Receipt files, newest first: by day, then by part. A missing directory has none. */
async function listReceiptFiles(dir: string): Promise<ReceiptFile[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names
    .flatMap((name) => {
      const match = FILE_NAME.exec(name)
      return match ? [{ name, day: match[1]!, part: match[2] ? Number(match[2]) : 0 }] : []
    })
    .sort((a, b) => (a.day === b.day ? b.part - a.part : a.day < b.day ? 1 : -1))
}

/**
 * The file's complete lines, without their newlines. Bytes after the last
 * newline are left out: they are a line another process is still writing,
 * or one cut short, and either way not a receipt yet.
 */
async function readLines(file: string): Promise<Buffer[]> {
  const data = await fs.promises.readFile(file)
  const lines: Buffer[] = []
  let start = 0
  for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
    lines.push(data.subarray(start, end))
    start = end + 1
  }
  return lines
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/**
 * The cursor is client input. Its file must match the receipt file pattern
 * and be one of the files listed, so it cannot name a path anywhere else.
 */
function decodeCursor(value: string, files: ReceiptFile[]): Cursor {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError()
  }
  if (typeof cursor !== 'object' || cursor === null) throw new InvalidCursorError()
  const { s, l } = cursor as Record<string, unknown>
  if (typeof s !== 'string' || !FILE_NAME.test(s) || !files.some((file) => file.name === s)) {
    throw new InvalidCursorError()
  }
  if (l !== null && !(typeof l === 'number' && Number.isSafeInteger(l) && l >= 0)) {
    throw new InvalidCursorError()
  }
  return { s, l }
}
