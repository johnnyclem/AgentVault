/**
 * The logic behind the Signed memory writes page: what each card shows
 * (webapp/src/lib/proof/signed-write-card.ts) and the list state
 * (webapp/src/lib/proof/signed-writes.ts). A card decodes the call from the
 * signed request and says where every field comes from: only a verified
 * check lets the result and time read as certified, and entry data is never
 * shown. The list checks receipts one at a time in order, leaves large
 * writes until the reader asks, keeps each result with its own receipt, and
 * drops answers that belong to an earlier load or another receipt.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';
import { CANISTER, COMMIT, COMMIT_ID, blsKey, commitArg, signedWrite, type BlsKey } from '../fixtures/icp-receipts.js';

type Check = { state: string; [field: string]: unknown };

interface CardModule {
  signedWriteCard: (
    receipt: unknown,
    check: Check,
    read?: unknown,
  ) => {
    view: { tone: string; title: string };
    summary: string;
    result: { label: string; value: string } | null;
    sender: { full: string; short: string } | null;
    network: string | null;
    time: { label: string; iso: string; text: string } | null;
    provenance: string;
    details: Array<{ label: string; value: string; mono?: boolean }>;
    steps: Array<{ outcome: string }>;
  };
}

interface Page {
  receipts: unknown[];
  nextCursor: string | null;
  skippedLines: number;
  writesConfigured: boolean | null;
  canisterId: string | null;
}

interface ListState {
  generation: number;
  status: 'loading' | 'ready' | 'error';
  error: { message: string } | null;
  receipts: unknown[];
  checks: Array<Check | null>;
  checking: number | null;
  requested: number[];
  nextCursor: string | null;
  skippedLines: number;
  writesConfigured: boolean | null;
  canisterId: string | null;
  older: { status: 'idle' | 'loading' | 'error'; error: { message: string } | null };
}

type ListEvent =
  | { type: 'load'; generation: number }
  | { type: 'loaded'; generation: number; page: Page }
  | { type: 'load-failed'; generation: number; error: { message: string } }
  | { type: 'load-older'; generation: number; cursor: string }
  | { type: 'loaded-older'; generation: number; cursor: string; page: Page }
  | { type: 'older-failed'; generation: number; cursor: string; error: { message: string } }
  | { type: 'check-requested'; generation: number; index: number }
  | { type: 'check-started'; generation: number; index: number }
  | { type: 'checked'; generation: number; index: number; result: Check };

interface ListModule {
  PAGE_SIZE: number;
  AUTO_CHECK_MAX_ARG_BYTES: number;
  INITIAL_SIGNED_WRITES: ListState;
  nextSignedWritesState: (state: ListState, event: ListEvent) => ListState;
  nextToCheck: (state: ListState) => number | null;
  checkAt: (state: ListState, index: number) => Check;
  readSignedWritesPage: (data: unknown) => Page | null;
  liveMessage: (state: ListState) => string;
}

interface CheckModule {
  checkIcpReceipt: (receipt: unknown, expectedCanisterId: string | null, options?: { rootKey?: Uint8Array }) => Promise<Check>;
  readReceipt: (receipt: unknown) => unknown;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const PROOF = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof');
let card: CardModule;
let list: ListModule;
let checker: CheckModule;
let root: BlsKey;
let receipt: IcpWriteReceipt;

beforeAll(async () => {
  card = (await import(join(PROOF, 'signed-write-card.ts'))) as CardModule;
  list = (await import(join(PROOF, 'signed-writes.ts'))) as ListModule;
  checker = (await import(join(PROOF, 'icp-receipt-check.ts'))) as CheckModule;
  root = blsKey();
  receipt = (await signedWrite('ed25519', { root, time: 1_761_300_000_000_000_000n })).receipt;
});

function detail(view: ReturnType<CardModule['signedWriteCard']>, label: string): string | undefined {
  return view.details.find((row) => row.label === label)?.value;
}

describe('signedWriteCard', () => {
  it('shows a verified write’s result and time as certified, decoded from the signed request', async () => {
    const view = card.signedWriteCard(receipt, await checker.checkIcpReceipt(receipt, CANISTER, { rootKey: root.der }));

    expect(view.view.title).toBe('Verified');
    expect(view.summary).toBe('Commit to polytician-main');
    expect(view.result).toEqual({ label: 'Commit', value: COMMIT_ID });
    expect(view.sender?.full).toBe(receipt.request.sender);
    expect(view.network).toBe('IC mainnet');
    expect(view.time).toMatchObject({ label: 'Certified', iso: '2025-10-24T10:00:00.000Z' });
    expect(view.provenance).toBe('Decoded in your browser from the signed request. The certificate shows the canister accepted it.');
    expect(detail(view, 'Commit id, certified')).toBe(COMMIT_ID);
    expect(detail(view, 'Sender')).toBe(`${receipt.request.sender} (Ed25519 key)`);
    expect(detail(view, 'Network')).toBe('Internet Computer mainnet (the certificate chains to its root key)');
    expect(detail(view, 'Request id, computed in your browser')).toBe(receipt.id);
    expect(detail(view, 'Certified at')).toBeDefined();
    expect(detail(view, 'Recorded by this server (its own clock)')).toBeDefined();
  });

  it('lists the entry keys and the size of the entry data, never the data itself', async () => {
    const view = card.signedWriteCard(receipt, await checker.checkIcpReceipt(receipt, CANISTER, { rootKey: root.der }));

    expect(detail(view, 'Branch')).toBe(COMMIT.branch);
    expect(detail(view, 'Message')).toBe(COMMIT.message);
    expect(detail(view, 'Tags')).toBe('ocean');
    expect(detail(view, 'Entry keys')).toBe('concept/tides');
    expect(detail(view, 'Entry data')).toBe(`${new TextEncoder().encode(COMMIT.diff).byteLength} bytes in the signed request (not shown)`);
    expect(JSON.stringify(view)).not.toContain('the tide turns at dawn');
  });

  it('says how many keys it leaves out of a long diff', async () => {
    const entries = Array.from({ length: 23 }, (_, i) => ({ key: `k${i}`, data: 'x' }));
    const many = await signedWrite('ed25519', { root, arg: commitArg('b', 'm', JSON.stringify(entries), []) });
    const view = card.signedWriteCard(many.receipt, { state: 'checking' });

    expect(detail(view, 'Entry keys')).toMatch(/^k0, k1, .*, k19 and 3 more$/);
    expect(detail(view, 'Tags')).toBe('None');
  });

  it('never marks a local replica write as certified', async () => {
    const local = { ...receipt, network: 'local' };
    const view = card.signedWriteCard(local, await checker.checkIcpReceipt(local, CANISTER, { rootKey: root.der }));

    expect(view.view.title).toBe('Signature checked, not anchored to the Internet Computer');
    expect(view.network).toBe('Local replica, as recorded');
    expect(view.time?.label).toBe('Recorded');
    expect(view.provenance).toBe('Decoded in your browser from the signed request. Nothing here shows the canister accepted it.');
    expect(detail(view, 'Commit id, as recorded')).toBe(COMMIT_ID);
    expect(detail(view, 'Network')).toBe('Local replica, as recorded');
    expect(detail(view, 'Certified at')).toBeUndefined();
  });

  it('shows a write whose check failed as recorded and not verified, without naming a signing key', async () => {
    const changed = { ...receipt, senderSig: receipt.senderSig.replace(/^../, receipt.senderSig.startsWith('00') ? '01' : '00') };
    const view = card.signedWriteCard(changed, await checker.checkIcpReceipt(changed, CANISTER, { rootKey: root.der }));

    expect(view.view.title).toBe('Signature does not match');
    expect(view.provenance).toBe('As recorded by this server. Not verified.');
    expect(detail(view, 'Sender')).toBe(receipt.request.sender);
    expect(detail(view, 'Network')).toBe('Internet Computer mainnet, as recorded');
    expect(view.network).toBe('IC mainnet, as recorded');
    expect(view.time?.label).toBe('Recorded');
  });

  it('names the signing key of a write to another canister but never shows it as accepted', async () => {
    const view = card.signedWriteCard(receipt, await checker.checkIcpReceipt(receipt, 'ryjl3-tyaaa-aaaaa-aaaba-cai', { rootKey: root.der }));

    expect(view.view).toMatchObject({ tone: 'neutral', title: 'Written to another canister' });
    expect(view.provenance).toBe('Decoded in your browser from the signed request. Nothing here shows the canister accepted it.');
    expect(detail(view, 'Sender')).toBe(`${receipt.request.sender} (Ed25519 key)`);
    expect(detail(view, 'Canister')).toBe(CANISTER);
    expect(detail(view, 'Commit id, as recorded')).toBe(COMMIT_ID);
    expect(view.network).toBe('IC mainnet, as recorded');
    expect(view.time?.label).toBe('Recorded');
  });

  it('shows a large write waiting for the reader as recorded, with nothing checked', () => {
    const view = card.signedWriteCard(receipt, { state: 'large-unchecked', argBytes: 300 * 1024 });

    expect(view.view).toMatchObject({ tone: 'neutral', title: 'Not checked yet (large write)' });
    expect(view.provenance).toBe('As recorded by this server, until it is checked.');
    expect(view.steps.every((step) => step.outcome === 'not-checked')).toBe(true);
    expect(view.summary).toBe('Commit to polytician-main');
  });

  it('labels the card from a reading of the receipt it is given, so the page decodes each receipt once', async () => {
    const branch = (await signedWrite('ed25519', { root, method: 'createBranchFrom' })).receipt;
    const view = card.signedWriteCard(receipt, { state: 'checking' }, checker.readReceipt(branch));

    expect(view.summary).toBe('New branch polytician-research from main');
  });

  it('shows the server’s fields as recorded while the check runs', () => {
    const view = card.signedWriteCard(receipt, { state: 'checking' });

    expect(view.view.title).toBe('Checking…');
    expect(view.provenance).toBe('As recorded by this server, until the check finishes.');
    expect(view.steps.every((step) => step.outcome === 'not-checked')).toBe(true);
  });

  it('labels a new branch’s reply as a reply', async () => {
    const branch = (await signedWrite('secp256k1', { root, method: 'createBranchFrom' })).receipt;
    const view = card.signedWriteCard(branch, { state: 'checking' });

    expect(view.summary).toBe('New branch polytician-research from main');
    expect(view.result).toEqual({ label: 'Reply', value: 'Branch created: polytician-research' });
    expect(detail(view, 'From branch')).toBe('main');
    expect(detail(view, 'Reply, as recorded')).toBe('Branch created: polytician-research');
  });

  it.each([
    ['null', null],
    ['a string', 'receipt'],
    ['another version', { version: 2, recordedAt: '2026-10-24T10:00:00.000Z' }],
  ])('shows a receipt it cannot read (%s) without inventing fields', (_label, unreadable) => {
    const view = card.signedWriteCard(unreadable, { state: 'check-failed', reason: 'This page cannot read this version of receipt.' });

    expect(view.summary).toBe('Receipt this page cannot read');
    expect(view.result).toBeNull();
    expect(view.sender).toBeNull();
    expect(view.network).toBeNull();
    expect(view.provenance).toBe('As recorded by this server. Not verified.');
    expect(view.details.every((row) => row.label === 'Recorded by this server (its own clock)')).toBe(true);
  });

  it('ignores a recorded time that is not a date', () => {
    expect(card.signedWriteCard({ ...receipt, recordedAt: 'yesterday' }, { state: 'checking' }).time).toBeNull();
  });
});

describe('the signed writes list', () => {
  const RESULT: Check = { state: 'check-failed', reason: 'x' };
  const NAMED = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
  const page = (count: number, nextCursor: string | null, from = 0, skippedLines = 0): Page => ({
    receipts: Array.from({ length: count }, (_, i) => ({ id: `r${from + i}` })),
    nextCursor,
    skippedLines,
    writesConfigured: true,
    canisterId: NAMED,
  });
  /** A receipt whose signed argument is `bytes` long, as far as the list can tell from its hex */
  const sized = (id: string, bytes: number) => ({ id, request: { arg: '00'.repeat(bytes) } });

  function run(...events: ListEvent[]): ListState {
    return events.reduce(list.nextSignedWritesState, list.INITIAL_SIGNED_WRITES);
  }

  /** Starts and finishes the check of receipt `index`, as the page does */
  function checkOne(state: ListState, index: number, result: Check = RESULT): ListState {
    const started = list.nextSignedWritesState(state, { type: 'check-started', generation: state.generation, index });
    return list.nextSignedWritesState(started, { type: 'checked', generation: state.generation, index, result });
  }

  const loaded = (count = 3, cursor: string | null = 'c1') =>
    run({ type: 'load', generation: 1 }, { type: 'loaded', generation: 1, page: page(count, cursor) });

  it('asks for ten at a time and starts out loading', () => {
    expect(list.PAGE_SIZE).toBe(10);
    expect(list.INITIAL_SIGNED_WRITES.status).toBe('loading');
    expect(list.liveMessage(list.INITIAL_SIGNED_WRITES)).toBe('');
  });

  it('keeps the canister the first page names for the whole load', () => {
    const state = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: page(1, 'c1') },
      { type: 'load-older', generation: 1, cursor: 'c1' },
      { type: 'loaded-older', generation: 1, cursor: 'c1', page: { ...page(1, null, 1), canisterId: 'ryjl3-tyaaa-aaaaa-aaaba-cai' } },
    );

    expect(state.canisterId).toBe(NAMED);
  });

  it('checks the loaded receipts one at a time, newest first', () => {
    const state = loaded();

    expect(list.nextToCheck(state)).toBe(0);
    expect(list.checkAt(state, 0)).toEqual({ state: 'checking' });
    // The same object every time, so a waiting card's inputs do not change from one render to the next.
    expect(list.checkAt(state, 1)).toBe(list.checkAt(state, 0));
    expect(list.liveMessage(state)).toBe('Checking signed memory writes…');

    const started = list.nextSignedWritesState(state, { type: 'check-started', generation: 1, index: 0 });
    expect(started.checking).toBe(0);
    expect(list.nextToCheck(started)).toBeNull();
    expect(list.liveMessage(started)).toBe('Checking signed memory writes…');

    const first = list.nextSignedWritesState(started, { type: 'checked', generation: 1, index: 0, result: RESULT });
    expect(first.checks).toEqual([RESULT, null, null]);
    expect(first.checking).toBeNull();
    expect(list.nextToCheck(first)).toBe(1);
    expect(list.checkAt(first, 0)).toBe(RESULT);
  });

  it('starts only the receipt next in line, and only one at a time', () => {
    const state = loaded(2);
    const started = list.nextSignedWritesState(state, { type: 'check-started', generation: 1, index: 0 });

    expect(list.nextSignedWritesState(state, { type: 'check-started', generation: 1, index: 1 })).toBe(state);
    expect(list.nextSignedWritesState(started, { type: 'check-started', generation: 1, index: 0 })).toBe(started);
    expect(list.nextSignedWritesState(started, { type: 'check-started', generation: 1, index: 1 })).toBe(started);
  });

  it('drops a result for a receipt not being checked, already checked, or past the end', () => {
    const state = loaded(2);
    const started = list.nextSignedWritesState(state, { type: 'check-started', generation: 1, index: 0 });
    const notStarted = list.nextSignedWritesState(state, { type: 'checked', generation: 1, index: 0, result: RESULT });
    const another = list.nextSignedWritesState(started, { type: 'checked', generation: 1, index: 1, result: RESULT });
    const once = list.nextSignedWritesState(started, { type: 'checked', generation: 1, index: 0, result: RESULT });
    const twice = list.nextSignedWritesState(once, { type: 'checked', generation: 1, index: 0, result: { state: 'verified' } });

    expect(notStarted).toBe(state);
    expect(another).toBe(started);
    expect(twice).toBe(once);
    expect(list.nextSignedWritesState(loaded(0), { type: 'checked', generation: 1, index: 0, result: RESULT }).checks).toEqual([]);
  });

  it('announces once when every loaded receipt is checked', () => {
    const done = [0, 1].reduce((state, index) => checkOne(state, index), loaded(2));

    expect(list.nextToCheck(done)).toBeNull();
    expect(list.liveMessage(done)).toBe('Finished checking 2 signed memory writes.');
  });

  it('leaves a write over the size limit for the reader, and checks the ones after it', () => {
    const limit = list.AUTO_CHECK_MAX_ARG_BYTES;
    const state = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: { ...page(0, null), receipts: [sized('a', 10), sized('big', limit + 1), sized('c', limit)] } },
    );

    expect(limit).toBe(256 * 1024);
    expect(list.checkAt(state, 1)).toEqual({ state: 'large-unchecked', argBytes: limit + 1 });
    expect(list.nextToCheck(state)).toBe(0);
    const both = checkOne(state, 0);
    expect(list.nextToCheck(both)).toBe(2);
    const done = checkOne(both, 2);
    expect(list.nextToCheck(done)).toBeNull();
    expect(list.liveMessage(done)).toBe('Finished checking 2 signed memory writes. 1 large write is not checked yet.');

    // Asked for, it is checked like any other.
    const asked = list.nextSignedWritesState(done, { type: 'check-requested', generation: 1, index: 1 });
    expect(list.checkAt(asked, 1)).toEqual({ state: 'checking' });
    expect(list.nextToCheck(asked)).toBe(1);
    expect(list.liveMessage(asked)).toBe('Checking signed memory writes…');
    expect(checkOne(asked, 1).checks[1]).toBe(RESULT);
  });

  it('takes a request to check only for a large write that has no result yet, once', () => {
    const limit = list.AUTO_CHECK_MAX_ARG_BYTES;
    const state = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: { ...page(0, null), receipts: [sized('a', 10), sized('big', limit + 1)] } },
    );
    const asked = list.nextSignedWritesState(state, { type: 'check-requested', generation: 1, index: 1 });

    expect(asked.requested).toEqual([1]);
    expect(list.nextSignedWritesState(asked, { type: 'check-requested', generation: 1, index: 1 })).toBe(asked);
    expect(list.nextSignedWritesState(state, { type: 'check-requested', generation: 1, index: 0 })).toBe(state);
    expect(list.nextSignedWritesState(state, { type: 'check-requested', generation: 1, index: 5 })).toBe(state);
    expect(list.nextSignedWritesState(state, { type: 'check-requested', generation: 2, index: 1 })).toBe(state);
  });

  it('appends an older page after the receipts shown, and goes on checking into it', () => {
    const state = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: page(1, 'c1', 0, 2) },
      { type: 'check-started', generation: 1, index: 0 },
      { type: 'checked', generation: 1, index: 0, result: RESULT },
      { type: 'load-older', generation: 1, cursor: 'c1' },
      { type: 'loaded-older', generation: 1, cursor: 'c1', page: page(2, null, 1, 1) },
    );

    expect(state.receipts).toEqual([{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }]);
    expect(state.checks).toEqual([RESULT, null, null]);
    expect(state.skippedLines).toBe(3);
    expect(state.writesConfigured).toBe(true);
    expect(state.nextCursor).toBeNull();
    expect(state.older.status).toBe('idle');
    expect(list.nextToCheck(state)).toBe(1);
  });

  it('loads one older page at a time and never appends the same page twice', () => {
    const loading = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: page(1, 'c1') },
      { type: 'load-older', generation: 1, cursor: 'c1' },
    );
    const appended = list.nextSignedWritesState(loading, { type: 'loaded-older', generation: 1, cursor: 'c1', page: page(1, 'c2', 1) });

    expect(list.nextSignedWritesState(loading, { type: 'load-older', generation: 1, cursor: 'c1' })).toBe(loading);
    expect(list.nextSignedWritesState(appended, { type: 'loaded-older', generation: 1, cursor: 'c1', page: page(1, 'c2', 1) })).toBe(appended);
    expect(appended.receipts).toHaveLength(2);
  });

  it('keeps the receipts shown when an older page fails, and lets it be asked for again', () => {
    const failed = run(
      { type: 'load', generation: 1 },
      { type: 'loaded', generation: 1, page: page(1, 'c1') },
      { type: 'load-older', generation: 1, cursor: 'c1' },
      { type: 'older-failed', generation: 1, cursor: 'c1', error: { message: 'Failed to fetch' } },
    );

    expect(failed.receipts).toHaveLength(1);
    expect(failed.older).toEqual({ status: 'error', error: { message: 'Failed to fetch' } });
    expect(list.nextSignedWritesState(failed, { type: 'load-older', generation: 1, cursor: 'c1' }).older.status).toBe('loading');
  });

  it('starts afresh on a new load and drops every answer that belongs to the one before', () => {
    const before = loaded();
    const reloaded = list.nextSignedWritesState(before, { type: 'load', generation: 2 });

    expect(reloaded).toEqual({ ...list.INITIAL_SIGNED_WRITES, generation: 2 });
    for (const late of [
      { type: 'loaded', generation: 1, page: page(5, null) },
      { type: 'load-failed', generation: 1, error: { message: 'late' } },
      { type: 'check-started', generation: 1, index: 0 },
      { type: 'checked', generation: 1, index: 0, result: RESULT },
    ] as ListEvent[]) {
      expect(list.nextSignedWritesState(reloaded, late)).toBe(reloaded);
    }
  });

  it('shows a load that failed', () => {
    const failed = run({ type: 'load', generation: 1 }, { type: 'load-failed', generation: 1, error: { message: 'Unauthorized' } });

    expect(failed).toMatchObject({ status: 'error', error: { message: 'Unauthorized' }, receipts: [] });
    expect(list.liveMessage(failed)).toBe('');
  });

  it('reads the API page envelope and leaves each receipt to its own check', () => {
    const data = {
      receipts: [null, { id: 'x' }],
      nextCursor: 'abc',
      skippedLines: 2,
      oldestKept: '2026-10-24',
      writesConfigured: false,
      canisterId: NAMED,
    };

    expect(list.readSignedWritesPage(data)).toEqual({
      receipts: [null, { id: 'x' }],
      nextCursor: 'abc',
      skippedLines: 2,
      writesConfigured: false,
      canisterId: NAMED,
    });
  });

  it('treats a count or canister the server leaves out or garbles as not said', () => {
    for (const [skippedLines, canisterId] of [[undefined, undefined], [-1, null], [1.5, ''], ['2', 7]]) {
      expect(list.readSignedWritesPage({ receipts: [], nextCursor: null, skippedLines, writesConfigured: 'yes', canisterId })).toEqual({
        receipts: [],
        nextCursor: null,
        skippedLines: 0,
        writesConfigured: null,
        canisterId: null,
      });
    }
  });

  it.each([
    ['no data', null],
    ['receipts that are not a list', { receipts: {}, nextCursor: null }],
    ['a missing cursor', { receipts: [] }],
    ['a cursor that is not a string', { receipts: [], nextCursor: 3 }],
    ['an empty cursor', { receipts: [], nextCursor: '' }],
  ])('refuses a page with %s', (_label, data) => {
    expect(list.readSignedWritesPage(data)).toBeNull();
  });
});
