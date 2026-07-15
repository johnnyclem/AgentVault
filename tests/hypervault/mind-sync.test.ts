import { describe, it, expect } from 'vitest';
import { topologicalOrder, syncMindToCanister, HV_COMMIT_TAG_PREFIX } from '../../src/hypervault/mind-sync.js';
import type { _SERVICE, Commit, OperationResult, RepoStatus } from '../../src/canister/memory-repo-actor.js';
import type { HvMindCommit } from '../../src/hypervault/types.js';

function commit(id: string, parent?: string, merge?: string, at?: string): HvMindCommit {
  return {
    id,
    parent_id: parent ?? null,
    merge_parent_id: merge ?? null,
    branch: 'main',
    message: `commit ${id}`,
    created_at: at ?? `2026-07-0${id.slice(-1)}T00:00:00.000Z`,
  };
}

/** Minimal in-memory fake of the memory_repo canister actor. */
function fakeActor(initialCommits: Commit[] = []): _SERVICE & { commits: Commit[] } {
  const commits: Commit[] = [...initialCommits];
  const thoughtforms = new Map<string, { json: string; timestamp: bigint; hash: string }>();
  let initialized = true;
  const actor = {
    commits,
    async getRepoStatus(): Promise<RepoStatus> {
      return { initialized, currentBranch: 'main', totalCommits: BigInt(commits.length), totalBranches: 1n, owner: 'test' };
    },
    async initRepo(): Promise<OperationResult> {
      initialized = true;
      return { ok: 'initialized' };
    },
    async getBranches(): Promise<[string, string][]> {
      return [['main', commits[commits.length - 1]?.id ?? '']];
    },
    async createBranch(): Promise<OperationResult> {
      return { ok: 'created' };
    },
    async switchBranch(): Promise<OperationResult> {
      return { ok: 'switched' };
    },
    async log(): Promise<Commit[]> {
      return commits;
    },
    async commit(message: string, diff: string, tags: string[]): Promise<OperationResult> {
      const id = `chain-${commits.length + 1}`;
      commits.push({ id, timestamp: 0n, message, diff, tags, parent: [], branch: 'main' });
      return { ok: id };
    },
    async getThoughtFormByHash(hash: string) {
      const tf = thoughtforms.get(hash);
      return (tf ? [tf] : []) as [{ json: string; timestamp: bigint; hash: string }] | [];
    },
    async storeThoughtForm(json: string, timestamp: bigint, hash: string): Promise<OperationResult> {
      thoughtforms.set(hash, { json, timestamp, hash });
      return { ok: hash };
    },
  } as unknown as _SERVICE & { commits: Commit[] };
  return actor;
}

describe('topologicalOrder', () => {
  it('orders parents before children including merge parents', () => {
    const commits = [
      commit('4', '2', '3'),
      commit('2', '1'),
      commit('3', '1'),
      commit('1'),
    ];
    const ordered = topologicalOrder(commits).map((c) => c.id);
    expect(ordered.indexOf('1')).toBeLessThan(ordered.indexOf('2'));
    expect(ordered.indexOf('1')).toBeLessThan(ordered.indexOf('3'));
    expect(ordered.indexOf('2')).toBeLessThan(ordered.indexOf('4'));
    expect(ordered.indexOf('3')).toBeLessThan(ordered.indexOf('4'));
  });

  it('throws on a cycle', () => {
    const commits = [commit('1', '2'), commit('2', '1')];
    expect(() => topologicalOrder(commits)).toThrow(/cycle|dangling/i);
  });
});

describe('syncMindToCanister', () => {
  it('replays all commits and is idempotent on a second run', async () => {
    const actor = fakeActor();
    const input = {
      commits: [commit('1'), commit('2', '1'), commit('3', '2')],
      revisions: [{ id: 'r1', commit_id: '1', memory_id: 'm1', operation: 'create' as const }],
      branches: [{ name: 'main' }],
      memories: [{ id: 'm1', title: 'M1', content: 'hello', tags: [] }],
    };

    const first = await syncMindToCanister(actor, input);
    expect(first.commitsReplayed).toBe(3);
    expect(first.errors).toEqual([]);
    expect(first.thoughtformsStored).toBe(1);

    const second = await syncMindToCanister(actor, input);
    expect(second.commitsReplayed).toBe(0);
    expect(second.commitsSkipped).toBe(3);
    // No duplicate thoughtforms
    expect(second.thoughtformsStored).toBe(0);

    // Every hypervault commit id is tagged exactly once on chain
    const tagged = actor.commits.flatMap((c) => c.tags).filter((t) => t.startsWith(HV_COMMIT_TAG_PREFIX));
    expect(new Set(tagged).size).toBe(3);
  });
});
