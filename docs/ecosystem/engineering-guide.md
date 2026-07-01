# The Agent Stack: Engineering Guide

Companion to [`executive-summary.md`](./executive-summary.md). This is the technical breakdown of how
AgentVault, SmallChat, Stenographer, and Short-Hand relate, what's actually wired up in this repo today,
and how to close the gaps.

> **Sourcing note:** AgentVault claims below are verified against source in this repo. SmallChat,
> Stenographer, and Short-Hand claims come from their public READMEs (`github.com/johnnyclem/{smallchat,
> stenographer,short-hand}`) — this session has no source-level GitHub access outside
> `johnnyclem/agentvault`. Re-verify exact APIs against upstream source before writing integration code.
> See [`cross-repo-playbook.md`](./cross-repo-playbook.md) for a runbook an agent with access to
> one of the other three repos can follow to verify and extend this guide from that side.

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

### SmallChat

- **What it is:** "Semantic tool dispatch" — instead of listing 50+ tool JSON schemas in the LLM's
  context window, SmallChat infers the correct tool deterministically, in-process, in microseconds,
  with an auditable decision trail. Modeled on Smalltalk/Objective-C message dispatch: tools are
  objects, intents are messages, dispatch is semantic rather than prompt-based.
- **Distribution:** `npm install -g @smallchat/core`; also ported to Swift (`smallchat-swift`).
- **Core claim:** "Tool inference is the durable idea" — token savings are a side effect, deterministic
  auditable selection is the point.

### Stenographer

- **What it is:** An MCP server that passively tails agent conversation logs (JSONL) and builds a
  searchable **GraphRAG** index — vector similarity plus graph traversal over entities, relations, and
  decisions extracted from the conversation. Self-described as "a court reporter sitting in the room —
  it doesn't participate, but it's always listening."
- **Storage/embeddings:** local `all-MiniLM-L6-v2` embeddings (~25MB, offline, no API key) via
  `@xenova/transformers`, persisted in SQLite with `sqlite-vec` KNN indexing (cosine fallback if the
  extension is unavailable).
- **Decision tracking:** append-only decision records with a **tombstone/supersession** model — when an
  agent changes its mind, the old decision is superseded, not deleted, preserving provenance.
- **Interfaces:** MCP over stdio (13 tools including `search_conversation`, `get_entities`,
  `get_relations`, `get_decisions`) and a REST API (`daemon` mode, port 8787: `/status`, `/messages`,
  `/entities`, `/search`, `/graphrag`).
- **Modes:** `live`, `catchup`, `watch` (directory monitoring), `daemon`.
- **Provider adapters:** `jsonl`, `claude-code`, `anthropic`, `openai`, `generic`, with auto-detection.
- **Maturity:** `0.1.0-alpha.2`, distributed as `@stenographer/core`.

### Short-Hand

- **What it is:** "Progressive context compaction for LLMs," applying LSM-tree-style database
  compaction to conversation history instead of naive truncation.
- **Five-level architecture:** L0 (verbatim recent messages) → L4 (core invariants), each level trading
  fidelity for compression. Corrections are detected via **tombstones**; message importance is scored
  from state changes, reference frequency, and trajectory shifts.
- **Key primitives:** a `CompactionEngine` orchestrating the lifecycle; regex-based compaction and
  importance-detection classes; token-budgeted context-frame generation; an `ActiveEngramStore` for
  agentic memory with re-interpretation at retrieval time; a three-tier interpretation system
  (regex → local model → host LLM) with fallback; CRDT primitives for distributed/multi-agent scenarios.
- **Explicit positioning:** README self-describes as "language middleware for Stenographer and
  SmallChat" — zero runtime dependencies, fully typed, ESM-only, MIT-licensed.

## 2. How the four fit together

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Conversation / Session                        │
│                     (user ↔ agent, tool calls, results)                    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                 │ raw JSONL log
                                 ▼
                        ┌─────────────────┐
                        │   Stenographer   │   passive observer
                        │  (GraphRAG index,│   entities / relations /
                        │  decision log)   │   decisions, tombstones
                        └────────┬─────────┘
                                 │ search_conversation / get_decisions (MCP)
                                 ▼
                        ┌─────────────────┐
                        │   Short-Hand     │   compacts retrieved history +
                        │ (5-level LSM     │   live context into a token-
                        │  compaction)     │   budgeted context frame
                        └────────┬─────────┘
                                 │ context frame
                                 ▼
                        ┌─────────────────┐
                        │   LLM (agent)    │   decides *what* to do next
                        └────────┬─────────┘
                                 │ tool intent
                                 ▼
                        ┌─────────────────┐
                        │   SmallChat      │   deterministic, in-process
                        │ (selector →      │   tool dispatch, no schema
                        │  tool dispatch)  │   stuffing
                        └────────┬─────────┘
                                 │ resolved tool call
                                 ▼
                        ┌─────────────────┐
                        │   AgentVault     │   policy check → canister exec
                        │ (canister exec,  │   → wallet/secrets/state →
                        │  wallet, vault)  │   VetKeys-signed, on-chain
                        └─────────────────┘
```

Read top to bottom: Stenographer is the **memory** (what happened), Short-Hand is the
**compression/retrieval middleware** between that memory and the model's limited context window,
SmallChat is the **reflex** (what to do about it, chosen cheaply and deterministically), and
AgentVault is the **body** (where it actually executes, durably and auditably).

## 3. What's actually wired up in AgentVault today

Only the SmallChat *pattern* is integrated, and it is a **from-scratch reimplementation**, not a
dependency on `@smallchat/core`:

| File | Role |
|---|---|
| `src/orchestration/smallchat-tools.ts` | Maps AgentVault's Candid service interface into a `ToolClass` hierarchy (`BaseTools` → `CanisterLifecycleTools`, `WalletTools` → `TransactionTools`, `SecretTools`, `VetKeysTools`), each tool tagged with a `category` and `riskLevel`. |
| `src/orchestration/smallchat-bridge.ts` | `SmallChatBridge` — selector interning, LRU resolution cache, superclass-fallback resolution, parameter validation, and a compact system-prompt generator (`generateSystemPromptHeader()`) so the LLM sees selectors, not full JSON schemas. |
| `src/orchestration/smallchat-compression.ts` | `IntentCompressor` — 38-byte fixed-width binary tool-call records (2-byte selector ID + 32-byte param hash + 4-byte timestamp delta) plus repeated-sequence pattern detection, purpose-built for the ICP canister's 64MB heap and cycle-metered compute. |
| `src/orchestration/smallchat-policy.ts` | `SmallChatPolicyEngine` — pre-dispatch validation, semantic dedup, rate limiting, MFA gating for high-risk ops, parameter sanitization, and audit logging; wired to `src/security/multisig.ts`, `src/security/mfa-approval.ts`, and `src/security/icp-audit.ts`. |
| `src/orchestration/claude.ts` (`initSmallChat`, ~line 457; `SmallChatOptions`, ~line 37) | Wires bridge + policy + compressor into the Claude Code orchestration session, opt-in via `options.smallChat.enabled`, and reports `SmallChatSessionReport` stats (registered selectors, cache hit rate, compression stats) back through `onProgress`. |
| `tests/unit/smallchat-{bridge,compression,policy}.test.ts`, `tests/integration/smallchat-orchestration.test.ts` | Test coverage for the above. |

**Stenographer and Short-Hand have zero references anywhere in this repo** (source, tests, docs,
`package.json`, `package-lock.json`) — confirmed by repo-wide search.

### Existing AgentVault subsystems that overlap with the missing pieces

- **`docs/memory-repo.md` (MemoryRepo canister):** git-style versioned memory — commits, branches,
  merge, rebase, cherry-pick, anchored by a genesis `Soul.md`. This is **structured, agent-identity
  memory**, not conversational recall. It does not do semantic search over free-text conversation the
  way Stenographer's GraphRAG index does — different data model, complementary rather than redundant.
- **`src/orchestration/polytician-enricher.ts` (`enrichWithPolyticianContext`):** calls an external MCP
  server's `search_concepts` / `read_concept` tools to pull relevant "concepts" into the prompt. Notably,
  its overflow handling is a **hard stop on total character count** (`totalContextLength + blockLength >
  maxContextLength - prompt.length - 500`) and, failing that, a **blunt string slice with `...`**
  (`enrichedPrompt.slice(0, maxContextLength - 3) + '...'`). This is precisely the naive-truncation
  failure mode Short-Hand's `CompactionEngine` is designed to replace with importance-scored,
  level-based compaction.

## 4. Integration gaps and concrete opportunities

### Gap A — Short-Hand ↔ `polytician-enricher.ts`

**Problem:** enrichment context is truncated by character count with no regard for which concept is
most important, and there's no history/session compaction elsewhere in the orchestration pipeline at
all — a long-running `orchestrate` session just keeps growing its system prompt
(`src/orchestration/claude.ts` line ~631 appends `smallChatReport.systemPromptHeader` unconditionally).

**Opportunity:** swap the truncate-on-overflow branch in `enrichWithPolyticianContext` for a
`CompactionEngine`-driven context frame: feed retrieved concepts in as candidate messages, let importance
scoring (state changes, reference frequency) decide what survives at L0–L4, and request a token-budgeted
frame instead of a character-budgeted string. Smallest surface area of the three gaps, highest
signal-to-noise improvement.

### Gap B — Stenographer ↔ orchestration session logs

**Problem:** AgentVault's orchestration sessions (`src/orchestration/claude.ts`) run Claude Code / ADK
sessions with `onProgress` callbacks and produce a session report, but there is no durable, queryable
index of *why* an agent made a given decision across sessions — only MemoryRepo's structured commits and
Polytician's saved "concepts" (`saveConceptFromOrchestration`).

**Opportunity:** point Stenographer's `watch` mode at wherever orchestration session transcripts are
written (or add a `jsonl` adapter emission from `claude.ts`), and expose `search_conversation` /
`get_decisions` as an additional MCP server alongside the existing Polytician MCP client
(`src/orchestration/mcp-client.ts`). This gives "what did we decide about X three sessions ago"
recall without teaching MemoryRepo to do full-text/semantic search over conversation, which isn't its
job. Treat this as **additive** to MemoryRepo, not a replacement.

### Gap C — SmallChat: vendor vs. depend

**Current state:** AgentVault vendors the *pattern*, not the package. This is arguably correct as-is:
the in-repo `SmallChatBridge`/`ToolClass` model is purpose-built for Candid method signatures and the
ICP canister's cycle/heap constraints (see the 38-byte binary record format in
`smallchat-compression.ts`, which has no equivalent need in a non-blockchain context). Re-platforming
onto `@smallchat/core` would mean adapting a generic tool-dispatch library to canister-specific
constraints it wasn't built for for little clear benefit.

**Recommendation:** keep the vendored implementation. Revisit only if `@smallchat/core` adds
canister/Candid-aware primitives upstream, or if maintaining the vendored fork in sync with SmallChat's
evolving semantics becomes a real cost.

## 5. Suggested phased roadmap

1. **Phase 1 (low risk, high signal):** Replace the truncation branch in `polytician-enricher.ts` with
   Short-Hand's compaction primitives. Add a unit test asserting importance-ranked survival under a
   tight token budget (mirroring the existing `tests/unit/smallchat-compression.test.ts` style).
2. **Phase 2 (additive):** Stand up Stenographer in `watch` mode against orchestration session logs in a
   non-production environment; wire its MCP tools into `src/orchestration/mcp-client.ts` behind a feature
   flag analogous to `SmallChatOptions.enabled`, so it can be disabled with zero blast radius.
3. **Phase 3 (evaluate, don't commit yet):** Once Phases 1–2 are validated, assess whether Short-Hand's
   `ActiveEngramStore` should sit in front of Stenographer's GraphRAG results as the single context-frame
   builder for *all* AgentVault orchestration inputs (Polytician concepts + Stenographer decisions +
   live conversation), rather than each source doing its own ad hoc trimming.

## 6. Risks and open questions

- **Single-maintainer, pre-1.0 dependencies:** SmallChat, Stenographer, and Short-Hand are all
  attributed to the same author as AgentVault, with Stenographer explicitly alpha
  (`0.1.0-alpha.2`) and low visibility (few/no stars reported). Pin exact versions and vendor-adapt
  (as already done for SmallChat) rather than taking a live `npm` dependency on a moving alpha target
  inside a security-sensitive orchestration path.
- **No verified API contracts:** the descriptions above come from public READMEs only. Before writing
  integration code, get direct source access to `stenographer` and `short-hand` (or their npm
  package contents) to confirm exact function signatures, MCP tool schemas, and the `CompactionEngine`
  public API.
- **Data-model boundary needs to stay explicit:** it will be tempting to let Stenographer's
  conversational index and MemoryRepo's structured commit history blur together. Keep them separate —
  MemoryRepo is the source of truth for agent identity/state; Stenographer is a derived, rebuildable
  index over conversation logs.
