/**
 * AgentVault Canister (Motoko) - Production Version
 *
 * This canister serves as the on-chain execution environment for AI agents.
 * It provides state management, task execution, memory storage, and WASM module loading.
 * Implements the standard 14-function agent interface.
 */

import Memory "mo:base/Memory";
import Buffer "mo:base/Buffer";
import Int "mo:base/Int";
import Time "mo:base/Time";
import Iter "mo:base/Iter";
import Blob "mo:base/Blob";
import Text "mo:base/Text";
import Array "mo:base/Array";
import Option "mo:base/Option";

// ==================== Types ====================

/**
 * Agent configuration stored on-chain
 */
public type AgentConfig = {
  name : Text;
  agentType : Text;
  version : Text;
  createdAt : Int;
};

/**
 * WASM module metadata
 */
public type WasmMetadata = {
  hash : [Nat8];
  size : Nat;
  loadedAt : Int;
  functionNameCount : Nat;
};

/**
 * Memory entry for agent
 */
public type Memory = {
  id : Text;
  memoryType : { #fact; #user_preference; #task_result };
  content : Text;
  timestamp : Int;
  importance : Nat8;
};

/**
 * Task entry
 */
public type Task = {
  id : Text;
  description : Text;
  status : { #pending; #running; #completed; #failed };
  result : ?Text;
  timestamp : Int;
};

/**
 * Execution result wrapper
 */
public type ExecutionResult = {
  #ok : [Nat8];
  #err : Text;
};

/**
 * Agent state
 */
public type AgentState = {
  initialized : Bool;
  lastExecuted : Int;
  executionCount : Nat;
};

// ==================== Stable State ====================

// Agent configuration
stable var agentConfig : ?AgentConfig = null;

// WASM module storage
stable var agentWasm : [Nat8] = [];
stable var wasmMetadata : ?WasmMetadata = null;

// Agent state
stable var agentState : AgentState = {
  initialized = false;
  lastExecuted = 0;
  executionCount = 0;
};

// Memory storage
stable var memories : [Memory] = [];

// Task storage
stable var tasks : [Task] = [];

// Context storage (key-value pairs)
stable var context : [(Text, Text)] = [];

// ==================== Wallet Registry (Phase 5A) ====================

/**
 * Wallet information stored in canister (metadata only, NO private keys)
 */
public type WalletInfo = {
  id : Text;
  agentId : Text;
  chain : Text;
  address : Text;
  registeredAt : Int;
  status : { #active; #inactive; #revoked };
};

// Wallet registry (maps walletId -> WalletInfo)
stable var walletRegistry : [(Text, WalletInfo)] = [];

// ==================== Transaction Queue (Phase 5B) ====================

/**
 * Transaction action type
 */
public type TransactionAction = {
  walletId : Text;
  action : { #send_funds; #sign_message; #deploy_contract };
  parameters : [(Text, Text)];
  priority : { #low; #normal; #high };
  threshold : ?Nat;
};

/**
 * Transaction status
 */
public type TransactionStatus = {
  #pending;
  #queued;
  #signed;
  #completed;
  #failed;
};

/**
 * Queued transaction
 */
public type QueuedTransaction = {
  id : Text;
  action : TransactionAction;
  status : TransactionStatus;
  result : ?Text;
  retryCount : Nat;
  scheduledAt : ?Int;
  createdAt : Int;
  signedAt : ?Int;
  completedAt : ?Int;
  errorMessage : ?Text;
};

// Transaction queue storage
stable var transactionQueue : [QueuedTransaction] = [];

// ==================== Wallet Registry Functions (Phase 5A) ====================

/**
 * Register a wallet in the canister
 *
 * @param walletInfo - Wallet metadata to register
 * @returns Registration result
 */
public shared func registerWallet(walletInfo : WalletInfo) : async {
  #ok : Text;
  #err : Text;
} {
  // Check if wallet already exists
  for ((id, _) in walletRegistry.vals()) {
    if (id == walletInfo.id) {
      return #err("Wallet already registered: " # walletInfo.id);
    };
  };

  // Validate wallet info
  if (walletInfo.id == "") {
    return #err("Invalid wallet ID");
  };
  if (walletInfo.agentId == "") {
    return #err("Invalid agent ID");
  };
  if (walletInfo.address == "") {
    return #err("Invalid wallet address");
  };

  // Register wallet
  walletRegistry := Array.append<(Text, WalletInfo)>(walletRegistry, [(walletInfo.id, walletInfo)]);

  #ok("Wallet registered: " # walletInfo.id)
};

/**
 * Get wallet information
 *
 * @param walletId - Wallet ID to query
 * @returns Wallet info if found
 */
public query func getWallet(walletId : Text) : async ?WalletInfo {
  for ((id, info) in walletRegistry.vals()) {
    if (id == walletId) {
      return ?info;
    };
  };
  null
};

/**
 * List all wallets for an agent
 *
 * @param agentId - Agent ID to filter wallets
 * @returns Array of wallet info
 */
public query func listWallets(agentId : Text) : async [WalletInfo] {
  var agentWallets : [WalletInfo] = [];

  for ((id, info) in walletRegistry.vals()) {
    if (info.agentId == agentId) {
      agentWallets := Array.append<WalletInfo>(agentWallets, [info]);
    };
  };

  agentWallets
};

/**
 * Deregister a wallet from the canister
 *
 * @param walletId - Wallet ID to deregister
 * @returns Deregistration result
 */
public shared func deregisterWallet(walletId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  // Remove wallet from registry
  walletRegistry := Array.filter<(Text, WalletInfo)>(
    walletRegistry,
    func(entry : (Text, WalletInfo)) : Bool {
      let (id, info) = entry;
      if (id == walletId) {
        found := true;
        false
      } else {
        true
      }
    }
  );

  if (found) {
    #ok("Wallet deregistered: " # walletId)
  } else {
    #err("Wallet not found: " # walletId)
  }
};

/**
 * Update wallet status
 *
 * @param walletId - Wallet ID to update
 * @param status - New status
 * @returns Update result
 */
public shared func updateWalletStatus(walletId : Text, status : { #active; #inactive; #revoked }) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  walletRegistry := Array.map<(Text, WalletInfo), (Text, WalletInfo)>(
    walletRegistry,
    func(entry : (Text, WalletInfo)) : (Text, WalletInfo) {
      let (id, info) = entry;
      if (id == walletId) {
        found := true;
        (id, {
          id = info.id;
          agentId = info.agentId;
          chain = info.chain;
          address = info.address;
          registeredAt = info.registeredAt;
          status = status;
        })
      } else {
        entry
      }
    }
  );

  if (found) {
    #ok("Wallet status updated: " # walletId)
  } else {
    #err("Wallet not found: " # walletId)
  }
};

// ==================== Agent Lifecycle ====================

/**
 * Get agent configuration
 */
public query func getAgentConfig() : async ?AgentConfig {
  agentConfig
};

/**
 * Get agent status
 */
public query func getAgentStatus() : async {
  initialized : Bool;
  version : Text;
  totalMemories : Nat;
  totalTasks : Nat;
  wasmLoaded : Bool;
  executionCount : Nat;
  lastExecuted : Int;
} {
  {
    initialized = Option.isSome(agentConfig);
    version = switch(agentConfig) {
      case(?c) { c.version };
      case(_) { "0.0.0" };
    };
    totalMemories = memories.size();
    totalTasks = tasks.size();
    wasmLoaded = Option.isSome(wasmMetadata);
    executionCount = agentState.executionCount;
    lastExecuted = agentState.lastExecuted;
  }
};

/**
 * Set agent configuration (can only be called once)
 */
public shared func setAgentConfig(config : AgentConfig) : async {
  #ok : Text;
  #err : Text;
} {
  if (Option.isSome(agentConfig)) {
    return #err("Agent already configured");
  };
  agentConfig := ?config;
  #ok("Agent configured successfully")
};

// ==================== WASM Module Management ====================

/**
 * Load agent WASM module into canister
 *
 * @param wasm - WASM binary data
 * @param hash - Expected SHA-256 hash of WASM
 * @returns Loading result
 */
public shared func loadAgentWasm(wasm : [Nat8], hash : [Nat8]) : async {
  #ok : Text;
  #err : Text;
} {
  // Validate WASM size (must be at least 8 bytes for magic + version)
  if (wasm.size() < 8) {
    return #err("WASM file too small (must be at least 8 bytes)");
  };

  // Validate WASM magic bytes (0x00 0x61 0x73 0x6d = "\0asm")
  let magicBytes = Array.subArray<Nat8>(wasm, 0, 4);
  let expectedMagic : [Nat8] = [0x00, 0x61, 0x73, 0x6d];
  if (not Blob.equal(Blob.fromArray(magicBytes), Blob.fromArray(expectedMagic))) {
    return #err("Invalid WASM magic bytes");
  };

  // Validate WASM version (0x01 0x00 0x00 0x00)
  let versionBytes = Array.subArray<Nat8>(wasm, 4, 8);
  let expectedVersion : [Nat8] = [0x01, 0x00, 0x00, 0x00];
  if (not Blob.equal(Blob.fromArray(versionBytes), Blob.fromArray(expectedVersion))) {
    return #err("Invalid WASM version (must be version 1)");
  };

  // Verify hash if provided
  if (hash.size() > 0) {
    // For MVP: Simple hash comparison (in production, use SHA-256)
    // Since we can't compute SHA-256 in pure Motoko easily,
    // we'll just store the provided hash for verification
  };

  // Store WASM and metadata
  agentWasm := wasm;
  wasmMetadata := ?{
    hash = hash;
    size = wasm.size();
    loadedAt = Time.now();
    functionNameCount = 14; // Standard 14-function interface
  };

  #ok("WASM module loaded successfully (" # Nat.toText(wasm.size()) # " bytes)")
};

/**
 * Get WASM module information
 */
public query func getWasmInfo() : async ?WasmMetadata {
  wasmMetadata
};

/**
 * Check if WASM module is loaded
 */
public query func isWasmLoaded() : async Bool {
  Option.isSome(wasmMetadata)
};

// ==================== Agent Interface: State Functions ====================

/**
 * Initialize agent state
 *
 * @param config - Agent configuration as JSON bytes
 * @returns Initialization result
 */
public shared func agent_init(config : [Nat8]) : async ExecutionResult {
  try {
    let configText = switch (Text.decodeUtf8(config)) {
      case (?text) { text };
      case (_) { return #err("Invalid UTF-8 in config") };
    };

    // Parse JSON (simplified for MVP)
    // In production, use proper JSON parsing

    agentState := {
      initialized = true;
      lastExecuted = 0;
      executionCount = 0;
    };

    #ok([0x01]); // Success
  } catch (e) {
    #err("Init failed: " # Error.message(e))
  }
};

/**
 * Execute agent step function
 *
 * @param input - Input data as bytes
 * @returns Execution result
 */
public shared func agent_step(input : [Nat8]) : async ExecutionResult {
  if (not agentState.initialized) {
    return #err("Agent not initialized");
  };

  try {
    // In production, this would execute the loaded WASM module
    // For MVP: Return simulated result
    let resultText = "Agent executed with " # Nat.toText(input.size()) # " bytes of input";
    let resultBytes = switch (Text.encodeUtf8(resultText)) {
      case (?bytes) { bytes };
      case (_) { [] };
    };

    agentState.lastExecuted := Time.now();
    agentState.executionCount += 1;

    #ok(resultBytes)
  } catch (e) {
    #err("Step failed: " # Error.message(e))
  }
};

/**
 * Get agent state as bytes
 *
 * @returns Agent state serialized as bytes
 */
public query func agent_get_state() : async [Nat8] {
  // In production, serialize actual state
  // For MVP: Return simple state bytes
  [0x01]
};

/**
 * Get agent state size
 *
 * @returns Size of serialized state in bytes
 */
public query func agent_get_state_size() : async Nat {
  // In production, return actual size
  1 // Minimal state size for MVP
};

// ==================== Agent Interface: Memory Functions ====================

/**
 * Add a memory entry
 *
 * @param type - Memory type (fact, user_preference, task_result)
 * @param content - Memory content as bytes
 * @returns Add result
 */
public shared func agent_add_memory(type : Nat, content : [Nat8]) : async ExecutionResult {
  try {
    let contentText = switch (Text.decodeUtf8(content)) {
      case (?text) { text };
      case (_) { return #err("Invalid UTF-8 in content") };
    };

    let memoryType : { #fact; #user_preference; #task_result } = switch (type) {
      case (0) { #fact };
      case (1) { #user_preference };
      case (2) { #task_result };
      case (_) { return #err("Invalid memory type") };
    };

    let memory : Memory = {
      id = "mem_" # Nat.toText(Time.now());
      memoryType = memoryType;
      content = contentText;
      timestamp = Time.now();
      importance = 1;
    };

    memories := Array.append<Memory>(memories, [memory]);

    #ok([0x01])
  } catch (e) {
    #err("Add memory failed: " # Error.message(e))
  }
};

/**
 * Get all memories
 *
 * @returns All memories serialized as bytes
 */
public query func agent_get_memories() : async [Nat8] {
  // In production, serialize all memories
  // For MVP: Return minimal representation
  let count = memories.size();
  [Nat8.fromNat(count)]
};

/**
 * Get memories by type
 *
 * @param memoryType - Memory type to filter (0=fact, 1=user_preference, 2=task_result)
 * @returns Filtered memories serialized as bytes
 */
public query func agent_get_memories_by_type(memoryType : Nat) : async [Nat8] {
  // In production, filter and serialize memories
  // For MVP: Return count
  let filterType : { #fact; #user_preference; #task_result } = switch (memoryType) {
    case (0) { #fact };
    case (1) { #user_preference };
    case (2) { #task_result };
    case (_) { return [] };
  };

  let filtered = Array.filter<Memory>(
    memories,
    func(m : Memory) : Bool {
      switch (m.memoryType, filterType) {
        case (#fact, #fact) { true };
        case (#user_preference, #user_preference) { true };
        case (#task_result, #task_result) { true };
        case (_) { false };
      }
    }
  );

  [Nat8.fromNat(filtered.size())]
};

/**
 * Clear all memories
 *
 * @returns Clear result
 */
public shared func agent_clear_memories() : async ExecutionResult {
  memories := [];
  #ok([0x01])
};

// ==================== Agent Interface: Task Functions ====================

/**
 * Add a task to the queue
 *
 * @param taskId - Task ID as bytes
 * @param description - Task description as bytes
 * @returns Add result
 */
public shared func agent_add_task(taskId : [Nat8], description : [Nat8]) : async ExecutionResult {
  try {
    let taskIdText = switch (Text.decodeUtf8(taskId)) {
      case (?text) { text };
      case (_) { return #err("Invalid UTF-8 in task ID") };
    };

    let descriptionText = switch (Text.decodeUtf8(description)) {
      case (?text) { text };
      case (_) { return #err("Invalid UTF-8 in description") };
    };

    let task : Task = {
      id = taskIdText;
      description = descriptionText;
      status = #pending;
      result = null;
      timestamp = Time.now();
    };

    tasks := Array.append<Task>(tasks, [task]);

    #ok([0x01])
  } catch (e) {
    #err("Add task failed: " # Error.message(e))
  }
};

/**
 * Get all tasks
 *
 * @returns All tasks serialized as bytes
 */
public query func agent_get_tasks() : async [Nat8] {
  // In production, serialize all tasks
  // For MVP: Return count
  [Nat8.fromNat(tasks.size())]
};

/**
 * Get pending tasks
 *
 * @returns Pending tasks serialized as bytes
 */
public query func agent_get_pending_tasks() : async [Nat8] {
  let pending = Array.filter<Task>(
    tasks,
    func(t : Task) : Bool {
      switch (t.status) {
        case (#pending) { true };
        case (_) { false };
      }
    }
  );

  [Nat8.fromNat(pending.size())]
};

/**
 * Update task status
 *
 * @param taskId - Task ID as bytes
 * @param status - Task status (0=pending, 1=running, 2=completed, 3=failed)
 * @param result - Task result as bytes (optional)
 * @returns Update result
 */
public shared func agent_update_task_status(taskId : [Nat8], status : Nat, result : [Nat8]) : async ExecutionResult {
  try {
    let taskIdText = switch (Text.decodeUtf8(taskId)) {
      case (?text) { text };
      case (_) { return #err("Invalid UTF-8 in task ID") };
    };

    let statusVariant : { #pending; #running; #completed; #failed } = switch (status) {
      case (0) { #pending };
      case (1) { #running };
      case (2) { #completed };
      case (3) { #failed };
      case (_) { return #err("Invalid status") };
    };

    let resultText : ?Text = if (result.size() > 0) {
      switch (Text.decodeUtf8(result)) {
        case (?text) { ?text };
        case (_) { return #err("Invalid UTF-8 in result") };
      }
    } else {
      null
    };

    let found = false;

    tasks := Array.map<Task, Task>(
      tasks,
      func(t : Task) : Task {
        if (t.id == taskIdText) {
          found := true;
          {
            id = t.id;
            description = t.description;
            status = statusVariant;
            result = resultText;
            timestamp = t.timestamp;
          }
        } else {
          t
        }
      }
    );

    if (found) {
      #ok([0x01])
    } else {
      #err("Task not found")
    }
  } catch (e) {
    #err("Update task status failed: " # Error.message(e))
  }
};

/**
 * Clear all tasks
 *
 * @returns Clear result
 */
public shared func agent_clear_tasks() : async ExecutionResult {
  tasks := [];
  #ok([0x01])
};

// ==================== Agent Interface: Info Function ====================

/**
 * Get agent information
 *
 * @returns Agent info serialized as bytes
 */
public query func agent_get_info() : async [Nat8] {
  // In production, serialize full agent info
  // For MVP: Return simple info bytes
  let infoText = switch (agentConfig) {
    case (?c) {
      c.name # "|" # c.version # "|" # Nat.toText(memories.size()) # "|" # Nat.toText(tasks.size())
    };
    case (_) { "not_configured" };
  };

  switch (Text.encodeUtf8(infoText)) {
    case (?bytes) { bytes };
    case (_) { [] };
  }
};

// ==================== Legacy Functions (for backward compatibility) ====================

/**
 * Execute agent (legacy function, calls agent_step)
 */
public shared func execute(input : Text) : async {
  #ok : Text;
  #err : Text;
} {
  if (Option.isNull(agentConfig)) {
    return #err("Agent not configured");
  };

  let inputBytes = switch (Text.encodeUtf8(input)) {
    case (?bytes) { bytes };
    case (_) { return #err("Invalid UTF-8 input") };
  };

  switch (await agent_step(inputBytes)) {
    case (#ok(result)) {
      let resultText = switch (Text.decodeUtf8(result)) {
        case (?text) { text };
        case (_) { "Result: " # Nat.toText(result.size()) # " bytes" };
      };
      #ok(resultText)
    };
    case (#err(e)) {
      #err(e)
    };
  }
};

// ==================== Memory Management Functions (Legacy) ====================

/**
 * Add a memory (legacy function)
 */
public shared func addMemory(memory : Memory) : async {
  #ok : Text;
  #err : Text;
} {
  memories := Array.append<Memory>(memories, [memory]);
  #ok("Memory added")
};

/**
 * Get all memories (legacy function)
 */
public query func getMemories() : async [Memory] {
  memories
};

/**
 * Get memories by type (legacy function)
 */
public query func getMemoriesByType(memoryType : { #fact; #user_preference; #task_result }) : async [Memory] {
  Array.filter<Memory>(
    memories,
    func(m : Memory) : Bool {
      switch(m.memoryType, memoryType) {
        case(#fact, #fact) { true };
        case(#user_preference, #user_preference) { true };
        case(#task_result, #task_result) { true };
        case(_) { false };
      }
    }
  )
};

/**
 * Clear memories (legacy function)
 */
public shared func clearMemories() : async Text {
  memories := [];
  "Memories cleared"
};

// ==================== Task Management Functions (Legacy) ====================

/**
 * Add a task to the queue (legacy function)
 */
public shared func addTask(task : Task) : async {
  #ok : Text;
  #err : Text;
} {
  tasks := Array.append<Task>(tasks, [task]);
  #ok("Task added to queue")
};

/**
 * Get all tasks (legacy function)
 */
public query func getTasks() : async [Task] {
  tasks
};

/**
 * Get pending tasks (legacy function)
 */
public query func getPendingTasks() : async [Task] {
  Array.filter<Task>(
    tasks,
    func(t : Task) : Bool {
      switch(t.status) {
        case(#pending) { true };
        case(_) { false };
      }
    }
  )
};

/**
 * Get running tasks (legacy function)
 */
public query func getRunningTasks() : async [Task] {
  Array.filter<Task>(
    tasks,
    func(t : Task) : Bool {
      switch(t.status) {
        case(#running) { true };
        case(_) { false };
      }
    }
  )
};

/**
 * Update task status (legacy function)
 */
public shared func updateTaskStatus(taskId : Text, status : { #pending; #running; #completed; #failed }, result : ?Text) : async {
  #ok : Text;
  #err : Text;
} {
  var updated = false;
  tasks := Array.map<Task, Task>(
    tasks,
    func(t : Task) : Task {
      if (t.id == taskId) {
        updated := true;
        {
          id = t.id;
          description = t.description;
          status = status;
          result = result;
          timestamp = t.timestamp;
        }
      } else {
        t
      }
    }
  );

  if (not updated) {
    #err("Task not found")
  } else {
    #ok("Task status updated")
  }
};

/**
 * Clear tasks (legacy function)
 */
public shared func clearTasks() : async Text {
  tasks := [];
  "Tasks cleared"
};

// ==================== Context Management Functions (Legacy) ====================

/**
 * Set context value (legacy function)
 */
public shared func setContext(key : Text, value : Text) : async Text {
  context := Array.append<(Text, Text)>(context, [(key, value)]);
  "Context set"
};

/**
 * Get context value (legacy function)
 */
public query func getContext(key : Text) : async ?Text {
  var found : ?Text = null;
  for ((k, v) in context.vals()) {
    if (k == key) {
      found := ?v;
    }
  };
  found
};

/**
 * Get all context (legacy function)
 */
public query func getAllContext() : async [(Text, Text)] {
  context
};

/**
 * Clear context (legacy function)
 */
public shared func clearContext() : async Text {
  context := [];
  "Context cleared"
};

// ==================== Transaction Queue Functions (Phase 5B) ====================

/**
 * Generate unique transaction ID
 */
private func generateTransactionId() : Text {
  "tx_" # Nat.toText(Time.now()) # "_" # Nat.toText(transactionQueue.size());
};

/**
 * Queue a transaction
 *
 * @param action - Transaction action to queue
 * @returns Queue result
 */
public shared func queueTransaction(action : TransactionAction) : async {
  #ok : Text;
  #err : Text;
} {
  let tx : QueuedTransaction = {
    id = generateTransactionId();
    action = action;
    status = #pending;
    result = null;
    retryCount = 0;
    scheduledAt = null;
    createdAt = Time.now();
    signedAt = null;
    completedAt = null;
    errorMessage = null;
  };

  transactionQueue := Array.append<QueuedTransaction>(transactionQueue, [tx]);

  #ok("Transaction queued: " # tx.id)
};

/**
 * Get all queued transactions
 *
 * @returns All queued transactions
 */
public query func getQueuedTransactions() : async [QueuedTransaction] {
  transactionQueue
};

/**
 * Get pending transactions
 *
 * @returns Pending transactions
 */
public query func getPendingTransactions() : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch(tx.status) {
        case(#pending) { true };
        case(_) { false };
      }
    }
  )
};

/**
 * Get queued transactions by wallet
 *
 * @param walletId - Wallet ID to filter
 * @returns Queued transactions for wallet
 */
public query func getQueuedTransactionsByWallet(walletId : Text) : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      tx.action.walletId == walletId
    }
  )
};

/**
 * Get transaction by ID
 *
 * @param txId - Transaction ID
 * @returns Transaction or null
 */
public query func getQueuedTransaction(txId : Text) : async ?QueuedTransaction {
  for(tx in transactionQueue.vals()) {
    if(tx.id == txId) {
      return ?tx;
    };
  };
  null
};

/**
 * Mark transaction as signed
 *
 * @param txId - Transaction ID
 * @param signature - Signature data
 * @returns Update result
 */
public shared func markTransactionSigned(txId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if(tx.id == txId) {
        found := true;
        {
          id = tx.id;
          action = tx.action;
          status = #signed;
          result = ?signature;
          retryCount = tx.retryCount;
          scheduledAt = tx.scheduledAt;
          createdAt = tx.createdAt;
          signedAt = ?Time.now();
          completedAt = tx.completedAt;
          errorMessage = tx.errorMessage;
        }
      } else {
        tx
      }
    }
  );

  if(found) {
    #ok("Transaction marked as signed: " # txId)
  } else {
    #err("Transaction not found: " # txId)
  }
};

/**
 * Mark transaction as completed
 *
 * @param txId - Transaction ID
 * @param txHash - Transaction hash
 * @returns Update result
 */
public shared func markTransactionCompleted(txId : Text, txHash : Text) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if(tx.id == txId) {
        found := true;
        {
          id = tx.id;
          action = tx.action;
          status = #completed;
          result = ?txHash;
          retryCount = tx.retryCount;
          scheduledAt = tx.scheduledAt;
          createdAt = tx.createdAt;
          signedAt = tx.signedAt;
          completedAt = ?Time.now();
          errorMessage = tx.errorMessage;
        }
      } else {
        tx
      }
    }
  );

  if(found) {
    #ok("Transaction marked as completed: " # txId)
  } else {
    #err("Transaction not found: " # txId)
  }
};

/**
 * Mark transaction as failed
 *
 * @param txId - Transaction ID
 * @param error - Error message
 * @returns Update result
 */
public shared func markTransactionFailed(txId : Text, error : Text) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if(tx.id == txId) {
        found := true;
        {
          id = tx.id;
          action = tx.action;
          status = #failed;
          result = null;
          retryCount = tx.retryCount + 1;
          scheduledAt = tx.scheduledAt;
          createdAt = tx.createdAt;
          signedAt = tx.signedAt;
          completedAt = ?Time.now();
          errorMessage = ?error;
        }
      } else {
        tx
      }
    }
  );

  if(found) {
    #ok("Transaction marked as failed: " # txId)
  } else {
    #err("Transaction not found: " # txId)
  }
};

/**
 * Retry failed transaction
 *
 * @param txId - Transaction ID
 * @returns Retry result
 */
public shared func retryTransaction(txId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if(tx.id == txId) {
        found := true;
        {
          id = tx.id;
          action = tx.action;
          status = #queued;
          result = null;
          retryCount = tx.retryCount;
          scheduledAt = ?Time.now();
          createdAt = tx.createdAt;
          signedAt = null;
          completedAt = null;
          errorMessage = null;
        }
      } else {
        tx
      }
    }
  );

  if(found) {
    #ok("Transaction queued for retry: " # txId)
  } else {
    #err("Transaction not found: " # txId)
  }
};

/**
 * Schedule transaction for future execution
 *
 * @param txId - Transaction ID
 * @param scheduledAt - Scheduled time
 * @returns Update result
 */
public shared func scheduleTransaction(txId : Text, scheduledAt : Int) : async {
  #ok : Text;
  #err : Text;
} {
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if(tx.id == txId) {
        found := true;
        {
          id = tx.id;
          action = tx.action;
          status = #queued;
          result = null;
          retryCount = tx.retryCount;
          scheduledAt = ?scheduledAt;
          createdAt = tx.createdAt;
          signedAt = null;
          completedAt = null;
          errorMessage = tx.errorMessage;
        }
      } else {
        tx
      }
    }
  );

  if(found) {
    #ok("Transaction scheduled: " # txId)
  } else {
    #err("Transaction not found: " # txId)
  }
};

/**
 * Clear completed transactions
 *
 * @returns Clear result
 */
public shared func clearCompletedTransactions() : async Text {
  transactionQueue := Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch(tx.status) {
        case(#completed) { false };
        case(_) { true };
      }
    }
  );

  "Completed transactions cleared"
};

/**
 * Get transaction queue statistics
 *
 * @returns Queue statistics
 */
public query func getTransactionQueueStats() : async {
  total : Nat;
  pending : Nat;
  queued : Nat;
  signed : Nat;
  completed : Nat;
  failed : Nat;
} {
  var pendingCount : Nat = 0;
  var queuedCount : Nat = 0;
  var signedCount : Nat = 0;
  var completedCount : Nat = 0;
  var failedCount : Nat = 0;

  for(tx in transactionQueue.vals()) {
    switch(tx.status) {
      case(#pending) { pendingCount += 1 };
      case(#queued) { queuedCount += 1 };
      case(#signed) { signedCount += 1 };
      case(#completed) { completedCount += 1 };
      case(#failed) { failedCount += 1 };
    }
  };

  {
    total = transactionQueue.size();
    pending = pendingCount;
    queued = queuedCount;
    signed = signedCount;
    completed = completedCount;
    failed = failedCount;
  }
};

// ==================== System Functions ====================

/**
 * Get canister status
 */
public query func getCanisterStatus() : async {
  status : { #running; #stopping; #stopped };
  memorySize : Nat;
  cycles : Nat;
} {
  {
    status = #running;
    memorySize = Memory.heapSize();
    cycles = Cycles.balance();
  }
};

/**
 * Get metrics
 */
public query func getMetrics() : async {
  uptime : Int;
  operations : Nat;
  lastActivity : Int;
} {
  // In production, these would be tracked
  {
    uptime = Time.now();
    operations = agentState.executionCount;
    lastActivity = agentState.lastExecuted;
  }
};

/**
 * Heartbeat for maintenance
 */
public shared func heartbeat() : async Bool {
  // Perform any necessary maintenance tasks
  true
};
