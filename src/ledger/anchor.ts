/**
 * Anchoring: copying what the ledger has stored to somewhere it does not
 * control, so the ledger's own disk is not the only witness.
 *
 * A checkpoint covers one consecutive range of one stream and names the hash
 * the range starts from and the hash it ends at. With entries inline, the
 * checkpoint is a full copy: the range can be rebuilt and re-verified from the
 * anchor alone. Without them it is a commitment only: it proves the ledger
 * held exactly those entries, but restoring them needs the ledger's files.
 *
 * Anchoring is at-least-once. A crash between the anchor's write and the
 * store recording it anchors the same range again; a duplicate checkpoint
 * says the same thing twice and verifies the same way.
 */

import { GENESIS_HASH, type LedgerEntryInput } from './format.js';
import type { AnchorEvidence, AnchorRecord, LedgerStore } from './store.js';

export const ANCHOR_FORMAT = 'agentvault-ledger-anchor/v1';

/** One anchored range, as it is written to the anchor. */
export interface AnchorCheckpoint {
  format: typeof ANCHOR_FORMAT;
  stream: string;
  from: number;
  to: number;
  /** The chain hash of entry `from - 1`; GENESIS_HASH when the range starts the stream. */
  prev: string;
  /** The chain hash of entry `to`. */
  head: string;
  /** The entries themselves, when the anchor keeps a full copy. */
  entries?: LedgerEntryInput[];
}

/** Somewhere durable outside the ledger that checkpoints are written to. */
export interface LedgerAnchor {
  readonly kind: string;
  /** The largest serialized checkpoint, in bytes, one write can take. */
  readonly maxCheckpointBytes: number;
  anchor(checkpoint: AnchorCheckpoint): Promise<AnchorEvidence>;
}

export interface AnchorOptions {
  /** Keep a full copy of each entry in the anchor (the default), or only the range's hashes. */
  inlineEntries?: boolean;
  now?: () => Date;
}

/** Entries read per pass while packing an inline checkpoint. */
const PACK_PAGE = 200;
/** Room left for the checkpoint's own fields around its entries. */
const CHECKPOINT_OVERHEAD_BYTES = 1024;

/**
 * Anchors every entry not yet anchored, stream by stream, oldest first.
 * Stops at the first failure and throws it; ranges anchored before it stay
 * recorded, and the next call carries on from there.
 */
export async function anchorPending(store: LedgerStore, anchor: LedgerAnchor, options: AnchorOptions = {}): Promise<AnchorRecord[]> {
  const inline = options.inlineEntries ?? true;
  const now = options.now ?? (() => new Date());
  const records: AnchorRecord[] = [];
  for (const stream of store.streams()) {
    for (;;) {
      const checkpoint = nextCheckpoint(store, stream, anchor.maxCheckpointBytes, inline);
      if (!checkpoint) break;
      const evidence = await anchor.anchor(checkpoint);
      const record: AnchorRecord = {
        stream,
        from: checkpoint.from,
        to: checkpoint.to,
        head: checkpoint.head,
        anchoredAt: now().toISOString(),
        evidence,
      };
      store.recordAnchor(record);
      records.push(record);
    }
  }
  return records;
}

/** The next range of `stream` to anchor, or null when it is anchored up to its head. */
function nextCheckpoint(store: LedgerStore, stream: string, maxBytes: number, inline: boolean): AnchorCheckpoint | null {
  const head = store.head(stream);
  const anchored = store.anchoredSeq(stream);
  if (!head || anchored >= head.seq) return null;
  const from = anchored + 1;
  const prev = anchored === 0 ? GENESIS_HASH : store.read(stream, { after: anchored - 1, limit: 1 })[0]!.hash;
  if (!inline) {
    return { format: ANCHOR_FORMAT, stream, from, to: head.seq, prev, head: head.hash };
  }

  const entries: LedgerEntryInput[] = [];
  let bytes = CHECKPOINT_OVERHEAD_BYTES;
  let last = prev;
  for (const entry of store.read(stream, { after: anchored, limit: PACK_PAGE })) {
    const { seq, kind, at, payload } = entry;
    const size = Buffer.byteLength(JSON.stringify({ seq, kind, at, payload })) + 1;
    // A first entry too large to fit is still sent alone, so the anchor refuses it by name.
    if (entries.length > 0 && bytes + size > maxBytes) break;
    entries.push({ seq, kind, at, payload });
    bytes += size;
    last = entry.hash;
  }
  return { format: ANCHOR_FORMAT, stream, from, to: from + entries.length - 1, prev, head: last, entries };
}
