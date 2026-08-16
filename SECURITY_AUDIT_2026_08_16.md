# AgentVault — Code Review & Security Audit

**Date:** August 16, 2026
**Scope:** Full repository — `src/` (186 files, ~46.6k LOC), `cli/` (51 commands), `canister/` (2 Motoko canisters), `webapp/` (Next.js, 50 API routes), `site/`, CI, dependencies
**Branch:** `claude/code-review-security-audit-inbq82`

---

## Executive summary

This audit found **five critical issues that no previous audit reported**, including two that meant core subsystems could never have worked as documented:

- The flagship canister, `canister/agent.mo`, **has never compiled** — it has no `actor` declaration and a broken block comment.
- The webapp **has never built** — ten type errors plus a bundler-level `SyntaxError`.
- VetKeys bundle encryption derived its key **solely from a public identifier stored inside the encrypted file**, providing no confidentiality at all.
- "Shamir's Secret Sharing" **embedded the full master mnemonic in every share**.
- The canister's mirror-replication surface had **no access control whatsoever** — any principal, including anonymous, could overwrite an agent's entire state.

All five are fixed, along with a data-loss bug that made every encrypted wallet backup permanently undecryptable. Both packages now report **0 dependency vulnerabilities**, down from 5 high (root) and 3 high (webapp).

### Status

| Check | Before | After |
|---|---|---|
| Root tests | 1,554 pass | 1,599 pass (+45) |
| Root typecheck | ✅ 0 errors | ✅ 0 errors |
| Root lint | 0 errors, 217 warnings | 0 errors, 215 warnings |
| Root `npm audit` | 5 high | ✅ 0 |
| **Webapp typecheck** | ❌ 10 errors | ✅ 0 errors |
| **Webapp build** | ❌ fails | ✅ succeeds |
| Webapp `npm audit` | 3 high | ✅ 0 |
| **`canister/agent.mo` parse** | ❌ 144 errors | ✅ 0 errors |
| Test coverage reporting | ❌ never generated | ✅ 36.98% statements |

---

## Architecture overview

AgentVault is **CLI-first**. `src/index.ts` exports only `VERSION` and `createConfig`; `package.json#exports` maps just `.`, `./vault`, `./backbone`, `./hypervault`. Packaging, deployment, wallet, security, icp and orchestration are unreachable to package consumers — the CLI, not the library API, is the real integration surface.

**Dependency shape.** `icp` and `backbone` are the hubs (11 inbound each). One cycle exists: `icp/index.ts` ⇄ `monitoring/info.ts`. Largest subsystems: `wallet` (23 files, 7.2k LOC), `packaging` (20 files, 5.5k), `hypervault` (15 files, 4.0k, including `pipeline.ts` at 993 lines — the largest file in the repo).

**Critical paths.** `init → package → deploy → exec` (ICP); multi-chain wallet key management; VetKeys encryption; HyperVault sync; canister state persistence.

---

## Critical findings (fixed)

### C-1 — `canister/agent.mo` did not compile
**Commit `fab4085`**

Two independent defects, both from a bad merge:

1. A `/**` opening a module doc comment was replaced by `// ==================== Types ====================`, leaving ~20 orphaned ` * ` continuation lines the parser read as operators. A duplicate partial import block sat above it. (The file had 48 `/**` openers against 49 `*/` closers.)
2. **The file had no `actor` declaration at all.** Every `public` member sat at module scope. `memory-repo.mo` declares `actor MemoryRepo` correctly; `agent.mo` never did.

Verified with the Motoko compiler: **144 parse errors → 0**, matching `memory-repo.mo`.

This corroborates two other findings — `src/canister/actor.idl.ts` declares ~30 methods absent from `agent.mo`, and `src/deployment/icpClient.ts:515` silently falls back to `getStubResponse()` synthetic success on error. The ICP deploy path has evidently never been exercised against a real build of this canister.

> ⚠️ **Semantic typechecking against `mo:base` could not be run** — the base package is unreachable under this environment's network policy. The type-level changes still require a `dfx build` before release.

### C-2 — Mirror-sync had no access control
**Commit `fab4085`**

`setMirrorCanister`, `clearMirrorCanister`, `syncToMirror`, `syncFromMirror`, `receiveSync` and `exportSyncState` were declared `public shared func` **without binding the caller**. `receiveSync` unconditionally executed:

```motoko
memories := inMemories; tasks := inTasks;
context := inCtx; agentConfig := inConfig;
```

Any principal — including anonymous — could replace an agent's entire state, bypassing both the kill switch and frozen mode. `syncToMirror` was an unauthenticated cycle-drain primitive (forced inter-canister calls to a caller-chosen target). `exportSyncState` returned every memory, task and context entry to any caller. `expireStaleConsensusProposals` was likewise open, letting anyone cancel pending consensus rounds.

The doc comment on `receiveSync` read *"Only the primary's controller should call it"* — nothing enforced it.

**Fixed** with an `isSyncPeer` check (primary and mirror deploy the same WASM and register each other, so the check is symmetric) plus `assertSyncAllowed`. Config changes are owner-only; state-mutating syncs require `assertWriteAllowed`. The heartbeat now calls a private `expireStaleProposalsInternal`, so the public entry point can be guarded.

Compounding this: **`agent.did` omits 27 of the canister's public methods**, including the entire mirror surface — so an auditor reading the interface would never see this attack surface.

### C-3 — VetKeys bundle encryption provided no confidentiality
**Commit `f32e445`**

`deriveBundleKey` derived the AES-256-GCM key from the ICP principal ID and a salt — **both written into the bundle header**. `decryptBundle` read the principal back out and re-derived the key with no secret input. Anyone holding a bundle could decrypt it; the 210,000 PBKDF2 iterations stretched nothing. The optional `principalId` argument was an equality check, not key material.

Reachable through `src/packaging/serializer.ts:199`. **The test suite asserted the broken behaviour** (`decryptBundle(encrypted)` succeeding with no secret).

**Fixed** with a v2 wire format (magic `VKE2`) keyed on a caller-supplied secret (falling back to `AGENTVAULT_BUNDLE_SECRET`), with the principal and a random per-bundle salt bound in as KDF context. Both encrypt and decrypt now fail loudly when no secret is available. Legacy v1 bundles remain decryptable so existing data can be recovered and re-encrypted, emitting a warning on every read; v1 is never produced again.

### C-4 — "Shamir's Secret Sharing" was not secret sharing
**Commit `3524d61`**

`generateParticipantSecret` built each share as `indexByte || fullMnemonic`, hex-encoded. **One share disclosed the master seed phrase in full.** Supporting defects:

- the share was encrypted under a key derived (via PBKDF2) from the very plaintext it encrypted — making the ciphertext a confirmation oracle for a guessed mnemonic;
- the loop emitted `threshold` shares instead of `totalParties`, so `n` participants could never all be provisioned;
- `masterCommitment` was computed over the still-empty shares array — always the SHA-256 of nothing.

A near-identical duplicate lived in `src/security/types.ts`. **No reconstruction path existed anywhere in the codebase** — shares were write-only artifacts that leaked the mnemonic.

**Fixed** with `src/security/shamir.ts`, a real GF(2⁸) implementation (AES polynomial, generator 3): byte-wise splitting over random degree-(t−1) polynomials, Lagrange interpolation at x=0 for reconstruction, with the leading coefficient resampled when zero so the threshold cannot silently drop for a byte. Both copies now use it.

Tests verify reconstruction from **every** t-of-n subset (all 20 of C(6,3)), non-recovery from every t−1 subset, and absence of the secret from any individual share.

### C-5 — Webapp API was 48% unauthenticated
**Commit `6ce4a4d`**

24 of 50 routes performed no authentication — each route opted *in* by calling `validateAuthToken` itself, and only the 26 `polytician/*` routes did. No `middleware.ts` existed. The gap included:

| Route | Exposure |
|---|---|
| `POST /api/deployments` | Took `sourcePath` + `projectRoot` from the body, ran `packageAgent` + `deployAgent` → shells out to `dfx` |
| `POST /api/backups/import` | Arbitrary local file read; restore writes into `~/.agentvault` |
| `POST /api/backups/export` | Arbitrary local file write |
| `GET /api/wallets`, `/api/agents` | Listed wallet and agent state |

**Fixed** with fail-closed `webapp/src/middleware.ts` covering `/api/:path*`, so a new route cannot be forgotten into being public. Token comparison replaced with a constant-time variant (the previous `!==` leaked a prefix-matching oracle), implemented in plain JS because the middleware runs on the Edge runtime where `node:crypto` is unavailable. Backup paths are confined to a backup root; deploy `network` is validated against `dfx.json`.

Verified end to end against a running server: `/api/agents` returns **401** with no token, **401** with a wrong token, **200** with the configured token.

> ⚠️ **Breaking:** clients must now send `Authorization: Bearer <token>`, and `AGENTVAULT_POLYTICIAN_API_TOKEN` must be set for the API to serve any request.

---

## High findings (fixed)

### H-1 — Archive extraction allowed zip-slip and symlink escape
**Commit `bf73ebd`**

`restoreFromEncryptedZip` ran `unzip -o` then `cpSync(stateDir, AGENTVAULT_DIR, { force: true })`. `unzip` restores symlinks and stored paths verbatim, so a crafted backup could place files — or a symlink pointing anywhere — outside the extraction directory. Reachable unauthenticated via C-5.

**Demonstrated, not theorised:** with the guards removed, the test archive planted `~/.agentvault/stolen -> <external path>` in the real home directory before failing later on an unrelated check.

**Fixed** by validating entry names before extraction (rejecting absolute paths and `..` components) and scanning the extracted tree for symlinks before the copy — entry-name validation alone is insufficient, since a symlink can have a benign name and an escaping target.

### H-2 — Every encrypted wallet backup was permanently undecryptable
**Commit `01a1ab4`**

```ts
data = JSON.stringify(backup, null, 2);
data = JSON.stringify({ encrypted });   // ← drops iv + salt
```

Only the ciphertext reached disk; the PBKDF2 salt and GCM IV needed to derive the key were discarded. **Silent, total data loss** for anyone relying on `wallet export --format encrypted`.

The file was also written `0o644` while the command itself warned it contains private keys, and returned exit code 0 on failure.

**Fixed** — emits the envelope `wallet-import` actually reads, writes `0o600`, exits non-zero on error. The pre-existing tests reimplemented the crypto inline and never called the handler (one asserted `expect(algorithm).toBe('aes-256-gcm')`); replaced with a real round trip through `handleExport`.

### H-3 — Webapp did not build
**Commit `279e2f8`**

CI runs `npm run build` and `npm run typecheck` for the webapp on every push touching `webapp/**` or `src/**`, so this has been failing on `main`. Three blockers: ten type errors (mostly `const hasCanister = entry.canister`, which does not narrow for TypeScript); an SWC minifier bug folding `` `proving${'\0'}` `` in `@polkadot/util-crypto` into an illegal octal escape; and a `SharedArrayBuffer` incompatibility in `src/packaging/state-format.ts` that only surfaces under the webapp's DOM lib.

### H-4 — Checksum fallback forged a SHA-256-shaped value
**Commit `279e2f8`**

`calculateChecksum`'s last-resort branch computed a 32-bit non-cryptographic hash and zero-padded it to 64 hex characters — indistinguishable from a real SHA-256 digest while carrying ~32 bits of entropy, for a function used in **integrity verification**. Now throws instead.

---

## Medium findings (fixed)

| ID | Finding | Commit |
|---|---|---|
| M-1 | `cycles mint`, `cycles transfer`, `tokens transfer` read positional Commander arguments off the options object — always passed `undefined` ("Minting undefined cycles...") | `01a1ab4` |
| M-2 | A literal NUL byte in `hypervault/pipeline.ts:241` made the repo's largest source file classify as binary, hiding ~1,000 lines from grep/ripgrep | `01a1ab4` |
| M-3 | `npm test` rewrote the committed fixture `backups/test-backup.json` on every run, leaving the tree dirty | `cf0ebd5` |
| M-4 | `package-lock.json` was gitignored while tracked and required by CI's `npm ci` — one `git rm --cached` from breaking release | `cf0ebd5` |
| M-5 | Codecov upload was a silent no-op: `npm test` never passed `--coverage`, and the configured provider was not installed | `7e62aee` |
| M-6 | `deriveThresholdKey` in `types.ts` still returned the raw `seedPhrase` (SEC-3 was fixed only in the `vetkeys.ts` sibling) | `3524d61` |

---

## Dependency summary

**Root:** 5 high-severity advisories → **0**. `undici` 7.28.0 → 7.29.0 (five advisories: response desynchronization, cross-user cache disclosure, CRLF injection, cookie attribute injection); `postcss`, `brace-expansion`, `js-yaml`, `nanoid` resolved transitively. No `package.json` ranges needed to change. All in-range direct dependencies brought current.

**Webapp:** 3 high-severity advisories → **0**, via Next 15 → 16 (`postcss` XSS and three sourceMappingURL path-traversal issues; `sharp`'s four inherited libvips CVEs).

### Next 16 migration notes

- The `eslint` key was removed from `NextConfig` along with `next lint`; the `lint` script now calls eslint directly.
- Next 16 enables Turbopack by default and errors when a custom `webpack` config is present. This project needs one — the shared `../src` tree uses NodeNext `.js` specifiers, which webpack resolves only via `resolve.extensionAlias`. `dev` and `build` are pinned to `--webpack`.
- `@polkadot/*` added to `serverExternalPackages` (see H-3).
- Next regenerated `tsconfig.json` and `next-env.d.ts` (including `jsx: react-jsx`).

Because the webapp has no test suite, the upgrade was validated by running it: production server start, dashboard render (`/` → `/canisters`, correct title), and the full auth matrix.

**Deferred majors** (no known advisory against the pinned versions): chalk 6, commander 15, eslint 10, execa 10, inquirer 14, ora 9, typescript 7, undici 8, `@noble/curves` 2, `@types/node` 26.

---

## Remaining technical debt

Ordered by leverage. None of these are fixed; all are recommendations.

### 1. Shipped stubs on advertised paths
- `src/packaging/wasm-compiler.ts` — Motoko, Rust and AssemblyScript compilation are **all stubs** emitting a synthetic binary tagged `agentvault-stub`, with `;; TODO:` markers written into generated WAT.
- `src/deployment/icpClient.ts:515` — silent stub-mode fallback returns synthetic success on network/actor errors. **This should be gated behind an explicit `--allow-stub`**; it is the single most misleading behaviour left in the codebase, and it is why C-1 could go unnoticed.
- `src/wallet/vetkeys-adapter.ts` — header states "Mock VetKeys canister integration".
- `deployment.generateStubCanisterId` is exported as public API and consumed by `src/mint/google-adk.ts` for real minting.

### 2. `src/canister/actor.idl.ts` describes a canister that does not exist
~30 declared methods (`addMemory`, `getMemories`, `execute`, `agent_step`, …) have no counterpart in `agent.mo`. Every CLI path calling them fails at runtime. Consequently `memories` and `tasks` have **no authenticated write API** — before C-2 was fixed, the only way to populate them was the unauthenticated mirror path. Reconciling the IDL, `agent.did` and `agent.mo` is the highest-value correctness work remaining.

### 3. Canister robustness (`agent.mo`)
- **Self-bricking heartbeat**: the Binance health-check outcall passes `transform = null`. Per-request response headers (`Date`, `x-mbx-uuid`, `x-mbx-used-weight`) break replica consensus, so the call fails, and three failures trip `canisterKilled`. A live-agent kill switch driven by a centralized exchange endpoint is a questionable dependency regardless.
- **Unbounded growth**: unlike `memory-repo.mo`, no per-collection maximum. All collections grow via `Array.append` (O(n²) overall). Once heap crosses 64 MB, `assertMemoryLimit` traps *every* write including ones that would shrink state — a permanent brick with no way to prune `mfaAuditLog`, `consensusProposals` or `thoughtForms`.
- **ID collisions**: transaction and proposal IDs derive from `Time.now()` + current array size, which goes backwards after pruning. `memory-repo.mo` got this right with a monotonic counter.
- Reads are unauthenticated across both canisters — `getEncryptedSecret`, `listEncryptedSecrets`, `getMfaAuditLogAll`, and `memory-repo`'s entire commit history are world-readable to anyone with the canister ID.

### 4. Cryptographic sprawl
AES-256-GCM is reimplemented in **11 separate files** with independently chosen KDF parameters — 210,000 PBKDF2 iterations in `wallet-crypto`/`backup`/`snapshot`, but 100,000 in `security/vetkeys`, `security/types` and `canister/encryption`. Nothing uses a memory-hard KDF despite `scrypt` being declared a supported method. A shared crypto primitive module is the highest-leverage refactor available.

Related, still open:
- `src/wallet/wallet-crypto.ts` — wallet at-rest encryption is **circular**: `encryptWalletSecrets(wallet, mnemonic)` derives the key from the mnemonic and then encrypts the mnemonic under it. There is no independent user passphrase anywhere in the chain.
- `src/canister/encryption.ts` — hardcoded global PBKDF2 salt (`'agentvault-canister-encryption'`), so identical seeds produce identical keys across every agent; and the decryption cipher is selected from a field inside the untrusted ciphertext container.
- `src/security/totp.ts` — verification uses `===` on a secret-derived value and has no replay burn.

### 5. Mandated helpers are largely unadopted
`AGENTS.md` requires `sanitizePathPart()` for user-supplied path components and `atomicWriteFileSync()` for crash-sensitive writes. `sanitizePathPart` is used in **2 of 186 files**; 30 files still use raw `writeFileSync`, including `security/mfa-approval.ts`, `security/webauthn.ts`, `security/icp-audit.ts` and `trading/api-key-manager.ts` — i.e. nonce replay-protection state and exchange credentials.

### 6. Duplicated subsystems
Three overlapping inference orchestrators (`fallback-chain`, `secure-inference`, `inference-manager`) all exported with no guidance on which to use; two Venice clients in one file; two WASM compilers; two Google ADK minters (`orchestration/google-adk.ts` and `mint/google-adk.ts`); two Arweave archive designs with colliding `ArchiveResult` types.

### 7. Testing
Real coverage is **36.98% of statements** despite 1,599 tests. Coverage is inverted relative to risk: no direct tests for `orchestration` (3.9k LOC including the Claude/ADK orchestrators), `backbone` (a published entry point), `fault-tolerance`, `metrics`, `network`, `pilot`, or `testing`. `webapp/` and `site/` have none.

A meaningful block of the suite asserts on **source text** rather than behaviour — `tests/cli.test.ts` (46 `readFileSync` calls, asserting things like `expect(content).toContain(".name('agentvault')")`), `tests/project-files.test.ts`, `tests/typescript-setup.test.ts`. Commit `0eef00f` ("Fix README test: restore literal `# AgentVault` heading") is a documented case of a test dictating prose. These pass whether or not the CLI works — as C-1 and H-3 demonstrate.

### 8. Smaller items
- `~/.agentvault` is hardcoded in 12 files with no single config-root resolver, so the storage layout cannot be relocated or tested in isolation.
- ~50 empty catch blocks; three consecutive ones in `backup/backup.ts:287-305` silently produce incomplete backups.
- `src/orchestration/claude.ts:379` and `google-adk.ts:106` use `execaCommand` with interpolated strings (shell-string parsing); `mcp-client.ts:51` spawns a config-supplied command with no allowlist.
- `docker-compose.yml` publishes a dev-mode Vault with a committed root token on `0.0.0.0:8200`.
- `src/wallet/wallet-storage.ts:86` creates agent directories without `mode: 0o700` (files are correctly `0o600`).
- `monitoring/alerting.ts` uses `process.env.HOME || process.cwd()`, silently writing alerts into the CWD when HOME is unset.
- `docs/cli/reference.md` is linked as the "complete CLI reference" but documents ~30 of 51 commands, omitting the entire HyperVault feature set.
- CHANGELOG has no entries for 1.0.5 or 1.0.6 although `package.json` is at 1.0.6.
- 215 `@typescript-eslint/no-explicit-any` warnings; 48 `any` usages in `wallet/` alone — the subsystem handling private keys.

---

## Recommended next steps

1. **`dfx build` both canisters.** Parse-level correctness is verified; semantic typechecking against `mo:base` was not possible here.
2. **Reconcile `actor.idl.ts`, `agent.did` and `agent.mo`** (debt §2) — without this the deploy path remains non-functional.
3. **Gate `getStubResponse` behind `--allow-stub`** (debt §1) so failures surface instead of masquerading as success.
4. **Fix the heartbeat transform** (debt §3) before any mainnet deployment.
5. **Re-encrypt any existing v1 VetKeys bundles** — they were never confidential. Treat any previously generated threshold share as a full mnemonic disclosure.
6. Consolidate crypto into one module with uniform KDF parameters (debt §4).
7. Replace the source-text assertions with behavioural tests (debt §7).

---

## Commits

| Commit | Summary |
|---|---|
| `f32e445` | Derive bundle encryption key from a real secret (C-3) |
| `3524d61` | Implement real Shamir's Secret Sharing (C-4, M-6) |
| `fab4085` | Make `agent.mo` compile; gate the mirror-sync surface (C-1, C-2) |
| `6ce4a4d` | Require auth on all webapp API routes; confine backup paths (C-5) |
| `bf73ebd` | Reject path traversal and symlinks when restoring archives (H-1) |
| `01a1ab4` | Repair encrypted wallet export, cycles/tokens args, NUL byte (H-2, M-1, M-2) |
| `cf0ebd5` | Stop tests mutating a committed fixture; fix `.gitignore` gaps (M-3, M-4) |
| `279e2f8` | Make the webapp build; dependencies to 0 vulnerabilities (H-3, H-4) |
| `4b1947d` | Upgrade Next 15 → 16, clearing the last 3 advisories |
| `7e62aee` | Correct documentation drift; make the coverage upload real (M-5) |
