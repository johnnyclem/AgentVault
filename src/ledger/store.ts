/**
 * The ledger's own durable store: one append-only JSON Lines file per stream,
 * plus a log of the anchors made for them.
 *
 *   <dir>/ledger.json              manifest
 *   <dir>/streams/<stream>.jsonl   one chained entry per line
 *   <dir>/anchors.jsonl            one line per anchored range
 *   <dir>/anchor-targets.json      where each stream that names its own is anchored
 *
 * One process owns a directory. Appends are synchronous and fsynced before
 * they are acknowledged, so an acknowledged entry survives a crash. A crash in
 * the middle of an append can leave a partial last line; it was never
 * acknowledged, so opening the stream drops it. Anything else that does not
 * parse or does not chain is corruption and is refused, never repaired.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync, sanitizePathPart } from '../utils/path-validation.js';
import {
  GENESIS_HASH,
  LEDGER_FORMAT,
  chainEntry,
  checkChain,
  isStreamId,
  ledgerEntrySchema,
  type ChainCheck,
  type LedgerEntry,
  type LedgerEntryInput,
  type LedgerHead,
} from './format.js';

const MANIFEST_FILE = 'ledger.json';
const STREAMS_DIR = 'streams';
const ANCHORS_FILE = 'anchors.jsonl';
const TARGETS_FILE = 'anchor-targets.json';
const TARGETS_FORMAT = 'agentvault-ledger-targets/v1';
const STREAM_EXTENSION = '.jsonl';

/** Proof, in the anchor's own terms, that a range was written somewhere durable. */
export interface AnchorEvidence {
  /** Which kind of anchor made it, such as `icp-memory-repo`. */
  kind: string;
  [detail: string]: unknown;
}

/** One anchored range of a stream. */
export interface AnchorRecord {
  stream: string;
  /** First and last sequence numbers the anchor covers. */
  from: number;
  to: number;
  /** The chain hash of entry `to`. */
  head: string;
  anchoredAt: string;
  /** Where the range was anchored, when the anchor says; older records name it in their evidence. */
  destination?: string;
  evidence: AnchorEvidence;
}

/** Where an anchored range was kept, or null when the record does not say. */
export function recordDestination(record: AnchorRecord): string | null {
  const named = record.evidence['canisterId'];
  return record.destination ?? (typeof named === 'string' ? named : null);
}

/** An append the stream cannot take: it skips ahead, or it rewrites an entry already stored. */
export class LedgerConflictError extends Error {
  override readonly name = 'LedgerConflictError';
  constructor(
    readonly reason: 'gap' | 'conflict',
    readonly head: LedgerHead | null,
    message: string,
  ) {
    super(message);
  }
}

/** The store's files do not read back as a ledger: a damaged, edited or foreign file. */
export class LedgerCorruptError extends Error {
  override readonly name = 'LedgerCorruptError';
}

interface StreamState {
  file: string;
  head: LedgerHead | null;
  /** Byte offset of each entry's line; offsets[seq - 1] starts entry seq. */
  offsets: number[];
  /** The file's length in bytes as this process last left it. */
  size: number;
}

export class LedgerStore {
  private readonly streamStates = new Map<string, StreamState>();
  /** For each stream, the last entry anchored to each destination, and `null` for any of them. */
  private readonly anchored = new Map<string, Map<string | null, number>>();
  private readonly targets = new Map<string, string>();

  private constructor(readonly dir: string) {}

  /** Opens the ledger in `dir`, creating an empty one when the directory holds none. */
  static open(dir: string): LedgerStore {
    const resolved = path.resolve(dir);
    const manifestPath = path.join(resolved, MANIFEST_FILE);
    if (fs.existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (!isRecord(manifest) || manifest['format'] !== LEDGER_FORMAT) {
        throw new LedgerCorruptError(`${manifestPath} is not a ${LEDGER_FORMAT} ledger`);
      }
    } else {
      fs.mkdirSync(path.join(resolved, STREAMS_DIR), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(manifestPath, `${JSON.stringify({ format: LEDGER_FORMAT, createdAt: new Date().toISOString() })}\n`);
    }
    const store = new LedgerStore(resolved);
    for (const record of store.anchors()) store.markAnchored(record);
    const targetsPath = path.join(resolved, TARGETS_FILE);
    if (fs.existsSync(targetsPath)) {
      const saved = readJson(targetsPath);
      const named = isRecord(saved) && saved['format'] === TARGETS_FORMAT ? saved['targets'] : undefined;
      if (!isRecord(named)) throw new LedgerCorruptError(`${targetsPath} is not a ${TARGETS_FORMAT} file`);
      for (const [stream, destination] of Object.entries(named)) {
        if (!isStreamId(stream) || typeof destination !== 'string' || !destination) {
          throw new LedgerCorruptError(`${targetsPath} names a destination that is not valid`);
        }
        store.targets.set(stream, destination);
      }
    }
    return store;
  }

  /** Every stream with at least one entry, sorted. */
  streams(): string[] {
    const dir = path.join(this.dir, STREAMS_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(STREAM_EXTENSION))
      .map((name) => name.slice(0, -STREAM_EXTENSION.length))
      .filter(isStreamId)
      .sort();
  }

  head(stream: string): LedgerHead | null {
    return this.state(stream).head;
  }

  /**
   * Appends entries in order. Re-sending entries the stream already holds is
   * accepted when they are identical, so a client that never saw an
   * acknowledgement can send the same batch again.
   *
   * @throws LedgerConflictError when the batch skips ahead of the stream or
   *   differs from an entry already stored. Nothing is written in either case.
   */
  append(stream: string, entries: readonly LedgerEntryInput[]): { head: LedgerHead; appended: number } {
    const state = this.state(stream);
    const headSeq = state.head?.seq ?? 0;
    const first = entries[0];
    if (!first) throw new Error('An append needs at least one entry');
    entries.forEach((entry, index) => {
      if (entry.seq !== first.seq + index) {
        throw new LedgerConflictError('gap', state.head, `Entries must be consecutive: entry ${index + 1} of the batch is ${entry.seq}, not ${first.seq + index}`);
      }
    });
    if (first.seq > headSeq + 1) {
      throw new LedgerConflictError('gap', state.head, `Stream ${stream} ends at entry ${headSeq}; the next entry must be ${headSeq + 1}, not ${first.seq}`);
    }

    const resent = entries.filter((entry) => entry.seq <= headSeq);
    if (resent.length > 0) {
      const stored = this.read(stream, { after: first.seq - 1, limit: resent.length });
      resent.forEach((entry, index) => {
        const kept = stored[index];
        if (!kept || kept.kind !== entry.kind || kept.at !== entry.at || kept.payload !== entry.payload) {
          throw new LedgerConflictError('conflict', state.head, `Stream ${stream} already holds a different entry ${entry.seq}`);
        }
      });
    }

    const fresh = entries.slice(resent.length);
    if (fresh.length === 0) return { head: state.head!, appended: 0 };

    // Another process writing the same directory would fork the chain.
    const onDisk = fs.existsSync(state.file) ? fs.statSync(state.file).size : 0;
    if (onDisk !== state.size) {
      throw new LedgerCorruptError(`${state.file} changed outside this process; one ledger directory takes one writer`);
    }

    let prev = state.head;
    const lines: Buffer[] = [];
    const offsets: number[] = [];
    let offset = state.size;
    for (const entry of fresh) {
      const chained = chainEntry(stream, entry, prev?.hash ?? GENESIS_HASH);
      const line = Buffer.from(`${JSON.stringify(chained)}\n`, 'utf8');
      offsets.push(offset);
      offset += line.length;
      lines.push(line);
      prev = { seq: chained.seq, hash: chained.hash };
    }

    const fd = fs.openSync(state.file, 'a', 0o600);
    try {
      fs.writeSync(fd, Buffer.concat(lines));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    state.offsets.push(...offsets);
    state.size = offset;
    state.head = prev;
    return { head: prev!, appended: fresh.length };
  }

  /**
   * Entries after sequence number `after`, oldest first: at most `limit`, and no more than fit
   * in `maxBytes` of stored lines, but always at least one when any remain.
   */
  read(stream: string, options: { after?: number; limit?: number; maxBytes?: number } = {}): LedgerEntry[] {
    const state = this.state(stream);
    const after = Math.max(0, options.after ?? 0);
    const limit = Math.max(0, options.limit ?? 100);
    const start = state.offsets[after];
    if (start === undefined || limit === 0) return [];
    const endOf = (count: number): number => state.offsets[after + count] ?? state.size;
    let count = Math.min(limit, state.offsets.length - after);
    while (options.maxBytes !== undefined && count > 1 && endOf(count) - start > options.maxBytes) count -= 1;
    const end = endOf(count);
    const buffer = Buffer.alloc(end - start);
    const fd = fs.openSync(state.file, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return parseLines(state.file, buffer.toString('utf8'));
  }

  /** Re-derives a whole stream from disk, ignoring anything this process has cached. */
  verify(stream: string): ChainCheck & { entries: number } {
    const file = this.streamFile(stream);
    if (!fs.existsSync(file)) return { ok: true, head: null, entries: 0 };
    let entries: LedgerEntry[];
    try {
      entries = parseLines(file, fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, seq: 0, reason: error instanceof Error ? error.message : String(error), entries: 0 };
    }
    return { ...checkChain(stream, entries), entries: entries.length };
  }

  /**
   * The last sequence number of `stream` that has been anchored to `destination`; 0 when none has.
   * Without a destination, the last one anchored anywhere.
   */
  anchoredSeq(stream: string, destination?: string): number {
    return this.anchored.get(stream)?.get(destination ?? null) ?? 0;
  }

  /** Where `stream` is anchored when it names its own place, or null. */
  anchorTarget(stream: string): string | null {
    return this.targets.get(stream) ?? null;
  }

  /** Every stream that names its own place to be anchored, and where. */
  anchorTargets(): Record<string, string> {
    return Object.fromEntries([...this.targets].sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Names where `stream` is anchored from now on, or with null puts it back with the rest. What
   * was already anchored stays where it is. A stream need not hold entries yet.
   */
  setAnchorTarget(stream: string, destination: string | null): void {
    if (!isStreamId(stream)) throw new Error(`Invalid stream id: ${JSON.stringify(stream)}`);
    if (destination === null) {
      if (!this.targets.delete(stream)) return;
    } else {
      if (this.targets.get(stream) === destination) return;
      this.targets.set(stream, destination);
    }
    atomicWriteFileSync(
      path.join(this.dir, TARGETS_FILE),
      `${JSON.stringify({ format: TARGETS_FORMAT, targets: this.anchorTargets() })}\n`,
    );
  }

  private markAnchored(record: AnchorRecord): void {
    const marks = this.anchored.get(record.stream) ?? new Map<string | null, number>();
    for (const key of new Set([null, recordDestination(record)])) marks.set(key, Math.max(marks.get(key) ?? 0, record.to));
    this.anchored.set(record.stream, marks);
  }

  /** Every anchor recorded, oldest first; only `stream`'s when one is named. */
  anchors(stream?: string): AnchorRecord[] {
    const file = path.join(this.dir, ANCHORS_FILE);
    if (!fs.existsSync(file)) return [];
    const records: AnchorRecord[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const record = parseAnchor(line);
      if (!record) throw new LedgerCorruptError(`${file} holds a line that is not an anchor record`);
      if (!stream || record.stream === stream) records.push(record);
    }
    return records;
  }

  /** Keeps an anchor's evidence and moves the stream's anchored mark forward. */
  recordAnchor(record: AnchorRecord): void {
    const file = path.join(this.dir, ANCHORS_FILE);
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.markAnchored(record);
  }

  private streamFile(stream: string): string {
    if (!isStreamId(stream)) throw new Error(`Invalid stream id: ${JSON.stringify(stream)}`);
    return path.join(this.dir, STREAMS_DIR, `${sanitizePathPart(stream)}${STREAM_EXTENSION}`);
  }

  /** Loads a stream once, checking its whole chain, then keeps its head and line offsets. */
  private state(stream: string): StreamState {
    const cached = this.streamStates.get(stream);
    if (cached) return cached;
    const file = this.streamFile(stream);
    const state: StreamState = { file, head: null, offsets: [], size: 0 };
    if (fs.existsSync(file)) {
      let raw = fs.readFileSync(file);
      const complete = raw.lastIndexOf(0x0a) + 1;
      if (complete !== raw.length) {
        // A partial last line was never acknowledged: drop it.
        fs.truncateSync(file, complete);
        raw = raw.subarray(0, complete);
      }
      let offset = 0;
      while (offset < raw.length) {
        state.offsets.push(offset);
        offset = raw.indexOf(0x0a, offset) + 1;
      }
      const check = checkChain(stream, parseLines(file, raw.toString('utf8')));
      if (!check.ok) throw new LedgerCorruptError(`${file}: ${check.reason}`);
      state.head = check.head;
      state.size = raw.length;
    }
    this.streamStates.set(stream, state);
    return state;
  }
}

function parseLines(file: string, text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new LedgerCorruptError(`${file} holds a line that is not JSON`);
    }
    const parsed = ledgerEntrySchema.safeParse(value);
    if (!parsed.success) throw new LedgerCorruptError(`${file} holds a line that is not a ledger entry`);
    entries.push(parsed.data);
  }
  return entries;
}

function parseAnchor(line: string): AnchorRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { stream, from, to, head, anchoredAt, evidence, destination } = value;
  if (typeof stream !== 'string' || !isStreamId(stream)) return null;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  if (typeof head !== 'string' || typeof anchoredAt !== 'string') return null;
  if (!isRecord(evidence) || typeof evidence['kind'] !== 'string') return null;
  if (destination !== undefined && typeof destination !== 'string') return null;
  return {
    stream,
    from: from as number,
    to: to as number,
    head,
    anchoredAt,
    ...(destination === undefined ? {} : { destination }),
    evidence: evidence as AnchorEvidence,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new LedgerCorruptError(`${file} is not readable JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
