# The Agent Stack: Executive Summary

**Scope:** AgentVault and the smallchat suite (smallchat, Stenographer, Short-hand, Polytician), evaluated
as a single ecosystem.
**Audience:** stakeholders deciding whether/how to integrate these projects.

> **Sourcing note:** AgentVault was evaluated directly from source. The first version of this page
> (July 2026) described smallchat, Stenographer and Short-hand from their public READMEs only. In
> October 2026 every statement about the suite was re-checked against each suite repo's default branch
> for its 1.0 release (README, CHANGELOG, MIGRATION and source), and Polytician was added. Each suite
> repo also keeps an evaluation from its own side under `docs/ecosystem/`;
> [`cross-repo-playbook.md`](./cross-repo-playbook.md) is the runbook for producing one.

## What each project is, in one line

| Project | One-line role | Language | License | Maturity |
|---|---|---|---|---|
| **AgentVault** | Deploys AI agents to Internet Computer canisters for persistent, 24/7, sovereign execution | TypeScript / Motoko | MIT | Active, ~1,600 tests ([testing.md](../development/testing.md)), v1.0 docs |
| **smallchat** | Semantic tool dispatch: resolves an intent to at most one tool, runs it only when the dispatch policy allows, checks arguments against the tool's JSON Schema, and records a replayable proof | TypeScript (`@smallchat/core`) and Swift (`SmallChat` package) | MIT | 1.0.0 (TypeScript and Swift) |
| **Stenographer** | An MCP server that indexes agent conversation logs for GraphRAG search (entities, relations, decisions) and keeps a hash-chained truth ledger | TypeScript (`@stenographer/core`) | MIT | 1.0.0 |
| **Short-hand** | Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame, plus CRDT memory and truth-ledger interop | TypeScript (`@shorthand/core`) | MIT | 1.0.0 |
| **Polytician** | A local-first MCP server for semantic memory: concepts stored as, and converted between, 384-dimension vectors, markdown and ThoughtForm JSON | TypeScript (`polytician`) | MIT | 3.0.0 |

These four projects make up the suite's 1.0 release (Polytician as 3.0.0). AgentVault is versioned
separately and is not part of that release.

## The thesis

Long-running, autonomous agents need things that a single chat session doesn't: a **body** that
survives when the browser tab closes, **reflexes** that pick actions cheaply and reliably, a **memory**
that records what happened, and a **working-memory compressor** that keeps that memory usable inside a
fixed token budget. AgentVault is the body. The suite covers the rest:

```
 AgentVault        →  the body         (durable, on-chain execution + wallet + secrets)
 smallchat         →  the reflexes     (resolve an intent to one tool, check it, record why)
 Stenographer      →  the memory       (conversation index + hash-chained truth ledger)
 Short-hand        →  working memory   (compacts raw history into an LLM-sized context frame)
 Polytician        →  concept memory   (local semantic store: vectors, markdown, ThoughtForm)
```

None of them is useful alone for a fully autonomous agent — a body with no memory forgets everything on
restart; a memory with no compaction blows the context window; reflexes with no body have nowhere
durable to act. Together they describe a coherent, layered agent runtime, authored by the same person.

Inside the suite, several seams are built, mostly as file-format and wire contracts rather than code
dependencies: `@smallchat/core` 1.0 depends on `@shorthand/core` 1.0; `@shorthand/core` reads
Stenographer's truth format v2 and checks it against Stenographer's golden fixtures; Stenographer can
deliver objections to smallchat's channel bridge; and the Swift package runs smallchat's shared
conformance vectors. None of these seams reaches into AgentVault.

## Key finding: AgentVault is only partly wired to the suite

AgentVault depends on no suite package (`package.json` lists none). What it has today:

- **smallchat — the pattern, not the package.** `src/orchestration/smallchat-*.ts` is a from-scratch,
  in-repo dispatcher modeled on smallchat's selector design: exact selector lookup with class-hierarchy
  fallback, no embeddings, followed by a policy engine (rate limits, dedup, MFA and approval
  decisions). It is opt-in through the orchestrator's library API (`smallChat.enabled`); the
  `agentvault orchestrate` command does not turn it on. It shares no code with `@smallchat/core` and
  uses none of its 1.0 features (JSON Schema validation, proofs, decision logs, conformance vectors).
- **Polytician — an MCP client for Polytician 3.0.** `agentvault polytician` and
  `agentvault orchestrate --polytician-entry` call a Polytician 3.0 MCP server over stdio
  (`src/orchestration/mcp-client.ts`, `polytician-enricher.ts`). The orchestrator adds the concepts most
  relevant to the task to Claude's prompt and saves each session's result as a concept, in the agent's own
  Polytician namespace; `status` and `search` work against Polytician as installed. `push-all`, `pull` and
  `archive` use Polytician's opt-in `vault_*` tools: AgentVault passes the Polytician it starts its webapp's
  URL and token when `AGENTVAULT_API_URL` and `AGENTVAULT_POLYTICIAN_API_TOKEN` are set, and
  `agentvault polytician config` writes Polytician's config file (archival is a further opt-in). A push goes
  through AgentVault's memory_repo routes, which sign with an identity the repo owner has authorized.
- **Stenographer and Short-hand — not integrated.** Neither is referenced anywhere in AgentVault's
  source, tests, `package.json` or plan files.

AgentVault also has two of its own, independently-built subsystems that overlap with what Stenographer
and Short-hand do:

- **MemoryRepo** (`docs/memory-repo.md`) — a git-style, on-chain versioned memory for structured
  state (commits, branches, merges), not conversational recall.
- **Polytician enrichment** (`src/orchestration/polytician-enricher.ts`) — pulls "concepts" from a
  Polytician MCP server and puts them into the prompt with a **hard character-count truncation**, the
  naive-truncation problem Short-hand's compaction engine was built to avoid.

So the ecosystem is real as a *design philosophy* and, inside the suite, as working contracts. From
AgentVault's side it is **one pattern borrowed (smallchat), one client for the current release
(Polytician), and two bridges missing** (Stenographer, Short-hand).

## Why this matters

- **Cost & context efficiency:** the Polytician enricher's truncate-at-N-characters step is the weakest
  link in AgentVault's orchestration pipeline for any long-running session. Short-hand exists
  specifically to solve this.
- **Auditability:** AgentVault already cares deeply about audit trails (VetKeys signing, on-chain
  commits, policy engine logging). Stenographer's decision supersession and its hash-chained truth
  ledger are a natural fit for "why did the agent decide X" queries that MemoryRepo doesn't answer today.
- **Duplication risk:** Building deeper conversational memory into AgentVault from scratch would
  re-invent what Stenographer already does. The cheaper path is integration, not reimplementation
  (as was arguably already done once with smallchat).
- **Dependency risk:** the suite packages are 1.0 (Polytician 3.0) and single-maintainer. Depending on
  them directly (vs. borrowing the pattern, as AgentVault does for smallchat) trades duplication for
  supply-chain and API-stability risk. Pin the major version.

## Recommendation

1. **Evaluate, don't blindly adopt:** pull in Stenographer/Short-hand behind the same kind of thin
   client/adapter AgentVault already has for Polytician's MCP server, so a breaking upstream change
   can't take down agent execution.
2. Keep the Polytician client's recorded contract (`tests/fixtures/polytician-3.0/`) current: re-capture
   it when Polytician changes its tools, so a contract change fails AgentVault's tests instead of
   silently emptying enrichment.
3. Pilot Short-hand as a drop-in replacement for the truncation logic in
   `polytician-enricher.ts` — smallest surface area, clearest win.
4. Pilot Stenographer as a read-side companion to MemoryRepo for conversational Q&A ("what did we
   decide about X"), not a replacement for MemoryRepo's structured on-chain commits.
5. Defer adopting the published `@smallchat/core` package. AgentVault's dispatcher maps Candid methods
   with no embeddings; `@smallchat/core` resolves intents by vector similarity with an embedder and a
   vector index. Re-platforming has a real cost and no clear benefit yet.

None of these steps is scheduled. See `docs/ecosystem/engineering-guide.md` for the technical detail
behind these recommendations.
