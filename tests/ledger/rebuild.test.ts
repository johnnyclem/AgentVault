import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ANCHOR_FORMAT,
  GENESIS_HASH,
  LedgerStore,
  MemoryRepoAnchor,
  anchorPending,
  chainEntry,
  checkMemoryRepoAnchor,
  memoryRepoHistory,
  rebuildFromMemoryRepo,
  type AnchorCheckpoint,
} from '../../src/ledger/index.js';
import { FakeCanister } from './fake-canister.js';
import { entry } from './helpers.js';

let root: string;
let original: LedgerStore;
let rebuilt: LedgerStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-rebuild-'));
  original = LedgerStore.open(path.join(root, 'original'));
  rebuilt = LedgerStore.open(path.join(root, 'rebuilt'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const entries = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => entry(from + index));

/** The checkpoint for `stream` `from`-`to` as the anchor writes it, built from `store`. */
function checkpointOf(store: LedgerStore, stream: string, from: number, to: number): AnchorCheckpoint {
  const stored = store.read(stream, { after: from - 1, limit: to - from + 1 });
  return {
    format: ANCHOR_FORMAT,
    stream,
    from,
    to,
    prev: from === 1 ? GENESIS_HASH : store.read(stream, { after: from - 2, limit: 1 })[0]!.hash,
    head: stored.at(-1)!.hash,
    entries: stored.map(({ seq, kind, at, payload }) => ({ seq, kind, at, payload })),
  };
}

/** Writes `checkpoint` to the ledger branch the way an anchor does. */
async function commitCheckpoint(repo: FakeCanister, checkpoint: AnchorCheckpoint): Promise<void> {
  await new MemoryRepoAnchor(repo).anchor(checkpoint);
}

const streamFile = (store: LedgerStore, stream: string) => fs.readFileSync(path.join(store.dir, 'streams', `${stream}.jsonl`));

describe('rebuildFromMemoryRepo', () => {
  it('rebuilds what the anchor wrote into a ledger identical to the original, from the canister alone', async () => {
    const repo = new FakeCanister();
    const anchor = new MemoryRepoAnchor(repo);
    // Several runs, so each stream is anchored in more than one checkpoint and the streams interleave.
    original.append('bot-1', entries(1, 3));
    original.append('space-1', entries(1, 2));
    await anchorPending(original, anchor);
    original.append('bot-1', entries(4, 9));
    await anchorPending(original, anchor);
    original.append('space-1', entries(3, 3));
    original.append('bot-1', entries(10, 10));
    await anchorPending(original, anchor);

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual([]);
    expect(report.commits).toBe(5);
    expect(report.streams).toEqual([
      { stream: 'bot-1', entries: 10, head: original.head('bot-1'), complete: true },
      { stream: 'space-1', entries: 3, head: original.head('space-1'), complete: true },
    ]);
    for (const stream of original.streams()) {
      expect(streamFile(rebuilt, stream).equals(streamFile(original, stream))).toBe(true);
      expect(rebuilt.verify(stream)).toMatchObject({ ok: true });
      expect(rebuilt.anchoredSeq(stream)).toBe(original.anchoredSeq(stream));
    }
  });

  it('records the anchors it came from, so they verify against the canister like the gateway\'s own', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 4));
    await anchorPending(original, new MemoryRepoAnchor(repo));

    await rebuildFromMemoryRepo(repo, rebuilt);

    const [record] = rebuilt.anchors('bot-1');
    expect(record).toMatchObject({ stream: 'bot-1', from: 1, to: 4, evidence: { kind: 'icp-memory-repo', canisterId: 'aaaaa-aa', branch: 'ledger', receipt: null } });
    const stored = rebuilt.read('bot-1', { after: 0, limit: 4 });
    await expect(checkMemoryRepoAnchor(repo, record!, stored)).resolves.toMatchObject({ ok: true });
  });

  it('takes a range anchored twice once, and rebuilds across a range that overlaps the one before', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 8));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 3));
    // Anchored again after a crash that lost the acknowledgement.
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 3));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 2, 5));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 6, 8));

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual([]);
    expect(streamFile(rebuilt, 'bot-1').equals(streamFile(original, 'bot-1'))).toBe(true);
    expect(rebuilt.anchoredSeq('bot-1')).toBe(8);
  });

  it('writes a stream as far as it goes and says where it stops when a range is not on the canister', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 8));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 3));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 6, 8));

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual(['bot-1 6-8: entries 4-5 are not on the canister']);
    expect(report.streams).toEqual([{ stream: 'bot-1', entries: 3, head: original.read('bot-1', { limit: 3 }).at(-1) && { seq: 3, hash: original.read('bot-1', { limit: 3 })[2]!.hash }, complete: false }]);
    expect(rebuilt.anchoredSeq('bot-1')).toBe(3);
  });

  it('cannot rebuild a range that was anchored as hashes only, and keeps what came before it', async () => {
    const repo = new FakeCanister();
    const anchor = new MemoryRepoAnchor(repo);
    original.append('bot-1', entries(1, 3));
    await anchorPending(original, anchor);
    original.append('bot-1', entries(4, 6));
    original.append('space-1', entries(1, 2));
    await anchorPending(original, anchor, { inlineEntries: false });

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual([
      'bot-1 4-6: anchored as hashes only, so the canister does not hold the entries',
      'space-1 1-2: anchored as hashes only, so the canister does not hold the entries',
    ]);
    expect(report.streams.map(({ stream, entries: n, complete }) => [stream, n, complete])).toEqual([
      ['bot-1', 3, false],
      ['space-1', 0, false],
    ]);
    expect(rebuilt.streams()).toEqual(['bot-1']);
  });

  it('refuses a copy whose entries do not match what was anchored, or that disagrees with an earlier one', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 4));
    original.append('space-1', entries(1, 4));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 2));
    // An entry changed after the head was computed.
    const altered = checkpointOf(original, 'bot-1', 3, 4);
    altered.entries![1] = { ...altered.entries![1]!, payload: Buffer.from('changed').toString('base64url') };
    await commitCheckpoint(repo, altered);
    await commitCheckpoint(repo, checkpointOf(original, 'space-1', 1, 4));
    // The same range again, saying something else.
    const other = LedgerStore.open(path.join(root, 'other'));
    other.append('space-1', [entry(1, 'a different first entry'), ...entries(2, 4)]);
    await commitCheckpoint(repo, checkpointOf(other, 'space-1', 1, 4));

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual([
      'bot-1 3-4: the copy does not rebuild to the anchored head',
      'space-1 1-4: the anchors disagree about entry 4',
    ]);
    expect(rebuilt.head('bot-1')?.seq).toBe(2);
    expect(rebuilt.head('space-1')?.seq).toBe(4);
  });

  it('refuses a range that overlaps the one before it but says something different about the overlap', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 5));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 3));
    // Entry 1 is the same, entry 2 is not: a different history from the second entry on.
    const other = LedgerStore.open(path.join(root, 'other'));
    other.append('bot-1', [entry(1), entry(2, 'something else'), ...entries(3, 5)]);
    await commitCheckpoint(repo, checkpointOf(other, 'bot-1', 2, 5));

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual(['bot-1 2-5: the anchors disagree about entry 2']);
    expect(rebuilt.head('bot-1')?.seq).toBe(3);
    expect(rebuilt.read('bot-1', { after: 1, limit: 1 })[0]).toEqual(original.read('bot-1', { after: 1, limit: 1 })[0]);
  });

  it('refuses a range that does not continue from the entries before it', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 4));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 2));
    const forged = checkpointOf(original, 'bot-1', 3, 4);
    forged.prev = '1'.repeat(64);
    await commitCheckpoint(repo, forged);

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual(['bot-1 3-4: it does not continue from the entries before it']);
    expect(rebuilt.head('bot-1')?.seq).toBe(2);
  });

  it('skips a commit on the ledger branch that is not a checkpoint, and says so', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 2));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 2));
    repo.append('ledger', 'notes', 'not json', []);
    repo.append('ledger', 'other', JSON.stringify({ format: 'something-else' }), []);

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual([
      "Commit c_4 on 'ledger' was skipped: it is not a ledger checkpoint",
      "Commit c_3 on 'ledger' was skipped: it is not JSON",
    ]);
    expect(rebuilt.head('bot-1')?.seq).toBe(2);
  });

  it('never writes outside the ledger, whatever stream a checkpoint on the canister names', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 2));
    const evil = { ...checkpointOf(original, 'bot-1', 1, 2), stream: '../../escaped' };
    repo.append('ledger', 'ledger ../../escaped 1-2', JSON.stringify(evil), []);
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 2));

    const report = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(report.problems).toEqual(["Commit c_2 on 'ledger' was skipped: it names no valid stream"]);
    expect(rebuilt.streams()).toEqual(['bot-1']);
    expect(fs.existsSync(path.join(root, 'escaped.jsonl'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['original', 'rebuilt']);
  });

  it('rebuilds one stream when asked, and reports one that is not there', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 2));
    original.append('space-1', entries(1, 2));
    await anchorPending(original, new MemoryRepoAnchor(repo));

    const only = await rebuildFromMemoryRepo(repo, rebuilt, { stream: 'space-1' });
    expect(only.streams.map((s) => s.stream)).toEqual(['space-1']);
    expect(rebuilt.streams()).toEqual(['space-1']);

    const missing = await rebuildFromMemoryRepo(repo, LedgerStore.open(path.join(root, 'missing')), { stream: 'bot-9' });
    expect(missing.problems).toEqual(["Stream bot-9 has no checkpoints on 'ledger'"]);
    await expect(rebuildFromMemoryRepo(repo, rebuilt, { stream: 'Not A Stream' })).rejects.toThrow(/Invalid stream id/);
  });

  it('leaves a stream the ledger already holds alone', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 3));
    await anchorPending(original, new MemoryRepoAnchor(repo));
    await rebuildFromMemoryRepo(repo, rebuilt);

    const again = await rebuildFromMemoryRepo(repo, rebuilt);

    expect(again.problems).toEqual(['bot-1: the ledger already holds this stream; rebuild into an empty directory']);
    expect(rebuilt.head('bot-1')?.seq).toBe(3);
  });

  it('says so when nothing was ever anchored, and refuses a canister that holds no ledger', async () => {
    const repo = new FakeCanister();
    await new MemoryRepoAnchor(repo).anchor(checkpointOf((original.append('bot-1', entries(1, 1)), original), 'bot-1', 1, 1));
    const empty = new FakeCanister();
    await empty.createBranch('ledger', 'main');

    expect(await rebuildFromMemoryRepo(empty, rebuilt)).toMatchObject({ commits: 0, streams: [], problems: [] });
    await expect(rebuildFromMemoryRepo(new FakeCanister(), rebuilt)).rejects.toThrow(/has no 'ledger' branch/);
    // A canister anchored to a branch of another name is found by naming it.
    const named = new FakeCanister();
    await named.createBranch('audit', 'main');
    await named.commit('audit', 'ledger bot-1 1-1', JSON.stringify(checkpointOf(original, 'bot-1', 1, 1)), []);
    expect((await rebuildFromMemoryRepo(named, rebuilt, { branch: 'audit' })).streams).toHaveLength(1);
  });

  it('refuses a history that names a commit the canister does not hold, or that loops', async () => {
    const repo = new FakeCanister();
    original.append('bot-1', entries(1, 1));
    await commitCheckpoint(repo, checkpointOf(original, 'bot-1', 1, 1));
    repo.commits.find((commit) => commit.id === 'c_2')!.parent = 'c_99';
    await expect(rebuildFromMemoryRepo(repo, rebuilt)).rejects.toThrow('does not hold it');

    const looping = new FakeCanister();
    await commitCheckpoint(looping, checkpointOf(original, 'bot-1', 1, 1));
    looping.commits.find((commit) => commit.id === 'c_2')!.parent = 'c_2';
    await expect(rebuildFromMemoryRepo(looping, LedgerStore.open(path.join(root, 'loop')))).rejects.toThrow('does not end');
  });

  it('chains entries exactly as the store does, so what it writes is what a gateway would have', () => {
    // The store recomputes the chain on append, so a rebuilt entry and a stored one agree by construction.
    const first = chainEntry('bot-1', entry(1), GENESIS_HASH);
    original.append('bot-1', [entry(1)]);
    expect(original.read('bot-1')[0]).toEqual(first);
  });
});

describe('memoryRepoHistory', () => {
  const commit = (id: string, parent: [string] | [], branch: string) => ({
    id,
    timestamp: 1_700_000_000_000_000_000n,
    message: 'm',
    diff: `diff ${id}`,
    tags: [],
    parent,
    branch,
  });

  it('reads the canister the way it answers: branch heads as pairs, and an optional parent or commit as an array', async () => {
    const history = memoryRepoHistory('aaaaa-aa', 'ic', {
      getBranches: async () => [
        ['main', 'c1'],
        ['ledger', 'c3'],
      ],
      getCommit: async (id: string) =>
        id === 'c1' ? [commit('c1', [], 'main')] : id === 'c3' ? [commit('c3', ['c1'], 'ledger')] : [],
    });

    expect(history.network).toBe('ic');
    expect(await history.branchHeads()).toEqual(new Map([['main', 'c1'], ['ledger', 'c3']]));
    expect(await history.getCommit('c1')).toEqual({ id: 'c1', parent: null, branch: 'main', timestamp: 1_700_000_000_000_000_000n, diff: 'diff c1' });
    expect((await history.getCommit('c3'))?.parent).toBe('c1');
    expect(await history.getCommit('c9')).toBeNull();
  });
});
