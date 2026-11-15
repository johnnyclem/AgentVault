import type { LedgerEntryInput } from '../../src/ledger/index.js';

/** A sealed-looking entry; `text` stands in for ciphertext. */
export function entry(seq: number, text = `record ${seq}`): LedgerEntryInput {
  return {
    seq,
    kind: 'memory.revision',
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    payload: Buffer.from(text).toString('base64url'),
  };
}
