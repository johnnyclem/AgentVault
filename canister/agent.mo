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
import Nat "mo:base/Nat";
import Time "mo:base/Time";
import Iter "mo:base/Iter";
import Blob "mo:base/Blob";
import Text "mo:base/Text";
import Array "mo:base/Array";
import Option "mo:base/Option";
import Result "mo:base/Result";
import Principal "mo:base/Principal";
import Cycles "mo:base/ExperimentalCycles";
import Debug "mo:base/Debug";

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

// ==================== VetKeys Encrypted Secrets (Phase 5D) ====================

/**
 * Encrypted secret for VetKeys integration
 */
public type EncryptedSecret = {
  id : Text;
  ciphertext : [Nat8];
  iv : [Nat8];
  tag : [Nat8];
  algorithm : { #aes_256_gcm; #chacha20_poly1305 };
  createdAt : Int;
};

// Encrypted secrets storage
stable var encryptedSecrets : [EncryptedSecret] = [];

// ==================== Hardening State ====================

let maxHeapSizeBytes : Nat = 64 * 1024 * 1024; // 64 MiB
let healthCheckIntervalNanos : Int = 5 * 60 * 1_000_000_000; // 5 minutes
let maxConsecutiveHealthTimeouts : Nat = 3;

stable var ownerPrincipal : ?Principal = null;
stable var authorizedCallers : [Principal] = [];
stable var upgradesLocked : Bool = true;
stable var frozenMode : Bool = true;
stable var canisterKilled : Bool = false;
stable var lastHealthCheckAt : Int = 0;
stable var lastHealthCheckOkAt : Int = 0;
stable var consecutiveHealthTimeouts : Nat = 0;

private func ensureOwnerInitialized(caller : Principal) {
  switch (ownerPrincipal) {
    case null {
      ownerPrincipal := ?caller;
      authorizedCallers := [caller];
    };
    case (_) {};
  }
};

private func isAuthorized(caller : Principal) : Bool {
  switch (ownerPrincipal) {
    case (?owner) {
      if (caller == owner) {
        true
      } else {
        Option.isSome(Array.find<Principal>(authorizedCallers, func(p : Principal) : Bool { p == caller }))
      }
    };
    case null { false };
  }
};

private func assertAuthorized(caller : Principal) : Result.Result<(), Text> {
  ensureOwnerInitialized(caller);
  if (canisterKilled) {
    return #err("Canister is killed due to failed health checks");
  };
  if (Memory.heapSize() > maxHeapSizeBytes) {
    canisterKilled := true;
    return #err("Heap limit exceeded (64 MiB). Canister moved to killed state");
  };
  if (isAuthorized(caller)) {
    #ok(())
  } else {
    #err("Unauthorized principal")
  }
};

private func checkGuard(caller : Principal) : ?Text {
  switch (assertAuthorized(caller)) {
    case (#ok(_)) { null };
    case (#err(msg)) { ?msg };
  }
};

private let ic : actor {
  http_request : ({
    url : Text;
    max_response_bytes : ?Nat;
    headers : [{ name : Text; value : Text }];
    body : ?[Nat8];
    method : { #get; #post; #head };
    transform : ?{
      function : shared query ({ status : Nat; headers : [{ name : Text; value : Text }]; body : [Nat8] }) -> async {
        status : Nat;
        headers : [{ name : Text; value : Text }];
        body : [Nat8];
      };
      context : [Nat8];
    };
  }) -> async { status : Nat; headers : [{ name : Text; value : Text }]; body : [Nat8] };
} = actor "aaaaa-aa";

public query func transformHealthResponse(resp : {
  status : Nat;
  headers : [{ name : Text; value : Text }];
  body : [Nat8];
}) : async {
  status : Nat;
  headers : [{ name : Text; value : Text }];
  body : [Nat8];
} {
  {
    status = resp.status;
    headers = [];
    body = [];
  }
};

private func runHealthCheck() : async Bool {
  let now = Time.now();
  if (now - lastHealthCheckAt < healthCheckIntervalNanos) {
    return true;
  };

  lastHealthCheckAt := now;
  try {
    let response = await ic.http_request({
      url = "https://api.binance.com/api/v3/ping";
      max_response_bytes = ?256;
      headers = [{ name = "User-Agent"; value = "agentvault-canister-health" }];
      body = null;
      method = #get;
      transform = ?{
        function = transformHealthResponse;
        context = [];
      };
    });

    if (response.status >= 200 and response.status < 300) {
      consecutiveHealthTimeouts := 0;
      lastHealthCheckOkAt := now;
      true
    } else {
      consecutiveHealthTimeouts += 1;
      if (consecutiveHealthTimeouts > maxConsecutiveHealthTimeouts) {
        canisterKilled := true;
      };
      false
    }
  } catch (_err) {
    consecutiveHealthTimeouts += 1;
    if (consecutiveHealthTimeouts > maxConsecutiveHealthTimeouts) {
      canisterKilled := true;
    };
    false
  }
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
public shared(msg) func queueTransaction(action : TransactionAction) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
public shared(msg) func markTransactionSigned(txId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
public shared(msg) func markTransactionCompleted(txId : Text, txHash : Text) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
public shared(msg) func markTransactionFailed(txId : Text, error : Text) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
          retryCount = tx.retryCount +1;
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
public shared(msg) func retryTransaction(txId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
public shared(msg) func scheduleTransaction(txId : Text, scheduledAt : Int) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

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
public shared(msg) func clearCompletedTransactions() : async Text {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return reason };
    case null {};
  };


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
      case(#pending) { pendingCount +=1 };
      case(#queued) { queuedCount +=1 };
      case(#signed) { signedCount +=1 };
      case(#completed) { completedCount +=1 };
      case(#failed) { failedCount +=1 };
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

// ==================== VetKeys Encrypted Secrets (Phase 5D) ====================

/**
 * Register a wallet in the canister
 *
 * @param walletInfo - Wallet metadata to register
 * @returns Registration result
 */
public shared(msg) func registerWallet(walletInfo : WalletInfo) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

  // Check if wallet already exists
  for ((id, _) in walletRegistry.vals()) {
    if (id == walletInfo.id) {
      return #err("Wallet already registered: " # walletInfo.id);
    };
  };

  // Register wallet metadata
  walletRegistry := Array.append<(Text, WalletInfo)>(walletRegistry, [(walletInfo.id, walletInfo)]);

  #ok("Wallet registered: " # walletInfo.id)
};

// ==================== VetKeys Canister Functions (Phase 5D - Mock) ====================

/**
 * Store encrypted secret in canister
 *
 * @param secret - Encrypted secret data
 * @returns Storage result
 */
public shared(msg) func storeEncryptedSecret(secret : EncryptedSecret) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

  encryptedSecrets := Array.append<EncryptedSecret>(encryptedSecrets, [secret]);

  #ok("Secret stored: " # secret.id)
};

/**
 * Get encrypted secret from canister
 *
 * @param secretId - Secret ID to retrieve
 * @returns Encrypted secret or null
 */
public query func getEncryptedSecret(secretId : Text) : async ?EncryptedSecret {
  for (secret in encryptedSecrets.vals()) {
    if (secret.id == secretId) {
      return ?secret;
    };
  };
  null
};

/**
 * List all encrypted secrets
 *
 * @returns Array of encrypted secrets
 */
public query func listEncryptedSecrets() : async [EncryptedSecret] {
  encryptedSecrets
};

/**
 * Delete encrypted secret from canister
 *
 * @param secretId - Secret ID to delete
 * @returns Deletion result
 */
public shared(msg) func deleteEncryptedSecret(secretId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

  var found = false;

  encryptedSecrets := Array.filter<EncryptedSecret>(
    encryptedSecrets,
    func(s : EncryptedSecret) : Bool {
      if (s.id == secretId) {
        found := true;
        false
      } else {
        true
      }
    }
  );

  if (found) {
    #ok("Secret deleted: " # secretId)
  } else {
    #err("Secret not found: " # secretId)
  }
};

/**
 * Verify VetKeys threshold signature
 *
 * IMPORTANT: Requires VetKeys canister deployment.
 * Without deployed VetKeys canister, returns error.
 *
 * @param transactionId - Transaction ID
 * @param signature - Signature to verify
 * @returns Verification result
 */
public query func verifyThresholdSignature(transactionId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  // Validate inputs
  if (Text.size(transactionId) == 0) {
    return #err("Transaction ID cannot be empty");
  };
  if (Text.size(signature) < 64) {
    return #err("Invalid signature: must be at least 64 characters");
  };

  // VetKeys canister not deployed - return error
  // In production, this would call the VetKeys canister for verification
  #err("VetKeys canister not deployed. Threshold signature verification requires deployed VetKeys canister. Use single-party signing or deploy VetKeys.")
};

/**
 * Derive threshold key via VetKeys
 *
 * IMPORTANT: Requires VetKeys canister deployment.
 * Without deployed VetKeys canister, returns error.
 * Does NOT store or log the seed phrase.
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param threshold - Threshold number (minimum 2)
 * @returns Derivation result
 */
public shared(msg) func deriveVetKeysKey(seedPhrase : Text, threshold : Nat) : async {
  #ok : Text;
  #err : Text;
} {
  switch (checkGuard(msg.caller)) {
    case (?reason) { return #err(reason) };
    case null {};
  };

  // Validate inputs
  if (Text.size(seedPhrase) == 0) {
    return #err("Seed phrase cannot be empty");
  };
  if (threshold < 2) {
    return #err("Threshold must be at least 2 for threshold signatures");
  };
  if (threshold > 10) {
    return #err("Threshold cannot exceed 10");
  };

  // VetKeys canister not deployed - return error
  // In production, this would call the VetKeys canister for key derivation
  // The seed phrase is NEVER stored or logged
  #err("VetKeys canister not deployed. Threshold key derivation requires deployed VetKeys canister. Use single-party key derivation or deploy VetKeys.")
};

/**
 * Get VetKeys status
 *
 * Reports current VetKeys configuration status.
 *
 * @returns VetKeys configuration status
 */
public query func getVetKeysStatus() : async {
  enabled : Bool;
  thresholdSupported : Bool;
  mode : { #mock; #production };
} {
  // VetKeys canister not deployed
  {
    enabled = false;
    thresholdSupported = true;  // Supported by architecture, but canister not deployed
    mode = #mock;
  }
};


public shared(msg) func addAuthorizedCaller(caller : Principal) : async {
  #ok : Text;
  #err : Text;
} {
  ensureOwnerInitialized(msg.caller);
  switch (ownerPrincipal) {
    case (?owner) {
      if (msg.caller != owner) {
        return #err("Only owner can add authorized callers");
      };
      if (Option.isSome(Array.find<Principal>(authorizedCallers, func(p : Principal) : Bool { p == caller }))) {
        return #ok("Caller already authorized");
      };
      authorizedCallers := Array.append<Principal>(authorizedCallers, [caller]);
      #ok("Authorized caller added")
    };
    case null { #err("Owner not initialized") };
  }
};

public shared(msg) func unlockUpgrades() : async { #ok : Text; #err : Text } {
  ensureOwnerInitialized(msg.caller);
  switch (ownerPrincipal) {
    case (?owner) {
      if (msg.caller != owner) {
        return #err("Only owner can unlock upgrades");
      };
      upgradesLocked := false;
      frozenMode := false;
      #ok("Upgrades unlocked")
    };
    case null { #err("Owner not initialized") };
  }
};

public shared(msg) func lockUpgrades() : async { #ok : Text; #err : Text } {
  ensureOwnerInitialized(msg.caller);
  switch (ownerPrincipal) {
    case (?owner) {
      if (msg.caller != owner) {
        return #err("Only owner can lock upgrades");
      };
      upgradesLocked := true;
      frozenMode := true;
      #ok("Upgrades locked")
    };
    case null { #err("Owner not initialized") };
  }
};

public query func getHardeningStatus() : async {
  owner : ?Principal;
  authorizedCallerCount : Nat;
  frozen : Bool;
  upgradesLocked : Bool;
  killed : Bool;
  heapLimitBytes : Nat;
  heapSizeBytes : Nat;
  lastHealthCheckAt : Int;
  lastHealthCheckOkAt : Int;
  consecutiveHealthTimeouts : Nat;
} {
  {
    owner = ownerPrincipal;
    authorizedCallerCount = authorizedCallers.size();
    frozen = frozenMode;
    upgradesLocked = upgradesLocked;
    killed = canisterKilled;
    heapLimitBytes = maxHeapSizeBytes;
    heapSizeBytes = Memory.heapSize();
    lastHealthCheckAt = lastHealthCheckAt;
    lastHealthCheckOkAt = lastHealthCheckOkAt;
    consecutiveHealthTimeouts = consecutiveHealthTimeouts;
  }
};

system func preupgrade() {
  if (upgradesLocked or frozenMode) {
    Debug.trap("Canister is frozen; unlockUpgrades must be called before upgrades");
  };
};

// ==================== System Functions ====================

/**
 * Get canister status
 */
public query func getCanisterStatus() : async {
  status : { #running; #stopping; #stopped };
  memorySize : Nat;
  memoryLimit : Nat;
  cycles : Nat;
  frozen : Bool;
  upgradesLocked : Bool;
  killed : Bool;
} {
  {
    status = if (canisterKilled) { #stopped } else { #running };
    memorySize = Memory.heapSize();
    memoryLimit = maxHeapSizeBytes;
    cycles = Cycles.balance();
    frozen = frozenMode;
    upgradesLocked = upgradesLocked;
    killed = canisterKilled;
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
 * Manual health check trigger (owner/authorized only)
 */
public shared(msg) func triggerHealthCheck() : async Bool {
  switch (checkGuard(msg.caller)) {
    case (?_) { return false };
    case null {};
  };

  if (canisterKilled) {
    return false;
  };

  await runHealthCheck()
};

/**
 * Automatic heartbeat health check
 */
system func heartbeat() : async () {
  if (canisterKilled) {
    return;
  };
  ignore await runHealthCheck();
};
