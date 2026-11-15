/**
 * Ledger entry format and hash chain.
 *
 * A ledger holds append-only streams. A client (an agent host such as a
 * hosted bot server) seals each record itself and sends only opaque bytes;
 * the ledger orders them, chains them, and later anchors them on a canister.
 * Nothing here reads a payload: what a stream means is the client's business.
 *
 * The chain is the tamper evidence. Each stored entry carries
 *
 *   hash = SHA-256( "agentvault-ledger/v1" \n stream \n seq \n prev \n kind \n at \n SHA-256(payload bytes) )
 *
 * where `prev` is the hash of the entry before it (GENESIS_HASH for seq 1).
 * Every field is restricted to a character set without newlines, so the
 * newline-joined preimage is unambiguous. Changing, dropping or reordering
 * any entry changes every hash after it.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LEDGER_FORMAT = 'agentvault-ledger/v1';

/** `prev` of the first entry in a stream. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Lowercase so a stream maps to one file on case-insensitive filesystems, and
 * at most 100 characters so `ledger:<stream>` fits a canister tag (128 bytes).
 */
export const STREAM_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const HASH = /^[0-9a-f]{64}$/;

/** The largest payload one entry may carry, in bytes, so any entry fits one anchor commit. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** The most entries one append may carry. */
export const MAX_APPEND_ENTRIES = 500;

const isoInstant = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, {
    message: 'must be an ISO 8601 instant in UTC with milliseconds, such as 2026-01-02T03:04:05.000Z',
  });

/** An entry as a client sends it: its place in the stream and its sealed bytes. */
export const ledgerEntryInputSchema = z
  .object({
    /** 1-based and contiguous within the stream. */
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** A short client-defined label, such as `memory.revision`. Not secret. */
    kind: z.string().regex(KIND),
    /** When the recorded thing happened, by the client's clock. */
    at: isoInstant,
    /** Sealed bytes, base64url without padding. */
    payload: z
      .string()
      .regex(BASE64URL)
      .max(Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3)),
  })
  .strict();

export type LedgerEntryInput = z.infer<typeof ledgerEntryInputSchema>;

export const appendRequestSchema = z
  .object({ entries: z.array(ledgerEntryInputSchema).min(1).max(MAX_APPEND_ENTRIES) })
  .strict();

/** A stored entry: the client's entry plus its place in the chain. */
export const ledgerEntrySchema = ledgerEntryInputSchema
  .extend({ prev: z.string().regex(HASH), hash: z.string().regex(HASH) })
  .strict();

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** Where a stream ends: its last sequence number and that entry's hash. */
export interface LedgerHead {
  seq: number;
  hash: string;
}

export function isStreamId(value: string): boolean {
  return STREAM_ID.test(value);
}

/** The SHA-256 of a payload's decoded bytes, as lowercase hex. */
export function payloadDigest(payload: string): string {
  return createHash('sha256').update(Buffer.from(payload, 'base64url')).digest('hex');
}

/** The chain hash of one entry, given the hash of the entry before it. */
export function entryHash(stream: string, entry: LedgerEntryInput, prev: string): string {
  const preimage = [LEDGER_FORMAT, stream, String(entry.seq), prev, entry.kind, entry.at, payloadDigest(entry.payload)];
  return createHash('sha256').update(preimage.join('\n')).digest('hex');
}

/** The entry as stored, with its chain fields filled in. */
export function chainEntry(stream: string, entry: LedgerEntryInput, prev: string): LedgerEntry {
  return { seq: entry.seq, kind: entry.kind, at: entry.at, payload: entry.payload, prev, hash: entryHash(stream, entry, prev) };
}

export type ChainCheck = { ok: true; head: LedgerHead | null } | { ok: false; seq: number; reason: string };

/**
 * Re-derives a run of stored entries from `after` (the head they continue
 * from; null for the start of a stream). Reports the first entry that is out
 * of order or whose hash does not follow from the one before it.
 */
export function checkChain(stream: string, entries: readonly LedgerEntry[], after: LedgerHead | null = null): ChainCheck {
  let head = after;
  for (const entry of entries) {
    const expectedSeq = (head?.seq ?? 0) + 1;
    if (entry.seq !== expectedSeq) {
      return { ok: false, seq: entry.seq, reason: `expected entry ${expectedSeq}, found ${entry.seq}` };
    }
    const prev = head?.hash ?? GENESIS_HASH;
    if (entry.prev !== prev) {
      return { ok: false, seq: entry.seq, reason: `entry ${entry.seq} does not follow entry ${entry.seq - 1}` };
    }
    if (entry.hash !== entryHash(stream, entry, prev)) {
      return { ok: false, seq: entry.seq, reason: `entry ${entry.seq} does not match its hash` };
    }
    head = { seq: entry.seq, hash: entry.hash };
  }
  return { ok: true, head };
}
