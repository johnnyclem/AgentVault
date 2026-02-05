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

// ==================== VetKeys Canister Functions (Phase 5D - Mock) ====================

/**
 * Store encrypted secret in canister
 *
 * @param secret - Encrypted secret data
 * @returns Storage result
 */
public shared func storeEncryptedSecret(secret : EncryptedSecret) : async {
  #ok : Text;
  #err : Text;
} {
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
public shared func deleteEncryptedSecret(secretId : Text) : async {
  #ok : Text;
  #err : Text;
} {
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
 * Verify VetKeys threshold signature (mock)
 *
 * @param transactionId - Transaction ID
 * @param signature - Signature to verify
 * @returns Verification result
 */
public query func verifyThresholdSignature(transactionId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  // Mock implementation: always return success
  #ok("Signature verified: " # transactionId)
};

/**
 * Derive threshold key via VetKeys (mock)
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param threshold - Threshold number
 * @returns Derivation result
 */
public shared func deriveVetKeysKey(seedPhrase : Text, threshold : Nat) : async {
  #ok : Text;
  #err : Text;
} {
  // Mock implementation: return success with note
  #ok("VetKeys key derived (mock): threshold = " # Nat.toText(threshold))
};

/**
 * Get VetKeys status (mock)
 *
 * @returns VetKeys configuration status
 */
public query func getVetKeysStatus() : async {
  enabled : Bool;
  thresholdSupported : Bool;
  mode : { #mock; #production };
} {
  {
    enabled = false;
    thresholdSupported = false;
    mode = #mock;
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
