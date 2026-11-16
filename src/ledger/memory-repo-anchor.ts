/**
 * Anchors ledger checkpoints as commits on a memory_repo canister.
 *
 * Each checkpoint becomes one commit on a dedicated branch, signed by the
 * gateway's identity. The canister's reply comes back with the Internet
 * Computer's certificate, kept as a receipt: anyone holding it can check,
 * from the bytes alone, that this exact checkpoint was written and by which
 * principal (see memory-repo-receipts.ts).
 *
 * One memory_repo holds at most 10,000 commits and 64 MB, and one anchor run
 * makes one commit per stream that changed, so the anchor interval decides
 * how long a canister lasts.
 */

import type { SignIdentity } from '@dfinity/agent';
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  explainMemoryRepoWriteError,
  memoryRepoErrorText,
  validateCanisterId,
  type _SERVICE as MemoryRepoActor,
} from '../canister/memory-repo-actor.js';
import { callWithReceipt, receiptNetwork, recordCalls } from '../canister/memory-repo-receipts.js';
import type { IcpWriteReceipt } from '../canister/memory-repo-receipts-types.js';
import { ANCHOR_FORMAT, type AnchorCheckpoint, type LedgerAnchor } from './anchor.js';
import { GENESIS_HASH, checkChain, chainEntry, type LedgerEntry } from './format.js';
import type { MemoryRepoHistoryPort } from './rebuild.js';
import type { AnchorEvidence, AnchorRecord } from './store.js';

export const MEMORY_REPO_ANCHOR_KIND = 'icp-memory-repo';
export const DEFAULT_LEDGER_BRANCH = 'ledger';
/** The branch every memory_repo starts with, which the ledger branch forks from. */
const BASE_BRANCH = 'main';
/** Under memory_repo's 1 MB diff limit and the Internet Computer's 2 MB message limit. */
const MAX_CHECKPOINT_BYTES = 900_000;

/** The memory_repo calls anchoring makes; the canister behind them, or a stand-in under test. */
export interface MemoryRepoPort {
  readonly canisterId: string;
  readonly network: 'ic' | 'local';
  branches(): Promise<string[]>;
  createBranch(name: string, base: string): Promise<void>;
  commit(branch: string, message: string, diff: string, tags: string[]): Promise<{ commitId: string; receipt: IcpWriteReceipt | null }>;
  /** A commit's diff, or null when the canister holds no such commit. */
  commitDiff(commitId: string): Promise<string | null>;
}

export interface MemoryRepoEvidence extends AnchorEvidence {
  kind: typeof MEMORY_REPO_ANCHOR_KIND;
  canisterId: string;
  network: 'ic' | 'local';
  branch: string;
  commitId: string;
  /** The certified reply for the commit; null when it could not be captured. */
  receipt: IcpWriteReceipt | null;
}

export class MemoryRepoAnchor implements LedgerAnchor {
  readonly kind = MEMORY_REPO_ANCHOR_KIND;
  readonly maxCheckpointBytes = MAX_CHECKPOINT_BYTES;
  private branchReady = false;

  constructor(
    private readonly repo: MemoryRepoPort,
    private readonly branch: string = DEFAULT_LEDGER_BRANCH,
  ) {}

  async anchor(checkpoint: AnchorCheckpoint): Promise<MemoryRepoEvidence> {
    await this.ensureBranch();
    const { commitId, receipt } = await this.repo.commit(
      this.branch,
      `ledger ${checkpoint.stream} ${checkpoint.from}-${checkpoint.to}`,
      JSON.stringify(checkpoint),
      ['ledger', `ledger:${checkpoint.stream}`],
    );
    return {
      kind: MEMORY_REPO_ANCHOR_KIND,
      canisterId: this.repo.canisterId,
      network: this.repo.network,
      branch: this.branch,
      commitId,
      receipt,
    };
  }

  private async ensureBranch(): Promise<void> {
    if (this.branchReady) return;
    const branches = await this.repo.branches();
    if (!branches.includes(BASE_BRANCH)) {
      throw new Error(
        `memory_repo ${this.repo.canisterId} has no repository yet. Create one with \`agentvault memory init\` before anchoring to it.`,
      );
    }
    if (!branches.includes(this.branch)) await this.repo.createBranch(this.branch, BASE_BRANCH);
    this.branchReady = true;
  }
}

export interface AnchorCheckResult {
  record: AnchorRecord;
  ok: boolean;
  /** Why the anchor does not vouch for the range; absent when it does. */
  reason?: string;
}

/**
 * Reads one anchored range back from the canister and checks it against the
 * entries the ledger holds now. `stored` is the ledger's entries `from`..`to`.
 */
export async function checkMemoryRepoAnchor(
  repo: Pick<MemoryRepoPort, 'canisterId' | 'commitDiff'>,
  record: AnchorRecord,
  stored: readonly LedgerEntry[],
): Promise<AnchorCheckResult> {
  const fail = (reason: string): AnchorCheckResult => ({ record, ok: false, reason });
  const { evidence } = record;
  if (evidence.kind !== MEMORY_REPO_ANCHOR_KIND || typeof evidence['commitId'] !== 'string') {
    return fail('the record is not a memory_repo anchor');
  }
  if (evidence['canisterId'] !== repo.canisterId) {
    return fail(`the range was anchored to canister ${String(evidence['canisterId'])}, not ${repo.canisterId}`);
  }
  const diff = await repo.commitDiff(evidence['commitId']);
  if (diff === null) return fail(`the canister has no commit ${evidence['commitId']}`);

  let checkpoint: AnchorCheckpoint;
  try {
    checkpoint = JSON.parse(diff) as AnchorCheckpoint;
  } catch {
    return fail('the commit is not a ledger checkpoint');
  }
  if (checkpoint?.format !== ANCHOR_FORMAT) return fail('the commit is not a ledger checkpoint');
  if (checkpoint.stream !== record.stream || checkpoint.from !== record.from || checkpoint.to !== record.to) {
    return fail('the commit covers a different range');
  }

  const last = stored.at(-1);
  if (stored.length !== record.to - record.from + 1 || !last) return fail('the ledger no longer holds the whole range');
  if (checkpoint.head !== last.hash) return fail(`entry ${record.to} in the ledger is not the one that was anchored`);
  if (checkpoint.entries) {
    // A full copy must rebuild to the same head from what the canister holds alone.
    let prev = checkpoint.prev;
    const rebuilt = checkpoint.entries.map((entry) => {
      const chained = chainEntry(record.stream, entry, prev);
      prev = chained.hash;
      return chained;
    });
    const after = record.from === 1 ? null : { seq: record.from - 1, hash: checkpoint.prev };
    const check = checkChain(record.stream, rebuilt, after);
    if (!check.ok) return fail(`the anchored copy does not chain: ${check.reason}`);
    if (check.head?.hash !== checkpoint.head || check.head.seq !== record.to) {
      return fail('the anchored copy does not rebuild to the anchored head');
    }
  }
  if (record.from === 1 && checkpoint.prev !== GENESIS_HASH) return fail('the anchored range does not start the stream');
  return { record, ok: true };
}

/** Reads a memory_repo canister's commits back. Queries are anonymous, so this needs no key. */
export async function readMemoryRepo(options: {
  canisterId: string;
  host: string;
}): Promise<Pick<MemoryRepoPort, 'canisterId' | 'branches' | 'commitDiff'>> {
  validateCanisterId(options.canisterId);
  const reader = createMemoryRepoActor(options.canisterId, await createMemoryRepoAgent(options.host));
  return {
    canisterId: options.canisterId,
    async branches() {
      return (await reader.getBranches()).map(([name]) => name);
    },
    async commitDiff(commitId) {
      const [commit] = await reader.getCommit(commitId);
      return commit ? commit.diff : null;
    },
  };
}

/** A memory_repo's history as rebuilding reads it, from the canister's own (Candid-shaped) replies. */
export function memoryRepoHistory(
  canisterId: string,
  network: 'ic' | 'local',
  reader: Pick<MemoryRepoActor, 'getBranches' | 'getCommit'>,
): MemoryRepoHistoryPort {
  return {
    canisterId,
    network,
    async branchHeads() {
      return new Map(await reader.getBranches());
    },
    async getCommit(commitId) {
      // An optional value arrives as an empty or one-element array.
      const [commit] = await reader.getCommit(commitId);
      return commit
        ? { id: commit.id, parent: commit.parent[0] ?? null, branch: commit.branch, timestamp: commit.timestamp, diff: commit.diff }
        : null;
    },
  };
}

/** Reads a memory_repo canister's branches and commits, for rebuilding a ledger from it. Needs no key. */
export async function readMemoryRepoHistory(options: { canisterId: string; host: string }): Promise<MemoryRepoHistoryPort> {
  validateCanisterId(options.canisterId);
  const agent = await createMemoryRepoAgent(options.host);
  return memoryRepoHistory(options.canisterId, receiptNetwork(agent.rootKey), createMemoryRepoActor(options.canisterId, agent));
}

/**
 * The memory_repo canister `canisterId` behind `host`, written to as
 * `identity`. Each commit is signed, and its certified reply kept as a receipt.
 */
export async function connectMemoryRepo(options: {
  canisterId: string;
  host: string;
  identity: SignIdentity;
  principal: string;
}): Promise<MemoryRepoPort> {
  const { canisterId, host, identity, principal } = options;
  const reader = await readMemoryRepo({ canisterId, host });
  const network = receiptNetwork((await createMemoryRepoAgent(host, identity)).rootKey);

  /** A canister refusal, said the way the memory commands say it. */
  const explain = (error: unknown): Error =>
    new Error(explainMemoryRepoWriteError(error, principal)?.message ?? memoryRepoErrorText(error));

  return {
    ...reader,
    network,
    async createBranch(name, base) {
      const writer = createMemoryRepoActor(canisterId, await createMemoryRepoAgent(host, identity));
      let result;
      try {
        result = await writer.createBranchFrom(name, base);
      } catch (error) {
        throw explain(error);
      }
      if (!('ok' in result)) throw new Error(`memory_repo did not create branch ${name}: ${result.err}`);
    },
    async commit(branch, message, diff, tags) {
      // A recorder per commit: it keeps every call it signs, so one kept for the process's life would only grow.
      const recorder = recordCalls(identity);
      const agent = await createMemoryRepoAgent(host, recorder.identity);
      let outcome;
      try {
        outcome = await callWithReceipt({ agent, canisterId, recorder }, { kind: 'commit', args: [branch, message, diff, tags] });
      } catch (error) {
        throw explain(error);
      }
      if (!('ok' in outcome.result)) throw new Error(`memory_repo refused the commit: ${outcome.result.err}`);
      return { commitId: outcome.result.ok, receipt: outcome.receipt };
    },
  };
}
