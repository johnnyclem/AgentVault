/**
 * Candid IDL Factory for AgentVault canister
 *
 * This file provides the IDL factory function used to create canister actors.
 * It's manually generated based on agent.did to avoid build-time dependencies.
 */

import { IDL } from '@dfinity/candid';

export const idlFactory = IDL.Service({
  getAgentConfig: IDL.Func([], [IDL.Opt(IDL.Record({
    name: IDL.Text,
    agentType: IDL.Text,
    version: IDL.Text,
    createdAt: IDL.Int,
  }))], ['query']),
  getAgentStatus: IDL.Func([], [IDL.Record({
    initialized: IDL.Bool,
    version: IDL.Text,
    totalMemories: IDL.Nat,
    totalTasks: IDL.Nat,
    wasmLoaded: IDL.Bool,
    executionCount: IDL.Nat,
    lastExecuted: IDL.Int,
  })], ['query']),
  setAgentConfig: IDL.Func([IDL.Record({
    name: IDL.Text,
    agentType: IDL.Text,
    version: IDL.Text,
    createdAt: IDL.Int,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  loadAgentWasm: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  getWasmInfo: IDL.Func([], [IDL.Opt(IDL.Record({
    hash: IDL.Vec(IDL.Nat8),
    size: IDL.Nat,
    loadedAt: IDL.Int,
    functionNameCount: IDL.Nat,
  }))], ['query']),
  isWasmLoaded: IDL.Func([], [IDL.Bool], ['query']),
  agent_init: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_step: IDL.Func([IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_get_state: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  agent_get_state_size: IDL.Func([], [IDL.Nat], ['query']),
  agent_add_memory: IDL.Func([IDL.Nat, IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_get_memories: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  agent_get_memories_by_type: IDL.Func([IDL.Nat], [IDL.Vec(IDL.Nat8)], ['query']),
  agent_clear_memories: IDL.Func([], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_add_task: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_get_tasks: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  agent_get_pending_tasks: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  agent_update_task_status: IDL.Func([IDL.Vec(IDL.Nat8), IDL.Nat, IDL.Vec(IDL.Nat8)], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_clear_tasks: IDL.Func([], [IDL.Variant({
    ok: IDL.Vec(IDL.Nat8),
    err: IDL.Text,
  })], []),
  agent_get_info: IDL.Func([], [IDL.Vec(IDL.Nat8)], ['query']),
  execute: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  addMemory: IDL.Func([IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  getMemories: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  }))], ['query']),
  getMemoriesByType: IDL.Func([IDL.Variant({
    fact: IDL.Null,
    user_preference: IDL.Null,
    task_result: IDL.Null,
  })], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    memoryType: IDL.Variant({
      fact: IDL.Null,
      user_preference: IDL.Null,
      task_result: IDL.Null,
    }),
    content: IDL.Text,
    timestamp: IDL.Int,
    importance: IDL.Nat8,
  }))], ['query']),
  clearMemories: IDL.Func([], [IDL.Text], []),
  addTask: IDL.Func([IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  getTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),
  getPendingTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),
  getRunningTasks: IDL.Func([], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    description: IDL.Text,
    status: IDL.Variant({
      pending: IDL.Null,
      running: IDL.Null,
      completed: IDL.Null,
      failed: IDL.Null,
    }),
    result: IDL.Opt(IDL.Text),
    timestamp: IDL.Int,
  }))], ['query']),
  updateTaskStatus: IDL.Func([IDL.Text, IDL.Variant({
    pending: IDL.Null,
    running: IDL.Null,
    completed: IDL.Null,
    failed: IDL.Null,
  }), IDL.Opt(IDL.Text)], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  clearTasks: IDL.Func([], [IDL.Text], []),
  setContext: IDL.Func([IDL.Text, IDL.Text], [IDL.Text], []),
  getContext: IDL.Func([IDL.Text], [IDL.Opt(IDL.Text)], ['query']),
  getAllContext: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text))], ['query']),
  clearContext: IDL.Func([], [IDL.Text], []),
  registerWallet: IDL.Func([IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  getWallet: IDL.Func([IDL.Text], [IDL.Opt(IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  }))], ['query']),
  listWallets: IDL.Func([IDL.Text], [IDL.Vec(IDL.Record({
    id: IDL.Text,
    agentId: IDL.Text,
    chain: IDL.Text,
    address: IDL.Text,
    registeredAt: IDL.Int,
    status: IDL.Variant({
      active: IDL.Null,
      inactive: IDL.Null,
      revoked: IDL.Null,
    }),
  }))], ['query']),
  deregisterWallet: IDL.Func([IDL.Text], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  updateWalletStatus: IDL.Func([IDL.Text, IDL.Variant({
    active: IDL.Null,
    inactive: IDL.Null,
    revoked: IDL.Null,
  })], [IDL.Variant({
    ok: IDL.Text,
    err: IDL.Text,
  })], []),
  getCanisterStatus: IDL.Func([], [IDL.Record({
    status: IDL.Variant({
      running: IDL.Null,
      stopping: IDL.Null,
      stopped: IDL.Null,
    }),
    memorySize: IDL.Nat,
    cycles: IDL.Nat,
  })], ['query']),
  getMetrics: IDL.Func([], [IDL.Record({
    uptime: IDL.Int,
    operations: IDL.Nat,
    lastActivity: IDL.Int,
  })], ['query']),
  heartbeat: IDL.Func([], [IDL.Bool], []),
});
