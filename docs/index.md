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

AgentVault is the runtime layer of a small family of tools built for long-running, autonomous agents: a
durable place to execute ([AgentVault](#get-started)), a cheap and deterministic way to pick the next action
([SmallChat](https://github.com/johnnyclem/smallchat)), a passive conversational memory
([Stenographer](https://github.com/johnnyclem/stenographer)), and a way to keep that memory inside a token
budget ([Short-Hand](https://github.com/johnnyclem/short-hand)). AgentVault already ships a purpose-built
implementation of the SmallChat tool-dispatch pattern in its orchestration layer.

- [Ecosystem overview](/docs/ecosystem/executive-summary) — what each project does and how they fit together.
- [Engineering guide](/docs/ecosystem/engineering-guide) — component reference, integration status, and the
  roadmap for wiring Stenographer and Short-Hand into AgentVault's orchestration pipeline.

## Guides

- [Deployment](/docs/user/deployment) — local and mainnet canister operations.
- [Wallets](/docs/user/wallets) — cross-chain custody and transaction flows.
- [Backups](/docs/user/backups) — snapshot, restore, and archival strategy.
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
