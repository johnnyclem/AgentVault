/**
 * The logic behind each receipt card on the Evidence page
 * (webapp/src/lib/proof/receipt-card.ts). A card starts out checking, shows
 * the result of its latest check only, and starts another check only where
 * asking again could change the answer. Its label names the receipt, so
 * several cards (and their status announcements) can be told apart.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

type CheckResult =
  | { state: 'confirmed'; confirmations: number; blockHeight: number; blockHash: string }
  | { state: 'pending' }
  | { state: 'not-found' }
  | { state: 'size-mismatch'; expected: number; actual: number }
  | { state: 'content-mismatch'; expected: string; actual: string }
  | { state: 'too-large'; maxBytes: number }
  | { state: 'check-failed'; reason: string; retryable: boolean };

type Check = { state: 'checking' } | CheckResult;

interface CardState {
  attempt: number;
  check: Check;
}

type CardEvent = { type: 'result'; attempt: number; result: CheckResult } | { type: 'retry' };

interface CardModule {
  INITIAL_CARD_STATE: CardState;
  nextCardState: (state: CardState, event: CardEvent) => CardState;
  receiptLabel: (receipt: { txId: string; recordedAt: string | null }) => string;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'receipt-card.ts');
let card: CardModule;

beforeAll(async () => {
  card = (await import(MODULE)) as CardModule;
});

const CONFIRMED: CheckResult = { state: 'confirmed', confirmations: 3, blockHeight: 2_027_980, blockHash: 'h'.repeat(64) };
const NETWORK_ERROR: CheckResult = { state: 'check-failed', reason: 'The check did not finish: Failed to fetch', retryable: true };
const TX = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';

function after(...events: CardEvent[]): CardState {
  return events.reduce(card.nextCardState, card.INITIAL_CARD_STATE);
}

describe('nextCardState', () => {
  it('starts out checking, on the first attempt', () => {
    expect(card.INITIAL_CARD_STATE).toEqual({ attempt: 0, check: { state: 'checking' } });
  });

  it('shows the result of the current check', () => {
    expect(after({ type: 'result', attempt: 0, result: CONFIRMED })).toEqual({ attempt: 0, check: CONFIRMED });
  });

  it('starts a new check on retry after a failure that asking again could fix', () => {
    const retried = after({ type: 'result', attempt: 0, result: NETWORK_ERROR }, { type: 'retry' });

    expect(retried).toEqual({ attempt: 1, check: { state: 'checking' } });
  });

  it('never lets a late result from an earlier check replace the newer one', () => {
    const state = after(
      { type: 'result', attempt: 0, result: NETWORK_ERROR },
      { type: 'retry' },
      // The first check answers again, late: it must not show as the outcome of the second.
      { type: 'result', attempt: 0, result: CONFIRMED },
    );

    expect(state).toEqual({ attempt: 1, check: { state: 'checking' } });
    expect(card.nextCardState(state, { type: 'result', attempt: 1, result: NETWORK_ERROR })).toEqual({
      attempt: 1,
      check: NETWORK_ERROR,
    });
  });

  const noRetry: Array<[string, CheckResult | null]> = [
    ['while a check is still running', null],
    ['after a confirmed check', CONFIRMED],
    ['for content too large to check here', { state: 'too-large', maxBytes: 5 * 1024 * 1024 }],
    ['for a malformed receipt', { state: 'check-failed', reason: 'The recorded size is not a byte count.', retryable: false }],
  ];

  it.each(noRetry)('ignores retry %s', (_label, result) => {
    const state = result ? after({ type: 'result', attempt: 0, result }) : card.INITIAL_CARD_STATE;

    expect(card.nextCardState(state, { type: 'retry' })).toBe(state);
  });

  const retryable: CheckResult[] = [
    { state: 'pending' },
    { state: 'not-found' },
    { state: 'size-mismatch', expected: 2048, actual: 10 },
    { state: 'content-mismatch', expected: 'a'.repeat(64), actual: 'b'.repeat(64) },
    NETWORK_ERROR,
  ];

  it.each(retryable)('allows a retry after $state', (result) => {
    expect(after({ type: 'result', attempt: 0, result }, { type: 'retry' }).check).toEqual({ state: 'checking' });
  });
});

describe('receiptLabel', () => {
  it('names the receipt by the time it was recorded', () => {
    const morning = card.receiptLabel({ txId: TX, recordedAt: '2026-10-22T08:00:00.000Z' });
    const evening = card.receiptLabel({ txId: TX, recordedAt: '2026-10-22T20:00:00.000Z' });

    expect(morning).toMatch(/^Arweave receipt · .*2026/);
    // Two receipts from the same day still get different labels.
    expect(morning).not.toBe(evening);
  });

  it('falls back to the start of the transaction id when no usable time was recorded', () => {
    expect(card.receiptLabel({ txId: TX, recordedAt: null })).toBe('Arweave receipt · tx bNbA3TEQ');
    expect(card.receiptLabel({ txId: TX, recordedAt: 'not a date' })).toBe('Arweave receipt · tx bNbA3TEQ');
  });
});
