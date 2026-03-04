/**
 * MemoryRepo Canister Actor Bindings
 *
 * TypeScript Actor interface for MemoryRepo canister.
 * Generated from memory-repo.did Candid interface.
 */

import { Actor, HttpAgent, Identity } from '@dfinity/agent';
import { idlFactory } from './memory-repo-actor.idl.js';

// ==================== Types ====================

/**
 * A single commit in the memory repository
 */
export type Commit = {
  id: string;
  timestamp: number;
  message: string;
  diff: string;
  tags: string[];
  parent: [string] | [];
  branch: string;
};

/**
 * Repository status
 */
export type RepoStatus = {
  initialized: boolean;
  currentBranch: string;
  totalCommits: number;
  totalBranches: number;
  owner: string;
};

/**
 * Operation result
 */
export type OperationResult = { ok: string } | { err: string };

/**
 * Rebase result
 */
export type RebaseResult =
  | { ok: { newBranch: string; commitsReplayed: number } }
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
 * Merge result
 */
export type MergeResult =
  | { ok: { merged: number; message: string } }
  | { conflicts: ConflictEntry[] }
  | { err: string };

// ==================== Service Interface ====================

/**
 * MemoryRepo canister actor interface
 */
export interface _SERVICE {
  // Repository Lifecycle
  initRepo: (soulContent: string) => Promise<OperationResult>;

  // Commit Operations
  commit: (message: string, diff: string, tags: string[]) => Promise<OperationResult>;
  getCommit: (commitId: string) => Promise<[Commit] | []>;

  // Log & State Queries
  log: (branchName: [string] | []) => Promise<Commit[]>;
  getCurrentState: () => Promise<[string] | []>;
  getRepoStatus: () => Promise<RepoStatus>;

  // Branch Operations
  getBranches: () => Promise<[string, string][]>;
  createBranch: (name: string) => Promise<OperationResult>;
  switchBranch: (name: string) => Promise<OperationResult>;

  // Rebase (PRD 3)
  rebase: (newBaseSoul: string, targetBranch: [string] | []) => Promise<RebaseResult>;

  // Merge & Cherry-Pick (PRD 4)
  merge: (fromBranch: string, strategy: MergeStrategy) => Promise<MergeResult>;
  cherryPick: (commitId: string) => Promise<OperationResult>;
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
 * Create anonymous agent for local canister access
 *
 * @param host - Host URL (default: from ICP_LOCAL_URL env or http://localhost:4943)
 * @returns HTTP agent instance
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
