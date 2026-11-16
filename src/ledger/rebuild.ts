/**
 * Rebuilding a ledger from the canister alone.
 *
 * Anchored checkpoints hold full copies of the entries (unless the gateway ran
 * with `--digest-only`), so a ledger's streams can be read back from the
 * canister without the gateway's disk: walk the `ledger` branch from its head
 * to the commit it forked from, collect each commit's checkpoint, and chain
 * the entries again from the first one. What comes out is a ledger directory,
 * so `ledger serve --dir` serves it and anything that restores from a ledger
 * restores from this one.
 *
 * Reads are anonymous queries, so this needs no key. A single replica answers
 * a query, so it can leave the newest checkpoints out; it cannot invent
 * entries that chain, and the client that sealed them rejects any it did not.
 */

import { ANCHOR_FORMAT, type AnchorCheckpoint } from './anchor.js';
import {
  GENESIS_HASH,
  chainEntry,
  checkChain,
  isStreamId,
  ledgerEntryInputSchema,
  type LedgerEntry,
  type LedgerHead,
} from './format.js';
import { DEFAULT_LEDGER_BRANCH, MEMORY_REPO_ANCHOR_KIND } from './memory-repo-anchor.js';
import type { LedgerStore } from './store.js';

/** A commit, as much of it as rebuilding reads. */
export interface RepoCommit {
  id: string;
  /** The commit before it on its branch; null for the first commit of the repository. */
  parent: string | null;
  branch: string;
  /** Nanoseconds since the epoch. */
  timestamp: bigint;
  diff: string;
}

/** What rebuilding reads from a memory_repo: where each branch ends, and a commit by id. */
export interface MemoryRepoHistoryPort {
  readonly canisterId: string;
  readonly network: 'ic' | 'local';
  branchHeads(): Promise<Map<string, string>>;
  getCommit(commitId: string): Promise<RepoCommit | null>;
}

export interface RebuiltStream {
  stream: string;
  /** Entries written to the ledger. */
  entries: number;
  head: LedgerHead | null;
  /** Every anchored range of the stream was usable, so nothing after the last entry is missing. */
  complete: boolean;
}

export interface RebuildReport {
  canisterId: string;
  branch: string;
  /** Commits read from the ledger branch. */
  commits: number;
  streams: RebuiltStream[];
  /** Everything that kept part of the ledger from being rebuilt. Empty when all of it was. */
  problems: string[];
}

export interface RebuildOptions {
  /** The memory_repo branch the checkpoints were committed to. */
  branch?: string;
  /** Rebuild only this stream. */
  stream?: string;
}

/** The most commits one memory_repo holds, which bounds a walk that never reaches its start. */
const MAX_COMMITS = 10_000;
const HASH = /^[0-9a-f]{64}$/;

interface Anchored {
  commitId: string;
  timestamp: bigint;
  checkpoint: AnchorCheckpoint;
}

/** The checkpoint a commit holds, or why it is not one. */
function parseCheckpoint(diff: string): AnchorCheckpoint | string {
  let value: unknown;
  try {
    value = JSON.parse(diff);
  } catch {
    return 'it is not JSON';
  }
  if (!value || typeof value !== 'object') return 'it is not a ledger checkpoint';
  const cp = value as Partial<AnchorCheckpoint>;
  if (cp.format !== ANCHOR_FORMAT) return 'it is not a ledger checkpoint';
  if (typeof cp.stream !== 'string' || !isStreamId(cp.stream)) return 'it names no valid stream';
  if (!Number.isSafeInteger(cp.from) || !Number.isSafeInteger(cp.to) || cp.from! < 1 || cp.to! < cp.from!) {
    return 'it names no valid range';
  }
  if (typeof cp.prev !== 'string' || typeof cp.head !== 'string' || !HASH.test(cp.prev) || !HASH.test(cp.head)) {
    return 'its hashes are malformed';
  }
  if (cp.entries !== undefined) {
    if (!Array.isArray(cp.entries) || cp.entries.length !== cp.to! - cp.from! + 1) return 'its entries do not fill its range';
    for (const entry of cp.entries) {
      if (!ledgerEntryInputSchema.safeParse(entry).success) return 'one of its entries is malformed';
    }
  }
  return cp as AnchorCheckpoint;
}

/** The checkpoints on `branch`, oldest first, and what was skipped. */
async function readCheckpoints(
  repo: MemoryRepoHistoryPort,
  branch: string,
): Promise<{ anchored: Anchored[]; commits: number; problems: string[] }> {
  const tip = (await repo.branchHeads()).get(branch);
  if (!tip) throw new Error(`Canister ${repo.canisterId} has no '${branch}' branch: nothing was anchored to it`);
  const problems: string[] = [];
  const anchored: Anchored[] = [];
  const seen = new Set<string>();
  let commits = 0;
  for (let id: string | null = tip; id; ) {
    if (seen.has(id) || seen.size > MAX_COMMITS) throw new Error(`The history of '${branch}' does not end: it loops at commit ${id}`);
    seen.add(id);
    const commit = await repo.getCommit(id);
    if (!commit) throw new Error(`The canister names commit ${id} but does not hold it`);
    // The first commit that is not on the branch is the one it forked from.
    if (commit.branch !== branch) break;
    commits += 1;
    const parsed = parseCheckpoint(commit.diff);
    if (typeof parsed === 'string') problems.push(`Commit ${id} on '${branch}' was skipped: ${parsed}`);
    else anchored.push({ commitId: id, timestamp: commit.timestamp, checkpoint: parsed });
    id = commit.parent;
  }
  return { anchored: anchored.reverse(), commits, problems };
}

/**
 * Chains a stream's checkpoints, oldest first, from its start. Stops at the
 * first one that cannot be used and says why; what came before it is kept.
 */
function assemble(stream: string, checkpoints: readonly Anchored[]): { chain: LedgerEntry[]; used: Anchored[]; problem?: string } {
  const chain: LedgerEntry[] = [];
  const used: Anchored[] = [];
  for (const ref of checkpoints) {
    const cp = ref.checkpoint;
    const range = `${stream} ${cp.from}-${cp.to}`;
    const stop = (reason: string) => ({ chain, used, problem: `${range}: ${reason}` });
    const held = chain.length;

    if (cp.to <= held) {
      // A range anchored again after a crash: it has to say what the first one did.
      if (chain[cp.to - 1]!.hash !== cp.head) return stop(`the anchors disagree about entry ${cp.to}`);
      used.push(ref);
      continue;
    }
    if (cp.from > held + 1) return stop(`entries ${held + 1}-${cp.from - 1} are not on the canister`);
    if (!cp.entries) return stop('anchored as hashes only, so the canister does not hold the entries');
    const before = cp.from === 1 ? GENESIS_HASH : chain[cp.from - 2]!.hash;
    if (cp.prev !== before) return stop('it does not continue from the entries before it');

    let prev = cp.prev;
    const rebuilt = cp.entries.map((entry) => {
      const chained = chainEntry(stream, entry, prev);
      prev = chained.hash;
      return chained;
    });
    const check = checkChain(stream, rebuilt, cp.from === 1 ? null : { seq: cp.from - 1, hash: cp.prev });
    if (!check.ok) return stop(`the copy does not chain: ${check.reason}`);
    if (prev !== cp.head) return stop('the copy does not rebuild to the anchored head');
    for (let seq = cp.from; seq <= held; seq += 1) {
      if (rebuilt[seq - cp.from]!.hash !== chain[seq - 1]!.hash) return stop(`the anchors disagree about entry ${seq}`);
    }
    chain.push(...rebuilt.slice(held + 1 - cp.from));
    used.push(ref);
  }
  return { chain, used };
}

/**
 * Rebuilds the streams anchored on `repo` into `store`, which should be a new
 * ledger: a stream the store already holds is left alone and reported. A stream
 * that cannot be rebuilt in full is written as far as it goes, and the report
 * says where and why it stops. The anchors it came from are recorded, so a
 * gateway serving the result carries on from where the chain ends.
 */
export async function rebuildFromMemoryRepo(
  repo: MemoryRepoHistoryPort,
  store: LedgerStore,
  options: RebuildOptions = {},
): Promise<RebuildReport> {
  const branch = options.branch ?? DEFAULT_LEDGER_BRANCH;
  if (options.stream !== undefined && !isStreamId(options.stream)) throw new Error(`Invalid stream id: ${JSON.stringify(options.stream)}`);
  const { anchored, commits, problems } = await readCheckpoints(repo, branch);

  const byStream = new Map<string, Anchored[]>();
  for (const ref of anchored) {
    const { stream } = ref.checkpoint;
    if (options.stream !== undefined && stream !== options.stream) continue;
    byStream.set(stream, [...(byStream.get(stream) ?? []), ref]);
  }
  if (options.stream !== undefined && !byStream.has(options.stream)) {
    problems.push(`Stream ${options.stream} has no checkpoints on '${branch}'`);
  }

  const streams: RebuiltStream[] = [];
  for (const [stream, checkpoints] of [...byStream].sort(([a], [b]) => a.localeCompare(b))) {
    if (store.head(stream)) {
      problems.push(`${stream}: the ledger already holds this stream; rebuild into an empty directory`);
      continue;
    }
    const { chain, used, problem } = assemble(stream, checkpoints);
    if (problem) problems.push(problem);
    if (chain.length > 0) {
      store.append(
        stream,
        chain.map(({ seq, kind, at, payload }) => ({ seq, kind, at, payload })),
      );
      for (const { commitId, timestamp, checkpoint } of used) {
        store.recordAnchor({
          stream,
          from: checkpoint.from,
          to: checkpoint.to,
          head: checkpoint.head,
          anchoredAt: new Date(Number(timestamp / 1_000_000n)).toISOString(),
          evidence: {
            kind: MEMORY_REPO_ANCHOR_KIND,
            canisterId: repo.canisterId,
            network: repo.network,
            branch,
            commitId,
            receipt: null,
          },
        });
      }
    }
    streams.push({ stream, entries: chain.length, head: store.head(stream), complete: !problem });
  }
  return { canisterId: repo.canisterId, branch, commits, streams, problems };
}
