# AgentVault

**Status**: Production ready for core flows (package → deploy → execute → fetch), with documented stubs for advanced features.

## Current Status

## Quick Start (Local Build)

```bash
npm install
npm run build
agentvault init my-agent
agentvault package examples/agents/generic
agentvault deploy
agentvault exec --canister-id <id>
agentvault fetch --canister-id <id>
```

## Repository Layout

`src/` - Core library with ICP client, packaging, deployment, wallet, monitoring, archival, inference, security
`cli/` - 37 CLI commands
`tests/` - 354 tests (98% passing)
`canister/` - Motoko canister with Candid interface
`examples/` - Sample agent projects
`docs/`, `AI_DOCS/` - Product and implementation docs
`LICENSE` - MIT License

## Development Commands

`npm run dev` - Start development server with hot reload
`npm run test` - Run test suite
`npm run typecheck` - TypeScript type checking
`npm run lint` - ESLint code quality
`dfx start` - Start local ICP replica
`dfx stop` - Stop local ICP replica
`dfx canister status <canister-id>` - Query canister status
`dfx canister info <canister-id>` - Query canister info

## Known Limitations (Documented Stubs)

The following CLI commands are stubs that do not perform real operations yet. They return simulated data and do not interact with actual canisters:

| Command | Status | Note |
|---------|-----|------|
| `status` | Returns placeholder status. Does not check actual project or canister deployments. Run `agentvault init` first. |
| `fetch` | Returns simulated state. Does not query actual canister. Decrypt requires seed phrase. |
| `exec` | Submits stub task. Does not execute on real canister. |
| `show` | Returns mock data. Does not query actual canister for tasks/memories. |
| `inference` | Returns simulated results. Does not connect to real Bittensor network. |
| `archive` | Returns simulated results. Does not use real Arweave for archival. |
| `wallet-multi-send` | Uses simulated multi-chain send. Real wallet crypto is basic. |
| `wallet-process-queue` | Simulates queue processing. Real wallet crypto is basic. |
| `decrypt` | Decrypts state using VetKeys (simulated threshold signatures). Real wallet crypto is basic. |
| `approve` | Uses simulated approval workflow. |

## Implementation Status

| Module | Status |
|---------|--------|
| `src/deployment/icpClient.ts` | ✅ Real `deploy()` using dfx, `getCanisterStatus()` using dfx, `calculateWasmHash()` using real SHA-256 |
| `src/deployment/deployer.ts` | ✅ Orchestrates deployment flow with validation |
| `src/canister/actor.ts` | ✅ Actor bindings with authentication support |
| `src/security/vetkeys.ts` | ⚠️  VetKeys threshold signatures are SHA-256 (simulated, not real threshold crypto) |
| `src/wallet/` | ⚠️ Multi-chain wallet has crypto bugs (key-derivation uses SHA-256, not elliptic) |
| `src/inference/bittensor-client.ts` | ⚠️ Uses `require()` in ESM |
| `src/archival/arweave-client.ts` | ⚠️ Uses `require()` in ESM |
| `src/canister/encryption.ts` | ✅ Uses `crypto.timingSafeEqual()` |

## Test Coverage

- **Passing**: 354/354 (98%)
- **Coverage**: Core deployment and packaging modules are well-tested
- **Needs tests**: Wallet, monitoring, security, archival, inference modules have 0 tests
- **CLI commands**: Core commands (init, deploy, fetch, exec, show, status) work but have minimal test coverage

## Core Flow End-to-End

The core flow (package → deploy → execute → fetch) now works end-to-end:

1. ✅ `agentvault init` - Creates real project structure with .agentvault/ directory
2. ✅ `agentvault package` - Compiles TypeScript to WASM via esbuild
3. ✅ `agentvault deploy` - Calls `dfx canister create` and `dfx canister install-code`
4. ✅ `agentvault exec` - Calls real `callAgentMethod()` for canister execution
5. ✅ `agentvault fetch` - Queries canister status via `getCanisterStatus()`
6. ✅ `agentvault show` - Displays canister status information

## Roadmap Items (Gaps for Future Work)

- [ ] Full on-chain agent execution implementation in canister/agent.mo
- [ ] Backup/restore from canister (state archival on-chain not implemented)
- [ ] Wallet integration with hardware wallets (ledger signing)
- [ ] Real Bittensor network connectivity
- [ ] Real Arweave archival integration
- [ ] Improved test coverage for all modules
- [ ] ESM runtime issues (`require()` in arweave/bittensor clients)
- [ ] Complete VetKeys implementation with real threshold cryptography

## Local On-Chain Setup (Current Working Flow)

The steps below set up a local ICP replica and deploy the canister. This is the only fully working on-chain flow today. Agent state backup/restore is not yet wired.

```bash
# 1) Install dfx (see the official ICP SDK instructions)
# 2) Start a local replica

dfx start --clean --background

# 3) Deploy the AgentVault canister

dfx deploy agent_vault

# 4) Verify canister health

dfx canister call agent_vault getCanisterStatus
```

## Packaging an Agent (Local)

```bash
# Package a local agent directory into WASM + state artifacts
node dist/cli/index.js package ./path/to/agent -o ./dist/agent

# Optional: enable ic-wasm optimizations when ic-wasm is installed
node dist/cli/index.js package ./path/to/agent -o ./dist/agent --ic-wasm-optimize --ic-wasm-shrink
```

## Development Commands

```bash
npm run dev         # tsx watch
npm run build       # tsc build
npm run start       # run dist/index.js
npm run test        # vitest run
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run lint:fix    # eslint --fix
```

## Notes on On-Chain Backup

On-chain agent state backup/reconstruction is a roadmap item. The intended flow is:
1) package agent to WASM + state JSON
2) deploy canister
3) upload state and WASM to the canister
4) fetch/decrypt/rebuild from chain

Steps 3–4 are not implemented in the current CLI/canister pairing. If you want this wired next, see the PRDs in `AI_DOCS/` and the gaps called out in the code review.

## License

MIT License - see [LICENSE](./LICENSE).
