/**
 * MemoryRepo Canister Actor Bindings (Hardened)
 *
 * TypeScript Actor interface for MemoryRepo canister.
 * Generated from memory-repo.did Candid interface.
 *
 * NOTE: Candid `int` and `nat` map to JavaScript `bigint` at runtime.
 * Fields typed as `bigint` below reflect this runtime behavior.
 */

import { Actor, HttpAgent, Identity } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { idlFactory } from './memory-repo-actor.idl.js';

// ==================== Types ====================

/**
 * A single commit in the memory repository.
 * `timestamp` is nanoseconds since epoch (Candid `int` -> JS `bigint`).
 */
export type Commit = {
  id: string;
  timestamp: bigint;
  message: string;
  diff: string;
  tags: string[];
  parent: [string] | [];
  branch: string;
};

/**
 * Repository status.
 * `totalCommits` and `totalBranches` are Candid `nat` -> JS `bigint`.
 */
export type RepoStatus = {
  initialized: boolean;
  currentBranch: string;
  totalCommits: bigint;
  totalBranches: bigint;
  owner: string;
};

/**
 * Security status.
 */
export type SecurityStatus = {
  owner: string;
  frozenMode: boolean;
  canisterKilled: boolean;
  authorizedCount: bigint;
  heapBytes: bigint;
};

/**
 * Operation result
 */
export type OperationResult = { ok: string } | { err: string };

/**
 * Rebase result.
 * `commitsReplayed` is Candid `nat` -> JS `bigint`.
 */
export type RebaseResult =
  | { ok: { newBranch: string; commitsReplayed: bigint } }
  | { err: string };

/**
 * Merge strategy
 */
export type MergeStrategy = { auto: null } | { manual: null };

/**
 * Conflict entry returned during merge
 */
export type ConflictEntry = {
  commitId: string;
  message: string;
  tags: string[];
  diff: string;
};

/**
 * Merge result.
 * `merged` is Candid `nat` -> JS `bigint`.
 */
export type MergeResult =
  | { ok: { merged: bigint; message: string } }
  | { conflicts: ConflictEntry[] }
  | { err: string };

/**
 * A ThoughtForm memory entry.
 * `timestamp` is Candid `nat64` -> JS `bigint`.
 */
export type ThoughtFormStore = {
  json: string;
  timestamp: bigint;
  hash: string;
};

// ==================== Service Interface ====================

/**
 * MemoryRepo canister actor interface
 */
export interface _SERVICE {
  // Owner & Security Management
  freeze: () => Promise<OperationResult>;
  manualUnlock: () => Promise<OperationResult>;
  killCanister: () => Promise<OperationResult>;
  reviveCanister: () => Promise<OperationResult>;
  addAuthorizedPrincipal: (p: Principal) => Promise<OperationResult>;
  removeAuthorizedPrincipal: (p: Principal) => Promise<OperationResult>;
  getSecurityStatus: () => Promise<SecurityStatus>;

  // Repository Lifecycle
  initRepo: (soulContent: string) => Promise<OperationResult>;

  // Commit Operations
  commit: (message: string, diff: string, tags: string[]) => Promise<OperationResult>;
  /** Commit onto `branch` in one message, without moving (or depending on) the current branch. */
  commitToBranch: (branch: string, message: string, diff: string, tags: string[]) => Promise<OperationResult>;
  getCommit: (commitId: string) => Promise<[Commit] | []>;

  // Log & State Queries
  log: (branchName: [string] | []) => Promise<Commit[]>;
  getCurrentState: () => Promise<[string] | []>;
  getRepoStatus: () => Promise<RepoStatus>;

  // Branch Operations
  getBranches: () => Promise<[string, string][]>;
  createBranch: (name: string) => Promise<OperationResult>;
  /** A branch at `base`'s HEAD (createBranch forks from the current branch). */
  createBranchFrom: (name: string, base: string) => Promise<OperationResult>;
  switchBranch: (name: string) => Promise<OperationResult>;

  // Rebase (PRD 3)
  rebase: (newBaseSoul: string, targetBranch: [string] | []) => Promise<RebaseResult>;

  // Merge & Cherry-Pick (PRD 4)
  merge: (fromBranch: string, strategy: MergeStrategy) => Promise<MergeResult>;
  cherryPick: (commitId: string) => Promise<OperationResult>;

  // ThoughtForm Memory (PRD 5)
  storeThoughtForm: (json: string, timestamp: bigint, hash: string) => Promise<OperationResult>;
  getThoughtForms: () => Promise<ThoughtFormStore[]>;
  getThoughtFormByHash: (hash: string) => Promise<[ThoughtFormStore] | []>;
}

// ==================== Actor Creation ====================

/**
 * Create MemoryRepo canister actor
 *
 * @param canisterId - Canister ID to connect to
 * @param agent - HTTP agent instance
 * @returns Actor instance
 */
export function createMemoryRepoActor(canisterId: string, agent?: HttpAgent): _SERVICE {
  const actor = Actor.createActor<_SERVICE>(idlFactory, {
    agent: agent,
    canisterId,
  });

  return actor;
}

/**
 * Create anonymous agent for local canister access.
 * Automatically fetches root key for local replicas.
 *
 * @param host - Host URL (default: from ICP_LOCAL_URL env or http://localhost:4943)
 * @returns HTTP agent instance (call fetchRootKey() before canister calls on local)
 */
export function createAnonymousAgent(host?: string): HttpAgent {
  const defaultHost = process.env.ICP_LOCAL_URL || 'http://localhost:4943';
  const agent = new HttpAgent({
    host: host ?? defaultHost,
  });

  return agent;
}

/**
 * Create authenticated agent for mainnet canister access
 *
 * @param host - Host URL (default: from ICP_MAINNET_URL env or https://ic0.app)
 * @param identity - Identity for signing transactions
 * @returns HTTP agent instance
 */
export function createAuthenticatedAgent(host?: string, identity?: Identity): HttpAgent {
  const defaultHost = process.env.ICP_MAINNET_URL || 'https://ic0.app';
  const agent = new HttpAgent({
    host: host ?? defaultHost,
    identity,
  });

  return agent;
}

/**
 * Whether a replica host is a local development replica: a loopback name or
 * address. Only such hosts are asked for their root key; any other host is
 * verified against the IC root key the agent ships with.
 */
export function isLocalReplicaHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(host).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/**
 * An agent for memory_repo calls, signed by `identity` when one is given and
 * anonymous otherwise. The canister answers anonymous queries but refuses
 * anonymous writes, so every update call needs an identity the canister
 * authorizes. Fetches the root key for local replicas only.
 *
 * @param host - Host URL (default: from ICP_LOCAL_URL env or http://localhost:4943)
 */
export async function createMemoryRepoAgent(host?: string, identity?: Identity): Promise<HttpAgent> {
  const resolvedHost = host ?? process.env.ICP_LOCAL_URL ?? 'http://localhost:4943';
  const agent = identity
    ? createAuthenticatedAgent(resolvedHost, identity)
    : createAnonymousAgent(resolvedHost);
  if (isLocalReplicaHost(resolvedHost)) {
    await agent.fetchRootKey();
  }
  return agent;
}

/** Codes for the write refusals explainMemoryRepoWriteError recognizes. */
export type MemoryRepoWriteErrorCode =
  | 'SIGNER_NOT_AUTHORIZED'
  | 'SIGNER_NOT_OWNER'
  | 'REPO_FROZEN'
  | 'REPO_KILLED'
  | 'MEMORY_REPO_OUTDATED';

/**
 * The part of a failed canister call worth showing: the replica's reject
 * text, without the request id, certificate and HTTP details agent-js puts
 * in the error message. Any other error keeps its first line.
 */
export function memoryRepoErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const reject = /Reject text:\s*(.+)/.exec(text);
  return (reject?.[1] ?? text.split('\n')[0] ?? '').trim() || 'Unknown error';
}

/**
 * Explain a memory_repo write that the canister trapped on, naming the
 * principal that signed it and what would let it through. The guards in
 * canister/memory-repo.mo trap with fixed messages, which reach the agent
 * as the reject text. A method the canister does not have means it was
 * built from an older canister/memory-repo.mo. Null for any other error.
 */
export function explainMemoryRepoWriteError(
  error: unknown,
  principal: string,
): { code: MemoryRepoWriteErrorCode; message: string } | null {
  const text = error instanceof Error ? error.message : String(error);
  const missing = /has no (?:update|query) method '([^']+)'/.exec(text);
  if (missing) {
    return {
      code: 'MEMORY_REPO_OUTDATED',
      message:
        `memory_repo has no ${missing[1]} method: the canister was built from an older canister/memory-repo.mo. ` +
        'Upgrade it from this release (`dfx deploy memory_repo`); an upgrade keeps its commits, owner and authorized principals.',
    };
  }
  if (text.includes('caller principal is not authorized')) {
    return {
      code: 'SIGNER_NOT_AUTHORIZED',
      message:
        `memory_repo refused the write: ${principal} is neither the repo owner nor an authorized principal. ` +
        `The owner can allow it with \`agentvault memory authorize ${principal}\`.`,
    };
  }
  if (text.includes('only the canister owner may call this function')) {
    return {
      code: 'SIGNER_NOT_OWNER',
      message:
        `memory_repo refused: only the repo owner may do this, and ${principal} is not the owner ` +
        '(`agentvault memory status` shows the owner).',
    };
  }
  if (text.includes('canister is frozen')) {
    return { code: 'REPO_FROZEN', message: 'memory_repo is frozen: writes are refused until the owner calls manualUnlock.' };
  }
  if (text.includes('canister killed')) {
    return { code: 'REPO_KILLED', message: 'memory_repo has been killed: writes are refused until the owner calls reviveCanister.' };
  }
  return null;
}

/**
 * Validate a canister ID string.
 * Throws if the string is not a valid ICP principal.
 */
export function validateCanisterId(canisterId: string): void {
  try {
    Principal.fromText(canisterId);
  } catch {
    throw new Error(`Invalid canister ID: "${canisterId}"`);
  }
}
