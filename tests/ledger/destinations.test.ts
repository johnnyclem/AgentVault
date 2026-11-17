import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AnchorPassError,
  GENESIS_HASH,
  LedgerCorruptError,
  LedgerStore,
  MemoryRepoAnchor,
  anchorPending,
  createDestinationRouter,
  destinationOf,
  rebuildFromMemoryRepo,
  startAnchorSchedule,
  type AnchorCheckpoint,
  type LedgerAnchor,
} from '../../src/ledger/index.js';
import { FakeCanister } from './fake-canister.js';
import { entry } from './helpers.js';

let dir: string;
let store: LedgerStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-destinations-'));
  store = LedgerStore.open(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entries = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => entry(from + index));

/** An anchor for `destination` that keeps what it is given, and refuses while `refusing()` says so. */
function anchorFor(destination: string, refusing: () => boolean = () => false): LedgerAnchor & { checkpoints: AnchorCheckpoint[] } {
  const checkpoints: AnchorCheckpoint[] = [];
  return {
    kind: 'test',
    destination,
    maxCheckpointBytes: 900_000,
    checkpoints,
    async anchor(checkpoint) {
      if (refusing()) throw new Error(`${destination} refused the write`);
      checkpoints.push(checkpoint);
      return { kind: 'test', id: `${destination}-${checkpoints.length}` };
    },
  };
}

describe('where a stream is anchored (the store)', () => {
  it('keeps the place a stream names across a restart, and puts it back with the rest when cleared', () => {
    store.setAnchorTarget('bot-1', 'canister-a');
    store.setAnchorTarget('space-1', 'canister-b');
    expect(store.anchorTarget('bot-1')).toBe('canister-a');
    expect(store.anchorTarget('bot-9')).toBeNull();

    const reopened = LedgerStore.open(dir);
    expect(reopened.anchorTargets()).toEqual({ 'bot-1': 'canister-a', 'space-1': 'canister-b' });

    reopened.setAnchorTarget('bot-1', null);
    reopened.setAnchorTarget('bot-1', null);
    expect(LedgerStore.open(dir).anchorTargets()).toEqual({ 'space-1': 'canister-b' });
  });

  it('names a place for a stream that holds no entries yet, and refuses what is not a stream id', () => {
    store.setAnchorTarget('bot-new', 'canister-a');
    expect(store.streams()).toEqual([]);
    expect(() => store.setAnchorTarget('../escape', 'canister-a')).toThrow(/Invalid stream id/);
  });

  it('refuses a file of places it cannot read, rather than guessing', () => {
    store.setAnchorTarget('bot-1', 'canister-a');
    fs.writeFileSync(path.join(dir, 'anchor-targets.json'), JSON.stringify({ format: 'agentvault-ledger-targets/v1', targets: { 'bot-1': '' } }));
    expect(() => LedgerStore.open(dir)).toThrow(LedgerCorruptError);
    fs.writeFileSync(path.join(dir, 'anchor-targets.json'), '{"not":"ours"}');
    expect(() => LedgerStore.open(dir)).toThrow(LedgerCorruptError);
  });

  it('counts how far a stream is anchored at each place, including records from before places had names', () => {
    store.append('bot-1', entries(1, 4));
    const record = (to: number, extra: object) => ({ stream: 'bot-1', from: 1, to, head: 'h', anchoredAt: 'now', ...extra });
    store.recordAnchor({ ...record(3, { destination: 'canister-a' }), evidence: { kind: 'test' } });
    store.recordAnchor({ ...record(1, { destination: 'canister-b' }), evidence: { kind: 'test' } });
    // An older record names its canister only in its evidence.
    store.recordAnchor({ ...record(2, {}), evidence: { kind: 'icp-memory-repo', canisterId: 'canister-c' } });

    for (const open of [store, LedgerStore.open(dir)]) {
      expect(open.anchoredSeq('bot-1', 'canister-a')).toBe(3);
      expect(open.anchoredSeq('bot-1', 'canister-b')).toBe(1);
      expect(open.anchoredSeq('bot-1', 'canister-c')).toBe(2);
      expect(open.anchoredSeq('bot-1', 'canister-d')).toBe(0);
      // With no place named, the furthest it has got anywhere.
      expect(open.anchoredSeq('bot-1')).toBe(3);
    }
  });
});

describe('anchorPending with a place for each stream', () => {
  it('anchors each stream where it belongs, records where, and leaves a stream with no place alone', async () => {
    store.append('bot-1', entries(1, 2));
    store.append('space-1', entries(1, 1));
    store.append('stray-1', entries(1, 1));
    const a = anchorFor('canister-a');
    const b = anchorFor('canister-b');
    const route = (stream: string) => ({ 'bot-1': a, 'space-1': b })[stream as 'bot-1'] ?? null;

    const records = await anchorPending(store, route);

    expect(records.map((record) => [record.stream, record.destination])).toEqual([
      ['bot-1', 'canister-a'],
      ['space-1', 'canister-b'],
    ]);
    expect(a.checkpoints.map((checkpoint) => checkpoint.stream)).toEqual(['bot-1']);
    expect(b.checkpoints.map((checkpoint) => checkpoint.stream)).toEqual(['space-1']);
    expect(store.anchoredSeq('stray-1')).toBe(0);
  });

  it('anchors all of a stream at a new place after it moves, and leaves what the old place holds', async () => {
    store.append('bot-1', entries(1, 3));
    const a = anchorFor('canister-a');
    const b = anchorFor('canister-b');
    let place: LedgerAnchor = a;
    await anchorPending(store, () => place);
    store.append('bot-1', entries(4, 5));

    place = b;
    await anchorPending(store, () => place);

    // The new place has the whole stream from its first entry, so it can be rebuilt on its own.
    expect(b.checkpoints).toHaveLength(1);
    expect(b.checkpoints[0]).toMatchObject({ from: 1, to: 5, prev: GENESIS_HASH });
    expect(a.checkpoints.map((checkpoint) => [checkpoint.from, checkpoint.to])).toEqual([[1, 3]]);
    expect(store.anchoredSeq('bot-1', 'canister-a')).toBe(3);
    expect(store.anchoredSeq('bot-1', 'canister-b')).toBe(5);
  });

  it('does not let one place that refuses hold up the others, and reports all of them together', async () => {
    store.append('bot-1', entries(1, 1));
    store.append('bot-2', entries(1, 1));
    store.append('space-1', entries(1, 1));
    let refusing = true;
    const a = anchorFor('canister-a', () => refusing);
    const b = anchorFor('canister-b');
    const route = (stream: string) => (stream === 'space-1' ? b : a);

    const failure = await anchorPending(store, route).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AnchorPassError);
    const { failures, records } = failure as AnchorPassError;
    // bot-1 failed, bot-2 was not tried after it: the same place had already refused.
    expect(failures.map((item) => [item.stream, item.destination])).toEqual([['bot-1', 'canister-a']]);
    expect((failure as Error).message).toBe('bot-1: canister-a refused the write');
    expect(records.map((record) => record.stream)).toEqual(['space-1']);
    expect(store.anchoredSeq('space-1', 'canister-b')).toBe(1);

    refusing = false;
    const retried = await anchorPending(store, route);
    expect(retried.map((record) => record.stream)).toEqual(['bot-1', 'bot-2']);
  });

  it('counts a stream whose place cannot be reached as that stream failing, and not the rest', async () => {
    store.append('bot-1', entries(1, 1));
    store.append('space-1', entries(1, 1));
    const b = anchorFor('canister-b');
    const route = (stream: string) => {
      if (stream === 'bot-1') throw new Error('no such canister');
      return b;
    };

    const failure = (await anchorPending(store, route).catch((error: unknown) => error)) as AnchorPassError;

    expect(failure.failures.map((item) => [item.stream, (item.error as Error).message])).toEqual([['bot-1', 'no such canister']]);
    expect(failure.records.map((record) => record.stream)).toEqual(['space-1']);
  });
});

describe('createDestinationRouter', () => {
  it('sends a stream to the place it names, else the default, else nowhere', async () => {
    store.setAnchorTarget('bot-1', 'canister-a');
    const connected: string[] = [];
    const connect = async (id: string) => {
      connected.push(id);
      return new FakeCanister({ canisterId: id });
    };

    const withDefault = createDestinationRouter({ store, connect, defaultDestination: 'canister-d' });
    expect((await withDefault('bot-1'))?.destination).toBe('canister-a');
    expect((await withDefault('space-1'))?.destination).toBe('canister-d');

    const without = createDestinationRouter({ store, connect });
    expect(await without('space-1')).toBeNull();
    expect((await without('bot-1'))?.destination).toBe('canister-a');
    expect(destinationOf(store, undefined, 'space-1')).toBeNull();
    expect(destinationOf(store, 'canister-d', 'space-1')).toBe('canister-d');
  });

  it('connects to each canister once, and tries again after a connection fails', async () => {
    store.setAnchorTarget('bot-1', 'canister-a');
    store.setAnchorTarget('bot-2', 'canister-a');
    let attempts = 0;
    const route = createDestinationRouter({
      store,
      connect: async (id) => {
        attempts += 1;
        if (attempts === 1) throw new Error('replica unreachable');
        return new FakeCanister({ canisterId: id });
      },
    });

    await expect(Promise.resolve(route('bot-1'))).rejects.toThrow('replica unreachable');
    const first = await route('bot-1');
    const second = await route('bot-2');

    expect(first).toBe(second);
    expect(attempts).toBe(2);
  });

  it("keeps each owner's streams on their own canister, and each canister rebuilds to only its own", async () => {
    const owners = { 'bot-a': new FakeCanister({ canisterId: 'canister-a' }), 'bot-b': new FakeCanister({ canisterId: 'canister-b' }) };
    store.setAnchorTarget('bot-a', 'canister-a');
    store.setAnchorTarget('bot-b', 'canister-b');
    store.append('bot-a', entries(1, 3));
    store.append('bot-b', entries(1, 2));
    const canisters = new Map(Object.values(owners).map((canister) => [canister.canisterId, canister]));
    const route = createDestinationRouter({ store, connect: async (id) => canisters.get(id)! });

    await anchorPending(store, route);

    for (const [stream, canister] of [['bot-a', owners['bot-a']], ['bot-b', owners['bot-b']]] as const) {
      const recovered = LedgerStore.open(path.join(dir, `recovered-${stream}`));
      const report = await rebuildFromMemoryRepo(canister, recovered);
      expect(report.problems).toEqual([]);
      expect(recovered.streams()).toEqual([stream]);
      expect(fs.readFileSync(path.join(recovered.dir, 'streams', `${stream}.jsonl`)).equals(fs.readFileSync(path.join(dir, 'streams', `${stream}.jsonl`)))).toBe(true);
    }
  });

  it('writes through the real anchor, so each checkpoint is committed on the canister it names', async () => {
    store.setAnchorTarget('bot-a', 'canister-a');
    store.append('bot-a', entries(1, 1));
    const canister = new FakeCanister({ canisterId: 'canister-a' });
    const route = createDestinationRouter({ store, connect: async () => canister });

    const [record] = await anchorPending(store, route);

    expect(record).toMatchObject({ destination: 'canister-a', evidence: { kind: 'icp-memory-repo', canisterId: 'canister-a' } });
    expect(await new MemoryRepoAnchor(canister).destination).toBe('canister-a');
  });
});

describe('startAnchorSchedule with places of their own', () => {
  it('anchors what it can, reports it, and remembers why a stream could not be until it can', async () => {
    store.append('bot-1', entries(1, 1));
    store.append('space-1', entries(1, 1));
    let refusing = true;
    const a = anchorFor('canister-a', () => refusing);
    const b = anchorFor('canister-b');
    const anchored: string[] = [];
    const errors: unknown[] = [];
    const schedule = startAnchorSchedule(store, (stream) => (stream === 'space-1' ? b : a), {
      intervalMs: 3_600_000,
      onAnchored: (records) => anchored.push(...records.map((record) => record.stream)),
      onError: (error) => errors.push(error),
    });

    await schedule.run();
    expect(anchored).toEqual(['space-1']);
    expect(errors).toHaveLength(1);
    expect(schedule.error('bot-1')).toBe('canister-a refused the write');
    expect(schedule.error('space-1')).toBeNull();

    refusing = false;
    await schedule.run();
    expect(anchored).toEqual(['space-1', 'bot-1']);
    expect(schedule.error('bot-1')).toBeNull();
    await schedule.stop();
  });
});
