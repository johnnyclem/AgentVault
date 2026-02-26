/**
 * AgentVault Canister (Motoko) - Hardened Production Version
 *
 * Security hardening applied:
 *
 *  1. HEAP LIMIT  — Prim.rts_heap_size() checked on every write call; aborts at 64 MB.
 *                   wasm_memory_limit is also enforced at the subnet level via dfx.json.
 *
 *  2. PRINCIPAL GUARDS — All state-mutating functions require an authorized caller.
 *                        Unknown / anonymous principals are rejected unconditionally.
 *                        Owner is claimed on first call to bootstrap(); any subsequent
 *                        attempt is rejected.
 *
 *  3. HEARTBEAT HEALTH CHECK — system func heartbeat() fires every IC round (~1 s).
 *                               It is throttled to ping the Binance REST API once per
 *                               5 minutes.  Three consecutive failures (timeout or non-200)
 *                               activate the kill switch, after which ALL non-owner
 *                               mutations are rejected until the owner calls reviveCanister().
 *
 *  4. FROZEN MODE — After the owner calls completeBootstrap(), the canister enters frozen
 *                   mode.  All state mutations are blocked until the owner calls
 *                   manualUnlock().  system func preupgrade() also traps while frozen,
 *                   preventing unauthorized code upgrades.
 */

import Memory    "mo:base/Memory";
import Buffer    "mo:base/Buffer";
import Int       "mo:base/Int";
import Nat       "mo:base/Nat";
import Nat64     "mo:base/Nat64";
import Time      "mo:base/Time";
import Iter      "mo:base/Iter";
import Blob      "mo:base/Blob";
import Text      "mo:base/Text";
import Array     "mo:base/Array";
import Option    "mo:base/Option";
import Principal "mo:base/Principal";
import Cycles    "mo:base/ExperimentalCycles";
import Prim      "mo:prim";

// ==================== Management Canister – HTTP Outcall Interface ====================
//
// Used exclusively by the heartbeat health-check to ping Binance.
// Declared at module scope so the actor reference is resolved at compile time.

type HttpHeader          = { name : Text; value : Text };
type HttpMethod          = { #get; #head; #post };
type HttpOutcallResponse = { status : Nat; headers : [HttpHeader]; body : Blob };
type TransformFn         = shared query { response : HttpOutcallResponse; context : Blob }
                             -> async HttpOutcallResponse;

type ManagementCanister = actor {
  http_request : shared {
    url               : Text;
    max_response_bytes : ?Nat64;
    headers           : [HttpHeader];
    body              : ?Blob;
    method            : HttpMethod;
    transform         : ?{ function : TransformFn; context : Blob };
  } -> async HttpOutcallResponse;
};

let mgmt : ManagementCanister = actor "aaaaa-aa";

// ==================== Domain Types ====================

public type AgentConfig = {
  name      : Text;
  agentType : Text;
  version   : Text;
  createdAt : Int;
};

public type WasmMetadata = {
  hash              : [Nat8];
  size              : Nat;
  loadedAt          : Int;
  functionNameCount : Nat;
};

public type Memory = {
  id         : Text;
  memoryType : { #fact; #user_preference; #task_result };
  content    : Text;
  timestamp  : Int;
  importance : Nat8;
};

public type Task = {
  id          : Text;
  description : Text;
  status      : { #pending; #running; #completed; #failed };
  result      : ?Text;
  timestamp   : Int;
};

public type ExecutionResult = {
  #ok  : [Nat8];
  #err : Text;
};

public type AgentState = {
  initialized    : Bool;
  lastExecuted   : Int;
  executionCount : Nat;
};

// ── Wallet Registry (Phase 5A) ──────────────────────────────────────────────

public type WalletInfo = {
  id           : Text;
  agentId      : Text;
  chain        : Text;
  address      : Text;
  registeredAt : Int;
  status       : { #active; #inactive; #revoked };
};

// ── Transaction Queue (Phase 5B) ────────────────────────────────────────────

public type TransactionAction = {
  walletId   : Text;
  action     : { #send_funds; #sign_message; #deploy_contract };
  parameters : [(Text, Text)];
  priority   : { #low; #normal; #high };
  threshold  : ?Nat;
};

public type TransactionStatus = {
  #pending;
  #queued;
  #signed;
  #completed;
  #failed;
};

public type QueuedTransaction = {
  id           : Text;
  action       : TransactionAction;
  status       : TransactionStatus;
  result       : ?Text;
  retryCount   : Nat;
  scheduledAt  : ?Int;
  createdAt    : Int;
  signedAt     : ?Int;
  completedAt  : ?Int;
  errorMessage : ?Text;
};

// ── VetKeys Encrypted Secrets (Phase 5D) ────────────────────────────────────

public type EncryptedSecret = {
  id         : Text;
  ciphertext : [Nat8];
  iv         : [Nat8];
  tag        : [Nat8];
  algorithm  : { #aes_256_gcm; #chacha20_poly1305 };
  createdAt  : Int;
};

// ==================== Security & Health Constants ====================

/// 64 MB hard ceiling on live heap.
let MAX_HEAP_BYTES     : Nat  = 64 * 1024 * 1024;

/// Health-check interval: 5 minutes in nanoseconds.
let HEALTH_INTERVAL_NS : Int  = 5 * 60 * 1_000_000_000;

/// Number of consecutive failures before the kill switch trips.
let MAX_TIMEOUTS       : Nat  = 3;

/// Cycles budget attached to each HTTP outcall (~300 M is typical mainnet cost).
let HTTP_OUTCALL_CYCLES : Nat = 300_000_000;

/// Binance public ping endpoint (no auth required, tiny 2-byte response).
let BINANCE_PING_URL   : Text = "https://api.binance.com/api/v3/ping";

/// Sentinel value: the built-in anonymous principal.
let ANON : Principal = Principal.fromText("2vxsx-fae");

// ==================== Security Stable State ====================

/// Canister owner — set once during bootstrap().  Defaults to anonymous (no-op sentinel).
stable var owner             : Principal  = ANON;

/// Additional principals allowed to call write functions.
stable var allowedPrincipals : [Principal] = [];

/// When true, ALL non-owner state mutations are rejected.
/// Set automatically by completeBootstrap(); cleared by manualUnlock().
stable var frozenMode        : Bool = false;

/// Tracks whether completeBootstrap() has been called.
stable var bootstrapComplete : Bool = false;

/// Kill switch — trips after MAX_TIMEOUTS consecutive Binance ping failures.
stable var canisterKilled        : Bool = false;
stable var consecutiveTimeouts   : Nat  = 0;
stable var totalHealthChecks     : Nat  = 0;
stable var lastHealthCheckNs     : Int  = 0;
stable var lastHealthStatus      : Text = "not_started";

// ==================== Agent Stable State ====================

stable var agentConfig  : ?AgentConfig  = null;
stable var agentWasm    : [Nat8]        = [];
stable var wasmMetadata : ?WasmMetadata = null;
stable var agentState   : AgentState    = {
  initialized    = false;
  lastExecuted   = 0;
  executionCount = 0;
};

stable var memories         : [Memory]             = [];
stable var tasks            : [Task]               = [];
stable var context          : [(Text, Text)]        = [];
stable var walletRegistry   : [(Text, WalletInfo)]  = [];
stable var transactionQueue : [QueuedTransaction]   = [];
stable var encryptedSecrets : [EncryptedSecret]     = [];

// ==================== Guard Functions ====================

/// Trap if the kill switch has been activated.
private func assertNotKilled() {
  if (canisterKilled) {
    assert false; // canister killed: Binance health-check failed too many times — call reviveCanister()
  };
};

/// Trap if live heap exceeds MAX_HEAP_BYTES (64 MB).
private func assertMemoryLimit() {
  if (Prim.rts_heap_size() >= MAX_HEAP_BYTES) {
    assert false; // heap size >= 64 MB hard limit; compact state before retrying
  };
};

/// Return true if `caller` is the owner or on the allowlist; anonymous is always rejected.
private func isAuthorized(caller : Principal) : Bool {
  if (Principal.isAnonymous(caller)) { return false };
  if (caller == owner)               { return true  };
  for (p in allowedPrincipals.vals()) {
    if (p == caller) { return true };
  };
  false
};

/// Trap if `caller` is not authorized.
private func assertAuthorized(caller : Principal) {
  if (not isAuthorized(caller)) {
    assert false; // caller principal is not authorized — unknown principals are rejected
  };
};

/// Trap if `caller` is not the owner.
private func assertOwner(caller : Principal) {
  if (caller != owner) {
    assert false; // only the canister owner may call this function
  };
};

/// Trap if frozen mode is active.
private func assertNotFrozen() {
  if (frozenMode) {
    assert false; // canister is frozen — call manualUnlock() first
  };
};

/// Combined write guard: kills, memory, auth, freeze — checked in that order.
private func assertWriteAllowed(caller : Principal) {
  assertNotKilled();
  assertMemoryLimit();
  assertAuthorized(caller);
  assertNotFrozen();
};

// ==================== Bootstrap & Owner Management ====================

/**
 * Claim ownership and set the initial agent configuration.
 *
 * May only be called ONCE.  The caller becomes the permanent owner.
 * Anonymous callers are rejected.
 */
public shared(msg) func bootstrap(config : AgentConfig) : async { #ok : Text; #err : Text } {
  assertNotKilled();
  assertMemoryLimit();

  if (agentState.initialized) {
    return #err("Already bootstrapped. Owner: " # Principal.toText(owner));
  };
  if (Principal.isAnonymous(msg.caller)) {
    return #err("Anonymous caller cannot claim ownership");
  };

  owner      := msg.caller;
  agentConfig := ?config;
  agentState  := {
    initialized    = true;
    lastExecuted   = Time.now();
    executionCount = 0;
  };

  #ok("Bootstrap complete. Owner: " # Principal.toText(msg.caller))
};

/**
 * Transition the canister into frozen mode.
 *
 * After this call, all state-mutating functions are blocked until the owner
 * explicitly calls manualUnlock().  Also blocks canister code upgrades via the
 * preupgrade system hook.
 *
 * Owner only.
 */
public shared(msg) func completeBootstrap() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  if (not agentState.initialized) {
    return #err("Call bootstrap() before completing bootstrap");
  };
  bootstrapComplete := true;
  frozenMode        := true;
  #ok("Canister is now frozen. Call manualUnlock() to re-enable writes.")
};

/**
 * Exit frozen mode.  Required before any write operation can succeed.
 *
 * Owner only.
 */
public shared(msg) func manualUnlock() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  frozenMode := false;
  #ok("Canister unfrozen by " # Principal.toText(msg.caller))
};

/**
 * Enter frozen mode manually.
 *
 * Owner only.
 */
public shared(msg) func freeze() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  frozenMode := true;
  #ok("Canister frozen by " # Principal.toText(msg.caller))
};

/**
 * Add a principal to the write-access allowlist.
 *
 * Owner only.  Anonymous principal is always rejected.
 */
public shared(msg) func addAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  if (Principal.isAnonymous(p)) {
    return #err("Cannot authorize the anonymous principal");
  };
  for (existing in allowedPrincipals.vals()) {
    if (existing == p) {
      return #ok("Already authorized: " # Principal.toText(p));
    };
  };
  allowedPrincipals := Array.append<Principal>(allowedPrincipals, [p]);
  #ok("Authorized: " # Principal.toText(p))
};

/**
 * Remove a principal from the write-access allowlist.
 *
 * Owner only.
 */
public shared(msg) func removeAuthorizedPrincipal(p : Principal) : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  allowedPrincipals := Array.filter<Principal>(
    allowedPrincipals,
    func(x : Principal) : Bool { x != p }
  );
  #ok("Removed: " # Principal.toText(p))
};

/**
 * Revive a killed canister.
 *
 * Resets the consecutive-timeout counter and clears the kill flag.
 * Owner only.
 */
public shared(msg) func reviveCanister() : async { #ok : Text; #err : Text } {
  assertOwner(msg.caller);
  canisterKilled      := false;
  consecutiveTimeouts := 0;
  lastHealthStatus    := "revived_by_owner";
  #ok("Canister revived")
};

/**
 * Read-only snapshot of the security posture.
 */
public query func getSecurityStatus() : async {
  owner             : Text;
  frozenMode        : Bool;
  bootstrapComplete : Bool;
  canisterKilled    : Bool;
  authorizedCount   : Nat;
  heapBytes         : Nat;
} {
  {
    owner             = Principal.toText(owner);
    frozenMode        = frozenMode;
    bootstrapComplete = bootstrapComplete;
    canisterKilled    = canisterKilled;
    authorizedCount   = allowedPrincipals.size();
    heapBytes         = Prim.rts_heap_size();
  }
};

// ==================== Health Monitoring ====================

/**
 * IC system heartbeat — invoked automatically every replica round (~1–2 s).
 *
 * Throttled: the Binance ping runs at most once per HEALTH_INTERVAL_NS (5 min).
 * On success  → consecutiveTimeouts reset to 0.
 * On failure  → consecutiveTimeouts incremented.
 * At MAX_TIMEOUTS (3) → canisterKilled set to true; all writes are then rejected
 *                        until the owner calls reviveCanister().
 */
system func heartbeat() : async () {
  if (canisterKilled) return;

  let now = Time.now();
  if (now - lastHealthCheckNs < HEALTH_INTERVAL_NS) return;

  lastHealthCheckNs := now;
  totalHealthChecks += 1;

  try {
    Cycles.add(HTTP_OUTCALL_CYCLES);
    let resp = await mgmt.http_request({
      url               = BINANCE_PING_URL;
      method            = #get;
      headers           = [];
      body              = null;
      max_response_bytes = ?Nat64.fromNat(256);
      transform         = null;
    });

    if (resp.status == 200) {
      consecutiveTimeouts := 0;
      lastHealthStatus    := "ok";
    } else {
      consecutiveTimeouts += 1;
      lastHealthStatus    := "http_error:" # Nat.toText(resp.status);
    };
  } catch (_) {
    consecutiveTimeouts += 1;
    lastHealthStatus    := "timeout_or_network_error";
  };

  if (consecutiveTimeouts >= MAX_TIMEOUTS) {
    canisterKilled   := true;
    lastHealthStatus := "KILLED:consecutive_failures=" # Nat.toText(consecutiveTimeouts);
  };
};

/**
 * Query current health-monitor state.
 */
public query func getHealthStatus() : async {
  alive               : Bool;
  killed              : Bool;
  lastCheckNs         : Int;
  consecutiveTimeouts : Nat;
  totalChecks         : Nat;
  lastStatus          : Text;
} {
  {
    alive               = not canisterKilled;
    killed              = canisterKilled;
    lastCheckNs         = lastHealthCheckNs;
    consecutiveTimeouts = consecutiveTimeouts;
    totalChecks         = totalHealthChecks;
    lastStatus          = lastHealthStatus;
  }
};

// ==================== Transaction Queue (Phase 5B) ====================

private func generateTransactionId() : Text {
  "tx_" # Int.toText(Time.now()) # "_" # Nat.toText(transactionQueue.size())
};

public shared(msg) func queueTransaction(action : TransactionAction) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);

  let tx : QueuedTransaction = {
    id           = generateTransactionId();
    action       = action;
    status       = #pending;
    result       = null;
    retryCount   = 0;
    scheduledAt  = null;
    createdAt    = Time.now();
    signedAt     = null;
    completedAt  = null;
    errorMessage = null;
  };

  transactionQueue := Array.append<QueuedTransaction>(transactionQueue, [tx]);
  #ok("Transaction queued: " # tx.id)
};

public query func getQueuedTransactions() : async [QueuedTransaction] {
  transactionQueue
};

public query func getPendingTransactions() : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch (tx.status) { case (#pending) { true }; case (_) { false } }
    }
  )
};

public query func getQueuedTransactionsByWallet(walletId : Text) : async [QueuedTransaction] {
  Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool { tx.action.walletId == walletId }
  )
};

public query func getQueuedTransaction(txId : Text) : async ?QueuedTransaction {
  for (tx in transactionQueue.vals()) {
    if (tx.id == txId) { return ?tx };
  };
  null
};

public shared(msg) func markTransactionSigned(txId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #signed;
          result       = ?signature;
          retryCount   = tx.retryCount;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = ?Time.now();
          completedAt  = tx.completedAt;
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Signed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func markTransactionCompleted(txId : Text, txHash : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #completed;
          result       = ?txHash;
          retryCount   = tx.retryCount;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = tx.signedAt;
          completedAt  = ?Time.now();
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Completed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func markTransactionFailed(txId : Text, error : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #failed;
          result       = null;
          retryCount   = tx.retryCount + 1;
          scheduledAt  = tx.scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = tx.signedAt;
          completedAt  = ?Time.now();
          errorMessage = ?error;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Failed: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func retryTransaction(txId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #queued;
          result       = null;
          retryCount   = tx.retryCount;
          scheduledAt  = ?Time.now();
          createdAt    = tx.createdAt;
          signedAt     = null;
          completedAt  = null;
          errorMessage = null;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Retry queued: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func scheduleTransaction(txId : Text, scheduledAt : Int) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;

  transactionQueue := Array.map<QueuedTransaction, QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : QueuedTransaction {
      if (tx.id == txId) {
        found := true;
        {
          id           = tx.id;
          action       = tx.action;
          status       = #queued;
          result       = null;
          retryCount   = tx.retryCount;
          scheduledAt  = ?scheduledAt;
          createdAt    = tx.createdAt;
          signedAt     = null;
          completedAt  = null;
          errorMessage = tx.errorMessage;
        }
      } else { tx }
    }
  );

  if (found) { #ok("Scheduled: " # txId) } else { #err("Not found: " # txId) }
};

public shared(msg) func clearCompletedTransactions() : async Text {
  assertWriteAllowed(msg.caller);
  transactionQueue := Array.filter<QueuedTransaction>(
    transactionQueue,
    func(tx : QueuedTransaction) : Bool {
      switch (tx.status) { case (#completed) { false }; case (_) { true } }
    }
  );
  "Completed transactions cleared"
};

public query func getTransactionQueueStats() : async {
  total : Nat; pending : Nat; queued : Nat; signed : Nat; completed : Nat; failed : Nat;
} {
  var p : Nat = 0; var q : Nat = 0; var s : Nat = 0; var c : Nat = 0; var f : Nat = 0;
  for (tx in transactionQueue.vals()) {
    switch (tx.status) {
      case (#pending)   { p += 1 };
      case (#queued)    { q += 1 };
      case (#signed)    { s += 1 };
      case (#completed) { c += 1 };
      case (#failed)    { f += 1 };
    }
  };
  { total = transactionQueue.size(); pending = p; queued = q; signed = s; completed = c; failed = f }
};

// ==================== Wallet Registry (Phase 5A) ====================

public shared(msg) func registerWallet(walletInfo : WalletInfo) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  for ((id, _) in walletRegistry.vals()) {
    if (id == walletInfo.id) {
      return #err("Wallet already registered: " # walletInfo.id);
    };
  };
  walletRegistry := Array.append<(Text, WalletInfo)>(walletRegistry, [(walletInfo.id, walletInfo)]);
  #ok("Wallet registered: " # walletInfo.id)
};

public query func getWallet(walletId : Text) : async ?WalletInfo {
  for ((id, info) in walletRegistry.vals()) {
    if (id == walletId) { return ?info };
  };
  null
};

public query func listWallets(agentId : Text) : async [WalletInfo] {
  let buf = Buffer.Buffer<WalletInfo>(4);
  for ((_, info) in walletRegistry.vals()) {
    if (info.agentId == agentId) { buf.add(info) };
  };
  Buffer.toArray(buf)
};

public shared(msg) func deregisterWallet(walletId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;
  walletRegistry := Array.filter<(Text, WalletInfo)>(
    walletRegistry,
    func((id, _) : (Text, WalletInfo)) : Bool {
      if (id == walletId) { found := true; false } else { true }
    }
  );
  if (found) { #ok("Deregistered: " # walletId) } else { #err("Not found: " # walletId) }
};

public shared(msg) func updateWalletStatus(
  walletId : Text,
  status   : { #active; #inactive; #revoked }
) : async { #ok : Text; #err : Text } {
  assertWriteAllowed(msg.caller);
  var found = false;
  walletRegistry := Array.map<(Text, WalletInfo), (Text, WalletInfo)>(
    walletRegistry,
    func((id, info) : (Text, WalletInfo)) : (Text, WalletInfo) {
      if (id == walletId) {
        found := true;
        (id, {
          id           = info.id;
          agentId      = info.agentId;
          chain        = info.chain;
          address      = info.address;
          registeredAt = info.registeredAt;
          status       = status;
        })
      } else { (id, info) }
    }
  );
  if (found) { #ok("Updated: " # walletId) } else { #err("Not found: " # walletId) }
};

// ==================== VetKeys Encrypted Secrets (Phase 5D) ====================

public shared(msg) func storeEncryptedSecret(secret : EncryptedSecret) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  encryptedSecrets := Array.append<EncryptedSecret>(encryptedSecrets, [secret]);
  #ok("Secret stored: " # secret.id)
};

public query func getEncryptedSecret(secretId : Text) : async ?EncryptedSecret {
  for (s in encryptedSecrets.vals()) {
    if (s.id == secretId) { return ?s };
  };
  null
};

public query func listEncryptedSecrets() : async [EncryptedSecret] {
  encryptedSecrets
};

public shared(msg) func deleteEncryptedSecret(secretId : Text) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  var found = false;
  encryptedSecrets := Array.filter<EncryptedSecret>(
    encryptedSecrets,
    func(s : EncryptedSecret) : Bool {
      if (s.id == secretId) { found := true; false } else { true }
    }
  );
  if (found) { #ok("Deleted: " # secretId) } else { #err("Not found: " # secretId) }
};

public query func verifyThresholdSignature(transactionId : Text, signature : Text) : async {
  #ok : Text;
  #err : Text;
} {
  if (Text.size(transactionId) == 0) {
    return #err("Transaction ID cannot be empty");
  };
  if (Text.size(signature) < 64) {
    return #err("Invalid signature: must be at least 64 characters");
  };
  #err("VetKeys canister not deployed. Threshold signature verification requires deployed VetKeys canister.")
};

public shared(msg) func deriveVetKeysKey(seedPhrase : Text, threshold : Nat) : async {
  #ok : Text;
  #err : Text;
} {
  assertWriteAllowed(msg.caller);
  if (Text.size(seedPhrase) == 0) { return #err("Seed phrase cannot be empty") };
  if (threshold < 2)  { return #err("Threshold must be at least 2") };
  if (threshold > 10) { return #err("Threshold cannot exceed 10") };
  // Seed phrase is NEVER stored or logged.
  #err("VetKeys canister not deployed. Threshold key derivation requires deployed VetKeys canister.")
};

public query func getVetKeysStatus() : async {
  enabled : Bool; thresholdSupported : Bool; mode : { #mock; #production };
} {
  { enabled = false; thresholdSupported = true; mode = #mock }
};

// ==================== System Functions ====================

/**
 * Returns canister status, live heap size, and current cycle balance.
 * Reports #stopped when the kill switch is active.
 */
public query func getCanisterStatus() : async {
  status     : { #running; #stopping; #stopped };
  memorySize : Nat;
  cycles     : Nat;
} {
  {
    status     = if (canisterKilled) { #stopped } else { #running };
    memorySize = Prim.rts_heap_size();
    cycles     = Cycles.balance();
  }
};

public query func getMetrics() : async {
  uptime : Int; operations : Nat; lastActivity : Int;
} {
  {
    uptime       = Time.now();
    operations   = agentState.executionCount;
    lastActivity = agentState.lastExecuted;
  }
};

// ==================== Upgrade Guard ====================

/**
 * Trap while frozen — aborts any attempt to upgrade the canister code without
 * the owner first calling manualUnlock().
 */
system func preupgrade() {
  // This assert causes the IC to abort the upgrade if frozen mode is active.
  assert (not frozenMode); // upgrade blocked: canister is frozen — call manualUnlock() first
};
