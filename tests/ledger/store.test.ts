import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GENESIS_HASH,
  LedgerConflictError,
  LedgerCorruptError,
  LedgerStore,
  checkChain,
  entryHash,
  type LedgerEntryInput,
} from '../../src/ledger/index.js';
import { entry } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const STREAM = 'bot-1';

function streamFile(stream = STREAM): string {
  return path.join(dir, 'streams', `${stream}.jsonl`);
}

describe('entry hash', () => {
  it('is fixed by the format, so stored ledgers stay verifiable across releases', () => {
    const first: LedgerEntryInput = { seq: 1, kind: 'memory.revision', at: '2026-01-01T00:00:00.000Z', payload: 'aGVsbG8' };
    // The preimage is the newline-joined fields, with the digest of the payload's bytes last.
    const payloadDigest = createHash('sha256').update('hello').digest('hex');
    const preimage = ['agentvault-ledger/v1', 'bot-1', '1', GENESIS_HASH, 'memory.revision', '2026-01-01T00:00:00.000Z', payloadDigest];
    expect(entryHash('bot-1', first, GENESIS_HASH)).toBe(createHash('sha256').update(preimage.join('\n')).digest('hex'));
    expect(entryHash('bot-1', first, GENESIS_HASH)).toBe('001b5f2cc208dd47e29b9f2892e6e62329648b8a1c178735c62f7e5991d8c3a8');
  });

  it('changes with the stream, the position and what came before', () => {
    const base = entryHash(STREAM, entry(1), GENESIS_HASH);
    expect(entryHash('bot-2', entry(1), GENESIS_HASH)).not.toBe(base);
    expect(entryHash(STREAM, { ...entry(1), seq: 2 }, GENESIS_HASH)).not.toBe(base);
    expect(entryHash(STREAM, entry(1), 'f'.repeat(64))).not.toBe(base);
    expect(entryHash(STREAM, entry(1, 'other'), GENESIS_HASH)).not.toBe(base);
  });
});

describe('LedgerStore append', () => {
  it('chains entries and keeps them across a restart', () => {
    const store = LedgerStore.open(dir);
    expect(store.head(STREAM)).toBeNull();
    const first = store.append(STREAM, [entry(1), entry(2)]);
    expect(first).toMatchObject({ appended: 2, head: { seq: 2 } });
    const second = store.append(STREAM, [entry(3)]);
    expect(second.head.seq).toBe(3);

    const reopened = LedgerStore.open(dir);
    expect(reopened.head(STREAM)).toEqual(second.head);
    const entries = reopened.read(STREAM);
    expect(entries.map((stored) => stored.seq)).toEqual([1, 2, 3]);
    expect(entries[0]!.prev).toBe(GENESIS_HASH);
    expect(entries[1]!.prev).toBe(entries[0]!.hash);
    expect(checkChain(STREAM, entries)).toEqual({ ok: true, head: second.head });
    expect(reopened.streams()).toEqual([STREAM]);
  });

  it('accepts the same entries again without storing them twice', () => {
    const store = LedgerStore.open(dir);
    const { head } = store.append(STREAM, [entry(1), entry(2)]);
    expect(store.append(STREAM, [entry(1), entry(2)])).toEqual({ head, appended: 0 });
    // A retry that overlaps what was stored and carries on past it.
    expect(store.append(STREAM, [entry(2), entry(3)])).toMatchObject({ appended: 1, head: { seq: 3 } });
    expect(store.read(STREAM)).toHaveLength(3);
  });

  it('refuses an entry that differs from the one already stored, and writes nothing', () => {
    const store = LedgerStore.open(dir);
    const { head } = store.append(STREAM, [entry(1), entry(2)]);
    const before = fs.readFileSync(streamFile(), 'utf8');
    let error: unknown;
    try {
      store.append(STREAM, [entry(2, 'rewritten'), entry(3)]);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LedgerConflictError);
    expect(error).toMatchObject({ reason: 'conflict', head });
    expect(fs.readFileSync(streamFile(), 'utf8')).toBe(before);
    expect(store.head(STREAM)).toEqual(head);
  });

  it('refuses a batch that skips ahead or is not consecutive', () => {
    const store = LedgerStore.open(dir);
    store.append(STREAM, [entry(1)]);
    expect(() => store.append(STREAM, [entry(3)])).toThrowError(expect.objectContaining({ reason: 'gap', head: store.head(STREAM) }));
    expect(() => store.append(STREAM, [entry(2), entry(4)])).toThrowError(expect.objectContaining({ reason: 'gap' }));
    expect(() => store.append('bot-2', [entry(2)])).toThrowError(expect.objectContaining({ reason: 'gap', head: null }));
    expect(store.read(STREAM)).toHaveLength(1);
  });

  it('keeps streams apart', () => {
    const store = LedgerStore.open(dir);
    store.append('bot-1', [entry(1)]);
    store.append('space-1', [entry(1), entry(2)]);
    expect(store.streams()).toEqual(['bot-1', 'space-1']);
    expect(store.head('bot-1')!.seq).toBe(1);
    expect(store.head('space-1')!.seq).toBe(2);
    expect(store.head('bot-1')!.hash).not.toBe(store.read('space-1')[0]!.hash);
  });

  it('rejects stream ids that could escape the directory or collide on disk', () => {
    const store = LedgerStore.open(dir);
    for (const stream of ['../x', 'a/b', 'Bot-1', '', '.hidden', 'a'.repeat(101)]) {
      expect(() => store.append(stream, [entry(1)])).toThrow(/Invalid stream id/);
    }
  });
});

describe('LedgerStore read', () => {
  it('pages by sequence number', () => {
    const store = LedgerStore.open(dir);
    store.append(STREAM, [1, 2, 3, 4, 5].map((seq) => entry(seq)));
    expect(store.read(STREAM, { after: 0, limit: 2 }).map((stored) => stored.seq)).toEqual([1, 2]);
    expect(store.read(STREAM, { after: 2, limit: 2 }).map((stored) => stored.seq)).toEqual([3, 4]);
    expect(store.read(STREAM, { after: 4, limit: 10 }).map((stored) => stored.seq)).toEqual([5]);
    expect(store.read(STREAM, { after: 5 })).toEqual([]);
    expect(store.read('unknown')).toEqual([]);
    expect(Buffer.from(store.read(STREAM, { after: 2, limit: 1 })[0]!.payload, 'base64url').toString()).toBe('record 3');
  });
});

describe('LedgerStore integrity', () => {
  it('drops a partial last line left by a crash and carries on from the last whole entry', () => {
    const store = LedgerStore.open(dir);
    const { head } = store.append(STREAM, [entry(1), entry(2)]);
    fs.appendFileSync(streamFile(), '{"seq":3,"kind":"memory.rev');

    const reopened = LedgerStore.open(dir);
    expect(reopened.head(STREAM)).toEqual(head);
    expect(reopened.append(STREAM, [entry(3)]).head.seq).toBe(3);
    expect(reopened.verify(STREAM)).toMatchObject({ ok: true, entries: 3 });
  });

  it('refuses a stream whose stored entry was edited', () => {
    const store = LedgerStore.open(dir);
    store.append(STREAM, [entry(1), entry(2), entry(3)]);
    const lines = fs.readFileSync(streamFile(), 'utf8').trimEnd().split('\n');
    const edited = { ...JSON.parse(lines[1]!), payload: Buffer.from('forged').toString('base64url') };
    lines[1] = JSON.stringify(edited);
    fs.writeFileSync(streamFile(), `${lines.join('\n')}\n`);

    expect(store.verify(STREAM)).toMatchObject({ ok: false, seq: 2 });
    const reopened = LedgerStore.open(dir);
    expect(() => reopened.head(STREAM)).toThrow(LedgerCorruptError);
    expect(() => reopened.append(STREAM, [entry(4)])).toThrow(LedgerCorruptError);
  });

  it('notices an entry removed from the middle', () => {
    const store = LedgerStore.open(dir);
    store.append(STREAM, [entry(1), entry(2), entry(3)]);
    const lines = fs.readFileSync(streamFile(), 'utf8').trimEnd().split('\n');
    fs.writeFileSync(streamFile(), `${[lines[0], lines[2]].join('\n')}\n`);
    expect(store.verify(STREAM)).toMatchObject({ ok: false, seq: 3 });
  });

  it('refuses to append after another process wrote the same stream', () => {
    const store = LedgerStore.open(dir);
    store.append(STREAM, [entry(1)]);
    const other = LedgerStore.open(dir);
    other.append(STREAM, [entry(2)]);
    expect(() => store.append(STREAM, [entry(2, 'fork')])).toThrow(/one writer/);
    expect(other.verify(STREAM)).toMatchObject({ ok: true, entries: 2 });
  });

  it('refuses a directory that is not a ledger', () => {
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ format: 'something-else' }));
    expect(() => LedgerStore.open(dir)).toThrow(LedgerCorruptError);
  });
});

describe('LedgerStore anchors', () => {
  it('remembers how far each stream is anchored across a restart', () => {
    const store = LedgerStore.open(dir);
    const { head } = store.append(STREAM, [entry(1), entry(2)]);
    expect(store.anchoredSeq(STREAM)).toBe(0);
    store.recordAnchor({ stream: STREAM, from: 1, to: 2, head: head.hash, anchoredAt: '2026-01-01T00:00:00.000Z', evidence: { kind: 'test', id: 'a1' } });

    const reopened = LedgerStore.open(dir);
    expect(reopened.anchoredSeq(STREAM)).toBe(2);
    expect(reopened.anchoredSeq('space-1')).toBe(0);
    expect(reopened.anchors(STREAM)).toEqual([
      { stream: STREAM, from: 1, to: 2, head: head.hash, anchoredAt: '2026-01-01T00:00:00.000Z', evidence: { kind: 'test', id: 'a1' } },
    ]);
    expect(reopened.anchors('space-1')).toEqual([]);
  });
});
