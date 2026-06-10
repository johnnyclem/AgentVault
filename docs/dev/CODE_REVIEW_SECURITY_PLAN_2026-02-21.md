# AgentVault code review + security audit (2026-02-21)

## Scope and method

This review covered:

- Core runtime modules under `src/`.
- CLI commands under `cli/commands/`.
- Motoko canister implementation under `canister/`.
- Product/design alignment against `docs/PRD.md`.
- Automated checks: `npm run typecheck`, `npm run lint`, `npm run test`, and `npm audit --json`.

## Executive assessment

- **Overall maturity:** solid scaffolding with broad test coverage, but still partially in prototype/stub mode in key product paths.
- **Security posture:** no obvious hardcoded secret leakage, but there are serious control-plane and key-handling gaps for production use.
- **Design spec alignment:** implementation is partially aligned with PRD goals, with several MVP requirements still incomplete (especially execution realism, deployed-agent discovery, and production VetKeys path).

## Findings (code review + security)

### 1) No canister-level authorization checks on mutable operations (High)

The canister exposes many `public shared func` mutation endpoints (queue/mark/retry/schedule tx, wallet registration, secret storage/deletion, VetKeys key derivation call path) without caller authorization checks.

Impact:

- Any principal can mutate queue state and wallet metadata.
- Any principal can store/list/delete encrypted secrets.
- Security model does not satisfy owner/operator-only governance expected by PRD security requirements.

Evidence:

- Mutation endpoints are `public shared` and contain no principal guard logic.

Recommended action:

1. Introduce owner/admin principal registry in stable state.
2. Require authorization for all state-mutating operations.
3. Restrict list/read operations of sensitive records (wallet registry, encrypted secret metadata) to authorized principals.

### 2) Seed phrase passed directly to canister API surface (High)

`deriveVetKeysKey(seedPhrase, threshold)` accepts raw seed phrase text in a canister method signature, even though current implementation returns mock errors.

Impact:

- If this path is ever activated/logged/proxied incorrectly, plaintext seed phrase handling on remote boundaries becomes a major risk.

Recommended action:

1. Remove seed-phrase transport over canister interfaces.
2. Perform local key derivation and send only derivation artifacts / wrapped secrets.
3. If remote derivation is required, use dedicated secure enclave/canister flow with explicit threat model and hard guarantees.

### 3) Wallet persistence is not encrypted at rest despite security-oriented comments (High)

`saveWallet` writes serialized wallet data directly to disk; serializer includes `privateKey` and `mnemonic` fields in payload.

Impact:

- Host compromise or local file exfiltration reveals plaintext private keys and mnemonics.
- Contradiction between security claims and actual implementation may create false confidence.

Recommended action:

1. Encrypt wallet payload before disk write with authenticated encryption (AES-256-GCM/XChaCha20-Poly1305).
2. Add OS keychain/KMS-backed KEK option and passphrase fallback.
3. Explicitly document key hierarchy and recovery workflow.

### 4) Threshold/VetKeys implementation retains seed phrase in returned data (Medium)

`deriveThresholdKey` returns an object containing `seedPhrase` and keeps sensitive values in normal JS strings.

Impact:

- Secrets persist in process memory and may leak via logs/errors/heap snapshots.

Recommended action:

1. Do not return seed phrase from derivation API.
2. Avoid long-lived string copies; move to bounded buffers where possible and zero mutable buffers after use.
3. Add tests asserting no seed phrase appears in serialized outputs/loggable objects.

### 5) “Secret sharing” implementation is not true t-of-n split and only loops to threshold count (Medium)

Share generation currently loops `for (let i = 0; i < threshold; i++)` and derives participant secret material from seed phrase rather than performing robust polynomial secret sharing.

Impact:

- Implementation semantics diverge from expected threshold cryptography and may mislead integrators.

Recommended action:

1. Use audited SSS/threshold primitives or actual VetKeys canister integration.
2. Generate `totalParties` shares with mathematically correct reconstruction guarantees.
3. Label current path explicitly as non-production mock until fixed.

### 6) Local/stub behavior can mask deployment/runtime issues (Medium)

`callAgentMethod` catches several network/actor errors for local mode and returns synthetic success-like stub responses.

Impact:

- CI and local validation may pass without proving real canister functionality.
- Defects can escape to production paths.

Recommended action:

1. Gate stub fallback behind explicit flag (`--allow-stub` / env var) defaulting off in CI.
2. Emit structured warning telemetry whenever stub responses are returned.
3. Add integration suite that fails hard when canister calls cannot be made.

### 7) Test suite currently has reproducibility failures in deployment + timing-sensitive crypto tests (Medium)

`npm run test` currently fails in deployer/e2e actor-constructor mocking paths and an HMAC timing assertion.

Impact:

- Reduced confidence in release readiness.

Recommended action:

1. Fix HttpAgent mocking pattern in deployment/e2e tests.
2. Rework timing test to statistically robust checks with multiple runs and tolerance bands.

### 8) Dependency vulnerabilities present in audit output (Medium)

`npm audit` reports 9 vulnerabilities (7 high, 2 moderate), largely around TypeScript-ESLint/minimatch dependency chain, plus moderate issues in `ajv` and `bn.js` transitive tree.

Impact:

- Tooling attack surface in developer/CI environments.

Recommended action:

1. Upgrade `typescript-eslint` stack and lockfile.
2. Re-run audit with fail-on-threshold policy in CI.
3. Track residual accepted risk with explicit expiry.

### 9) MVP feature completeness gaps vs PRD (Medium)

PRD calls out deterministic WASM packaging, deployment/execution/reconstruction flow, and robust security model. Current code still includes explicit stubs/placeholders in packaging output, deployed-agent listing, and deployment method responses.

Impact:

- Product behavior may not yet meet “true autonomy” and production execution expectations in spec language.

Recommended action:

1. Replace placeholder compiler and stub execution flows with real compile/execute paths.
2. Implement deployed-agent discovery against real canister registry/state.
3. Add status matrix documenting which PRD requirements are complete/partial/not started.

## Design-spec comparison matrix (PRD vs implementation)

| PRD area | Current implementation status | Notes |
|---|---|---|
| Agent packaging to WASM | **Partial** | Compiler emits stub WAT text and placeholder logic in generated module paths. |
| Canister deployment + state upload | **Partial** | Deployment path exists, but local actor/stub fallbacks and test failures reduce confidence. |
| On-chain execution layer | **Partial** | Canister task/memory APIs exist, but production authorization and hardened execution controls are missing. |
| Reconstruction CLI | **Mostly present** | Fetch/decrypt/rebuild commands exist, but security hardening for key material handling is incomplete. |
| VetKeys threshold security | **Partial/Mock** | Mock-mode canister status and non-production threshold logic remain. |
| Multi-agent + wallet operations | **Present but hardening needed** | Rich wallet/queue features implemented, but plaintext-at-rest and access controls must be fixed. |

## Prioritized remediation plan

### Phase 0 (Immediate, release blocker)

1. Add authorization guards to all sensitive canister mutation/read endpoints.
2. Remove seed phrase from canister API contracts and from returned derivation objects.
3. Encrypt wallet-at-rest data and migrate legacy plaintext wallet files.
4. Fix failing deployment/e2e tests and mark CI red on failure.

### Phase 1 (Near-term hardening)

1. Replace pseudo-threshold sharing with audited threshold primitives.
2. Disable silent local stub fallbacks by default; require explicit opt-in.
3. Close dependency vulnerabilities via lockfile refresh and package upgrades.
4. Reduce `any` usage in security-critical and wallet/deployment paths first.

### Phase 2 (Spec completion)

1. Implement real deployed-agent discovery (`agentvault list --deployed`).
2. Replace packaging placeholders with deterministic production build pipeline.
3. Publish PRD traceability table (`requirement -> code path -> test`).
4. Add security regression suite (authz, secret leakage, tamper, recovery).

## Suggested “definition of done” gates

- All high findings closed or explicitly waived with expiry and owner.
- `npm run typecheck && npm run lint && npm run test` green in CI.
- `npm audit` has no high vulnerabilities (or approved exceptions).
- Canister authorization tests verify unauthorized callers are denied.
- Wallet export/import migration validates encrypted-at-rest invariant.
