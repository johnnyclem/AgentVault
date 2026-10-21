/**
 * Total Recall — on-disk format
 *
 * A total-recall volume is a directory of append-only, hash-chained JSONL
 * files plus a small JSON manifest:
 *
 *   volume.json        identity + guardrail policy (the one mutable file)
 *   memories.jsonl     one line per memory event (created/recalled/updated/deleted)
 *   transcript.jsonl   optional: one line per conversation message
 *   anchors.jsonl      head hashes recorded at a point in time
 *
 * Every archive line carries `seq` (1-based position), `prevHash` (the
 * previous line's hash, null for the first) and `hash` =
 * sha256(canonical JSON of the line without `hash`). Canonical JSON sorts
 * object keys recursively and has no whitespace, so a line hashes the same
 * however it was produced. Lines are only ever appended: a changed memory is
 * a new `updated` event, a forgotten one a `deleted` event, and both keep
 * every earlier version readable.
 *
 * Transcript lines are also valid stenographer `jsonl` messages (id, role,
 * content, timestamp, sessionId, model, toolCalls), so
 * `stenographer start <volume>/transcript.jsonl` indexes a volume with no
 * adapter work. The chain fields are extra keys stenographer ignores.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

export const TOTAL_RECALL_VOLUME_FORMAT = 'agentvault-total-recall/volume-v1' as const;
export const TOTAL_RECALL_MEMORY_FORMAT = 'agentvault-total-recall/memory-v1' as const;
export const TOTAL_RECALL_TRANSCRIPT_FORMAT = 'agentvault-total-recall/transcript-v1' as const;

export const VOLUME_MANIFEST_FILE = 'volume.json';
export const MEMORIES_FILE = 'memories.jsonl';
export const TRANSCRIPT_FILE = 'transcript.jsonl';
export const ANCHORS_FILE = 'anchors.jsonl';

/** Default volume location inside a project. */
export const DEFAULT_VOLUME_DIR = '.agentvault/total-recall';

// ---------------------------------------------------------------------------
// Memory events
// ---------------------------------------------------------------------------

export const MEMORY_OPS = ['created', 'recalled', 'updated', 'deleted'] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** Where an event came from: which assistant, which agent/session inside it. */
export const memorySourceSchema = z.object({
  /** e.g. "chatgpt", "claude", "gemini", "agentvault" */
  provider: z.string().min(1).max(64),
  /** Agent or model identity inside the provider, when known */
  agent: z.string().max(256).optional(),
  /** Conversation / session identifier inside the provider, when known */
  session: z.string().max(256).optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

/** What the memory said at the time of the event. */
export const memoryBodySchema = z.object({
  /** Stable key the provider uses for this memory (its id or a slug). */
  key: z.string().min(1).max(512),
  title: z.string().max(1024).optional(),
  content: z.string(),
  tags: z.array(z.string().max(128)).max(64).default([]),
});
export type MemoryBody = z.infer<typeof memoryBodySchema>;

export const memoryEventSchema = z.object({
  format: z.literal(TOTAL_RECALL_MEMORY_FORMAT),
  seq: z.number().int().positive(),
  id: z.string().min(1),
  ts: z.string().min(1),
  op: z.enum(MEMORY_OPS),
  source: memorySourceSchema,
  memory: memoryBodySchema,
  /** sha256 of the canonical `memory` object */
  contentHash: z.string().length(64),
  prevHash: z.string().length(64).nullable(),
  hash: z.string().length(64),
});
export type MemoryEvent = z.infer<typeof memoryEventSchema>;

/** The caller-supplied part of a memory event; the volume fills the rest. */
export interface MemoryEventInput {
  op: MemoryOp;
  source: MemorySource;
  memory: { key: string; title?: string; content: string; tags?: string[] };
  /** Event time; defaults to now */
  ts?: string;
}

// ---------------------------------------------------------------------------
// Transcript messages (stenographer-compatible)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

const toolCallSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const transcriptMessageSchema = z.object({
  format: z.literal(TOTAL_RECALL_TRANSCRIPT_FORMAT),
  seq: z.number().int().positive(),
  id: z.string().min(1),
  role: z.enum(TRANSCRIPT_ROLES),
  content: z.string(),
  timestamp: z.string().min(1),
  sessionId: z.string().min(1),
  model: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  /** Provider the conversation happened in (chatgpt, claude, ...) */
  provider: z.string().min(1).max(64),
  prevHash: z.string().length(64).nullable(),
  hash: z.string().length(64),
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

export interface TranscriptMessageInput {
  role: TranscriptRole;
  content: string;
  /** Conversation id inside the provider */
  sessionId: string;
  provider: string;
  /** Provider's own message id, when it has one; otherwise derived from content */
  id?: string;
  timestamp?: string;
  model?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

export const anchorRecordSchema = z.object({
  ts: z.string().min(1),
  memoriesSeq: z.number().int().nonnegative(),
  memoriesHead: z.string().length(64).nullable(),
  transcriptSeq: z.number().int().nonnegative(),
  transcriptHead: z.string().length(64).nullable(),
  /** Where the heads were recorded: "local", "canister:<id>", "arweave:<tx>" */
  target: z.string().min(1),
  /** Reference inside the target (commit id, tx id), when there is one */
  ref: z.string().optional(),
});
export type AnchorRecord = z.infer<typeof anchorRecordSchema>;

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted (by UTF-16 code units, like RFC 8785),
 * no whitespace, `undefined` properties dropped. Throws on values JSON can't
 * carry, so a hash never covers something other than what was written.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize non-finite number ${value}`);
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('Cannot canonicalize a non-plain object');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`Cannot canonicalize a ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash of a chained line: every field except `hash` itself. */
export function lineHash(line: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...line };
  delete rest.hash;
  return sha256Hex(canonicalJson(rest));
}

/** `${prefix}_${128-bit hex}` over length-prefixed parts (stenographer's contentId idiom). */
export function contentId(prefix: string, ...parts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(`${part.length}:`);
    hash.update(part);
    hash.update('\0');
  }
  return `${prefix}_${hash.digest('hex').slice(0, 32)}`;
}

/** Result of re-walking a chain. */
export interface ChainCheck {
  valid: boolean;
  count: number;
  head: string | null;
  errors: string[];
}

/**
 * Walk parsed lines in file order and confirm each one's `seq`, `prevHash`
 * and `hash`. `parse` validates a line's shape; a line it rejects is an
 * error, not a skip, because a reader must never silently drop archive.
 */
export function verifyChain<T extends { seq: number; prevHash: string | null; hash: string }>(
  rawLines: string[],
  parse: (value: unknown) => T,
): ChainCheck {
  const errors: string[] = [];
  let prevHash: string | null = null;
  let count = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    let line: T;
    try {
      line = parse(JSON.parse(raw));
    } catch (error) {
      errors.push(`line ${i + 1}: unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (line.seq !== i + 1) errors.push(`line ${i + 1}: seq ${line.seq}, expected ${i + 1}`);
    if (line.prevHash !== prevHash) errors.push(`line ${i + 1}: prevHash does not match the previous line`);
    const expected = lineHash(line as unknown as Record<string, unknown>);
    if (line.hash !== expected) errors.push(`line ${i + 1}: hash mismatch (content changed after it was written)`);
    prevHash = line.hash;
    count += 1;
  }
  return { valid: errors.length === 0, count, head: prevHash, errors };
}
