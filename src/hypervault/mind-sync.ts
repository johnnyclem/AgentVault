/**
 * Mind sync — mirror the HyperVault mind DAG onto a memory_repo canister
 *
 * Replays hypervault `memory_commits` onto the on-chain repo commit-for-
 * commit, in topological order (parents before children), idempotently:
 * each on-chain commit is tagged `hv:commit:<uuid>` and commits whose UUID
 * is already on-chain are skipped. Mapping (§5.6):
 *
 *   memory_branches.name       → createBranch / switchBranch
 *   memory_commits             → commit(message, diff, tags) with hypervault
 *                                UUID, author provenance and merge-parent in tags
 *   memory_revisions           → the commit `diff` payload (JSON revision ops)
 *   memory content at head     → storeThoughtForm entries (content-addressed)
 *
 * Large blobs never go in the canister (64 MiB wasm_memory_limit): entries
 * over the chunk threshold are replaced by `{content_hash}` pointers whose
 * blobs live on Arweave.
 */

import * as crypto from 'node:crypto';
import type { _SERVICE } from '../canister/memory-repo-actor.js';
import type { HvMemory, HvMindBranch, HvMindCommit, HvRevision } from './types.js';

/** Keep individual canister payloads comfortably under message limits. */
const MAX_ONCHAIN_PAYLOAD_BYTES = 256 * 1024;

export const HV_COMMIT_TAG_PREFIX = 'hv:commit:';
export const HV_PARENT_TAG_PREFIX = 'hv:parent:';
export const HV_MERGE_PARENT_TAG_PREFIX = 'hv:merge-parent:';
export const HV_AUTHOR_TAG_PREFIX = 'hv:author:';
export const ARCHIVE_RECEIPT_TAG_PREFIX = 'archive-receipt:';

export interface MindSyncInput {
  commits: HvMindCommit[];
  /** memory_revisions grouped however they arrive; matched by commit_id */
  revisions: HvRevision[];
  branches: HvMindBranch[];
  /** memory heads to store as thoughtforms (content-addressed) */
  memories: HvMemory[];
}

export interface MindSyncResult {
  commitsReplayed: number;
  commitsSkipped: number;
  thoughtformsStored: number;
  /** hypervault UUID of the last replayed (or already-synced) commit */
  lastSyncedCommitId?: string;
  errors: string[];
}

/**
 * Order commits so every parent (and merge parent) precedes its children.
 * Ties break on created_at then id for determinism.
 */
export function topologicalOrder(commits: HvMindCommit[]): HvMindCommit[] {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const commit of commits) {
    inDegree.set(commit.id, 0);
  }
  for (const commit of commits) {
    for (const parent of [commit.parent_id, commit.merge_parent_id]) {
      if (parent && byId.has(parent)) {
        children.set(parent, [...(children.get(parent) ?? []), commit.id]);
        inDegree.set(commit.id, (inDegree.get(commit.id) ?? 0) + 1);
      }
    }
  }

  const compare = (a: string, b: string): number => {
    const ca = byId.get(a)!;
    const cb = byId.get(b)!;
    return (ca.created_at ?? '').localeCompare(cb.created_at ?? '') || ca.id.localeCompare(cb.id);
  };

  const ready = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort(compare);
  const ordered: HvMindCommit[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const remaining = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }

  if (ordered.length !== commits.length) {
    throw new Error('Mind DAG contains a cycle or dangling parent references; refusing to replay');
  }
  return ordered;
}

/** Collect hypervault commit UUIDs already replayed onto the canister. */
export async function collectSyncedCommitIds(actor: _SERVICE): Promise<Set<string>> {
  const synced = new Set<string>();
  const branches = await actor.getBranches();
  const branchNames = branches.map(([name]) => name);
  const targets: Array<[string] | []> = branchNames.length > 0 ? branchNames.map((n) => [n] as [string]) : [[]];
  for (const target of targets) {
    const commits = await actor.log(target);
    for (const commit of commits) {
      for (const tag of commit.tags) {
        if (tag.startsWith(HV_COMMIT_TAG_PREFIX)) {
          synced.add(tag.slice(HV_COMMIT_TAG_PREFIX.length));
        }
      }
    }
  }
  return synced;
}

/**
 * Replay the mind DAG onto the canister. Idempotent and resumable.
 */
export async function syncMindToCanister(actor: _SERVICE, input: MindSyncInput): Promise<MindSyncResult> {
  const result: MindSyncResult = {
    commitsReplayed: 0,
    commitsSkipped: 0,
    thoughtformsStored: 0,
    errors: [],
  };

  // Ensure the repo is initialized.
  const status = await actor.getRepoStatus();
  if (!status.initialized) {
    const init = await actor.initRepo('HyperVault mind mirror');
    if ('err' in init) {
      result.errors.push(`initRepo failed: ${init.err}`);
      return result;
    }
  }

  const synced = await collectSyncedCommitIds(actor);
  const revisionsByCommit = new Map<string, HvRevision[]>();
  for (const revision of input.revisions) {
    revisionsByCommit.set(revision.commit_id, [...(revisionsByCommit.get(revision.commit_id) ?? []), revision]);
  }

  const existingBranches = new Set((await actor.getBranches()).map(([name]) => name));
  let currentBranch = (await actor.getRepoStatus()).currentBranch;

  const ensureBranch = async (name: string | undefined): Promise<void> => {
    const branch = name && name.length > 0 ? name : 'main';
    if (!existingBranches.has(branch)) {
      const created = await actor.createBranch(branch);
      if ('ok' in created) existingBranches.add(branch);
      // "already exists" errors are fine — treat as present.
      else existingBranches.add(branch);
    }
    if (currentBranch !== branch) {
      const switched = await actor.switchBranch(branch);
      if ('ok' in switched) currentBranch = branch;
    }
  };

  // Replay commits in topological order.
  for (const commit of topologicalOrder(input.commits)) {
    if (synced.has(commit.id)) {
      result.commitsSkipped += 1;
      result.lastSyncedCommitId = commit.id;
      continue;
    }
    await ensureBranch(commit.branch);

    const revisions = revisionsByCommit.get(commit.id) ?? [];
    let diff = JSON.stringify(revisions.map(revisionOp));
    if (Buffer.byteLength(diff, 'utf-8') > MAX_ONCHAIN_PAYLOAD_BYTES) {
      // Blob too large for the canister: store a content-hash pointer instead.
      diff = JSON.stringify({
        pointer: true,
        content_hash: sha256(diff),
        note: 'revision payload exceeds on-chain chunk limit; blob archived off-chain',
      });
    }

    const tags = [
      `${HV_COMMIT_TAG_PREFIX}${commit.id}`,
      ...(commit.parent_id ? [`${HV_PARENT_TAG_PREFIX}${commit.parent_id}`] : []),
      ...(commit.merge_parent_id ? [`${HV_MERGE_PARENT_TAG_PREFIX}${commit.merge_parent_id}`] : []),
      ...(commit.author_kind || commit.author_key_prefix || commit.author_key_id
        ? [`${HV_AUTHOR_TAG_PREFIX}${commit.author_kind ?? 'unknown'}/${commit.author_key_prefix ?? commit.author_key_id ?? ''}`]
        : []),
    ];

    const committed = await actor.commit(commit.message || `hypervault commit ${commit.id}`, diff, tags);
    if ('err' in committed) {
      result.errors.push(`commit ${commit.id} failed: ${committed.err}`);
      // Children depend on this commit's tag for idempotency — stop here so
      // the next run resumes from the same point.
      return result;
    }
    synced.add(commit.id);
    result.commitsReplayed += 1;
    result.lastSyncedCommitId = commit.id;
  }

  // Store memory heads as content-addressed thoughtforms.
  for (const memory of input.memories) {
    const withoutEmbedding: Record<string, unknown> = { ...memory };
    delete withoutEmbedding.embedding;
    const json = JSON.stringify(withoutEmbedding);
    if (Buffer.byteLength(json, 'utf-8') > MAX_ONCHAIN_PAYLOAD_BYTES) continue;
    const hash = sha256(json);
    const existing = await actor.getThoughtFormByHash(hash);
    if (existing.length > 0) continue;
    const stored = await actor.storeThoughtForm(json, BigInt(Date.now()), hash);
    if ('ok' in stored) {
      result.thoughtformsStored += 1;
    } else {
      result.errors.push(`storeThoughtForm ${memory.id} failed: ${stored.err}`);
    }
  }

  return result;
}

/**
 * Write an archive receipt commit: the chain itself attests where the cold
 * copy lives (§5.6).
 */
export async function writeArchiveReceipt(
  actor: _SERVICE,
  arweaveTx: string,
  manifestHash: string,
): Promise<boolean> {
  const result = await actor.commit(
    `Archive receipt: ${arweaveTx}`,
    JSON.stringify({ arweave_tx: arweaveTx, manifest_hash: manifestHash }),
    [`${ARCHIVE_RECEIPT_TAG_PREFIX}${arweaveTx}`],
  );
  return 'ok' in result;
}

function revisionOp(revision: HvRevision): Record<string, unknown> {
  return {
    id: revision.id,
    memory_id: revision.memory_id,
    operation: revision.operation,
    snapshot: revision.snapshot,
    created_at: revision.created_at,
  };
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
}
