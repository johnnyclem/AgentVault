/**
 * Total Recall — the volume
 *
 * `TotalRecallVolume` owns one volume directory (see format.ts). Writes are
 * appends under a directory lock, fsynced before the lock is released, so two
 * MCP server processes (one per connected assistant) extend the same chain
 * without forking it. Reads never take the lock.
 *
 * The write-once rule: the only mutation to memories.jsonl, transcript.jsonl
 * and anchors.jsonl is appending a complete line. The one exception is a
 * torn tail: bytes after the last newline that don't parse as a line were
 * never a record (a crash mid-write), and the next append truncates them
 * after noting it. volume.json (identity + policy) is ordinary config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FtsIndex } from '../hypervault/index/fts-index.js';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import {
  ANCHORS_FILE,
  MEMORIES_FILE,
  TOTAL_RECALL_MEMORY_FORMAT,
  TOTAL_RECALL_TRANSCRIPT_FORMAT,
  TOTAL_RECALL_VOLUME_FORMAT,
  TRANSCRIPT_FILE,
  VOLUME_MANIFEST_FILE,
  anchorRecordSchema,
  canonicalJson,
  contentId,
  lineHash,
  memoryBodySchema,
  memoryEventSchema,
  memorySourceSchema,
  sha256Hex,
  transcriptMessageSchema,
  verifyChain,
  type AnchorRecord,
  type ChainCheck,
  type MemoryEvent,
  type MemoryEventInput,
  type MemoryOp,
  type TranscriptMessage,
  type TranscriptMessageInput,
} from './format.js';
import { defaultPolicy, policySchema, type TotalRecallPolicy } from './policy.js';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface VolumeManifest {
  format: typeof TOTAL_RECALL_VOLUME_FORMAT;
  volumeId: string;
  createdAt: string;
  policy: TotalRecallPolicy;
}

function parseManifest(raw: string, dir: string): VolumeManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Total-recall volume at ${dir} has an unreadable ${VOLUME_MANIFEST_FILE}`);
  }
  const m = data as Partial<VolumeManifest>;
  if (m.format !== TOTAL_RECALL_VOLUME_FORMAT) {
    throw new Error(`Total-recall volume at ${dir}: unsupported format ${String(m.format)}`);
  }
  if (typeof m.volumeId !== 'string' || typeof m.createdAt !== 'string') {
    throw new Error(`Total-recall volume at ${dir}: ${VOLUME_MANIFEST_FILE} is missing volumeId/createdAt`);
  }
  return {
    format: TOTAL_RECALL_VOLUME_FORMAT,
    volumeId: m.volumeId,
    createdAt: m.createdAt,
    policy: policySchema.parse(m.policy ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Folded view of memories
// ---------------------------------------------------------------------------

/** The current state of one memory, folded from its events. */
export interface FoldedMemory {
  /** `${provider}/${key}` */
  id: string;
  provider: string;
  key: string;
  title?: string;
  content: string;
  tags: string[];
  /** True when the last non-recall event was `deleted` */
  deleted: boolean;
  firstSeenAt: string;
  lastChangedAt: string;
  /** seq of the event that produced the current content */
  lastChangeSeq: number;
  /** How many created/updated events this memory has had */
  versions: number;
  /** How many times assistants reported recalling it */
  recalls: number;
  /** Which agents/sessions touched it */
  agents: string[];
}

export interface ReadEventsOptions {
  /** Return events with seq > sinceSeq */
  sinceSeq?: number;
  limit?: number;
  ops?: MemoryOp[];
  provider?: string;
}

export interface ReadTranscriptOptions {
  sinceSeq?: number;
  limit?: number;
  sessionId?: string;
  provider?: string;
}

export interface VolumeStatus {
  dir: string;
  volumeId: string;
  createdAt: string;
  policy: TotalRecallPolicy;
  memories: { events: number; head: string | null; current: number; deleted: number; providers: Record<string, number> };
  transcript: { messages: number; head: string | null; sessions: number };
  lastAnchor: AnchorRecord | null;
  tornTail: { memories: boolean; transcript: boolean };
}

export interface VolumeVerifyResult {
  valid: boolean;
  memories: ChainCheck;
  transcript: ChainCheck;
  /** The last anchor, and whether the chains still extend it */
  anchor: { record: AnchorRecord | null; consistent: boolean; errors: string[] };
}

// ---------------------------------------------------------------------------
// Low-level file helpers
// ---------------------------------------------------------------------------

interface Tail {
  /** Byte length of the complete, newline-terminated prefix */
  completeLength: number;
  /** The last complete line, or null for an empty file */
  lastLine: string | null;
  /** Bytes after the last newline (a torn write), '' when clean */
  torn: string;
}

/** Read the tail of a line-oriented file without loading all of it. */
function readTail(file: string): Tail {
  if (!fs.existsSync(file)) return { completeLength: 0, lastLine: null, torn: '' };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { completeLength: 0, lastLine: null, torn: '' };
    let window = Math.min(size, 64 * 1024);
    for (;;) {
      const buf = Buffer.alloc(window);
      fs.readSync(fd, buf, 0, window, size - window);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0 && window < size) {
        window = Math.min(size, window * 4);
        continue;
      }
      if (lastNl < 0) {
        // No newline at all: the whole file is one torn line.
        return { completeLength: 0, lastLine: null, torn: text };
      }
      const torn = text.slice(lastNl + 1);
      const completeLength = size - Buffer.byteLength(torn, 'utf8');
      const head = text.slice(0, lastNl);
      const prevNl = head.lastIndexOf('\n');
      if (prevNl < 0 && window < size) {
        // The last complete line started before this window; widen it.
        window = Math.min(size, window * 4);
        continue;
      }
      const lastLine = prevNl < 0 ? head : head.slice(prevNl + 1);
      return { completeLength, lastLine, torn };
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (!text) return [];
  const lines = text.split('\n');
  // A trailing newline leaves an empty last element; a torn tail leaves a
  // non-empty one that never became a record. Neither is a line.
  lines.pop();
  return lines;
}

/** Append one complete line and fsync. */
function appendLine(file: string, line: string): void {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const LOCK_FILE = '.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Directory lock: exclusive-create a lock file, waiting briefly, breaking a stale one. */
function withLock<T>(dir: string, fn: () => T): T {
  const lockPath = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the open and the stat
      }
      if (Date.now() > deadline) {
        throw new Error(`Total-recall volume at ${dir} is locked by another writer (${lockPath})`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The volume
// ---------------------------------------------------------------------------

export interface InitVolumeOptions {
  volumeId?: string;
  policy?: Partial<TotalRecallPolicy>;
}

export class TotalRecallVolume {
  private manifest: VolumeManifest;

  private constructor(
    readonly dir: string,
    manifest: VolumeManifest,
  ) {
    this.manifest = manifest;
  }

  static exists(dir: string): boolean {
    return fs.existsSync(path.join(dir, VOLUME_MANIFEST_FILE));
  }

  /** Create a volume directory; refuses to re-initialize an existing one. */
  static init(dir: string, options: InitVolumeOptions = {}): TotalRecallVolume {
    if (TotalRecallVolume.exists(dir)) {
      throw new Error(`A total-recall volume already exists at ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest: VolumeManifest = {
      format: TOTAL_RECALL_VOLUME_FORMAT,
      volumeId: options.volumeId ?? `tr_${crypto.randomBytes(8).toString('hex')}`,
      createdAt: new Date().toISOString(),
      policy: policySchema.parse({ ...defaultPolicy(), ...(options.policy ?? {}) }),
    };
    atomicWriteFileSync(path.join(dir, VOLUME_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    return new TotalRecallVolume(dir, manifest);
  }

  static open(dir: string): TotalRecallVolume {
    const manifestPath = path.join(dir, VOLUME_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No total-recall volume at ${dir} (run \`agentvault total-recall init\`)`);
    }
    return new TotalRecallVolume(dir, parseManifest(fs.readFileSync(manifestPath, 'utf8'), dir));
  }

  /** Open an existing volume or create one. */
  static openOrInit(dir: string, options: InitVolumeOptions = {}): TotalRecallVolume {
    return TotalRecallVolume.exists(dir) ? TotalRecallVolume.open(dir) : TotalRecallVolume.init(dir, options);
  }

  get volumeId(): string {
    return this.manifest.volumeId;
  }
  get createdAt(): string {
    return this.manifest.createdAt;
  }
  get policy(): TotalRecallPolicy {
    return this.manifest.policy;
  }
  get memoriesPath(): string {
    return path.join(this.dir, MEMORIES_FILE);
  }
  get transcriptPath(): string {
    return path.join(this.dir, TRANSCRIPT_FILE);
  }
  get anchorsPath(): string {
    return path.join(this.dir, ANCHORS_FILE);
  }

  /** Replace the policy (the archive files are untouched). */
  setPolicy(patch: Partial<TotalRecallPolicy>): TotalRecallPolicy {
    const next = policySchema.parse({ ...this.manifest.policy, ...patch });
    this.manifest = { ...this.manifest, policy: next };
    atomicWriteFileSync(path.join(this.dir, VOLUME_MANIFEST_FILE), JSON.stringify(this.manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    return next;
  }

  // -- writes ---------------------------------------------------------------

  /** Append a memory event. Returns the stored line. */
  appendMemoryEvent(input: MemoryEventInput): MemoryEvent {
    const source = memorySourceSchema.parse(input.source);
    const memory = memoryBodySchema.parse({ ...input.memory, tags: input.memory.tags ?? [] });
    const ts = input.ts ?? new Date().toISOString();
    return withLock(this.dir, () => {
      const { seq, prevHash } = this.nextPosition(this.memoriesPath);
      const unhashed = {
        format: TOTAL_RECALL_MEMORY_FORMAT,
        seq,
        id: contentId('mem', source.provider, memory.key, input.op, ts, String(seq)),
        ts,
        op: input.op,
        source,
        memory,
        contentHash: sha256Hex(canonicalJson(memory)),
        prevHash,
      };
      const event: MemoryEvent = { ...unhashed, hash: lineHash(unhashed) };
      appendLine(this.memoriesPath, JSON.stringify(event));
      return event;
    });
  }

  /** Append a transcript message (stenographer-compatible line). */
  appendTranscript(input: TranscriptMessageInput): TranscriptMessage {
    const timestamp = input.timestamp ?? new Date().toISOString();
    return withLock(this.dir, () => {
      const { seq, prevHash } = this.nextPosition(this.transcriptPath);
      const unhashed = {
        format: TOTAL_RECALL_TRANSCRIPT_FORMAT,
        seq,
        id: input.id ?? contentId('msg', input.provider, input.sessionId, input.role, timestamp, input.content, String(seq)),
        role: input.role,
        content: input.content,
        timestamp,
        sessionId: input.sessionId,
        ...(input.model ? { model: input.model } : {}),
        ...(input.toolCalls && input.toolCalls.length > 0 ? { toolCalls: input.toolCalls } : {}),
        provider: input.provider,
        prevHash,
      };
      const message = transcriptMessageSchema.parse({ ...unhashed, hash: lineHash(unhashed) });
      appendLine(this.transcriptPath, JSON.stringify(message));
      return message;
    });
  }

  /** Record the current heads. `target` names where else they were written. */
  anchor(target = 'local', ref?: string): AnchorRecord {
    return withLock(this.dir, () => {
      const m = this.nextPosition(this.memoriesPath);
      const t = this.nextPosition(this.transcriptPath);
      const record: AnchorRecord = {
        ts: new Date().toISOString(),
        memoriesSeq: m.seq - 1,
        memoriesHead: m.prevHash,
        transcriptSeq: t.seq - 1,
        transcriptHead: t.prevHash,
        target,
        ...(ref ? { ref } : {}),
      };
      appendLine(this.anchorsPath, JSON.stringify(record));
      return record;
    });
  }

  /**
   * Where the next line goes. Must run under the lock. Truncates a torn
   * tail (bytes after the last newline that are not a record).
   */
  private nextPosition(file: string): { seq: number; prevHash: string | null } {
    const tail = readTail(file);
    if (tail.torn) {
      process.stderr.write(`total-recall: truncating ${tail.torn.length} bytes of torn tail in ${path.basename(file)}\n`);
      fs.truncateSync(file, tail.completeLength);
    }
    if (tail.lastLine === null) return { seq: 1, prevHash: null };
    let last: { seq: number; hash: string };
    try {
      last = JSON.parse(tail.lastLine) as { seq: number; hash: string };
    } catch {
      throw new Error(`${file}: last line is not JSON; refusing to extend a broken chain (run \`agentvault total-recall verify\`)`);
    }
    if (typeof last.seq !== 'number' || typeof last.hash !== 'string') {
      throw new Error(`${file}: last line has no seq/hash; refusing to extend a broken chain`);
    }
    return { seq: last.seq + 1, prevHash: last.hash };
  }

  // -- reads ----------------------------------------------------------------

  /** Memory events in file order, optionally after a cursor. */
  readMemoryEvents(options: ReadEventsOptions = {}): MemoryEvent[] {
    const since = options.sinceSeq ?? 0;
    const out: MemoryEvent[] = [];
    for (const raw of readLines(this.memoriesPath)) {
      const event = memoryEventSchema.parse(JSON.parse(raw));
      if (event.seq <= since) continue;
      if (options.ops && !options.ops.includes(event.op)) continue;
      if (options.provider && event.source.provider !== options.provider) continue;
      out.push(event);
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }

  /** The seq of the newest memory event, 0 for none. */
  memoriesSeq(): number {
    const tail = readTail(this.memoriesPath);
    if (tail.lastLine === null) return 0;
    try {
      return Number((JSON.parse(tail.lastLine) as { seq: number }).seq) || 0;
    } catch {
      return 0;
    }
  }

  readTranscript(options: ReadTranscriptOptions = {}): TranscriptMessage[] {
    const since = options.sinceSeq ?? 0;
    const out: TranscriptMessage[] = [];
    for (const raw of readLines(this.transcriptPath)) {
      const message = transcriptMessageSchema.parse(JSON.parse(raw));
      if (message.seq <= since) continue;
      if (options.sessionId && message.sessionId !== options.sessionId) continue;
      if (options.provider && message.provider !== options.provider) continue;
      out.push(message);
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }

  readAnchors(): AnchorRecord[] {
    return readLines(this.anchorsPath).map((raw) => anchorRecordSchema.parse(JSON.parse(raw)));
  }

  lastAnchor(): AnchorRecord | null {
    const anchors = this.readAnchors();
    return anchors.length > 0 ? anchors[anchors.length - 1]! : null;
  }

  /** Current state of every memory, folded from its events. */
  foldMemories(options: { includeDeleted?: boolean; provider?: string } = {}): FoldedMemory[] {
    const folded = new Map<string, FoldedMemory>();
    for (const event of this.readMemoryEvents({ provider: options.provider })) {
      const id = `${event.source.provider}/${event.memory.key}`;
      const agent = event.source.agent;
      let m = folded.get(id);
      if (!m) {
        m = {
          id,
          provider: event.source.provider,
          key: event.memory.key,
          title: event.memory.title,
          content: event.memory.content,
          tags: [...event.memory.tags],
          deleted: false,
          firstSeenAt: event.ts,
          lastChangedAt: event.ts,
          lastChangeSeq: event.seq,
          versions: 0,
          recalls: 0,
          agents: [],
        };
        folded.set(id, m);
      }
      if (agent && !m.agents.includes(agent)) m.agents.push(agent);
      switch (event.op) {
        case 'created':
        case 'updated':
          m.title = event.memory.title;
          m.content = event.memory.content;
          m.tags = [...event.memory.tags];
          m.deleted = false;
          m.lastChangedAt = event.ts;
          m.lastChangeSeq = event.seq;
          m.versions += 1;
          break;
        case 'deleted':
          m.deleted = true;
          m.lastChangedAt = event.ts;
          m.lastChangeSeq = event.seq;
          break;
        case 'recalled':
          m.recalls += 1;
          // A recall of a memory never created here still tells us its content.
          if (m.versions === 0 && !m.content) m.content = event.memory.content;
          break;
      }
    }
    const all = [...folded.values()];
    return options.includeDeleted ? all : all.filter((m) => !m.deleted);
  }

  /** Every version of one memory, oldest first. */
  memoryHistory(provider: string, key: string): MemoryEvent[] {
    return this.readMemoryEvents({ provider }).filter((e) => e.memory.key === key);
  }

  /** Lexical search over the folded memories (title > tags > content). */
  searchMemories(query: string, options: { limit?: number; includeDeleted?: boolean; provider?: string } = {}): Array<{
    memory: FoldedMemory;
    score: number;
  }> {
    const memories = this.foldMemories({ includeDeleted: options.includeDeleted, provider: options.provider });
    const byId = new Map(memories.map((m) => [m.id, m]));
    const index = new FtsIndex();
    for (const m of memories) index.add({ id: m.id, title: m.title, tags: m.tags, content: m.content });
    return index
      .search(query, options.limit ?? 10)
      .map((hit) => ({ memory: byId.get(hit.id)!, score: hit.score }))
      .filter((r) => r.memory !== undefined);
  }

  // -- integrity ------------------------------------------------------------

  verify(): VolumeVerifyResult {
    const mLines = readLines(this.memoriesPath);
    const tLines = readLines(this.transcriptPath);
    const memories = verifyChain(mLines, (v) => memoryEventSchema.parse(v));
    const transcript = verifyChain(tLines, (v) => transcriptMessageSchema.parse(v));
    const record = this.lastAnchor();
    const errors: string[] = [];
    if (record) {
      const hashAt = (lines: string[], seq: number): string | null | undefined => {
        if (seq === 0) return null;
        const raw = lines[seq - 1];
        if (!raw) return undefined;
        try {
          return (JSON.parse(raw) as { hash: string }).hash;
        } catch {
          return undefined;
        }
      };
      if (memories.count < record.memoriesSeq) {
        errors.push(`memories.jsonl has ${memories.count} events but the last anchor recorded ${record.memoriesSeq} (lines removed)`);
      } else if (hashAt(mLines, record.memoriesSeq) !== record.memoriesHead) {
        errors.push(`memories.jsonl line ${record.memoriesSeq} no longer matches the anchored head`);
      }
      if (transcript.count < record.transcriptSeq) {
        errors.push(`transcript.jsonl has ${transcript.count} messages but the last anchor recorded ${record.transcriptSeq} (lines removed)`);
      } else if (hashAt(tLines, record.transcriptSeq) !== record.transcriptHead) {
        errors.push(`transcript.jsonl line ${record.transcriptSeq} no longer matches the anchored head`);
      }
    }
    return {
      valid: memories.valid && transcript.valid && errors.length === 0,
      memories,
      transcript,
      anchor: { record, consistent: errors.length === 0, errors },
    };
  }

  status(): VolumeStatus {
    const folded = this.foldMemories({ includeDeleted: true });
    const providers: Record<string, number> = {};
    for (const m of folded) providers[m.provider] = (providers[m.provider] ?? 0) + 1;
    const mTail = readTail(this.memoriesPath);
    const tTail = readTail(this.transcriptPath);
    const headOf = (tail: Tail): string | null => {
      if (tail.lastLine === null) return null;
      try {
        return (JSON.parse(tail.lastLine) as { hash: string }).hash ?? null;
      } catch {
        return null;
      }
    };
    const transcript = this.readTranscript();
    return {
      dir: this.dir,
      volumeId: this.volumeId,
      createdAt: this.createdAt,
      policy: this.policy,
      memories: {
        events: this.memoriesSeq(),
        head: headOf(mTail),
        current: folded.filter((m) => !m.deleted).length,
        deleted: folded.filter((m) => m.deleted).length,
        providers,
      },
      transcript: {
        messages: transcript.length,
        head: headOf(tTail),
        sessions: new Set(transcript.map((t) => t.sessionId)).size,
      },
      lastAnchor: this.lastAnchor(),
      tornTail: { memories: mTail.torn.length > 0, transcript: tTail.torn.length > 0 },
    };
  }
}
