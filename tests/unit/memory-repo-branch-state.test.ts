/**
 * The memory_repo branch state that GET /api/memory-repo/branches/:branch
 * returns, and Polytician's vault_memory_pull imports: every entry committed
 * on the branch, not only the newest commit's. Polytician's vault_memory_push
 * makes one commit per concept, and a tombstone commit removes a key.
 */

import { describe, it, expect } from 'vitest';
import type { Commit } from '../../src/canister/memory-repo-actor.js';
import { branchStateFromLog } from '../../src/canister/memory-repo-branch-state.js';

let timestamp = 0n;

function commit(id: string, diff: unknown): Commit {
  timestamp += 1n;
  return {
    id,
    timestamp,
    message: `commit ${id}`,
    diff: typeof diff === 'string' ? diff : JSON.stringify(diff),
    tags: [],
    parent: [],
    branch: 'polytician-main',
  };
}

function entry(key: string, data: string) {
  return { key, contentType: 'markdown', data, tags: ['t'], metadata: { updatedAt: 1 } };
}

describe('branchStateFromLog', () => {
  it('keeps the entries of every commit on the branch, newer commits replacing older ones', () => {
    // The canister's log is newest first.
    const log = [
      commit('sha4', [entry('concepts/a/markdown', 'alpha v2')]),
      commit('sha3', [entry('concepts/c/markdown', 'gamma')]),
      commit('sha2', [entry('concepts/b/markdown', 'beta')]),
      commit('sha1', [entry('concepts/a/markdown', 'alpha v1')]),
    ];

    const state = branchStateFromLog('polytician-main', log);

    expect(state.headSha).toBe('sha4');
    expect(state.entries.map((e) => [e.key, e.data])).toEqual([
      ['concepts/a/markdown', 'alpha v2'],
      ['concepts/b/markdown', 'beta'],
      ['concepts/c/markdown', 'gamma'],
    ]);
  });

  it('drops a key a tombstone commit deleted, unless a later commit adds it again', () => {
    const log = [
      commit('sha5', [entry('concepts/b/markdown', 'beta again')]),
      commit('sha4', { deleted: 'concepts/b/markdown' }),
      commit('sha3', { deleted: 'concepts/a/markdown' }),
      commit('sha2', [entry('concepts/b/markdown', 'beta'), entry('concepts/c/markdown', 'gamma')]),
      commit('sha1', [entry('concepts/a/markdown', 'alpha')]),
    ];

    const state = branchStateFromLog('polytician-main', log);

    expect(state.entries.map((e) => [e.key, e.data])).toEqual([
      ['concepts/c/markdown', 'gamma'],
      ['concepts/b/markdown', 'beta again'],
    ]);
  });

  it('three single-entry commits and a tombstone leave the two surviving entries', () => {
    const log = [
      commit('sha4', { deleted: 'concepts/b/markdown' }),
      commit('sha3', [entry('concepts/c/markdown', 'gamma')]),
      commit('sha2', [entry('concepts/b/markdown', 'beta')]),
      commit('sha1', [entry('concepts/a/markdown', 'alpha')]),
    ];

    const state = branchStateFromLog('polytician-main', log);

    expect(state.headSha).toBe('sha4');
    expect(state.entries.map((e) => e.key)).toEqual(['concepts/a/markdown', 'concepts/c/markdown']);
  });

  it('ignores commits whose diff is not an entry list or a tombstone, such as the genesis Soul.md', () => {
    const log = [
      commit('sha2', [entry('concepts/a/markdown', 'alpha')]),
      commit('sha1', '# Soul.md\n\nI am an agent.'),
    ];

    const state = branchStateFromLog('polytician-main', log);

    expect(state.entries).toEqual([
      { key: 'concepts/a/markdown', contentType: 'markdown', data: 'alpha', tags: ['t'], metadata: { updatedAt: 1 } },
    ]);
  });

  it('has no head and no entries for an empty log', () => {
    expect(branchStateFromLog('polytician-main', [])).toEqual({ branch: 'polytician-main', headSha: null, entries: [] });
  });
});
