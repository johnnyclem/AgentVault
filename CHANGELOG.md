# CHANGELOG

All notable changes to AgentVault will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased] - HyperVault integration

### Added
- **HyperVault ⇄ AgentVault bridge (`src/hypervault/`, `agentvault hypervault`).**
  Makes the HyperVault cloud mind a first-class citizen across three tiers —
  hot (cloud), warm (ICP canister), cold (Arweave):
  - `HyperVaultClient` — typed REST client over undici with retry/backoff and
    streamed NDJSON export (`GET /api/export`), plus import and archive-receipt
    endpoints.
  - `agentvault-hypervault-snapshot-v1` bundle format — reuses the
    thoughtform-bundle envelope with per-entry SHA-256, a Merkle root, and an
    ed25519 manifest signature. Encryption via the audited `CanisterEncryption`
    (AES-256-GCM); private artifacts and conversations are always encrypted.
  - Local indices — pure-TS weighted FTS index and a cosine `VectorIndex` over
    exported embeddings, with reciprocal-rank hybrid recall and graceful
    FTS-only fallback.
  - Backbone/wiki adapters — `HyperVaultMemoryStore`, `HyperVaultKnowledgeStore`,
    `HyperVaultWikiStore` run the existing interfaces against the cloud mind.
  - On-chain mind mirror — topological, idempotent DAG replay onto a
    `memory_repo` canister, with on-chain archive receipts.
  - CLI: `hypervault connect · status · bootstrap · pull · push · snapshot ·
    archive · verify · restore · reindex · recall`; `init --hypervault`.
  - Native MCP server — `agentvault mcp serve` (stdio JSON-RPC, no new
    dependency) exposing the `hypervault_*` pipeline tools and the existing
    `wiki_*` tools.
  - New package export subpath `agentvault/hypervault`.
- **Polytician 3.0 contract tests.** `tests/fixtures/polytician-3.0/` holds
  Polytician 3.0.0's MCP contract recorded from the real server, the script
  that captures it, and a fake stdio server that checks every `tools/call`
  against the captured input schemas and answers with the recorded
  responses. The client, enricher, orchestrator prompt and
  `agentvault polytician` run against it; `tests/integration/polytician-real.test.ts`
  runs the same flows against a real server when `POLYTICIAN_ENTRY` is set.

### Changed
- **Polytician 3.0 (`polytician@^3`) is the Polytician AgentVault talks to.**
  3.0 rejects the 2.x calls AgentVault made, so the client, enricher, CLI and
  webapp routes now make 3.0's calls, and some results change shape:
  - `saveConceptFromOrchestration` returns the saved concept's id and throws
    on a Polytician error (it returned `null`). The concept is markdown tagged
    `orchestration` and `session:<id>`, titled with the task's first line (the
    title is what `search` and enrichment show, since 3.0 concepts have no
    name); 3.0 has no free-form metadata, so the session id, save time and
    file count are in the markdown.
  - `enrichWithPolyticianContext` throws on a Polytician error (an
    `MCPToolError` carrying its code), and keeps hits scoring at least
    `minRelevanceScore`, now 0.65 by default: 3.0 scores a hit
    (1 + cosine similarity) / 2, so the old 0.3 let every concept through.
    `conceptsUsed[].name` is the concept markdown's first heading outside a
    code fence, else its id. The result has a new `context` field: the
    concept blocks alone, without the task.
  - `OrchestrationResult` has `semanticMemory` (the concepts used, the saved
    concept's id, and an enrichment or save error) when a Polytician server
    is given, and a dry run's result has `prompt` (`system` and `user`).
    `agentvault orchestrate` prints both: enrichment and save failures, and the
    dry-run prompt, used to go only to the spinner, which hid them.
  - `agentvault polytician search --json` prints 3.0's `results` array (`id`,
    `namespace`, `score`, `tags`, `representations`, `assertionStatus`;
    there is no `name`), `[]` when nothing matches, and `-l` is clamped to
    1-100. `push-all` exits 1 when any push fails.
  - The webapp `/api/polytician/[agentId]/*` routes return 3.0's results:
    search `{ results }`, list `{ concepts, total }` (`?limit=` 1-100), the
    stored concept for read and save (a save takes `{ markdown, tags? }`),
    `{ deleted }`, the archive receipt `{ archived, encrypted, txId, url, size }`,
    and stats `{ health: { status, version, embedding, llm }, stats }`.
    Polytician error codes map to HTTP statuses (404 `NOT_FOUND`, 400
    `VALIDATION_ERROR`, 502 `UPSTREAM_ERROR`, 504 `OUTCOME_UNKNOWN`, ...).
    Any other failure (the server would not start, exited or timed out) is
    logged on the server and answered with a generic 502
    `POLYTICIAN_UNAVAILABLE` or 504 `POLYTICIAN_TIMEOUT`, since the message
    can carry Polytician's stderr. A body that is not JSON is a 400. Auth is
    unchanged.
  - `push-all`, `pull` and `archive` (and the webapp archive route) need
    configuration on Polytician's side: Polytician registers its `vault_*`
    tools only when `POLYTICIAN_AV_API_URL` and `POLYTICIAN_AV_API_TOKEN` are
    set, and `vault_archive_concept` only with `agentVault.archival` enabled.
    `push-all` still cannot complete against AgentVault's own HTTP API: the
    memory_repo commit and tombstone routes call the canister with the
    anonymous principal, and the canister refuses anonymous writes.
  - The `vault_*` calls wait longer than Polytician's own AgentVault requests
    (archive 150 s, push 60 s, pull 150 s; other tools 30 s), so Polytician
    answers first. An archive or push that still gets no answer is reported
    as `OUTCOME_UNKNOWN` (`... outcome unknown: ...`), not as a failure: the
    commit or the paid Arweave upload may have happened.

### Fixed
- **Polytician enrichment and concept saving were silently empty against
  Polytician 3.0.** Search sent `limit`/`min_score` and saves sent
  `name`/`content`/`representation`/`metadata`, which 3.0 rejects; the client
  read `content[0].data`, which 3.0 never sends, and took tool errors for
  results. It now sends `search_concepts { query, k }`,
  `read_concept { id, representations: ["markdown"] }` and
  `save_concept { markdown, tags }`, and reads `structuredContent`, checked
  against zod schemas that mirror 3.0's `outputSchema`
  (`src/orchestration/polytician-tools.ts`).
- **Polytician context now reaches Claude.** `orchestrate()` built the real
  prompt from the plain task, so the context reached only the dry-run
  progress callback. Both the API and the local `claude` CLI path now get it,
  in the user message inside a `<semantic_memory>` block labelled as
  reference data, not instructions. It is kept out of the system prompt:
  concepts hold earlier sessions' output and pulled content. Headings inside
  a concept are pushed three levels down (Setext ones too) so they cannot
  read as the prompt's own sections; code fences are left alone, and a
  preview cut inside a fence closes it.
- **`PolyticianMCPClient`** sends `notifications/initialized` after
  `initialize`, requests protocol `2025-06-18` and refuses an answer it does
  not support, and keeps the server's name and version (`getServerInfo()`).
  It clears its request timers (`agentvault polytician status` waited about
  30 s before exiting), fails pending requests as soon as the server exits,
  with its exit code and stderr, instead of after a 30 s timeout, rejects an
  entry point that cannot be started instead of throwing an unhandled error,
  answers a server `ping` instead of taking it for a response, and closes the
  server's stdin on disconnect. New `callToolResult()` / `parseToolResult()`
  return a tool's result and throw `MCPToolError`, with Polytician's error
  `code`, for an `isError` result.
- **`PolyticianMCPClient` corrupted non-ASCII text in large results.** It
  decoded each stdout read on its own, so a character split across two
  64 KiB pipe reads became U+FFFD (CJK, emoji, em dashes and curly quotes in
  concepts over about 64 KB). stdout and stderr are now decoded as streams.
  A second `connect()` during the handshake started a second server that was
  never stopped; it now waits for the first. Calls take a timeout
  (`callTool(name, args, { timeoutMs })`) and a timeout rejects with
  `MCPTimeoutError`.
- **`GET /api/memory-repo/branches/:branch` returned only the newest commit's
  entries**, so Polytician's `vault_memory_pull` imported one concept after a
  `push-all` of many (one commit per concept), and nothing after a tombstone.
  The route now replays every commit on the branch (newer entries win,
  tombstones remove a key; `src/canister/memory-repo-branch-state.ts`). It
  also no longer calls `switchBranch`, an update call that the canister
  refuses from the route's anonymous principal and that moved the canister's
  current branch on a read; it uses the `getBranches` and `log` queries.
- **`agentvault polytician`:** `status` printed empty sections and now shows
  the server, version, embedding model, LLM provider, concept and vector
  counts and whether the `vault_*` tools are available; `search` prints ids,
  scores, titles and tags; `push-all`, `pull` and `archive` call
  `vault_memory_push` (for each concept), `vault_memory_pull` and
  `vault_archive_concept` instead of tools 3.0 does not have, and say which
  Polytician settings are missing when those tools are. Errors print
  Polytician's code, e.g. `vault_archive_concept failed (UPSTREAM_ERROR): fetch failed`.
- **`agentvault mcp call`** reports a tool's `isError` result as a failure
  (exit 1) instead of "executed".
- **`agentvault polytician search`** no longer fails when a hit is deleted
  before its title is read; that hit is listed without a title.
- **`agentvault orchestrate --no-semantic-enrichment` and `--no-save-concept`
  had no effect:** the command read option names Commander never sets.

### Security
- **C-1 (CRITICAL):** `vetkeys.decryptJSON` now validates the AES-256-GCM /
  ChaCha20-Poly1305 authentication tag before returning plaintext (previously
  `setAuthTag` was never called, so tampered ciphertext decrypted silently).
  `EncryptedData` gains an optional `tag` field, a matching `encryptJSON` helper
  is added, and payloads with no usable tag are refused rather than decrypted
  unauthenticated. Legacy combined-layout payloads (tag appended to ciphertext)
  are still supported.

## [1.0.4] - 2026-05-24 - Security & build hygiene refresh

### Security
- **SEC-2 (HIGH):** Vault client now actually validates TLS against the
  configured `caCertPath`. An `undici.Agent` is attached as the fetch
  dispatcher with `ca` (and optional `rejectUnauthorized`) on every
  request from `VaultClient`. Previously the cert was loaded and ignored.
- **SEC-5 (HIGH):** Removed `--mnemonic`, `--private-key`, and
  `--password` CLI options from `agentvault wallet`. Secrets are now read
  from `AGENTVAULT_MNEMONIC`, `AGENTVAULT_PRIVATE_KEY`, and
  `AGENTVAULT_PASSWORD` env vars, or via an interactive `inquirer`
  password prompt for keystore decryption in TTY contexts. CLI args are
  visible in `ps aux` and shell history and should never carry secrets.
- **SEC-6 (MED):** Vault key-pattern matching escapes regex
  metacharacters before expanding `*` and `?` globs. Removes ReDoS
  exposure and stops `.` / `+` / `(` etc. in user patterns from
  triggering unintended regex matches.
- **SEC-10 (MED):** `encryptShare()` in both VetKeys clients now
  generates an independent random salt for PBKDF2 instead of reusing the
  IV. Share blob layout is now `salt(16) || iv(12 or 16) || ciphertext`.
  Also fixed an algorithm-name bug (`aes-256-gcm` was being mangled to
  `aes256-gcm` by `String.replace('-','')`).
- **SEC-12 (MED):** New `sanitizePathPart()` rejects `..`, separators,
  NUL, and out-of-alphabet input on every agent-id / wallet-id path
  segment used by `wallet-storage.ts`.
- **SEC-15 (MED):** `DEFAULT_WASMEDGE_OPTIONS.debug` and `.sourcemap`
  now default to `false`. Shipped WASM no longer leaks debug symbols
  unless `--debug` is explicitly passed.
- **SEC-17 (MED):** New `atomicWriteFileSync()` (write→fsync→rename)
  is used for backup envelopes, the ed25519 signing-key file, and wallet
  files. A crash mid-write can no longer corrupt these artefacts.

### Changed
- CLI: `agentvault wallet multi-send` and `agentvault wallet
  process-queue` are now wired up (handlers previously existed but were
  not reachable from the dispatcher).
- CLI help: `trace` and `profile` are labelled `[Stub]` (Phase 3 not
  implemented / mock data) and `stats` is labelled `[Partial]` (current
  values only; historical analysis pending).
- Tests: `tests/cli/commands/wallet.test.ts` exercises the env-var
  import flow instead of the now-removed CLI options.

### Added
- `src/utils/path-validation.ts` — `sanitizePathPart`, `sanitizePathParts`,
  `atomicWriteFileSync`.
- `tests/unit/path-validation.test.ts` — 15 cases for the new utilities.
- `tests/vault/glob-pattern.test.ts` — 4 cases verifying SEC-6 behaviour.

### Dependencies
- Added `undici` (^7.25.0) as a direct dep for the TLS dispatcher.
- Added `overrides` block pinning `brace-expansion`, `uuid`, `ws`, and
  `postcss` to vulnerability-free ranges without forcing breaking
  upgrades of `@solana/web3.js` or `ethers`.
- `npm audit` now reports **0 vulnerabilities** (was 8 moderate).

### Build
- TypeScript: 0 errors (was 24, all in tests/`wiki.test.ts` non-null
  narrowing and `cli/commands/wiki.ts` unused import).
- ESLint: 0 errors (was 13, mostly `Function`-typed callback params and
  a stray `require()`).
- Removed `pnpm-lock.yaml`; `package-lock.json` is authoritative.

### Documentation
- `SECURITY_AUDIT_AND_COMPLETION_PLAN.md` rewritten as a living document
  with per-finding status (FIXED / OPEN) and links to the resolving
  commits.
- `README.md` Known Limitations table updated to reflect that wallet
  encryption is now real.

## [1.0.0] - 2025-02-12 - v1.0.0 Final Release

### Added
- Complete core flow: init → package → deploy → exec → show → fetch
- Real ICP canister deployment via dfx integration
- Multi-chain wallet support (ICP, Ethereum, Polkadot, Solana)
- VetKeys threshold key derivation for secure secrets
- AES-256-GCM encryption with timing-safe HMAC verification
- Comprehensive CLI with 36 commands
- Next.js web dashboard with 8 pages
- Monitoring system with health checks and alerts
- Arweave archival integration
- Bittensor inference integration
- Environment variable configuration for all RPC endpoints
- Cryptographically secure random generation for share IDs
- `backup export --canister-id` option to include live canister state (tasks, memory, context)
- `promote --wasm-path` option for actual canister deployment during promotion

### Changed
- ICP client now uses real dfx commands for deployment
- WASM hash calculation uses proper SHA-256
- VetKeys IV generation uses crypto.randomBytes
- Memory thresholds now correctly use 4GB max canister limit
- Cycle parsing uses correct multipliers (T=10^12, G=10^9, M=10^6, K=10^3)
- Encryption uses timing-safe comparison to prevent timing attacks

### Fixed
- Math.random() replaced with crypto.randomBytes in vetkeys.ts
- All hardcoded localhost URLs now use environment variables
- ESM compatibility for arweave and bittensor clients
- Principal validation regex accepts valid ICP formats
- Webapp components now use real API hooks instead of mock data

### Security
- Timing-safe HMAC verification in encryption.ts
- Secure IV generation in vetkeys.ts
- Environment variable configuration for sensitive endpoints
- Threshold signatures properly validate canister connection

### Experimental Features
The following commands are marked [Experimental] and under active development:
- `inference` - Bittensor network integration
- `archive` - Arweave archival
- `approve` - Multi-signature workflows
- `profile` - Canister profiling
- `trace` - Execution traces
- `wallet-multi-send` - Multi-chain transactions
- `wallet-process-queue` - Transaction queue processing

## [1.0.0] - 2025-02-10 - Phase 5: Production Release

> **Note:** this file carries two `[1.0.0]` headings with different dates — the
> 2025-02-12 "Final Release" entry above and this 2025-02-10 "Phase 5" one,
> which sits above the `1.0.0-rc.*` entries. The duplication came from a merge
> and the two sets of notes have never been reconciled. Both are kept verbatim
> rather than guessing which shipped; treat the 2025-02-12 entry as describing
> the released 1.0.0.

### Added
- Production-ready AI agent platform for Internet Computer
- Complete web dashboard with agent management
- Multi-chain wallet support (ICP, Polkadot, Solana)
- Batched canister deployment operations
- Arweave archival for permanent storage
- Bittensor inference integration
- Multi-sig approval workflows
- Automated backup and restore
- Real-time monitoring and metrics
- Comprehensive CLI with 36 commands
- TypeScript/ESLint configuration
- CI/CD pipeline with GitHub Actions

### Changed
- Upgraded from development to production-ready state
- Added comprehensive documentation for users and developers
- Configured production deployment settings
- Established automated testing and release process

### Fixed
- Pre-existing test errors resolved
- CI/CD workflows configured
- Package configuration for npm publishing
- Production dfx.json and icp.yaml created

### Removed
- Pre-existing test file with errors removed
- Stale backup file cleaned up

---

## [1.0.0-rc.1] - 2025-02-09 - Phase 5: Documentation

### Added
- User guide: Getting started, deployment, wallets, backups
- Developer guide: Architecture, extending agents, canister development
- Troubleshooting guide with comprehensive solutions
- Web dashboard guide

---

## [1.0.0-rc.2] - 2025-02-08 - Phase 5: Testing & CI/CD

### Added
- GitHub Actions workflows: test, test-webapp, release
- Automated testing on every push/PR
- Coverage reporting with Codecov
- Automated npm publishing

---

## [1.0.0-rc.3] - 2025-02-07 - Phase 5: Package Config

### Added
- Package files configuration
- npm keywords for searchability
- Repository, bugs, homepage fields
- Engine strictness (Node.js 18+)
- License specification

---

## [0.4.1] - 2025-02-06 - Phase 4: Webapp & Backend

### Added
- Next.js 15 + React 19 web dashboard
- 8 dashboard pages (canisters, agents, tasks, logs, wallets, networks, backups, settings)
- 18 API routes
- 21 UI components (agents, tasks, logs, wallets, common)
- 6 custom hooks for data fetching
- 2 context providers (theme, ICP)
- 4 utility modules (types, api-client, utils, icp-connection)

---

## [0.4.0] - 2025-02-05 - Phase 4: Archival & Inference

### Added
- Arweave client for permanent storage
- Archive manager for local backup management
- Bittensor client for AI inference
- CLI commands: archive, inference, approve

---

## [0.3.0] - 2025-02-04 - Phase 4: Wallet & Multi-sig

### Added
- Multi-chain wallet system
- Hardware wallet support
- Transaction queue and history
- Multi-signature approval workflows
- CLI commands: wallet-export, wallet-import, wallet-history, wallet-sign, wallet-multi-send, wallet-process-queue

---

## [0.2.0] - 2025-02-03 - Phase 4: Testing & Monitoring

### Added
- Vitest testing framework
- Coverage reporting
- Monitoring system with health checks and alerts
- CLI commands: monitor, health, info, instrument

---

## [0.1.0] - 2025-02-02 - Phase 4: Metrics & Backup

### Added
- Metrics collection and aggregation
- Backup system with local and Arweave
- CLI commands: backup, status, show

---

## [0.0.1] - 2025-02-01 - Phase 3: Deployment

### Added
- Batched canister operations
- Topological sort for dependencies
- CLI commands: deploy, promote, rebuild, rollback

---

## [0.0.0] - 2025-01-25 - Initial Release

### Added
- Initial agent packaging system
- Basic deployment capabilities
- Wallet integration stubs
- Monitoring and metrics foundation
- Documentation structure

---
