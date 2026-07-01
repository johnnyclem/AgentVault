# The Agent Stack: Executive Summary

**Scope:** AgentVault, SmallChat, Stenographer, and Short-Hand — evaluated as a single ecosystem.
**Audience:** stakeholders deciding whether/how to integrate these projects.

> **Sourcing note:** This session's GitHub access is scoped to `johnnyclem/agentvault` only.
> AgentVault was evaluated directly from source. SmallChat, Stenographer, and Short-Hand were
> evaluated from their public GitHub READMEs and repository metadata (no source-level access).
> Treat claims about those three as directionally accurate, not verified against code.

## What each project is, in one line

| Project | One-line role | Language | License | Maturity |
|---|---|---|---|---|
| **AgentVault** | Deploys AI agents to Internet Computer canisters for persistent, 24/7, sovereign execution | TypeScript / Motoko | MIT | Active, 508 tests, v1.0 docs |
| **SmallChat** | Deterministic, in-process tool dispatch so agents pick the right tool without stuffing 50+ schemas into the prompt | TypeScript (+ Swift port) | MIT | Public, `@smallchat/core` on npm |
| **Stenographer** | A passive "court reporter" that tails agent conversation logs and builds a searchable GraphRAG index (entities, relations, decisions) | TypeScript | — | Alpha (`0.1.0-alpha.2`) |
| **Short-Hand** | Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame | TypeScript | MIT | Public, npm package |

## The thesis

Long-running, autonomous agents need four things that a single chat session doesn't: a **body** that
survives when the browser tab closes, **reflexes** that pick actions cheaply and reliably, a **memory**
that records what happened, and a **working-memory compressor** that keeps that memory usable inside a
fixed token budget. Each of these four repositories owns exactly one of those responsibilities:

```
 AgentVault        →  the body        (durable, on-chain execution + wallet + secrets)
 SmallChat         →  the reflexes    (deterministic tool selection, no schema bloat)
 Stenographer      →  the memory      (passive conversation observer + GraphRAG index)
 Short-Hand        →  working memory  (compacts raw history into an LLM-sized context frame)
```

None of them is useful alone for a fully autonomous agent — a body with no memory forgets everything on
restart; a memory with no compaction blows the context window; reflexes with no body have nowhere
durable to act. Together they describe a coherent, layered agent runtime, authored by the same person,
with Short-Hand explicitly billed as "language middleware for Stenographer and SmallChat" — the seam
between the memory layer and the reflex layer is intentional, not coincidental.

## Key finding: the ecosystem is designed, but only partially wired

AgentVault today **only** integrates the SmallChat *pattern* — and even that is a from-scratch,
in-repo reimplementation (`src/orchestration/smallchat-*.ts`), not a dependency on the published
`@smallchat/core` package. Stenographer and Short-Hand are **not referenced anywhere in AgentVault's
source, tests, or docs.** AgentVault already has two of its own, independently-built subsystems that
overlap with what Stenographer and Short-Hand do:

- **MemoryRepo** (`docs/memory-repo.md`) — a git-style, on-chain versioned memory for structured
  state (commits, branches, merges), not conversational recall.
- **Polytician enrichment** (`src/orchestration/polytician-enricher.ts`) — pulls "concepts" from an
  external MCP server and stuffs them into the prompt with a **hard character-count truncation**, the
  exact naive-truncation problem Short-Hand's compaction engine was built to avoid.

So the four-project ecosystem is real as a *design philosophy*, but as of today it is **one bridge
built (AgentVault ↔ SmallChat, partially) and two bridges missing** (AgentVault ↔ Stenographer,
AgentVault ↔ Short-Hand).

## Why this matters

- **Cost & context efficiency:** Polytician's truncate-at-N-characters enrichment is the weakest link
  in AgentVault's orchestration pipeline for any long-running session. Short-Hand exists specifically
  to solve this.
- **Auditability:** AgentVault already cares deeply about audit trails (VetKeys signing, on-chain
  commits, policy engine logging). Stenographer's decision-supersession/tombstone model is a natural
  fit for "why did the agent decide X" queries that MemoryRepo doesn't answer today.
- **Duplication risk:** Building deeper conversational memory into AgentVault from scratch would
  re-invent what Stenographer already does. The cheaper path is integration, not reimplementation
  (as was arguably already done once with SmallChat).
- **Dependency risk:** SmallChat, Stenographer, and Short-Hand are single-maintainer, low-star,
  alpha-to-early-stable projects. Depending on them directly (vs. vendoring, as AgentVault already
  does for SmallChat) trades duplication for supply-chain and API-stability risk.

## Recommendation

1. Treat SmallChat's vendored pattern in AgentVault as the template: **evaluate, don't blindly adopt**
   — pull in Stenographer/Short-Hand behind the same kind of thin bridge/adapter AgentVault already
   builds for SmallChat and Polytician, so a breaking upstream change can't take down agent execution.
2. Pilot Short-Hand as a drop-in replacement for the truncation logic in
   `polytician-enricher.ts` — smallest surface area, clearest win.
3. Pilot Stenographer as a read-side companion to MemoryRepo for conversational Q&A ("what did we
   decide about X"), not a replacement for MemoryRepo's structured on-chain commits.
4. Defer adopting the published `@smallchat/core` package; the in-repo reimplementation is already
   tailored to Candid method dispatch and canister cycle constraints — re-platforming has a
   real cost and no clear benefit yet.

See `docs/ecosystem/engineering-guide.md` for the technical detail behind these recommendations.
