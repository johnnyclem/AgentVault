# The Agent Stack: Engineering Guide

Companion to [`executive-summary.md`](./executive-summary.md). This is the technical breakdown of how
AgentVault relates to the smallchat suite (smallchat, Stenographer, Short-hand and Polytician), what's
actually wired up in this repo today, and how to close the gaps.

> **Sourcing note:** AgentVault claims below are verified against source in this repo. Claims about the
> suite were re-checked in October 2026 against each suite repo's default branch for its 1.0 release
> (`github.com/johnnyclem/{smallchat,smallchat-swift,stenographer,short-hand,polytician}`: README,
> CHANGELOG, MIGRATION and source). Re-verify exact APIs against the released packages before writing
> integration code. See [`cross-repo-playbook.md`](./cross-repo-playbook.md) for the runbook an agent in
> one of the other repos can follow to verify and extend this guide from that side.

## 1. Component reference

### AgentVault (this repo)

- **What it is:** CLI + ICP canister system that packages a TypeScript agent to WASM, deploys it to an
  Internet Computer canister, and gives it a durable identity, multi-chain wallet, secrets vault, and
  versioned memory that survives independent of any browser session or host process.
- **Key subsystems:** `src/deployment`, `src/packaging`, `src/wallet`, `src/security` (VetKeys, multisig,
  MFA), `src/monitoring`, `src/orchestration` (Claude Code / Google ADK session orchestration).
- **Persistence model:** on-chain canister state, plus `MemoryRepo` — a git-style versioned memory
  canister (commits/branches/merge/rebase/cherry-pick, anchored by a genesis `Soul.md`), documented in
  `docs/memory-repo.md`.

### smallchat — `@smallchat/core` 1.0.0, `SmallChat` Swift package 1.0.0

- **What it is:** semantic tool dispatch. The LLM states an intent; the runtime resolves it, by vector
  similarity against compiled selectors, to at most one tool, and runs that tool only when its dispatch
  policy allows (otherwise it asks the caller to pick a tool by id). Modeled on Smalltalk/Objective-C
  message dispatch: tools are objects, intents are messages.
- **What 1.0 adds:** resolve is separate from execute (`runtime.resolve(intent)` runs nothing;
  `dispatchById(toolId, args)` runs exactly the named tool); arguments are validated against each tool's
  JSON Schema before anything runs; compiled artifacts are content-hashed and pinned to the embedder that
  produced their vectors; every decision carries a replayable proof with a canonical call digest.
  `smallchat replay` checks golden traces or a decision log against an artifact, and `smallchat explain`
  shows one intent's candidates, tiers, policy verdicts and proof digest. Same artifact, embedder and
  runtime state give the same choice and proof digest. The TypeScript and Swift implementations share
  conformance vectors (`spec/`).
- **Distribution:** `npm install @smallchat/core@^1` (bin `smallchat`; one-shot:
  `npx -y @smallchat/core@^1 <command>`), Node 22 or later. Swift:
  `.package(url: "https://github.com/johnnyclem/smallchat-swift", from: "1.0.0")` (Swift 6.1+; macOS 14+;
  iOS 17+ for every library except `SmallChatAgents`; Linux for every library except `SmallChatUI`, plus
  the `smallchat` CLI). Site: [www.smallchat.dev](https://www.smallchat.dev).
- **Dependencies inside the suite:** `@smallchat/core` depends on `@shorthand/core` `^1.0.0`.

### Stenographer — `@stenographer/core` 1.0.0

- **What it is:** an MCP server that watches agent conversation logs (JSONL) and builds a queryable
  **GraphRAG** index: messages ranked by reciprocal rank fusion of vector similarity, entity-graph
  evidence and recency, over entities, relations and decisions extracted from the conversation.
  Self-described as a court reporter: it doesn't take part in the conversation unless asked to object,
  but it's always listening.
- **Storage/embeddings:** local `all-MiniLM-L6-v2` embeddings via `@huggingface/transformers` (model
  downloaded once, then runs locally with no API key), or an offline hashed embedder with
  `--embeddings hashed`; persisted in SQLite with a `sqlite-vec` KNN index (brute-force cosine fallback
  if the extension can't load). The state database is pinned to the embedder that wrote it.
- **Decision tracking:** append-only decision records with a **supersession** model — when an agent
  changes its mind, the old decision is closed onto its successor, not deleted, preserving provenance.
- **Truth ledger (new in 1.0):** signed tombstones (TBs) and unverified assertions (UVs) in an
  append-only, hash-chained ledger (SHA-256 over RFC 8785 JSON), synced between teams as truth format v2
  JSONL; `stenographer verify` re-checks the chain. One agent alone settles nothing. A person signs, or two
  or more agent sessions agree within 15 minutes, each citing its own checkable evidence (a commit, file,
  test, claimed command or ledger entry), with at least two kinds of evidence between them. Agents never
  override, strike, dismiss or rule: a claim that contests a tombstone, or a verdict another session
  disputes, goes to a person.
  An optional `stenographer gate` (a Claude Code `PreToolUse` hook) can deny a write that reintroduces a
  tombstoned literal; it matches exact tokens and is a guardrail against accidents, not a security
  boundary.
- **Interfaces:** MCP over stdio in two profiles (`agent`, the default, and `operator`), with tools such
  as `search_conversation`, `get_entities`, `get_relations` and `get_decisions`; a REST API in `daemon`
  mode (port 8787, bound to 127.0.0.1, bearer token required on every route) with `/status`,
  `/messages`, `/entities`, `/search`, `/graphrag` and more; CLI commands for the notary, the gate and
  ledger verification.
- **Modes:** `live`, `catchup`, `watch` (directory monitoring), `daemon`.
- **Provider adapters:** `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, with auto-detection.
- **Distribution:** `npm install @stenographer/core@^1` (bin `stenographer`; one-shot:
  `npx -y @stenographer/core@^1 start <log>`), Node 22 or later. Site:
  [stenographer.smallchat.dev](https://stenographer.smallchat.dev).

### Short-hand — `@shorthand/core` 1.0.0

- **What it is:** progressive context compaction for LLMs, applying LSM-tree-style database compaction
  to conversation history instead of naive truncation.
- **Five-level architecture:** L0 (verbatim recent messages) → L4 (core invariants), each level trading
  fidelity for compression. Corrections create **tombstones**, and every level that still states only
  the superseded value is archived, never deleted.
- **Key primitives:** a `CompactionEngine` that owns the lifecycle and builds a context frame with
  `buildContextFrame(budget)`, filling typed sections in priority order, item by item, under the token
  budget (by its ~4-characters-per-token estimate, not a model tokenizer); snapshot compaction with
  verification; an `ActiveEngramStore` whose memories are reinterpreted at recall time through a
  regex/local/host interpreter tier; CRDT memory (clocks, LWW-Register, OR-Set, G-Set, RGA,
  `AgentMemory`); a standalone `ImportanceDetector` (the engine does not call it); and readers for
  Stenographer's truth format v2.
- **Positioning:** the package that smallchat depends on for compaction, CRDT memory, importance and
  truth-ledger interop. Zero runtime dependencies, fully typed, ESM-only, MIT-licensed.
- **Distribution:** `npm install @shorthand/core@^1` (the package was renamed from `short-hand`), Node 22
  or later. Site: [short-hand.smallchat.dev](https://short-hand.smallchat.dev).

### Polytician — `polytician` 3.0.0

- **What it is:** a local-first MCP server for semantic memory. Each concept can be stored as, and
  converted between, a 384-dimension vector, markdown and structured ThoughtForm JSON. Embeddings run
  in-process (`all-MiniLM-L6-v2`); storage is SQLite with `sqlite-vec` by default, or Postgres with
  `pgvector`.
- **Interfaces:** MCP over stdio (one client per process) or Streamable HTTP with `--http` and a bearer
  token. Core tools include `save_concept`, `read_concept`, `search_concepts`, `list_concepts`,
  `delete_concept`, `get_stats` and `health_check`. Every tool's input schema is strict (an unknown
  argument is a validation error), and results come back as `structuredContent` with the same JSON in
  `content[0].text`.
- **AgentVault integration (Polytician's side):** opt-in `vault_*` tools (`vault_infer`,
  `vault_memory_push`, `vault_memory_pull`, `vault_archive_concept`, ...), memory sync with AgentVault's
  `memory_repo`, Arweave archival through AgentVault and AgentVault inference for LLM conversions. Each
  path is enabled separately by the operator.
- **Distribution:** `npm install polytician@^3` (bin `polytician`, which starts the MCP server over
  stdio), Node 22 or later; or from a checkout (`npm install && npm run build && npm start`). Site:
  [polytician.smallchat.dev](https://polytician.smallchat.dev).

## 2. How the pieces fit together

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Conversation / Session                        │
│                     (user ↔ agent, tool calls, results)                    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                 │ raw JSONL log
                                 ▼
 ┌───────────────┐      ┌─────────────────┐
 │  Polytician   │      │   Stenographer   │   conversation index
 │ concept store │      │  (GraphRAG index,│   entities / relations /
 │ (MCP server)  │      │  truth ledger)   │   decisions, truth format v2
 └───────▲───────┘      └────────┬─────────┘
         │                       │ truth format v2 (search_conversation: proposed)
         │                       ▼
         │ MCP, stdio   ┌─────────────────┐
         │ (AgentVault  │   Short-hand     │   compacts retrieved history +
         │  client,     │ (5-level LSM     │   live context into a token-
         │  predates    │  compaction)     │   budgeted context frame
         │  3.0)        └────────┬─────────┘
         │                       │ context frame
         │                       ▼
         │              ┌─────────────────┐
         │              │   LLM (agent)    │   decides *what* to do next
         │              └────────┬─────────┘
         │                       │ tool intent
         │                       ▼
         │              ┌─────────────────┐
         │              │   smallchat      │   resolve → policy → dispatch,
         │              │ (selector →      │   with a replayable proof
         │              │  tool dispatch)  │
         │              └────────┬─────────┘
         │                       │ resolved tool call
         │                       ▼
         │              ┌─────────────────┐
         └─────────────►│   AgentVault     │   policy check → canister exec
                        │ (canister exec,  │   → wallet/secrets/state →
                        │  wallet, vault)  │   VetKeys-signed, on-chain
                        └─────────────────┘
```

Read top to bottom: Stenographer is the **memory** (what happened), Short-hand is the
**compression/retrieval middleware** between that memory and the model's limited context window,
smallchat is the **reflex** (what to do about it), and AgentVault is the **body** (where it actually
executes, durably and auditably). Polytician, on the left, is a concept store beside the memory layer;
AgentVault's orchestrator calls it over MCP with a client that predates Polytician 3.0 (see §3).

Inside the suite, only the Stenographer → Short-hand arrow is wired today, and only for the truth ledger:
`@shorthand/core` reads Stenographer's truth format v2. Nothing in Short-hand consumes
`search_conversation` yet. Separately, `@smallchat/core`
depends on `@shorthand/core` for compaction, CRDT memory, importance and truth-ledger interop; that is a
package dependency, not one of the arrows above. The arrows into AgentVault are not wired, except the
Polytician client described in §3.

## 3. What's actually wired up in AgentVault today

AgentVault's `package.json` depends on no suite package (`@smallchat/core`, `@stenographer/core`,
`@shorthand/core`, `polytician`).

### smallchat: a from-scratch reimplementation of the pattern

AgentVault's dispatcher is modeled on smallchat's selector design but shares no code with
`@smallchat/core`, and it uses none of smallchat 1.0's features. It resolves by exact selector (with
class-hierarchy fallback), with no embeddings.

| File | Role |
|---|---|
| `src/orchestration/smallchat-tools.ts` | Maps AgentVault's Candid service interface into a `ToolClass` hierarchy (`BaseTools` → `CanisterLifecycleTools`, `WalletTools` → `TransactionTools`, `SecretTools`, `VetKeysTools`), each tool tagged with a `category` and `riskLevel`. |
| `src/orchestration/smallchat-bridge.ts` | `SmallChatBridge` — selector interning, LRU resolution cache, superclass-fallback resolution, parameter type checks, and a compact system-prompt generator (`generateSystemPromptHeader()`) so the LLM sees selectors, not full JSON schemas. |
| `src/orchestration/smallchat-compression.ts` | `IntentCompressor` — 38-byte fixed-width binary tool-call records (2-byte selector ID + 32-byte param hash + 4-byte timestamp delta) plus repeated-sequence pattern detection, designed for the ICP canister's 64MB heap and cycle-metered compute. |
| `src/orchestration/smallchat-policy.ts` | `SmallChatPolicyEngine` — pre-dispatch validation (blocked categories, parameter size), dedup, rate limiting, MFA gating for high-risk ops, rule-based approval gating, and an in-memory audit log. It returns `require_mfa` / `require_approval` decisions with challenge ids; it does not call `src/security/multisig.ts`, `mfa-approval.ts` or `icp-audit.ts` itself (its header comment names them as the intended integration points). |
| `src/orchestration/claude.ts` (`initSmallChat`, ~line 457; `dispatchToolCall`, ~line 477; `SmallChatOptions`, ~line 37) | Wires bridge + policy + compressor into the Claude Code orchestrator, opt-in via `options.smallChat.enabled` (library API only; the `agentvault orchestrate` command does not set it). When enabled, `orchestrate()` appends the compact tool header to the system prompt and reports `SmallChatSessionReport` stats (registered selectors, cache hit rate, compression stats) through `onProgress`. `dispatchToolCall()` runs one call through bridge → policy → compressor for library callers. |
| `tests/unit/smallchat-{bridge,compression,policy}.test.ts`, `tests/integration/smallchat-orchestration.test.ts` | Test coverage for the above. |

### Polytician: a client that predates Polytician 3.0

| File | Role |
|---|---|
| `src/orchestration/mcp-client.ts` | `PolyticianMCPClient` — spawns a Polytician MCP server from an entry-point command and speaks JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`); plus an HTTP `/health` probe. |
| `cli/commands/polytician.ts` | `agentvault polytician -e "<entry>" <status\|search\|push-all\|pull\|archive\|register>`. |
| `src/orchestration/polytician-enricher.ts` | `enrichWithPolyticianContext` searches concepts (`search_concepts`), reads the top matches (`read_concept`) and prepends them to the task, truncated by character count; `saveConceptFromOrchestration` saves a session's result (`save_concept`). Used by `agentvault orchestrate --polytician-entry`. |
| `src/packaging/parsers/polytician.ts`, `src/packaging/detector.ts` | The packager recognizes a `polytician.json` / `.polytician.json` config as the `polytician` agent type. |
| `webapp/src/app/api/polytician/[agentId]/*`, `webapp/src/components/polytician/*` | Webapp API routes that proxy to the same client (`POLYTICIAN_ENTRY_POINT`), and concept components that no page renders yet. |

This client does not match Polytician 3.0's tool contract (Polytician's README, "Calling Polytician from
AgentVault's orchestrator", lists the corrected calls):

- 3.0 rejects `save_concept { name, content, representation, metadata }` and
  `search_concepts { query, limit, min_score }` with a validation error (the corrected calls use
  `markdown`, `tags` and `k`). `read_concept { id }` works.
- The client reads `content[0].data`; 3.0 returns `structuredContent` and `content[0].text`, and
  `search_concepts` returns `{ results }`, not `{ concepts }`.
- `push-all`, `pull` and `archive` call `push_to_memory_repo`, `pull_from_memory_repo` and
  `archive_concept`; 3.0 has no tools by those names (its AgentVault tools are the opt-in `vault_*` set).
- In a non-dry run, `orchestrate()` builds the system prompt from `options.task`, not the enriched task
  (`src/orchestration/claude.ts`, ~line 627), so enrichment only shows up in `--dry-run` output.

In the other direction, Polytician 3.0's opt-in AgentVault integration calls AgentVault's HTTP API
(`/api/inference`, `/api/memory-repo/*`, `/api/archival/upload`, `/api/secrets/:name`). Routes with those
paths exist in `webapp/src/app/api/`; their request and response shapes have not been checked against
Polytician's client.

### Stenographer and Short-hand: not integrated

**Stenographer and Short-hand have zero references in this repo's code** (source, tests, `package.json`,
`package-lock.json`) or plan files (`PLAN_*.md`) — confirmed by repo-wide search. The only mentions are
in these ecosystem docs and the site.

### Existing AgentVault subsystems that overlap with the missing pieces

- **`docs/memory-repo.md` (MemoryRepo canister):** git-style versioned memory — commits, branches,
  merge, rebase, cherry-pick, anchored by a genesis `Soul.md`. This is **structured, agent-identity
  memory**, not conversational recall. It does not do semantic search over free-text conversation the
  way Stenographer's GraphRAG index does — different data model, complementary rather than redundant.
- **`src/orchestration/polytician-enricher.ts` (`enrichWithPolyticianContext`):** its overflow handling
  is a **hard stop on total character count** (`totalContextLength + blockLength >
  maxContextLength - prompt.length - 500`) and, failing that, a **blunt string slice with `...`**
  (`enrichedPrompt.slice(0, maxContextLength - 3) + '...'`). This is the naive-truncation failure mode
  Short-hand's `CompactionEngine` is designed to replace with level-based compaction and a budgeted,
  item-by-item context frame.

## 4. Integration gaps and concrete opportunities

### Gap A — Short-hand ↔ `polytician-enricher.ts`

**Problem:** enrichment context is truncated by character count with no regard for which concept matters
most, and there's no history/session compaction elsewhere in the orchestration pipeline.

**Opportunity:** swap the truncate-on-overflow branch in `enrichWithPolyticianContext` for a
`CompactionEngine`-driven context frame: feed retrieved concepts in as messages and request a
token-budgeted frame (`buildContextFrame(budget)`) instead of a character-budgeted string. The frame
skips an item that does not fit and counts it in `section.omitted`, rather than cutting text mid-concept.
Smallest surface area of the gaps, highest signal-to-noise improvement. It only pays off once Gap D is
closed and the real (non-dry-run) prompt uses the enriched task.

### Gap B — Stenographer ↔ orchestration session logs

**Problem:** AgentVault's orchestration sessions (`src/orchestration/claude.ts`) run Claude Code / ADK
sessions with `onProgress` callbacks and produce a session report, but there is no durable, queryable
index of *why* an agent made a given decision across sessions — only MemoryRepo's structured commits and
Polytician's saved "concepts" (`saveConceptFromOrchestration`).

**Opportunity:** point Stenographer's `watch` mode (with the `claude-code` adapter) at wherever
orchestration session transcripts are written, or emit `jsonl` from `claude.ts`, and expose
`search_conversation` / `get_decisions` as an additional MCP server alongside the existing Polytician MCP
client (`src/orchestration/mcp-client.ts`). Use Stenographer's default `agent` profile for this: it can
read and draft, but cannot sign truth on a person's behalf. This gives "what did we decide about X three
sessions ago" recall without teaching MemoryRepo to do full-text/semantic search over conversation, which
isn't its job. Treat this as **additive** to MemoryRepo, not a replacement.

### Gap C — smallchat: own dispatcher vs. depend on `@smallchat/core`

**Current state:** AgentVault borrows the *pattern*, not the package. This is arguably correct as-is:
the in-repo `SmallChatBridge`/`ToolClass` model maps Candid method signatures by exact selector with no
embeddings, and `smallchat-compression.ts` targets the ICP canister's cycle/heap constraints (the 38-byte
binary record format). `@smallchat/core` resolves intents by vector similarity, so it needs an embedder
and a vector index (its package depends on `onnxruntime-node` and `sqlite-vec`). These are different
tools for adjacent problems, not a fork of one.

**Recommendation:** keep the in-repo implementation. Revisit only if AgentVault needs intent-based
(semantic) resolution in a Node process — for example in the orchestrator, not a canister — where
`@smallchat/core` 1.0's JSON Schema validation, proofs and replayable decision logs would add value.

### Gap D — Polytician client ↔ Polytician 3.0

**Problem:** see §3. Against Polytician 3.0, search returns an error the client reads as "no concepts",
saving stores nothing and returns no id, and three `agentvault polytician` subcommands call tools that do
not exist.

**Opportunity:** update `mcp-client.ts`, `polytician-enricher.ts`, `cli/commands/polytician.ts` and the
webapp routes to the calls in Polytician's README (read `structuredContent`, `search_concepts { query, k }`
with client-side score filtering, `save_concept { markdown, tags }`), and build the real system prompt
from the enriched task. Polytician's `tests/mcp-contract.test.ts` replays AgentVault's calls and is a
ready-made reference.

## 5. Suggested phased roadmap

None of these phases is scheduled in an AgentVault plan file.

1. **Phase 0 (prerequisite):** close Gap D so Polytician enrichment and concept saving work against
   Polytician 3.0.
2. **Phase 1 (low risk, high signal):** Replace the truncation branch in `polytician-enricher.ts` with
   Short-hand's compaction primitives. Add a unit test asserting which concepts survive under a tight
   token budget (mirroring the existing `tests/unit/smallchat-compression.test.ts` style).
3. **Phase 2 (additive):** Stand up Stenographer in `watch` mode against orchestration session logs in a
   non-production environment; wire its MCP tools into `src/orchestration/mcp-client.ts` behind a feature
   flag analogous to `SmallChatOptions.enabled`, so turning it off leaves the rest of the pipeline as it is.
4. **Phase 3 (evaluate, don't commit yet):** Once Phases 1–2 are validated, assess whether Short-hand's
   context frame should be the single builder for *all* AgentVault orchestration inputs (Polytician
   concepts + Stenographer decisions + live conversation), rather than each source doing its own ad hoc
   trimming. `@shorthand/core` already reads Stenographer's truth format v2, which makes Stenographer's
   ledger the natural first input.

## 6. Risks and open questions

- **Single-maintainer dependencies:** the suite packages are 1.0 (Polytician 3.0) and attributed to the
  same author as AgentVault. Pin the major version (`@^1`, `polytician@^3`) and keep a thin adapter (as
  AgentVault does for Polytician's MCP server) rather than letting an upstream change reach a
  security-sensitive orchestration path directly.
- **Verify contracts against the release:** the descriptions above were checked against each suite
  repo's default branch before publication to npm. Before writing integration code, confirm exact
  function signatures, MCP tool schemas and the `CompactionEngine` public API against the published
  package contents. Gap D shows what happens when a client drifts from a server's schema.
- **Data-model boundary needs to stay explicit:** it will be tempting to let Stenographer's
  conversational index and MemoryRepo's structured commit history blur together. Keep them separate —
  MemoryRepo is the source of truth for agent identity/state; Stenographer's index is a derived,
  rebuildable index over conversation logs, and its truth ledger records claims that people or agent
  quorums settle, not agent state.
