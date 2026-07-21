<p align="center">
  <img src="site/static/img/logo.svg" alt="AgentVault" width="88" height="88" />
</p>

# AgentVault

**Persistent On-Chain AI Agent Platform — Sovereign, Reconstructible, Autonomous**

<p align="center">
  <a href="https://www.npmjs.com/package/agentvault"><img src="https://img.shields.io/npm/v/agentvault.svg" alt="npm version"></a>
  <a href="https://github.com/johnnyclem/agentvault/actions/workflows/test.yml"><img src="https://github.com/johnnyclem/agentvault/actions/workflows/test.yml/badge.svg" alt="test status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/agentvault.svg" alt="license"></a>
  <img src="https://img.shields.io/node/v/agentvault.svg" alt="node engine">
</p>

AgentVault is an open-source CLI and canister system that gives local AI agents
true autonomy. Package an agent, deploy it to an [Internet Computer](https://internetcomputer.org/)
(ICP) canister, and it keeps running 24/7 — no laptop, browser tab, or hosting
bill required. State lives on-chain, so any agent can be fetched, decrypted,
and reconstructed from nothing but its canister ID or a single Arweave
transaction.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [HyperVault](#hypervault)
- [Example Agents](#example-agents)
- [CLI Commands](#cli-commands)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Development](#development)
- [Testing](#testing)
- [Known Limitations](#known-limitations)
- [Wallet Secrets](#wallet-secrets)
- [Contributing](#contributing)
- [License](#license)
- [Resources](#resources)

## Features

- **Agent Packaging** — compile TypeScript agents to WASM
- **Canister Deployment** — deploy to an ICP local replica or mainnet
- **State Management** — query, fetch, and reconstruct agent state
- **Multi-Chain Wallets** — ICP, Ethereum, Polkadot, and Solana support
- **VetKeys Integration** — threshold key derivation for secure secrets
- **Monitoring** — health checks, metrics, and alerting
- **Archival** — Arweave integration for permanent, off-chain-cheap storage
- **AI Inference** — Bittensor network integration
- **Fault Tolerance** — mirrored canisters, cron-driven liveness checks, and auto-restore
- **HyperVault Bridge** — reconstruct a cloud-hosted agent from chain alone

## Installation

### From npm (Recommended)

```bash
npm install -g agentvault
agentvault --help
```

### From Source

```bash
git clone https://github.com/johnnyclem/agentvault.git
cd agentvault
npm install
npm run build
node dist/cli/index.js --help
```

### Prerequisites

- Node.js 18+
- [dfx](https://internetcomputer.org/docs/current/developer-docs/getting-started/install/) (Internet Computer SDK) — for canister deployment
- TypeScript 5.7+

## Quick Start

### 1. Initialize a New Agent Project

```bash
npx agentvault@latest init my-agent --template default
cd my-agent
```

This scaffolds a new project directory containing `agent.json`, an `index.js`
entry point, and a `.agentvault/` directory with agent configuration. Use
`--template minimal` for a bare scaffold. (If you installed the CLI globally
with `npm install -g agentvault`, replace `npx agentvault@latest` with
`agentvault` in any command.)

### 2. Package Your Agent

```bash
agentvault package ./
```

Compiles your agent to WASM and generates deployment artifacts.

### 3. Start Local ICP Replica

```bash
dfx start --background
```

### 4. Deploy to Canister

```bash
agentvault deploy --network local
```

### 5. Execute Agent

```bash
agentvault exec --canister-id <your-canister-id> "your task"
```

### 6. Query Agent State

```bash
agentvault show --canister-id <your-canister-id>
```

### 7. Fetch State for Local Rebuild

```bash
agentvault fetch --canister-id <your-canister-id>
```

## HyperVault

[HyperVault](https://github.com/johnnyclem/hypervault) is the living cloud mind
(`hypervault.store`); AgentVault is the sovereign body. The `hypervault` command
group bridges them across three tiers — hot (cloud), warm (ICP canister), cold
(Arweave) — so a cloud account becomes reconstructible from chain alone.

```bash
# Bootstrap a HyperVault-backed agent — memories, mind history, and indices included
npx agentvault@latest hypervault bootstrap my-agent --key hv_...

# hypervault.store → fully secure, archived, blockchain-backed AgentVault
npx agentvault@latest hypervault archive --all --encrypt --network ic --arweave

# Resurrect anywhere from a single Arweave transaction
npx agentvault@latest hypervault restore ar://<tx-id> --to local
```

Both one-liners are also MCP tools via the native `agentvault mcp serve` server.
See [`docs/guides/hypervault.md`](docs/guides/hypervault.md) for the full guide.

## Example Agents

The [`examples/`](examples) directory ships ready-to-package agents so you can
see the full workflow before writing your own:

| Example | Description |
|---------|-------------|
| [`vale-agent`](examples/vale-agent) | A persona-driven agent with a defined "soul" (`soul.md`) |
| [`agents/generic`](examples/agents/generic) | Minimal generic agent scaffold (`agent.json` / `agent.yaml`) |
| [`agents/clawdbot`](examples/agents/clawdbot) | Claude-based agent example |
| [`agents/cline`](examples/agents/cline) | Cline-configured coding agent |
| [`agents/goose`](examples/agents/goose) | Goose-configured agent |
| [`agents/nemoclaw`](examples/agents/nemoclaw) | NVIDIA Nemotron/OpenShell inference runtime example |

## CLI Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize a new AgentVault project |
| `package` | Package agent directory to WASM |
| `deploy` | Deploy agent to ICP canister |
| `exec` | Execute task on canister |
| `show` | Show agent state |
| `fetch` | Download agent state from canister |
| `status` | Display project status |
| `list` | List all agents |

### Wallet Commands

| Command | Description |
|---------|-------------|
| `wallet` | Manage agent wallets |
| `identity` | Manage ICP identities |
| `cycles` | Manage canister cycles |
| `tokens` | Query token balances |

### Monitoring Commands

| Command | Description |
|---------|-------------|
| `monitor` | Monitor canister health |
| `health` | Run health checks |
| `info` | Get canister information |
| `stats` | View canister statistics |
| `logs` | View canister logs |

### Advanced Commands

| Command | Description | Status |
|---------|-------------|--------|
| `backup` | Backup agent data | Stable |
| `rebuild` | Rebuild agent from state | Stable |
| `promote` | Promote canister between environments | Stable |
| `rollback` | Rollback canister deployment | Stable |
| `inference` | Query AI inference services | Experimental |
| `archive` | Archive to Arweave | Experimental |
| `approve` | Multi-signature approvals | Experimental |
| `profile` | Profile canister performance | Experimental |
| `trace` | View execution traces | Experimental |

### Memory, Knowledge & Identity Commands

| Command | Description |
|---------|-------------|
| `memory` | Git-style memory repository for agent identity and versioned memory |
| `rebase` | Fetch on-chain commits and merge with a local bundle file |
| `merge` | Merge a local bundle file with on-chain commits (thoughtform merging) |
| `wiki` | LLM-maintained knowledge base (archivist) |
| `polytician` | Manage Polytician semantic memory integration |
| `skills` | Manage domain-specific agent skill files |
| `decrypt` | Decrypt agent state using a seed phrase |

### Security & Secrets Commands

| Command | Description |
|---------|-------------|
| `vault` | Manage agent secrets and API keys (HashiCorp Vault or Bitwarden) |
| `safehouse` | Agent Safehouse secret management layer (deny-first sandboxing) |
| `repo` | Repository security, audit, and integrity commands |

### Fault Tolerance & Operations Commands

| Command | Description |
|---------|-------------|
| `mirror` | Mirror agent state to a second ICP canister for fault tolerance |
| `cron` | Fault-tolerance automation: daily liveness check and auto-restore |
| `cloud-backup` | Detect available cloud storage providers on this machine |
| `network` | Manage ICP networks |
| `test` | Run tests against canisters |
| `instrument` | Instrument WASM file for debugging |

### Orchestration & Scaffolding Commands

| Command | Description |
|---------|-------------|
| `orchestrate` | Orchestrate an AI-assisted development session governed by AgentVault |
| `mcp` | Manage MCP (Model Context Protocol) server registrations |
| `mint` | Scaffold a new Google ADK agent with on-chain canister and birthday backup |
| `pilot` | Initialize a private ICP replica and deploy Guild canisters |
| `hypervault` | Bridge a HyperVault cloud account across hot/warm/cold tiers (see [HyperVault](#hypervault)) |

Run `agentvault <command> --help` for full option details, or see the
[complete CLI reference](docs/cli/reference.md).

## Environment Variables

### ICP Configuration

```bash
ICP_LOCAL_URL=http://127.0.0.1:4943    # Local replica URL
ICP_MAINNET_URL=https://ic0.app        # Mainnet URL
```

### RPC Endpoints

```bash
# Ethereum
ETHEREUM_RPC_URL=https://eth.example.com
INFURA_API_KEY=your-key
ETHERSCAN_API_KEY=your-key

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com

# Polkadot
POLKADOT_RPC_URL=wss://rpc.polkadot.io
KUSAMA_RPC_URL=wss://kusama-rpc.polkadot.io
```

## Project Structure

```
agentvault/
├── src/                    # Core TypeScript library
│   ├── deployment/         # ICP client and deployment
│   ├── packaging/          # WASM compilation
│   ├── canister/           # Actor bindings
│   ├── wallet/             # Multi-chain wallet
│   ├── security/           # VetKeys and encryption
│   ├── monitoring/         # Health and metrics
│   ├── archival/           # Arweave client
│   └── inference/          # Bittensor client
├── cli/                    # CLI commands
├── canister/               # Motoko canister code
├── webapp/                 # Next.js dashboard
├── macos-wallet-app/        # Native macOS/iOS wallet companion app (Xcode project)
├── tests/                  # Test suite (1,500+ cases)
└── examples/               # Sample agents
```

## Documentation (v1.0)

- **Website**: https://agentvault.cloud
- [Documentation index](docs/user/index-v1.0.md)
- [Comprehensive tutorial](docs/user/tutorial-v1.0.md)
- [Getting started](docs/getting-started/quick-start.md) · [Installation](docs/getting-started/installation.md) · [Configuration](docs/getting-started/configuration.md)
- [Complete CLI reference](docs/cli/reference.md)
- [Architecture overview](docs/architecture/overview.md)
- [Security overview](docs/security/overview.md) & [best practices](docs/security/best-practices.md)
- [Clawdbot/Claude skill runbook](docs/user/clawdbot-claude-skill.md)

## Development

```bash
npm run dev          # Development mode with watch
npm run dev:dashboard # Run core + web dashboard together
npm run dev:webapp   # Run only Next.js dashboard
npm run build        # Build TypeScript
npm run test         # Run test suite
npm run test:watch   # Run tests in watch mode
npm run typecheck    # TypeScript type checking
npm run typecheck:webapp # Dashboard type checking
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
```

## Testing

AgentVault has 1,500+ test cases across 88 test files covering:

- CLI commands (init, deploy, package, status)
- ICP client (connection, deployment, execution)
- Packaging (compiler, detector, packager)
- Integration tests

```bash
npm run test
```

## Known Limitations

| Feature | Status |
|---------|--------|
| Core flow (init → package → deploy → exec → fetch) | ✅ Working |
| Wallet crypto (real elliptic curves) | ✅ secp256k1 / ed25519 via `@noble/curves` |
| Wallet at-rest encryption | ✅ AES-256-GCM via `encryptWalletSecrets` |
| Backup atomic writes | ✅ write→fsync→rename via `atomicWriteFileSync` |
| Vault TLS CA cert | ✅ honoured via `undici.Agent` dispatcher |
| VetKeys threshold signatures | ⚠️ Simulated (real canister integration pending) |
| Bittensor inference | ⚠️ Requires API access |
| Arweave archival | ⚠️ Requires wallet setup |
| `trace` / `profile` CLI | ⚠️ Stub — Phase 3 not yet implemented |
| `stats` CLI historical analysis | ⚠️ Partial — current values only |

See [`SECURITY_AUDIT_AND_COMPLETION_PLAN.md`](./SECURITY_AUDIT_AND_COMPLETION_PLAN.md) for the current security posture and audit history.

### Wallet secrets

Mnemonics, private keys, and keystore passwords are **never** accepted as
CLI arguments (they would leak through `ps aux` and shell history). Use:

- `AGENTVAULT_MNEMONIC` env var for `wallet import`
- `AGENTVAULT_PRIVATE_KEY` env var for `wallet import`
- `AGENTVAULT_PASSWORD` env var or interactive `inquirer` prompt for
  `--keystore` decryption

## Contributing

Contributions are welcome! See the [contributing guide](docs/development/contributing.md)
for the full workflow. In short:

1. Fork the repository
2. Create a feature branch
3. Run tests and linting
4. Submit a pull request

## License

MIT License - see [LICENSE](./LICENSE).

## Resources

- **Website**: https://agentvault.cloud
- **Documentation**: https://agentvault.cloud/docs
- **npm**: https://www.npmjs.com/package/agentvault
- [Product Requirements Document](./docs/PRD.md)
- [Implementation Plan](./AI_DOCS/)
- [Changelog](./CHANGELOG.md)
- [ICP Documentation](https://internetcomputer.org/docs/)
</content>
