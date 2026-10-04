# AgentVault Documentation

AgentVault packages your AI agent, deploys it to an Internet Computer canister, and keeps it running with its
own durable identity, multi-chain wallet, encrypted secrets, and versioned memory. This is the full reference
for installing, deploying, operating, and securing it in production.

:::note Before you start
Production use requires a funded ICP identity and cycles balance, plus secure handling of your wallet
mnemonic. See [Installation](/docs/getting-started/installation) for setup details.
:::

## Get started

| Step | What it covers | Start here |
| --- | --- | --- |
| 1. Install | Install the CLI and set up your ICP identity | [Installation](/docs/getting-started/installation) |
| 2. Deploy | Package and deploy your first agent | [Quick Start](/docs/getting-started/quick-start) |
| 3. Operate | End-to-end lifecycle for real workloads | [Tutorial v1.0](/docs/user/tutorial-v1.0) |

## The agent stack

AgentVault is the runtime layer for long-running, autonomous agents: a durable place to execute
([AgentVault](#get-started)). It pairs with the smallchat suite, which covers the other layers: picking the
next tool, a memory that survives, and keeping that memory inside a token budget. The suite's 1.0 release is:

| Project | What it does | Release |
| --- | --- | --- |
| [smallchat](https://www.smallchat.dev) ([repo](https://github.com/johnnyclem/smallchat), [Swift](https://github.com/johnnyclem/smallchat-swift)) | Semantic tool dispatch: resolves an intent to at most one tool and checks its arguments against the tool's JSON Schema | `@smallchat/core` 1.0.0, `SmallChat` Swift package 1.0.0 |
| [Stenographer](https://stenographer.smallchat.dev) ([repo](https://github.com/johnnyclem/stenographer)) | Conversation index with GraphRAG search, plus a hash-chained truth ledger | `@stenographer/core` 1.0.0 |
| [Short-hand](https://short-hand.smallchat.dev) ([repo](https://github.com/johnnyclem/short-hand)) | Progressive compaction of conversation history into a token-budgeted context frame | `@shorthand/core` 1.0.0 |
| [Polytician](https://polytician.smallchat.dev) ([repo](https://github.com/johnnyclem/polytician)) | Local-first MCP server for semantic memory (concepts as vectors, markdown and ThoughtForm JSON) | `polytician` 3.0.0 |

AgentVault ships on its own schedule and does not depend on those packages. Its orchestration layer has its
own selector-based dispatcher modeled on smallchat, and an MCP client for Polytician 3.0:
`agentvault orchestrate --polytician-entry` adds the concepts most relevant to the task to Claude's prompt and
saves each session's result as a concept, in the agent's own Polytician namespace. The `push-all`, `pull` and
`archive` commands use Polytician's `vault_*` tools, which AgentVault turns on by passing Polytician its
webapp's URL and token; pushes reach the `memory_repo` canister through webapp routes that sign with an
identity the repo owner has authorized. See the [Polytician guide](/docs/guides/polytician). Stenographer and
Short-hand are not integrated yet.

- [Ecosystem overview](/docs/ecosystem/executive-summary) — what each project does and how they fit together.
- [Engineering guide](/docs/ecosystem/engineering-guide) — component reference, integration status, and a
  proposed roadmap (not yet scheduled) for wiring Stenographer and Short-hand into AgentVault's orchestration
  pipeline.
- [Cross-repo evaluation playbook](/docs/ecosystem/cross-repo-playbook) — runbook for reproducing
  the ecosystem evaluation from within another repo in the stack.

## Guides

- [Deployment](/docs/user/deployment) — local and mainnet canister operations.
- [Wallets](/docs/user/wallets) — cross-chain custody and transaction flows.
- [Backups](/docs/user/backups) — snapshot, restore, and archival strategy.
- [MemoryRepo](/docs/memory-repo) — git-style on-chain memory, and the identities that may write to it.
- [Polytician](/docs/guides/polytician) — semantic memory per agent, connected to AgentVault's webapp.
- [Monitoring](/docs/guides/monitoring) — health checks, metrics, and alerting.
- [Troubleshooting](/docs/user/troubleshooting) — fast diagnostics and recovery.

## Reference

- [CLI Reference](/docs/cli/reference) — the complete command surface.
- [CLI Options](/docs/cli/options) — global flags and environment variables.

## Security

- [Security Overview](/docs/security/overview) — trust model and control boundaries.
- [Best Practices](/docs/security/best-practices) — secure-by-default operation.
- [Security Audit](/docs/dev/SECURITY_AUDIT) — v1.0 findings and recommendations.

## Architecture

- [Architecture Overview](/docs/architecture/overview)
- [Module Reference](/docs/architecture/modules)
- [Canister Internals](/docs/architecture/canister)

## Recommended reading order

1. [Installation](/docs/getting-started/installation)
2. [Quick Start](/docs/getting-started/quick-start)
3. [Tutorial v1.0](/docs/user/tutorial-v1.0)
4. [Deployment](/docs/user/deployment) and [Wallets](/docs/user/wallets)
5. [Backups](/docs/user/backups) and [Monitoring](/docs/guides/monitoring)
6. [Security Overview](/docs/security/overview)
7. [Ecosystem overview](/docs/ecosystem/executive-summary)

## Status

- Version: **AgentVault v1.0.0**
- Website: [agentvault.cloud](https://agentvault.cloud)
- Source: [github.com/johnnyclem/agentvault](https://github.com/johnnyclem/agentvault)
- Package: [npmjs.com/package/agentvault](https://www.npmjs.com/package/agentvault)
