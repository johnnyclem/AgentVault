# AgentVault

Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous

## Overview

AgentVault is an open-source CLI and canister system that enables true autonomy for local AI agents. It solves the fundamental problem of agent state persistence and execution reliability by migrating from fragile local file storage to immutable, sovereign Internet Computer (ICP) canisters.

**Core value proposition:** Any user can fully rebuild and resume their agent on a clean OS install using only chain data and a seed phrase.

## Features

- **Real ICP Deployment** - Deploy agents to ICP canisters with @dfinity/agent SDK integration
- **Agent Packaging** - Compile local AI agents to WASM for on-chain deployment (esbuild bundling)
- **Canister Deployment** - Deploy agents to ICP canisters with persistent state
- **State Reconstruction** - Fetch, decrypt, and rebuild agents from chain data
- **Cross-Chain Support** - Native interoperability with Ethereum, Bitcoin, Solana via Chain Fusion
- **Security-First** - VetKeys threshold key derivation for encrypted secrets

## Supported Agents

- Clawdbot (Claude Code)
- Goose
- Cline
- Generic agents

## Requirements

- Node.js 18+
- dfx (Internet Computer SDK) - for canister development and deployment
- @dfinity/agent - for ICP canister interaction
- @dfinity/candid - for Candid interface generation
- Local dfx replica - `dfx start` for development environment
- Wallet/identity for signing canister operations (production)

## Installation

```bash
npm install -g agentvault
```

## Quick Start

```bash
# Initialize a new agent project
agentvault init

# Package an agent (bundles with esbuild, generates WASM)
agentvault package ./path/to/agent

# Deploy to ICP canister (uses @dfinity/agent)
agentvault deploy --network local dist/my-agent.wasm

# View canister status
agentvault show <canister-id>

# Fetch and rebuild agent from chain
agentvault fetch <canister-id>
agentvault decrypt <canister-id>
agentvault rebuild <canister-id>
```

### Development Workflow

```bash
# Start local dfx replica (required for local deployment)
dfx start

# Build canister locally (generates .did file)
dfx build

# Deploy to local development canister
agentvault deploy --network local

# Dry run deployment (no changes)
agentvault deploy --dry-run --network local dist/agent.wasm
```

## Documentation

See the [docs](./docs) directory for detailed documentation.

## Development Setup

### Prerequisites

1. **Install dfx**:
   ```bash
   DFX_VERSION=0.22.0 sh -ci <dfx-installer.install.sh> https://sdk.dfinity.org
   ```

2. **Start local replica**:
   ```bash
   dfx start --clean --background
   ```

3. **Verify environment**:
   ```bash
   dfx ping
   ```

### Project Structure

```
agentvault/
├── cli/              # Command-line interface
├── src/
│   ├── packaging/     # Agent detection, bundling, and compilation
│   ├── deployment/    # ICP client and deployment logic
│   └── security/       # Encryption and VetKeys integration
├── canister/         # Motoko canister code
├── tests/            # Test suite
├── dfx.json          # dfx configuration
└── dist/             # Build output (WASM files)
```

### Key Files

- **`src/deployment/icpClient.ts`** - Real ICP client with @dfinity/agent integration
- **`dfx.json`** - Canister configuration for dfx build tool
- **`canister/agent.mo`** - Motoko canister with stable memory support
- **`package.json`** - Includes @dfinity/agent and @dfinity/candid dependencies

### Known Limitations

- Local development uses fixed canister ID (`aaaaa-bbbbb-...`)
- Production deployment requires actual canister IDs from dfx
- Cycles calculated are estimates; real costs may vary
- Full canister lifecycle management requires additional dfx workflows

### Deployment Progress

**✅ Completed:**
- Real ICP client implementation
- @dfinity/agent integration
- dfx configuration
- Canister deployment pipeline

**🔄 In Progress:**
- Candid interface generation
- WASM execution in canisters
- Production canister management
- Identity and signing

**📋 Planned:**
- Agent-specific config parsers
- WasmEdge local runtime
- Comprehensive error handling
- VetKeys threshold encryption
- Cross-chain oracles

## License

MIT License - see [LICENSE](./LICENSE) for details.
