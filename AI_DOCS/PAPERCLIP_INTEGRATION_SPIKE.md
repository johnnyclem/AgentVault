# AgentVault x Paperclip Integration Spike

**Date:** March 7, 2026
**Status:** Research Spike / Implementation Plan
**Priority:** High
**Effort Estimate:** 3-4 weeks (phased)

---

## Executive Summary

This document proposes a 1st-party integration of **AgentVault** as the knowledge, truth, and communication backend for **Paperclip** — the open-source multi-agent orchestration platform for "zero-human companies."

**Paperclip** orchestrates *companies* of AI agents (org charts, budgets, goals, tasks) but lacks a sovereign, persistent, auditable backend for:
- **Knowledge** — agents need durable, version-controlled memory that survives session boundaries
- **Truth** — task results, decisions, and state changes need an immutable audit trail
- **Communication** — inter-agent messaging needs a decentralized backbone, not just a PostgreSQL row

**AgentVault** provides exactly these primitives through ICP canisters: persistent on-chain state, MemoryRepo (git-style version-controlled memory), VetKeys-signed audit trails, and multi-chain wallet identity.

The integration makes Paperclip agents *sovereign* — their knowledge and decisions are anchored on-chain, reconstructible, and independent of any single Paperclip server deployment.

---

## System Analysis

### Paperclip Architecture (Source of Orchestration)

| Aspect | Details |
|--------|---------|
| **Purpose** | Multi-agent company orchestration — models orgs with hierarchies, budgets, governance |
| **Core model** | Companies → Projects → Goals → Tasks (tickets) |
| **Agent model** | "Bring Your Own Agent" — OpenClaw, Claude Code, Codex, Cursor, Bash, HTTP endpoints |
| **Execution** | Heartbeat-driven (scheduled wake cycles) + event-driven (@-mentions, task assignment) |
| **State** | PostgreSQL — persistent agent state, session context, audit logs |
| **Stack** | TypeScript monorepo (pnpm), Node.js 20+, React UI, PostgreSQL |
| **Packages** | `server/`, `ui/`, `cli/`, `packages/{db, adapters, adapter-utils, shared}` |
| **Skills** | Runtime skill injection via `skills/` directory |
| **Extension** | Adapter pattern for agent runtimes; planned plugin system for knowledge bases, tracing, queues |

### AgentVault Architecture (Source of Truth)

| Aspect | Details |
|--------|---------|
| **Purpose** | Persistent on-chain AI agent platform — sovereign, reconstructible, autonomous |
| **Core model** | Agents → Canisters → State (tasks, context, config) |
| **State** | ICP canisters with stable memory; Arweave for permanent archival |
| **Memory** | MemoryRepo — git-style version-controlled memory (commits, branches, merge, rebase) |
| **Security** | VetKeys threshold signing, AES-256-GCM encryption, multi-chain wallets |
| **Secrets** | HashiCorp Vault / Bitwarden via `SecretProvider` interface |
| **Orchestration** | `ClaudeOrchestrator` — governed AI dev sessions with audit trails |
| **MCP** | `PolyticianMCPClient` — stdio-based MCP client for tool discovery & calls |
| **Stack** | TypeScript, Node.js 18+, Motoko (canisters), Next.js (dashboard) |

---

## Integration Surface Areas

### 1. Knowledge Backend — MemoryRepo as Paperclip Agent Memory

**Problem:** Paperclip agents have session-persistent state (survives across heartbeats within a server) but no *sovereign* knowledge store. If the Paperclip server is wiped, agent memory is gone.

**Solution:** Each Paperclip agent gets an AgentVault MemoryRepo canister as its knowledge backend.

```
Paperclip Agent                    AgentVault
┌──────────────┐                  ┌──────────────────────┐
│  Heartbeat   │───commit────────▶│  MemoryRepo Canister │
│  Session     │◀──query state────│  (ICP)               │
│              │                  │                      │
│  Context:    │   MemoryRepo     │  Commits:            │
│  - task      │   Client         │  - session logs      │
│  - goal      │   (TypeScript)   │  - decisions         │
│  - org chart │                  │  - learned context   │
└──────────────┘                  │  - tool outputs      │
                                  │                      │
                                  │  Branches:           │
                                  │  - main (production) │
                                  │  - draft (in-flight) │
                                  │  - experiments       │
                                  └──────────────────────┘
```

**Key operations:**
- **On heartbeat start:** `log(branch)` → load recent memory for context injection
- **On task completion:** `commit(message, diff, tags)` → persist task result + reasoning
- **On goal change:** `createBranch()` + `switchBranch()` → isolate goal-specific memory
- **On conflict resolution:** `merge()` / `cherryPick()` → reconcile parallel agent work
- **On agent "soul" update:** `rebase(newSoul)` → re-anchor identity

### 2. Truth Backend — Immutable Audit Trail

**Problem:** Paperclip has audit logs in PostgreSQL, but they're mutable, server-local, and not cryptographically attested. There's no way to prove "Agent X made decision Y at time Z."

**Solution:** AgentVault's VetKeys-signed state snapshots + Arweave archival provide an immutable, verifiable audit trail.

```
Paperclip Event                    AgentVault
┌──────────────┐                  ┌──────────────────────┐
│ Task complete│                  │  Audit Canister      │
│ Budget spent │───sign+commit──▶│  (VetKeys signed)    │
│ Goal reached │                  │                      │
│ Agent hired  │                  │  ┌────────────────┐  │
│ Approval     │                  │  │ Arweave        │  │
└──────────────┘                  │  │ (permanent)    │  │
                                  │  └────────────────┘  │
                                  └──────────────────────┘
```

**Key operations:**
- **On significant event:** Create signed `AuditEntry` with VetKeys, commit to canister
- **On budget milestone:** Archive financial state to Arweave (immutable spend proof)
- **On dispute/review:** Query audit trail by time range, agent, or event type
- **Verification:** Any party can verify VetKeys signatures against ICP consensus

### 3. Communication Backend — Inter-Agent Messaging via Canister

**Problem:** Paperclip agents communicate via task assignments and @-mentions in PostgreSQL. This is functional but centralized — agents can't communicate if the server is down, and there's no guaranteed delivery or ordering.

**Solution:** AgentVault canisters provide a decentralized message bus with guaranteed ordering.

```
Agent A (Paperclip)               Agent B (Paperclip)
      │                                   │
      │  commit("msg to B",              │
      │    diff, ["message","to:B"])      │
      │           │                       │
      │           ▼                       │
      │    ┌──────────────┐               │
      │    │  Shared       │              │
      │    │  MemoryRepo   │──query by──▶│
      │    │  Canister     │   tag "to:B" │
      │    └──────────────┘               │
```

This is a secondary concern — Paperclip's existing task-based communication works well for most cases. The canister-based approach adds value for:
- Cross-deployment agent communication
- Offline message queuing
- Cryptographically verified message provenance

### 4. Secrets Backend — VaultClient for Paperclip Agent Credentials

**Problem:** Paperclip agents need API keys, tokens, and credentials. Currently these live in environment variables or the PostgreSQL database.

**Solution:** AgentVault's `SecretProvider` interface (HashiCorp Vault / Bitwarden backends) provides scoped, audited, runtime-only secret access.

```
Paperclip Agent                    AgentVault Vault
┌──────────────┐                  ┌──────────────────────┐
│  Needs       │                  │  HashiCorp Vault     │
│  API key     │───getSecret()──▶│  agents/<id>/secrets  │
│              │◀──runtime val────│                      │
│  (never      │                  │  Policy:             │
│   persisted) │                  │  - scoped per agent  │
│              │                  │  - audit logged      │
└──────────────┘                  │  - TTL enforced      │
                                  └──────────────────────┘
```

### 5. Identity Backend — Multi-Chain Wallets for Agent Identity

**Problem:** Paperclip agents have server-local identities (database IDs). They can't prove identity across deployments or interact with on-chain systems.

**Solution:** AgentVault's multi-chain wallet system gives each Paperclip agent a cryptographic identity.

- ICP principal → on-chain identity for canister access
- Ethereum address → DeFi interactions, ENS identity
- Solana address → high-throughput on-chain actions

---

## Implementation Plan

### Phase 0: Shared Package — `@paperclip/agentvault-adapter` (Week 1)

Create a Paperclip adapter package that wraps AgentVault's TypeScript library.

**New file:** `packages/adapters/src/agentvault/` (in Paperclip repo) OR `src/integrations/paperclip/` (in AgentVault repo)

**Recommendation:** Build in the AgentVault repo as `src/integrations/paperclip/` so it ships with the `agentvault` npm package and is usable by any Paperclip deployment without extra dependencies.

```
src/integrations/paperclip/
├── index.ts                    # Public exports
├── types.ts                    # Shared types between systems
├── paperclip-memory-adapter.ts # MemoryRepo adapter for Paperclip heartbeats
├── paperclip-audit-adapter.ts  # Audit trail adapter
├── paperclip-secret-adapter.ts # Secret injection adapter
├── paperclip-identity.ts       # Wallet/identity bridge
└── paperclip-skill.ts          # AgentVault skill for Paperclip skill system
```

#### Key Types

```typescript
/**
 * Configuration for connecting a Paperclip agent to AgentVault
 */
interface PaperclipAgentVaultConfig {
  /** Paperclip agent ID (maps to AgentVault agent namespace) */
  agentId: string;
  /** Paperclip company ID (maps to MemoryRepo canister) */
  companyId: string;
  /** ICP network: 'local' | 'ic' */
  network: 'local' | 'ic';
  /** MemoryRepo canister ID (auto-provisioned if not set) */
  memoryCanisterId?: string;
  /** Audit canister ID (shared per company) */
  auditCanisterId?: string;
  /** Vault config for secrets (optional) */
  vaultConfig?: VaultConfig;
  /** Enable Arweave archival for audit entries */
  enableArchival?: boolean;
}

/**
 * Heartbeat context injected into Paperclip agent sessions
 */
interface AgentVaultHeartbeatContext {
  /** Recent memory commits (last N from MemoryRepo) */
  recentMemory: Commit[];
  /** Current branch and repo status */
  repoStatus: RepoStatus;
  /** Available secrets (keys only, not values) */
  availableSecrets: string[];
  /** Agent's on-chain identity (ICP principal) */
  identity: string;
  /** Audit trail summary (last N entries) */
  recentAudit: AuditEntry[];
}

/**
 * Result of a heartbeat completion, to be persisted
 */
interface HeartbeatResult {
  /** Task ID from Paperclip */
  taskId: string;
  /** Commit message for MemoryRepo */
  commitMessage: string;
  /** Diff content (task output, decisions, learned context) */
  diff: string;
  /** Semantic tags for categorization */
  tags: string[];
  /** Audit event type */
  auditEventType: 'task_complete' | 'goal_progress' | 'decision' | 'error';
  /** Budget spent (tokens/cost) for on-chain attestation */
  budgetSpent?: { tokens: number; cost: number };
}
```

### Phase 1: Memory Integration (Week 1-2)

#### 1a. MemoryRepo Adapter

```typescript
class PaperclipMemoryAdapter {
  private actor: _SERVICE;
  private config: PaperclipAgentVaultConfig;

  /** Load context for heartbeat injection */
  async loadHeartbeatContext(limit?: number): Promise<AgentVaultHeartbeatContext>;

  /** Persist heartbeat result as MemoryRepo commit */
  async persistHeartbeatResult(result: HeartbeatResult): Promise<string>;

  /** Branch management for goal isolation */
  async createGoalBranch(goalId: string): Promise<void>;
  async switchToGoalBranch(goalId: string): Promise<void>;
  async mergeGoalBranch(goalId: string, strategy: 'auto' | 'manual'): Promise<MergeResult>;

  /** Full state reconstruction from on-chain data */
  async reconstructState(): Promise<Commit[]>;
}
```

#### 1b. Paperclip Skill Definition

Create an AgentVault skill that Paperclip injects into agents at runtime:

**New file:** `skills/paperclip/agentvault-memory.md`

```markdown
# AgentVault Memory Skill

You have access to persistent, version-controlled memory via AgentVault.

## Available Operations
- **Remember**: Commit important context, decisions, and learned information
- **Recall**: Query your memory for relevant past context
- **Branch**: Create isolated memory branches for experimental work
- **Merge**: Bring experimental results back into main memory

## When to Commit Memory
- After completing a task: commit the result and reasoning
- After learning something new: commit the insight with appropriate tags
- After making a decision: commit the decision and rationale
- When starting a new goal: create a branch for isolated exploration

## Memory Format
Commits use structured diffs with semantic tags for retrieval.
```

### Phase 2: Audit Trail Integration (Week 2)

#### 2a. Audit Adapter

```typescript
class PaperclipAuditAdapter {
  /** Record a signed audit entry for a Paperclip event */
  async recordEvent(event: PaperclipAuditEvent): Promise<string>;

  /** Query audit trail with filters */
  async queryAudit(filters: AuditQueryFilters): Promise<AuditEntry[]>;

  /** Verify a specific audit entry's VetKeys signature */
  async verifyEntry(entryId: string): Promise<boolean>;

  /** Archive audit batch to Arweave */
  async archiveToArweave(fromDate: Date, toDate: Date): Promise<string>;
}

interface PaperclipAuditEvent {
  type: 'task_assigned' | 'task_completed' | 'task_failed'
      | 'budget_spent' | 'goal_reached' | 'agent_hired'
      | 'agent_terminated' | 'approval_requested' | 'approval_granted';
  agentId: string;
  companyId: string;
  payload: Record<string, unknown>;
  /** VetKeys-signed hash of the payload */
  signature?: string;
}
```

#### 2b. Paperclip Server Hook

Add a middleware/hook in Paperclip's server that fires audit events to AgentVault on significant state changes. This would be implemented as a Paperclip adapter:

```typescript
// In Paperclip's adapter system
class AgentVaultAuditAdapter {
  async onTaskComplete(task: Task, agent: Agent): Promise<void>;
  async onBudgetSpent(agent: Agent, amount: number): Promise<void>;
  async onGoalReached(goal: Goal, company: Company): Promise<void>;
}
```

### Phase 3: Secrets & Identity (Week 3)

#### 3a. Secret Provider Bridge

```typescript
class PaperclipSecretAdapter {
  private provider: SecretProvider;

  /** Inject secrets into agent environment for a single heartbeat */
  async injectSecrets(agentId: string, requiredKeys: string[]): Promise<Record<string, string>>;

  /** Rotate a secret and propagate to all agents that use it */
  async rotateSecret(key: string, newValue: string): Promise<void>;

  /** Health check for the secrets backend */
  async healthCheck(): Promise<SecretProviderHealth>;
}
```

#### 3b. Identity Bridge

```typescript
class PaperclipIdentityAdapter {
  /** Create or load an ICP identity for a Paperclip agent */
  async getOrCreateIdentity(agentId: string): Promise<{ principal: string; address: string }>;

  /** Register agent's wallet addresses on-chain */
  async registerWallets(agentId: string, chains: string[]): Promise<CanisterWalletInfo[]>;

  /** Sign a message with the agent's identity (for cross-deployment auth) */
  async signMessage(agentId: string, message: string): Promise<string>;
}
```

### Phase 4: Paperclip UI Integration (Week 3-4)

#### 4a. AgentVault Panel in Paperclip Dashboard

Add an optional panel to Paperclip's React UI that shows:
- Agent memory timeline (commits from MemoryRepo)
- Audit trail viewer with signature verification
- On-chain identity info (ICP principal, wallet addresses)
- Memory branch visualization

#### 4b. AgentVault Dashboard Link

Add Paperclip context to AgentVault's existing Next.js dashboard:
- Show which Paperclip company/agent owns each canister
- Display Paperclip task context alongside MemoryRepo commits
- Link back to Paperclip UI for task management

---

## Configuration

### Paperclip Side (`.env` or config)

```bash
# AgentVault Integration
AGENTVAULT_ENABLED=true
AGENTVAULT_NETWORK=local          # 'local' | 'ic'
AGENTVAULT_ICP_URL=http://127.0.0.1:4943
AGENTVAULT_MEMORY_CANISTER_ID=    # Auto-provisioned if empty
AGENTVAULT_AUDIT_CANISTER_ID=     # Shared per company
AGENTVAULT_VAULT_ADDR=http://127.0.0.1:8200
AGENTVAULT_VAULT_TOKEN=           # For secret management
AGENTVAULT_ARCHIVAL_ENABLED=false # Arweave archival
```

### AgentVault Side (`agent.config.json`)

```json
{
  "integration": "paperclip",
  "paperclip": {
    "serverUrl": "http://localhost:3000",
    "companyId": "company-uuid",
    "agentMapping": {
      "paperclip-agent-1": "memory-canister-1",
      "paperclip-agent-2": "memory-canister-2"
    }
  }
}
```

---

## Data Flow: Complete Heartbeat Cycle

```
1. Paperclip heartbeat fires for Agent A
   │
2. AgentVault adapter loads context:
   │  ├── MemoryRepo.log() → recent 20 commits
   │  ├── MemoryRepo.getRepoStatus() → branch info
   │  └── SecretProvider.listSecrets() → available keys
   │
3. Context injected into agent session prompt
   │  (via Paperclip's runtime skill injection)
   │
4. Agent executes task with full memory context
   │
5. On completion, adapter persists results:
   │  ├── MemoryRepo.commit(message, diff, tags)
   │  ├── AuditAdapter.recordEvent(task_completed, ...)
   │  ├── VetKeys.sign(stateHash) → signed attestation
   │  └── (optional) Arweave.archive(auditBatch)
   │
6. Paperclip updates task status in PostgreSQL
   │  (existing flow, unchanged)
   │
7. Next heartbeat starts at step 1 with updated context
```

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| ICP canister latency adds to heartbeat time | Medium | Cache recent commits locally; async audit writes |
| ICP mainnet costs per agent could be high | Medium | Batch commits; use local replica for dev; only mainnet for production |
| MemoryRepo canister capacity limits | Low | Prune old commits; archive to Arweave; branch cleanup |
| Paperclip server and AgentVault version drift | Medium | Semantic versioning on adapter; integration tests in CI |
| Secret injection timing (Vault latency) | Low | Cache secrets per heartbeat cycle; prefetch on boot |
| Agent memory bloat from verbose commits | Medium | Enforce commit size limits; structured diff format; tag-based pruning |

---

## Testing Strategy

### Unit Tests (AgentVault repo)
- `PaperclipMemoryAdapter`: mock MemoryRepo actor, test context loading/commit
- `PaperclipAuditAdapter`: mock canister, test event recording/querying
- `PaperclipSecretAdapter`: mock SecretProvider, test injection lifecycle
- `PaperclipIdentityAdapter`: mock wallet manager, test identity creation

### Integration Tests
- Full heartbeat cycle: load context → execute → persist → verify on-chain
- Multi-agent scenario: two agents, shared MemoryRepo, branch/merge workflow
- Audit verification: record event, retrieve, verify VetKeys signature
- Secret rotation: rotate key, verify all agents pick up new value

### E2E Tests (requires local ICP replica + Paperclip server)
- Deploy Paperclip + AgentVault locally via Docker Compose
- Create a company with 2 agents
- Run 10 heartbeat cycles
- Verify: all commits on-chain, audit trail signed, memory reconstructible

---

## Open Questions

1. **Canister provisioning model:** One MemoryRepo canister per agent, or one shared canister per company with agent namespacing?
   - *Recommendation:* One per company with tag-based agent namespacing (cheaper, simpler)

2. **Heartbeat context window:** How many recent commits to inject? All, or top-N by relevance?
   - *Recommendation:* Top 20 by recency, with option to search by tag

3. **Commit granularity:** Every heartbeat, or only on meaningful state changes?
   - *Recommendation:* Only on meaningful changes (task complete, decision, error) — avoid memory bloat

4. **Mainnet vs local:** When should Paperclip agents use ICP mainnet vs local replica?
   - *Recommendation:* Local for dev/staging, mainnet for production companies with governance needs

5. **Adapter placement:** Should the adapter live in AgentVault (npm package) or Paperclip (monorepo package)?
   - *Recommendation:* AgentVault repo, published as part of `agentvault` npm package, consumed by Paperclip

6. **Existing Paperclip plugin roadmap:** Paperclip's docs mention a planned plugin system for "knowledge bases, custom tracing, queues." Should this integration wait for that plugin system, or build as a standalone adapter?
   - *Recommendation:* Build standalone adapter now; refactor to plugin when Paperclip's plugin system ships

---

## Success Criteria

- [ ] `PaperclipMemoryAdapter` can load and persist heartbeat context via MemoryRepo
- [ ] `PaperclipAuditAdapter` records VetKeys-signed events for Paperclip state changes
- [ ] `PaperclipSecretAdapter` injects scoped secrets into agent heartbeat sessions
- [ ] `PaperclipIdentityAdapter` provisions and manages agent on-chain identities
- [ ] Paperclip skill file enables runtime memory injection without agent retraining
- [ ] End-to-end heartbeat cycle works: load context → execute → persist → verify
- [ ] Agent memory survives Paperclip server wipe and is fully reconstructible from ICP
- [ ] All integration tests pass in CI
- [ ] Docker Compose setup enables local development of both systems together

---

## Next Steps

1. Review and approve this spike document
2. Set up development environment (local ICP replica + Paperclip dev server)
3. Implement Phase 0 (shared types and adapter skeleton)
4. Implement Phase 1 (MemoryRepo integration — highest value)
5. Implement Phase 2 (audit trail — highest trust value)
6. Implement Phase 3 (secrets and identity)
7. Implement Phase 4 (UI integration)
8. Write comprehensive tests and documentation
9. Publish updated `agentvault` npm package with Paperclip integration
