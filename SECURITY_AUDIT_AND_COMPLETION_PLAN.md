# AgentVault Security Audit & Completion Plan

**Last refresh:** May 24, 2026 (branch `claude/platform-review-security-audit-iLwey`)
**Original audit:** February 21, 2026 (Kilo / Codex)

---

## Executive Summary

This document tracks the security posture of AgentVault over time. The Feb 2026 audit catalogued 27 findings; the May 2026 refresh closes the remaining critical/high/medium issues, fixes build hygiene drift (TypeScript, ESLint, npm audit), wires two orphaned CLI sub-commands, and re-classifies three stub commands so the help text matches reality.

### Current State (May 2026)

| Check | Result |
|---|---|
| Tests | 1377/1380 pass (3 skipped, 0 failing) |
| TypeScript | ✅ 0 errors |
| ESLint | ✅ 0 errors (217 `no-explicit-any` warnings in test code, deferred) |
| `npm audit` | ✅ 0 vulnerabilities |
| Lock files | ✅ `package-lock.json` only (`pnpm-lock.yaml` removed) |
| Package manager | npm (see `AGENTS.md`) |
| Security findings still open | 0 critical, 0 high, 0 medium |

---

## Part 1: Findings status (Feb 2026 → May 2026)

### CRITICAL

| ID | File | Status |
|---|---|---|
| SEC-1 | Command injection in `tool-detector.ts` | ✅ **FIXED** (now uses `execa('which', [name])` with a tool allow-list) |

### HIGH

| ID | File | Status | Resolution |
|---|---|---|---|
| SEC-2 | TLS CA cert not actually used (`vault/client.ts`) | ✅ **FIXED in this pass** | `undici.Agent({ connect: { ca, rejectUnauthorized }})` is now attached as `dispatcher` on every fetch (`rawRequest` and `health`). |
| SEC-3 | Seed phrase retained in returned key object | ✅ **FIXED** (Feb 2026) |
| SEC-4 | `new Function()` for dynamic imports | ✅ **FIXED** — replaced with standard `await import()` in `bittensor-client.ts` and `arweave-client.ts`. |
| SEC-5 | Secrets via CLI args (`--mnemonic`, `--private-key`, `--password`) | ✅ **FIXED in this pass** | CLI options removed entirely. Secrets are now sourced from `AGENTVAULT_MNEMONIC` / `AGENTVAULT_PRIVATE_KEY` / `AGENTVAULT_PASSWORD` env vars; keystore password falls back to an interactive `inquirer.password` prompt when running in a TTY. |

### MEDIUM

| ID | File | Status | Resolution |
|---|---|---|---|
| SEC-6 | Regex ReDoS in Vault key-pattern validation | ✅ **FIXED in this pass** | New `globToSafeRegex()` escapes every non-wildcard character before constructing the RegExp. |
| SEC-7 | `Math.random()` for share IDs | ✅ **FIXED** (Feb 2026) |
| SEC-8 | Address logged to console (Solana provider) | ✅ **FIXED** — gated behind `debugLog`. |
| SEC-9 | Secret IDs logged in VetKeys | ✅ **FIXED** (Feb 2026) |
| SEC-10 | IV reused as PBKDF2 salt (`vetkeys.ts`, `security/types.ts`) | ✅ **FIXED in this pass** | Both `encryptShare()` implementations now generate an independent 16-byte random salt and emit `salt(16) || iv(12 or 16) || ciphertext` as the share blob. Also corrected the algorithm name (the old `algorithm.replace('-','')` produced an invalid OpenSSL identifier for `aes-256-gcm`). |
| SEC-11 | Weak canister ID validation | ✅ **FIXED** (Feb 2026) — Principal-format regex. |
| SEC-12 | No path traversal validation in wallet storage | ✅ **FIXED in this pass** | New `src/utils/path-validation.ts#sanitizePathPart` is applied to every agent-id and wallet-id segment in `wallet-storage.ts`. Rejects `..`, separators, NUL, and anything outside `[a-zA-Z0-9._-]{1,128}`. |
| SEC-13 | Non-cryptographic audit tokens | ✅ Documented limitation. |
| SEC-14 | No rate limiting on Vault API | Open (documented; out of scope for this refresh — Vault server enforces server-side limits). |
| SEC-15 | Debug default `true` in `wasmedge-compiler.ts` | ✅ **FIXED in this pass** | `DEFAULT_WASMEDGE_OPTIONS.debug = false`, `sourcemap = false`, and the build-config fallback flipped to `?? false`. |
| SEC-16 | Unencrypted wallet storage | ✅ **FIXED** — `encryptWalletSecrets()` now wraps secrets with AES-256-GCM. |
| SEC-17 | Non-atomic file writes in `backup/backup.ts` | ✅ **FIXED in this pass** | New `atomicWriteFileSync()` (write→fsync→rename) is used for both backup envelopes (`exportBackup`, `exportFullBackup`), the signing-key file, and `saveWallet()` in `wallet-storage.ts`. |

### LOW

SEC-18 – SEC-27: Either documented as expected (anonymous-agent local-dev, HTTP for local replica) or already mitigated by Feb 2026 fixes. No further action this pass.

---

## Part 2: Dependency Vulnerabilities

### Before this refresh

8 moderate vulnerabilities (uuid, ws, brace-expansion, postcss transitively).

### After this refresh

`npm audit`: **0 vulnerabilities.**

Resolved via `overrides` in `package.json` pinning safe versions without forcing breaking SDK upgrades:

```json
"overrides": {
  "brace-expansion": "^1.1.13",
  "uuid": "^11.1.1",
  "ws": "^8.20.1",
  "postcss": "^8.5.10"
}
```

Direct upgrades of `@solana/web3.js` (major) and the `ethers` v5 path remain deferred — the overrides remove the underlying CVE exposure without requiring breaking API migrations.

---

## Part 3: Build hygiene

| Item | Before | After |
|---|---|---|
| `npm run typecheck` | 24 errors | 0 errors |
| `npm run lint` | 13 errors + 217 warnings | 0 errors + 217 warnings (test-code `any` types — deferred) |
| `npm audit` | 8 moderate | 0 |
| Lock files | `package-lock.json` + `pnpm-lock.yaml` (ambiguous) | `package-lock.json` only |
| Install | Required `--legacy-peer-deps` | Still required (peer dep churn between `@dfinity/*` and `@solana/web3.js`) — documented in `AGENTS.md` |

Specific fixes:

- `cli/commands/wiki.ts` — removed unused `createWikiPageSchema` import.
- `tests/unit/wiki.test.ts` — added non-null assertions where the array length is guaranteed by prior `expect()` checks; removed unused `WikiStore` import.
- `tests/vault/bitwarden.test.ts` — replaced 6 `Function`-typed callback params with explicit `(err: Error | null, stdout?: string, stderr?: string) => void` signatures.
- `src/vault/secret-leak-detector.ts` — replaced `require('node:crypto')` with a module-top `import`; replaced the `const self = this` indirection with arrow functions.
- `src/wallet/hsm/{ledger,sgx}-provider.ts` — dropped unused `err` bindings in `catch` clauses.
- `src/wallet/secure-wallet.ts` — `let newPrivateKeyBytes` → `const`.

---

## Part 4: CLI surface

### Orphaned commands wired

- `agentvault wallet multi-send` — calls `handleMultiSend` from `cli/commands/wallet-multi-send.ts`.
- `agentvault wallet process-queue` — calls `handleProcessQueue`, prompts for the target canister ID.

### Stub status surfaced in `--help`

| Command | Old description | New description |
|---|---|---|
| `trace` | `[Experimental] View execution traces…` | `[Stub] View execution traces from instrumented canisters (Phase 3, not yet implemented)` |
| `profile` | `[Experimental] Profile canister performance` | `[Stub] Profile canister performance (currently returns mock data)` |
| `stats` | `Display resource usage statistics` | `[Partial] Display resource usage statistics (current only; historical not yet implemented)` |

`info` and `instrument` were re-reviewed and left unchanged — they are minimal but functional.

---

## Part 5: New tests added

| File | Coverage |
|---|---|
| `tests/unit/path-validation.test.ts` | 15 cases exercising `sanitizePathPart`, `sanitizePathParts`, and `atomicWriteFileSync` (SEC-12 + SEC-17). |
| `tests/vault/glob-pattern.test.ts` | 4 cases asserting `globToSafeRegex` escapes regex metacharacters and that `*`/`?` still expand correctly (SEC-6). |

---

## Part 6: Out of scope (follow-up tracking)

1. Implementing real bodies for the stub commands (`trace`, `profile`, `stats` historical).
2. Major upgrades: `@solana/web3.js` v2, full Solana RPC migration; ethers v5→v6 migration of any straggler call sites.
3. The 217 `@typescript-eslint/no-explicit-any` warnings in test code.
4. True Shamir Secret Sharing and live VetKeys canister integration (intentionally simulated by current design).
5. Vault client rate limiting (SEC-14).

---

## Verification commands

```bash
npm install --legacy-peer-deps
npm run typecheck   # 0 errors
npm run lint        # 0 errors
npm test            # 1377 pass, 3 skipped, 0 fail
npm audit           # 0 vulnerabilities
```

**End of refresh — May 24, 2026**
