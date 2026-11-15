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
  checkMemoryRepoAnchor,
  type AnchorCheckpoint,
  type LedgerAnchor,
  type MemoryRepoPort,
} from '../../src/ledger/index.js';
import { entry } from './helpers.js';

let dir: string;
let store: LedgerStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-anchor-'));
  store = LedgerStore.open(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-02-03T04:05:06.000Z');

/** An anchor that keeps what it was given. */
function recordingAnchor(maxCheckpointBytes = 900_000): LedgerAnchor & { checkpoints: AnchorCheckpoint[] } {
  const checkpoints: AnchorCheckpoint[] = [];
  return {
    kind: 'test',
    maxCheckpointBytes,
    checkpoints,
    async anchor(checkpoint) {
      checkpoints.push(checkpoint);
      return { kind: 'test', id: `a${checkpoints.length}` };
    },
  };
}

/** A memory_repo that holds its commits in memory. */
function fakeRepo(branches: string[] = ['main']): MemoryRepoPort & { commits: Map<string, { branch: string; message: string; diff: string; tags: string[] }> } {
  const commits = new Map<string, { branch: string; message: string; diff: string; tags: string[] }>();
  return {
    canisterId: 'aaaaa-aa',
    network: 'local',
    commits,
    async branches() {
      return branches;
    },
    async createBranch(name, base) {
      if (!branches.includes(base)) throw new Error(`no branch ${base}`);
      branches.push(name);
    },
    async commit(branch, message, diff, tags) {
      if (!branches.includes(branch)) throw new Error(`no branch ${branch}`);
      const commitId = `c_${commits.size + 1}`;
      commits.set(commitId, { branch, message, diff, tags });
      return { commitId, receipt: null };
    },
    async commitDiff(commitId) {
      return commits.get(commitId)?.diff ?? null;
    },
  };
}

describe('anchorPending', () => {
  it('anchors each stream once, with a full copy of its entries', async () => {
    const bot = store.append('bot-1', [entry(1), entry(2), entry(3)]);
    const space = store.append('space-1', [entry(1)]);
    const anchor = recordingAnchor();

    const records = await anchorPending(store, anchor, { now: () => NOW });

    expect(records).toEqual([
      { stream: 'bot-1', from: 1, to: 3, head: bot.head.hash, anchoredAt: NOW.toISOString(), evidence: { kind: 'test', id: 'a1' } },
      { stream: 'space-1', from: 1, to: 1, head: space.head.hash, anchoredAt: NOW.toISOString(), evidence: { kind: 'test', id: 'a2' } },
    ]);
    expect(anchor.checkpoints[0]).toEqual({
      format: ANCHOR_FORMAT,
      stream: 'bot-1',
      from: 1,
      to: 3,
      prev: GENESIS_HASH,
      head: bot.head.hash,
      entries: [entry(1), entry(2), entry(3)],
    });
    expect(store.anchoredSeq('bot-1')).toBe(3);
    expect(await anchorPending(store, anchor)).toEqual([]);
  });

  it('carries on from the last anchored entry', async () => {
    const anchor = recordingAnchor();
    store.append('bot-1', [entry(1), entry(2)]);
    await anchorPending(store, anchor);
    const second = store.read('bot-1')[1]!;
    const { head } = store.append('bot-1', [entry(3), entry(4)]);

    await anchorPending(store, anchor);

    expect(anchor.checkpoints[1]).toMatchObject({ from: 3, to: 4, prev: second.hash, head: head.hash });
    expect(anchor.checkpoints[1]!.entries).toEqual([entry(3), entry(4)]);
  });

  it('splits a stream across checkpoints that each fit the anchor', async () => {
    const big = 'x'.repeat(2_000);
    store.append('bot-1', [1, 2, 3, 4, 5].map((seq) => entry(seq, big)));
    const anchor = recordingAnchor(7_000);

    const records = await anchorPending(store, anchor);

    expect(records.map((record) => [record.from, record.to])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    for (const checkpoint of anchor.checkpoints) {
      expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeLessThanOrEqual(7_000);
    }
    expect(store.anchoredSeq('bot-1')).toBe(5);
  });

  it('anchors only the hashes of a range when asked', async () => {
    const { head } = store.append('bot-1', [entry(1), entry(2)]);
    const anchor = recordingAnchor();
    await anchorPending(store, anchor, { inlineEntries: false });
    expect(anchor.checkpoints).toEqual([{ format: ANCHOR_FORMAT, stream: 'bot-1', from: 1, to: 2, prev: GENESIS_HASH, head: head.hash }]);
  });

  it('keeps what was anchored before a failure and retries the rest', async () => {
    store.append('bot-1', [entry(1)]);
    store.append('space-1', [entry(1)]);
    let calls = 0;
    const failing: LedgerAnchor = {
      kind: 'test',
      maxCheckpointBytes: 900_000,
      async anchor() {
        calls += 1;
        if (calls === 2) throw new Error('canister unreachable');
        return { kind: 'test' };
      },
    };

    await expect(anchorPending(store, failing)).rejects.toThrow('canister unreachable');
    expect(store.anchoredSeq('bot-1')).toBe(1);
    expect(store.anchoredSeq('space-1')).toBe(0);

    const retried = await anchorPending(store, failing);
    expect(retried.map((record) => record.stream)).toEqual(['space-1']);
    // What was recorded survives a restart: nothing is anchored twice.
    expect(await anchorPending(LedgerStore.open(dir), failing)).toEqual([]);
  });
});

describe('MemoryRepoAnchor', () => {
  it('commits each checkpoint to its own branch, creating the branch once', async () => {
    const repo = fakeRepo();
    store.append('bot-1', [entry(1), entry(2)]);
    store.append('space-1', [entry(1)]);

    const records = await anchorPending(store, new MemoryRepoAnchor(repo));

    expect(records.map((record) => record.evidence)).toEqual([
      { kind: 'icp-memory-repo', canisterId: 'aaaaa-aa', network: 'local', branch: 'ledger', commitId: 'c_1', receipt: null },
      { kind: 'icp-memory-repo', canisterId: 'aaaaa-aa', network: 'local', branch: 'ledger', commitId: 'c_2', receipt: null },
    ]);
    const first = repo.commits.get('c_1')!;
    expect(first).toMatchObject({ branch: 'ledger', message: 'ledger bot-1 1-2', tags: ['ledger', 'ledger:bot-1'] });
    expect(JSON.parse(first.diff)).toMatchObject({ format: ANCHOR_FORMAT, stream: 'bot-1', from: 1, to: 2 });
    expect(await repo.branches()).toEqual(['main', 'ledger']);
  });

  it('says how to fix a canister with no repository', async () => {
    store.append('bot-1', [entry(1)]);
    await expect(anchorPending(store, new MemoryRepoAnchor(fakeRepo([])))).rejects.toThrow(/agentvault memory init/);
    expect(store.anchoredSeq('bot-1')).toBe(0);
  });

  it('keeps tags and messages within what memory_repo accepts for the longest stream id', async () => {
    const repo = fakeRepo();
    const stream = 'a'.repeat(100);
    store.append(stream, [entry(1)]);
    await anchorPending(store, new MemoryRepoAnchor(repo));
    const commit = repo.commits.get('c_1')!;
    for (const tag of commit.tags) expect(Buffer.byteLength(tag)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(commit.message)).toBeLessThanOrEqual(1024);
  });
});

describe('checkMemoryRepoAnchor', () => {
  async function anchored(options: { inlineEntries?: boolean } = {}) {
    const repo = fakeRepo();
    store.append('bot-1', [entry(1), entry(2), entry(3)]);
    const [record] = await anchorPending(store, new MemoryRepoAnchor(repo), options);
    return { repo, record: record!, stored: store.read('bot-1') };
  }

  it('passes when the canister holds the range the ledger holds', async () => {
    const { repo, record, stored } = await anchored();
    expect(await checkMemoryRepoAnchor(repo, record, stored)).toEqual({ record, ok: true });
  });

  it('passes for a range anchored by its hashes alone', async () => {
    const { repo, record, stored } = await anchored({ inlineEntries: false });
    expect(JSON.parse(repo.commits.get('c_1')!.diff)).not.toHaveProperty('entries');
    expect(await checkMemoryRepoAnchor(repo, record, stored)).toEqual({ record, ok: true });
  });

  it('fails when a ledger entry was replaced after it was anchored', async () => {
    const { repo, record, stored } = await anchored();
    const forged = LedgerStore.open(fs.mkdtempSync(path.join(dir, 'forged-')));
    forged.append('bot-1', [entry(1), entry(2, 'forged'), entry(3)]);
    expect(await checkMemoryRepoAnchor(repo, record, forged.read('bot-1'))).toMatchObject({
      ok: false,
      reason: 'entry 3 in the ledger is not the one that was anchored',
    });
    expect(await checkMemoryRepoAnchor(repo, record, stored.slice(0, 2))).toMatchObject({
      ok: false,
      reason: 'the ledger no longer holds the whole range',
    });
  });

  it('fails when the canister copy was changed or is missing', async () => {
    const { repo, record, stored } = await anchored();
    const commit = repo.commits.get('c_1')!;
    const checkpoint = JSON.parse(commit.diff) as AnchorCheckpoint;

    checkpoint.entries![1] = entry(2, 'changed on the canister');
    repo.commits.set('c_1', { ...commit, diff: JSON.stringify(checkpoint) });
    expect(await checkMemoryRepoAnchor(repo, record, stored)).toMatchObject({
      ok: false,
      reason: 'the anchored copy does not rebuild to the anchored head',
    });

    repo.commits.set('c_1', { ...commit, diff: 'not a checkpoint' });
    expect(await checkMemoryRepoAnchor(repo, record, stored)).toMatchObject({ ok: false, reason: 'the commit is not a ledger checkpoint' });

    repo.commits.delete('c_1');
    expect(await checkMemoryRepoAnchor(repo, record, stored)).toMatchObject({ ok: false, reason: 'the canister has no commit c_1' });
  });

  it('fails for a range anchored to another canister', async () => {
    const { repo, record, stored } = await anchored();
    expect(await checkMemoryRepoAnchor({ ...repo, canisterId: 'bbbbb-bb' }, record, stored)).toMatchObject({
      ok: false,
      reason: 'the range was anchored to canister aaaaa-aa, not bbbbb-bb',
    });
  });
});
