/**
 * AgentVault Canister Actor Bindings
 *
 * TypeScript Actor interface for AgentVault canister.
 * Generated from agent.did Candid interface.
 */

import { Actor, HttpAgent } from '@dfinity/agent';
import { idlFactory } from './actor.idl';


/**
 * Agent configuration stored on-chain
 */
export type AgentConfig = {
  name: string;
  agentType: string;
  version: string;
  createdAt: bigint;
};

/**
 * WASM module metadata
 */
export type WasmMetadata = {
  hash: Uint8Array;
  size: bigint;
  loadedAt: bigint;
  functionNameCount: bigint;
};

/**
 * Memory entry for agent
 */
export type MemoryType = { fact: null } | { user_preference: null } | { task_result: null };

export type Memory = {
  id: string;
  memoryType: MemoryType;
  content: string;
  timestamp: bigint;
  importance: number;
};

/**
 * Task entry
 */
export type TaskStatus = { pending: null } | { running: null } | { completed: null } | { failed: null };

export type Task = {
  id: string;
  description: string;
  status: TaskStatus;
  result: [string] | [];
  timestamp: bigint;
};

/**
 * Execution result wrapper
 */
export type ExecutionResult = { ok: Uint8Array } | { err: string };

/**
 * Agent state
 */
export type AgentState = {
  initialized: boolean;
  lastExecuted: bigint;
  executionCount: bigint;
};

/**
 * Wallet information stored in canister (metadata only, NO private keys)
 */
export type WalletStatus = { active: null } | { inactive: null } | { revoked: null };

export type WalletInfo = {
  id: string;
  agentId: string;
  chain: string;
  address: string;
  registeredAt: bigint;
  status: WalletStatus;
};

/**
 * Agent status query result
 */
export type AgentStatus = {
  initialized: boolean;
  version: string;
  totalMemories: bigint;
  totalTasks: bigint;
  wasmLoaded: boolean;
  executionCount: bigint;
  lastExecuted: bigint;
};

/**
 * Canister status query result
 */
export type CanisterStatus = { running: null } | { stopping: null } | { stopped: null };

/**
 * Full canister status
 */
export type FullCanisterStatus = {
  status: CanisterStatus;
  memorySize: bigint;
  cycles: bigint;
};

/**
 * Canister metrics
 */
export type CanisterMetrics = {
  uptime: bigint;
  operations: bigint;
  lastActivity: bigint;
};

/**
 * Operation result
 */
export type OperationResult = { ok: string } | { err: string };

/**
 * AgentVault canister actor interface
 */
export interface _SERVICE {
  getAgentConfig: () => Promise<[AgentConfig] | []>;
  getAgentStatus: () => Promise<AgentStatus>;
  setAgentConfig: (arg_0: AgentConfig) => Promise<OperationResult>;
  loadAgentWasm: (arg_0: Uint8Array, arg_1: Uint8Array) => Promise<OperationResult>;
  getWasmInfo: () => Promise<[WasmMetadata] | []>;
  isWasmLoaded: () => Promise<boolean>;
  agent_init: (arg_0: Uint8Array) => Promise<ExecutionResult>;
  agent_step: (arg_0: Uint8Array) => Promise<ExecutionResult>;
  agent_get_state: () => Promise<Uint8Array>;
  agent_get_state_size: () => Promise<bigint>;
  agent_add_memory: (arg_0: bigint, arg_1: Uint8Array) => Promise<ExecutionResult>;
  agent_get_memories: () => Promise<Uint8Array>;
  agent_get_memories_by_type: (arg_0: bigint) => Promise<Uint8Array>;
  agent_clear_memories: () => Promise<ExecutionResult>;
  agent_add_task: (arg_0: Uint8Array, arg_1: Uint8Array) => Promise<ExecutionResult>;
  agent_get_tasks: () => Promise<Uint8Array>;
  agent_get_pending_tasks: () => Promise<Uint8Array>;
  agent_update_task_status: (arg_0: Uint8Array, arg_1: bigint, arg_2: Uint8Array) => Promise<ExecutionResult>;
  agent_clear_tasks: () => Promise<ExecutionResult>;
  agent_get_info: () => Promise<Uint8Array>;
  execute: (arg_0: string) => Promise<OperationResult>;
  addMemory: (arg_0: Memory) => Promise<OperationResult>;
  getMemories: () => Promise<Array<Memory>>;
  getMemoriesByType: (arg_0: MemoryType) => Promise<Array<Memory>>;
  clearMemories: () => Promise<string>;
  addTask: (arg_0: Task) => Promise<OperationResult>;
  getTasks: () => Promise<Array<Task>>;
  getPendingTasks: () => Promise<Array<Task>>;
  getRunningTasks: () => Promise<Array<Task>>;
  updateTaskStatus: (arg_0: string, arg_1: TaskStatus, arg_2: [string] | []) => Promise<OperationResult>;
  clearTasks: () => Promise<string>;
  setContext: (arg_0: string, arg_1: string) => Promise<string>;
  getContext: (arg_0: string) => Promise<[string] | []>;
  getAllContext: () => Promise<Array<[string, string]>>;
  clearContext: () => Promise<string>;
  registerWallet: (arg_0: WalletInfo) => Promise<OperationResult>;
  getWallet: (arg_0: string) => Promise<[WalletInfo] | []>;
  listWallets: (arg_0: string) => Promise<Array<WalletInfo>>;
  deregisterWallet: (arg_0: string) => Promise<OperationResult>;
  updateWalletStatus: (arg_0: string, arg_1: WalletStatus) => Promise<OperationResult>;
  getCanisterStatus: () => Promise<FullCanisterStatus>;
  getMetrics: () => Promise<CanisterMetrics>;
  heartbeat: () => Promise<boolean>;
}

/**
 * Create AgentVault canister actor
 *
 * @param canisterId - Canister ID to connect to
 * @param agent - HTTP agent instance
 * @returns Actor instance
 */
export function createActor(canisterId: string, agent?: HttpAgent): _SERVICE {
  const actor = Actor.createActor<_SERVICE>(idlFactory, {
    agent: agent,
    canisterId,
  });

  return actor;
}

/**
 * Create anonymous agent for local canister access
 *
 * @param host - Host URL (default: http://localhost:4943)
 * @returns HTTP agent instance
 */
export function createAnonymousAgent(host = 'http://localhost:4943'): HttpAgent {
  const agent = new HttpAgent({
    host,
  });

  agent.fetchRootKey();

  return agent;
}

/**
 * Create authenticated agent for mainnet canister access
 *
 * @param host - Host URL (default: https://ic0.app)
 * @returns HTTP agent instance
 */
export function createAuthenticatedAgent(host = 'https://ic0.app'): HttpAgent {
  const agent = new HttpAgent({
    host,
  });

  return agent;
}
