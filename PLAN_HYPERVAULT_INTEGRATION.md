# HyperVault ⇄ AgentVault — First-Class Integration Plan

**Date:** July 14, 2026
**Status:** Proposed
**Scope:** `johnnyclem/agentvault` (primary) + companion changes in `johnnyclem/hypervault`
**Related (orthogonal):** `PLAN_VAULT_INTEGRATION.md` covers HashiCorp-style *secrets* vaulting (largely implemented in `src/vault/`). This plan covers [HyperVault](https://github.com/johnnyclem/hypervault) — the memory / artifact / versioned-mind platform at `hypervault.store`. The two compose: HyperVault API keys are secrets that live *in* the secrets vault.

---

## 1. Executive Summary

HyperVault is the **living, cloud-hosted mind**: per-user memories with auto-tagging and knowledge-graph links, git-versioned history ("Git for a Mind": branches, commits, three-way merge, time-travel), pgvector semantic indices, saved artifacts with permanent links, and a 19-tool MCP server — all backed by Supabase Postgres behind `hypervault.store`.

AgentVault is the **sovereign, permanent body**: ICP canisters with stable on-chain state (`agent.mo`, `memory-repo.mo`), a git-style on-chain memory repo (ThoughtForms), ed25519-signed Arweave archival, thoughtform-bundle backup format, VetKeys threshold encryption, and a multi-chain wallet layer.

The integration makes each the missing half of the other:

1. **Bootstrap** — spin up an AgentVault agent *from* a HyperVault account in one command: pull its memories, mind history, artifacts, and search indices into a ready-to-deploy agent project, with the HyperVault MCP server pre-wired.
2. **Continuous sync** — agents running anywhere (local, canister, sandbox) read/write the same HyperVault mind through backbone storage adapters and MCP.
3. **Sovereign archive** — one command takes a complete snapshot of a HyperVault account (`hypervault.store` → export), converts it into a signed, encrypted thoughtform-bundle, commits it to an ICP `memory_repo` canister, and permanently archives it to Arweave with on-chain verification receipts. The cloud mind becomes reconstructible from chain alone.

### The two headline one-liners

```bash
# 1) Bootstrap a HyperVault-backed agent — memories, mind history, and indices included
npx agentvault@latest hypervault bootstrap my-agent --key hv_...

# 2) hypervault.store → fully secure, archived, blockchain-backed AgentVault
npx agentvault@latest hypervault archive --all --encrypt --network ic --arweave
```

Both are also exposed as MCP tools (`hypervault_bootstrap`, `hypervault_archive`) via a new native `agentvault mcp serve` server, so any MCP-capable agent can invoke the full pipeline itself.

---

## 2. Why the Fit Is Natural (evidence from both codebases)

| HyperVault concept | AgentVault counterpart | Integration action |
|---|---|---|
| `memories` table (title/content/tags/summary, FTS `tsvector`) | `src/backbone/services/memory.ts` `MemoryStore` + `AgentMemoryEntry` (already has `vaultRef`, `companyId`/`agentId` scoping, "inject a database-backed adapter" by design) | Implement `HyperVaultMemoryStore` adapter |
| Git for a Mind (`memory_branches`, `memory_commits`, `memory_revisions`, `mind_commit()` — provenance, merge, time-travel) | `canister/memory-repo.mo` (commits, branches, rebase, merge, cherry-pick, ThoughtForm commits) | Mirror the mind DAG on-chain; map commit-for-commit |
| Memory knowledge graph (`memory_links`, `connections`) | `src/wiki/` backlinks + cross-references | Preserve edges in wiki pages and bundle format |
| pgvector embeddings (`memories.embedding vector(1536)`, HNSW) | **nothing** — AgentVault has no vector index today | Net-new local vector index (`.agentvault/index/`) |
| MCP server (Python FastMCP, 19 tools, `X-HyperVault-Key`) | `PolyticianMCPClient` (stdio JSON-RPC client) + `agentvault mcp register/tools/call` | Register + consume out of the box |
| MCP tool *definitions* without a server (`src/wiki/mcp-tools.ts` has 10 wiki tools and no transport) | — | Wire a real server transport: `agentvault mcp serve` |
| No bulk export endpoint (**gap**) | `thoughtform-bundle` + `ArweaveArchiver` want a complete snapshot | Add `GET /api/export` to hypervault (companion PR) |
| Artifacts (permanent `/a/<slug>` pages, `content_hash`) | Arweave permanent storage, `backup export` | Archive artifacts as content-addressed entries |
| API keys (`hv_` prefix, SHA-256 stored, provenance via `author_key_id`) | `src/vault/` SecretProvider (HashiCorp/Bitwarden/memory) + safehouse injection | Store `hv_` keys in the secrets vault; never in flags/files |
| `agentvault.cloud` already in HyperVault's vanity-domain portfolio | — | Brand-level tie already exists; use it for hosted bridge later |

---

## 3. Target Architecture

```
                       ┌────────────────────────────────────────────┐
                       │              hypervault.store              │
                       │  Supabase Postgres: memories · mind DAG ·  │
                       │  artifacts · connections · pgvector index  │
                       │                                            │
                       │  REST API (X-HyperVault-Key)               │
                       │  + NEW: GET /api/export (bulk snapshot)    │
                       └───────▲──────────────────────▲─────────────┘
                               │                      │
                 hypervault-mcp (FastMCP,             │ HTTPS (typed client)
                 19 tools, stdio/http)                │
                               │                      │
┌──────────────────────────────┴──────────────────────┴──────────────────────┐
│                              AgentVault CLI / SDK                          │
│                                                                            │
│  NEW src/hypervault/                    Existing modules                   │
│  ├── client.ts        (typed REST) ───▶ src/vault/    (hv_ key storage)    │
│  ├── types.ts         (schemas)         src/backbone/ (MemoryStore /       │
│  ├── memory-store.ts  (adapter) ──────▶               KnowledgeStore ifc)  │
│  ├── knowledge-store.ts (adapter)       src/wiki/     (WikiStore, MCP      │
│  ├── wiki-store.ts    (adapter)                        tool defs)          │
│  ├── snapshot.ts      (export→bundle) ▶ src/backup/   (thoughtform-bundle) │
│  ├── index/           (local vector +   src/archival/ (ArweaveArchiver)    │
│  │                     FTS indices)     src/canister/ (memory-repo actor)  │
│  └── mcp-server.ts    (native MCP   ◀── src/orchestration/mcp-client.ts    │
│                        server)                                             │
│                                                                            │
│  NEW cli/commands/hypervault.ts:                                           │
│    connect · status · bootstrap · pull · push · snapshot · archive ·       │
│    verify · restore · reindex                                              │
│  NEW cli/commands/mcp.ts: `serve` subcommand                               │
└───────────────┬───────────────────────────────────────────┬────────────────┘
                │ dfx / @dfinity/agent                       │ arweave upload
                ▼                                            ▼
┌───────────────────────────────────┐        ┌──────────────────────────────┐
│   ICP canisters (sovereign body)  │        │   Arweave (permanent grave-  │
│   memory_repo.mo: mind DAG mirror │        │   stone + resurrection seed) │
│   (commits/branches/ThoughtForms) │        │   agentvault-arweave-bundle  │
│   agent.mo: memories · state ·    │◀──────▶│   ed25519-signed manifest,   │
│   encryptedSecrets (VetKeys) ·    │ receipt│   Merkle root, State-Hash    │
│   archival receipts (tx IDs)      │  txids │   tags                       │
└───────────────────────────────────┘        └──────────────────────────────┘
```

**Design principle — three tiers of the same mind:**

- **Hot (HyperVault/Supabase):** the live, queryable, multi-device mind. Fast recall, embeddings, agents writing through MCP.
- **Warm (ICP canister):** the sovereign mirror. On-chain `memory_repo` holds the mind DAG; `agent.mo` holds working memories + encrypted secrets. Survives HyperVault outage; agent can run 24/7 from chain.
- **Cold (Arweave):** the permanent archive. Signed, content-addressed, verifiable bundles. Full account reconstructible from a single tx ID + keys.

Every layer can rebuild the layer above it (`restore` flows), and every write down the stack carries integrity receipts back up.

---

## 4. Deliverables in `johnnyclem/hypervault` (companion PRs)

These are small and unblock everything else. Filed as a separate PR series against hypervault.

### 4.1 Bulk export endpoint — `GET /api/export` *(the missing piece)*

There is currently **no wholesale account export**. Add `app/api/export/route.ts`:

- Auth: `resolveApiIdentity` (session or `X-HyperVault-Key`), reusing `lib/api-auth.ts`.
- Query params: `?include=memories,mind,artifacts,connections,conversations,embeddings` (default: all), `?since=<ISO>` (incremental), `?branch=<name>` (default all branches).
- Response: streamed NDJSON (one record per line, `{"table": "...", "row": {...}}`) so multi-thousand-memory accounts don't need a giant JSON buffer. Final line is a manifest: row counts + per-table SHA-256 + export cursor.
- Contents: `memories`, `memory_branches`, `memory_commits`, `memory_revisions`, `memory_heads`, `memory_links` + `memory_link_changes`, `memory_artifact_links`, `artifacts` (incl. `content`, `original_content`, `source_prompt`, `content_hash`), `connections`, optionally `conversations`/`messages`, and `embedding` + `embedding_model` columns when present.
- Rate-limit as an expensive operation (reuse `lib/ratelimit.ts`, e.g. 4/hour per key).

### 4.2 MCP tool `export_vault`

Add to `mcp-server/src/hypervault_mcp/server.py`: `export_vault(include=None, since=None) -> str` returning a download URL / streamed payload from `/api/export`. Keeps the MCP server's thin-proxy design.

### 4.3 Import endpoint hardening (for restore / round-trip)

`POST /api/memories/import` already exists for files/URLs. Add `POST /api/import/vault` accepting the §4.1 NDJSON stream to restore a full account (idempotent via `content_hash` / `external_id` / commit IDs). This gives **chain → cloud** resurrection, completing the loop.

### 4.4 Archival receipt field (optional, nice-to-have)

Migration adding `public.archive_receipts` (`user_id`, `kind ('arweave'|'icp')`, `ref` (tx id / canister id + commit), `manifest_hash`, `created_at`) + `POST /api/archive-receipts`, so the HyperVault dashboard can show "last archived to chain at …" with a verify link. AgentVault posts receipts after successful archive.

---

## 5. Deliverables in `johnnyclem/agentvault`

### 5.1 New module: `src/hypervault/` (exported as `agentvault/hypervault`)

| File | Contents |
|---|---|
| `types.ts` | TS mirrors of the hypervault schema: `HvMemory`, `HvArtifact`, `HvConnection`, `HvMindBranch`, `HvMindCommit`, `HvRevision`, `HvExportManifest`, plus zod validators (follow `src/backbone/validators.ts` idiom). |
| `client.ts` | `HyperVaultClient` — typed REST client over `undici` (already a dep). Base URL `HYPERVAULT_API_URL` (default `https://hypervault.store`), header `X-HyperVault-Key`. Methods map 1:1 to the API the Python MCP server proxies: `saveArtifact`, `listArtifacts`, `deleteArtifact`, `memorize`, `recall`, `listMemories`, `editMemory`, `forgetMemory`, `memoryHistory`, `mindLog`, `mindBranches`, `mindBranch`, `mindDiff`, `mindMerge`, `mindRevert`, `mindState`, `connect`, `exportVault` (NDJSON stream), `importVault`. Retry with exponential backoff; respects hypervault's 60 req/min key limit. |
| `auth.ts` | Key resolution chain: `--key` flag (discouraged, warns) → `HYPERVAULT_API_KEY` env → secrets vault lookup (`SecretProvider.get(agentId, 'hypervault_api_key')`) → interactive prompt. Persist choice as a **vaultRef, never plaintext**, in `.agentvault/hypervault.json`. |
| `memory-store.ts` | `HyperVaultMemoryStore implements MemoryStore` (backbone interface: `list/get/upsert/delete/purgeExpired`). Maps `AgentMemoryEntry.{key,value,metadata}` ⇄ `HvMemory.{title,content,tags}`; sets `vaultRef: 'hypervault:<memory_id>'`; `agentId` recorded in tags for scoping. Write path goes through `memorize`/`edit_memory` so every write is a provenance-stamped mind commit. |
| `knowledge-store.ts` | `HyperVaultKnowledgeStore implements KnowledgeStore` — `KnowledgeEntry` lifecycle (draft→proposed→ratified→archived) mapped to memories tagged `knowledge:<status>`, versions backed by `memory_history`. |
| `wiki-store.ts` | `HyperVaultWikiStore implements WikiStore` — wiki pages persisted as memories tagged `wiki:<wikiId>`; backlinks ⇄ `memory_links`. Lets `agentvault wiki` run against the cloud mind instead of `.agentvault/wiki/*.json`. |
| `snapshot.ts` | Consumes the `/api/export` NDJSON stream → produces a **HyperVault snapshot** (§5.4) → wraps into a thoughtform-bundle. Also the reverse: bundle → `importVault` (restore). |
| `index/` | Local indices (§5.5): `vector-index.ts` (HNSW), `fts-index.ts`, `builder.ts`, on-disk layout under `.agentvault/index/`. |
| `mind-sync.ts` | Incremental DAG sync: walks `mindLog` since the last synced commit, replays each commit onto the `memory_repo` canister (§5.6). Maintains cursor in `.agentvault/hypervault.json`. |
| `mcp-server.ts` | Native MCP server (§5.7). |
| `index.ts` | Barrel export; add `"./hypervault"` subpath to `package.json` `exports` (parallel to `./vault`, `./backbone`). |

### 5.2 New CLI command group: `cli/commands/hypervault.ts`

Registered in `cli/index.ts` alongside `memory`/`wiki`/`vault`. All subcommands accept `--api-url`, key resolution per §5.1 `auth.ts`.

| Command | What it does |
|---|---|
| `hypervault connect` | Validate key against `/api/keys` echo, store it in the secrets vault (`vault put <agent> hypervault_api_key`), write `.agentvault/hypervault.json` (`{ apiUrl, keyRef, userIdHint, lastSync }`). |
| `hypervault status` | Key validity, memory/artifact/branch counts, last local sync cursor, last canister commit, last Arweave receipt — the whole three-tier picture in one screen. |
| `hypervault bootstrap <project>` | The §6.1 one-liner. `init` + `connect` + `pull` + index build + MCP wiring. Flags: `--key`, `--branch <name>`, `--no-artifacts`, `--no-index`, `--template`, `--deploy` (optionally continue straight to `package` + `deploy --network local`). |
| `hypervault pull` | Incremental export → update local snapshot, `.agentvault/memories/`, and indices. `--since` auto-derived from cursor. |
| `hypervault push` | Push locally created memories/wiki pages up (through `memorize`/`edit_memory`, preserving commit semantics). `--dry-run` prints the diff-as-mind-commits. |
| `hypervault snapshot` | Full export → `hypervault-snapshot` thoughtform-bundle on disk (`-o`, `--encrypt`, `--include`). No network beyond hypervault. |
| `hypervault archive` | The §6.2 pipeline: snapshot → encrypt → canister commit → Arweave upload → verify → receipts. Flags: `--all`, `--encrypt` (VetKeys/AES-256-GCM), `--network <local\|ic>`, `--canister-id`, `--arweave` / `--arweave-jwk <file>`, `--since` (incremental archive), `--yes`. |
| `hypervault verify <ref>` | Verify a bundle / Arweave tx / canister commit: manifest hash, ed25519 signature, Merkle root, per-table SHA-256s. Exit code for CI. |
| `hypervault restore <ref>` | Chain → anywhere: fetch bundle from Arweave tx or canister, decrypt, then `--to local` (rebuild `.agentvault/` + indices) or `--to hypervault` (POST `/api/import/vault`). |
| `hypervault reindex` | Rebuild local vector/FTS indices from the snapshot (embedding provider optional, §5.5). |

Also: `agentvault init --hypervault` flag = shorthand that chains into `hypervault connect` after scaffolding, and `agentvault mcp serve` (§5.7).

### 5.3 Config & state files

- `.agentvault/hypervault.json` — `{ apiUrl, keyRef ("vault:<backend>/<agentId>/hypervault_api_key"), branch, lastExportCursor, lastMindCommitSynced, canisterId?, lastArweaveTx? }`. **Never contains the key itself.** Written with `atomicWriteFileSync`, paths via `sanitizePathPart` (existing utils).
- `.agentvault/memories/` — human-readable working tree of pulled memories (one markdown file per memory, frontmatter = id/tags/branch/commit) so agents and humans can grep the mind offline.
- `.agentvault/index/` — indices (§5.5).
- `agent.json` gains optional `"hypervault": { "apiUrl": "...", "branch": "main" }` block; `init` template updated.

### 5.4 Snapshot & bundle format: `agentvault-hypervault-snapshot-v1`

Extends the proven thoughtform-bundle envelope (`src/backup/thoughtform-bundle.ts`) rather than inventing a new one — a hypervault snapshot **is** a thoughtform-bundle whose entries are:

```
entries:
  manifest.json          — HvExportManifest (row counts, per-table sha256, cursor, branch heads)
  memories.ndjson        — live memories (all branches' heads)
  mind/commits.ndjson    — memory_commits (full DAG incl. merge parents, author provenance)
  mind/revisions.ndjson  — memory_revisions (full snapshots per change — the history)
  mind/branches.json     — memory_branches
  mind/links.ndjson      — memory_links + memory_link_changes
  artifacts/<hash>.html  — artifact content, content-addressed by content_hash
  artifacts/index.ndjson — artifact metadata (slug, title, tags, source_prompt, visibility)
  connections.ndjson     — artifact graph edges + memory_artifact_links
  embeddings.bin         — packed float32 vectors + id/model sidecar (embeddings.idx.json)
  conversations.ndjson   — optional (--include conversations)
```

- `manifest` reuses `BackupManifest` fields + `merkleRoot` over all entries (`src/backup/merkle.ts`), so `ArweaveArchiver.verifyBundle` semantics carry over unchanged.
- `--encrypt`: entries encrypted with `CanisterEncryption` (AES-256-GCM — the audited-correct implementation in `src/canister/encryption.ts`; **explicitly not** `vetkeys.decryptJSON` until audit finding C-1 is fixed). Data key wrapped via VetKeys threshold derivation when a canister is configured, else PBKDF2 passphrase (same UX as `backup export --encrypted`).
- Format version registered next to `THOUGHTFORM_BUNDLE_FORMAT`; `backup preview`/`restore`/`verify` learn to recognize it.

### 5.5 Indices ("…along with its memories *and indices*")

HyperVault's indices are Postgres-native (tsvector FTS + pgvector HNSW) and cannot come along as-is. The snapshot carries the **raw material** (content + precomputed embeddings), and AgentVault builds equivalent local indices:

- **Vector index:** `hnswlib-node` (new dep, optional/lazy-loaded) over exported `embedding vector(1536)` values → `.agentvault/index/vectors.hnsw`. Query path: embed query via any OpenAI-compatible endpoint (reuse the agent's configured inference provider; falls back cleanly when absent — same graceful degradation hypervault itself uses).
- **FTS index:** MiniSearch-style inverted index (pure TS, no native dep) over title/tags/summary/content with the same A/B/C field weighting hypervault's generated tsvector uses → `.agentvault/index/fts.json`.
- **Hybrid recall:** port the fusion logic shape of hypervault's `hybridRecallMemories` (lexical + semantic merge) into `src/hypervault/index/recall.ts`; exposed via `agentvault hypervault recall "<query>"` (offline) and the wiki/backbone adapters, and as MCP tool `hypervault_recall_local`.
- Memories with no exported embedding are embedded at `reindex` time if a provider is configured; otherwise FTS-only (parity with hypervault's own fallback).
- Index rebuild is always derivable from the snapshot ⇒ indices are **never** part of the archived bundle's integrity surface (they're rebuild artifacts, listed in manifest as `derived`).

### 5.6 On-chain mirror: mind DAG → `memory_repo` canister

`memory-repo.mo` already speaks git: `commit(msg, diff, tags)`, branches, `store_thoughtform(entry, parentHash, branch)`, merge/rebase/cherry-pick. Mapping:

| HyperVault | memory_repo canister |
|---|---|
| `memory_branches.name` | branch (`createBranch`/`switchBranch`) |
| `memory_commits` (id, parent, merge_parent, message, author_kind, author_key_id) | `commit()` with message = hypervault commit message; hypervault commit UUID, author provenance, and merge-parent recorded in `tags` |
| `memory_revisions` per commit | commit `diff` payload (JSON of the revision ops) |
| memory content at head | `store_thoughtform` entries (content-addressed by revision hash) |

- `mind-sync.ts` replays commits **in topological order** from the last synced cursor; idempotent (skip if commit UUID tag already on-chain). 64 MiB `wasm_memory_limit` respected via `assertMemoryLimit`-aware chunking: large artifact blobs do *not* go in the canister — they go to Arweave, and the canister stores `{content_hash, arweave_tx}` pointers.
- Archive receipts: after Arweave upload, `hypervault archive` writes a final canister commit tagged `archive-receipt:<arweave-tx>` — the chain itself attests where the cold copy lives.
- Restore path: `hypervault restore --from-canister <id>` reconstructs the snapshot from thoughtforms + fetches artifact blobs from their Arweave pointers.

### 5.7 Native MCP server: `agentvault mcp serve`

AgentVault currently only *consumes* MCP (`PolyticianMCPClient`) and has serverless tool definitions (`src/wiki/mcp-tools.ts`). Add the first real server:

- New dep `@modelcontextprotocol/sdk`; `src/hypervault/mcp-server.ts` wires stdio (default) + HTTP (`--transport http --port`) transports.
- Tools exposed:
  - **Pipeline tools (net-new):** `hypervault_bootstrap`, `hypervault_pull`, `hypervault_push`, `hypervault_snapshot`, `hypervault_archive`, `hypervault_verify`, `hypervault_restore`, `hypervault_status`, `hypervault_recall_local`.
  - **Wiki tools (already defined, finally served):** the 10 `wiki_*` tools via existing `getWikiToolDefinitions()`/`handleWikiToolCall()`.
  - **Canister tools:** `vault_show`, `vault_fetch`, `vault_health` (thin wrappers over existing command logic).
- This makes the *entire* store→chain pipeline "MCP available": an agent with this server can archive its own mind.
- Registration one-liner for any MCP host:
  ```json
  { "mcpServers": { "agentvault": { "command": "npx", "args": ["-y", "agentvault@latest", "mcp", "serve"],
      "env": { "HYPERVAULT_API_KEY": "hv_..." } } } }
  ```
- Complement, don't replace: `hypervault bootstrap` also registers the upstream Python `hypervault-mcp` server config (for hosts that want the cloud-native 19 tools directly), and `agentvault mcp register --entry "hypervault-mcp"` keeps working through the existing client.

### 5.8 Webapp & dashboard (thin slice)

Mirror the existing `api/backbone/*` pattern:

- `webapp/src/app/api/hypervault/{status,snapshot,archive}/route.ts` — proxy to the SDK, key from server-side secrets vault only.
- Dashboard card: three-tier status (Hot cloud ✓ / Warm canister ✓ @commit / Cold Arweave ✓ @tx + verified badge), "Archive now" button, receipts history.
- Follows `PLAN_VAULT_INTEGRATION.md`'s provider/hook pattern (`HyperVaultProvider`, `useHyperVault`).
- **Security precondition:** the archive-triggering route must not join the 18 unauthenticated webapp routes flagged in `SECURITY_AUDIT_2026_02_13.md` — gate on the audit's auth remediation.

### 5.9 macOS wallet app (follow-on, not in critical path)

`macos-wallet-app` already models MCP servers (`Models/MCPServer.swift`, `AddMCPServerSheet`). Add a canned "HyperVault" server template (command `hypervault-mcp`, env `HYPERVAULT_API_KEY` from Keychain) and an "AgentVault (native)" template (`npx agentvault mcp serve`). One small PR.

---

## 6. The Flagship Flows (exact command anatomy)

### 6.1 One-line bootstrap: HyperVault account → running agent

```bash
npx agentvault@latest hypervault bootstrap my-agent --key hv_XXXX
```

Steps (each idempotent, resumable, `--verbose` shows all):

1. **Scaffold** — `init` path: project dir, `agent.json` (+`hypervault` block), `index.js`, `.agentvault/`.
2. **Connect** — validate key, store in secrets vault, write `hypervault.json` with `keyRef`.
3. **Pull memories & mind** — stream `/api/export` → `.agentvault/memories/` working tree + snapshot bundle in `.agentvault/canister/`.
4. **Build indices** — FTS always; vectors from exported embeddings (provider optional).
5. **Wire MCP** — emit `.mcp.json` (or merge into existing) registering both `agentvault mcp serve` and `hypervault-mcp`; print Claude Desktop/Code snippet.
6. **Soul detection** — if the account has a memory tagged `soul` (or `--soul <slug>`), write `soul.md` so the existing `init` soul-detection → `memory-repo.config.json` path activates.
7. Optional `--deploy`: continue into `package` → `dfx start` check → `deploy --network local` → initial `mind-sync` to the canister.

MCP equivalent: `hypervault_bootstrap {"project": "my-agent"}` (key from server env).
Without a key: interactive flow prints the dashboard URL for key creation and waits.

### 6.2 One-line sovereign archive: hypervault.store → blockchain-backed AgentVault

```bash
npx agentvault@latest hypervault archive --all --encrypt --network ic --arweave
```

Pipeline (printed as a checklist as it runs):

1. **Export** — full/incremental NDJSON stream from `hypervault.store` (`--since` from cursor for incrementals).
2. **Bundle** — build `agentvault-hypervault-snapshot-v1` thoughtform-bundle; compute per-entry SHA-256 + Merkle root.
3. **Encrypt** — AES-256-GCM per entry; data key wrapped via VetKeys (canister-derived) or passphrase.
4. **Canister commit** — ensure `memory_repo` canister (create+deploy on first run with `--yes`, else prompt; cycles check via existing `cycles` command); replay mind DAG (§5.6); store bundle manifest as a thoughtform.
5. **Arweave upload** — `ArweaveArchiver.archive()` with tags `App-Name=AgentVault`, `Bundle-Format=agentvault-hypervault-snapshot-v1`, `HyperVault-User`, `State-Hash`; JWK from `--arweave-jwk`/wallet module.
6. **Receipts** — canister commit `archive-receipt:<tx>`; optional POST to hypervault `/api/archive-receipts` (§4.4).
7. **Verify** — re-fetch from Arweave, `verifyBundle` (hash, ed25519 signature, pubkey), cross-check canister head. Print the resurrection line:

```
✔ Archived. Resurrect anywhere with:
  npx agentvault@latest hypervault restore ar://<tx-id> --to local
```

MCP equivalent: `hypervault_archive {"all": true, "encrypt": true, "network": "ic", "arweave": true}`.

### 6.3 Resurrection (the payoff)

```bash
# chain → local working agent (memories + indices rebuilt)
npx agentvault@latest hypervault restore ar://<tx-id> --to local

# chain → fresh hypervault account (cloud mind rebuilt)
npx agentvault@latest hypervault restore ar://<tx-id> --to hypervault --key hv_NEW
```

---

## 7. Security Plan

1. **Key handling:** `hv_` keys flow only through env / secrets vault / prompt — never argv (matches `AGENTS.md` wallet-secret policy). `--key` on `bootstrap` is accepted for the one-liner UX but immediately vaulted, scrubbed from any persisted config, and a warning suggests env/vault next time. Safehouse injection (`safehouse inject -m env-scoped`) supported for sandboxed agents.
2. **Encryption:** all bundle encryption via `CanisterEncryption` (verified GCM tag handling). **Blocker dependency:** audit finding **C-1** (`src/security/vetkeys.ts` `decryptJSON` missing GCM auth-tag validation) must be fixed before VetKeys-wrapped archive keys ship; until then passphrase wrapping is the default and `--encrypt vetkeys` is gated behind the fix.
3. **Integrity chain:** content SHA-256 per entry → Merkle root in manifest → ed25519 manifest signature (`~/.agentvault/arweave-signing.key`) → Arweave tags → canister receipt commit. `hypervault verify` checks every link; CI-friendly exit codes.
4. **Least privilege:** the export endpoint is read-only for a key; archive receipts POST is the only hypervault write in the archive flow. Restore-to-hypervault requires a distinct explicit key.
5. **Privacy:** artifacts respect `visibility` — private artifacts are always encrypted in bundles regardless of `--encrypt`; memories are owner-only by RLS upstream and encrypted-by-default in archives (`--no-encrypt` prints a red warning).
6. **Provenance preserved end-to-end:** hypervault `author_kind`/`author_key_prefix` travel into revision records, canister commit tags, and manifest — "which agent wrote this memory" survives archival.
7. **Rate-limit citizenship:** client backoff honoring hypervault's 60/min; export calls capped.

---

## 8. Implementation Phases

Ordering favors shipping a usable vertical slice early; each phase lands green (`npm run typecheck && npm run lint && npm test`) and is independently releasable.

### Phase 0 — Foundations & unblockers (1–2 days)
- Fix audit **C-1** (GCM tag validation in `vetkeys.decryptJSON`) — small, high-value, blocks §7.2.
- Companion hypervault PR #1: `GET /api/export` (§4.1) + `export_vault` MCP tool (§4.2) + tests.
- `src/hypervault/types.ts` + `client.ts` + `auth.ts` with contract tests against recorded fixtures (NDJSON golden files checked into `tests/hypervault/fixtures/`).

### Phase 1 — Snapshot & bundle (2–3 days)
- `snapshot.ts`, `agentvault-hypervault-snapshot-v1` format, `hypervault connect/status/snapshot/verify` commands.
- `backup preview/verify` taught the new format.
- Tests: round-trip (fixture export → bundle → parse → deep-equal), Merkle/signature verification, encryption round-trip, tampered-bundle rejection.

### Phase 2 — Bootstrap & indices (3–4 days)
- `hypervault bootstrap/pull/reindex`, `.agentvault/memories/` working tree, FTS + HNSW indices, hybrid recall, `init --hypervault`.
- Tests: bootstrap e2e against a mock hypervault server (undici MockAgent), index build determinism, recall quality smoke tests, no-embedding fallback.

### Phase 3 — Chain: canister sync + Arweave archive (4–5 days)
- `mind-sync.ts` DAG replay, `hypervault archive`, receipts, `hypervault restore --to local`, `--from-canister`.
- Reuse `tests/memory-repo/` harness (local dfx replica) + `tests/archival/` patterns; add topological-replay, idempotent-resync, chunking-at-memory-limit, and full archive→restore e2e on `--network local`.

### Phase 4 — MCP server + push/round-trip (3–4 days)
- `agentvault mcp serve` (stdio+HTTP), all `hypervault_*` tools, wiki tools wired to transport, `hypervault push`.
- Companion hypervault PR #2: `POST /api/import/vault` (§4.3) → `hypervault restore --to hypervault`.
- Tests: MCP protocol conformance (initialize/tools list/call over stdio pipes), tool e2e against mocks.

### Phase 5 — Adapters, webapp, polish (3–4 days)
- Backbone `HyperVaultMemoryStore`/`HyperVaultKnowledgeStore`, `HyperVaultWikiStore`; webapp routes + dashboard card; macOS app MCP templates; hypervault PR #3 (archive receipts, §4.4).
- Docs: `docs/guides/hypervault.md`, README Quick Start section, `docs/architecture/` update, CHANGELOG; Docusaurus page on the three-tier model.
- Release: version bump, `v*` tag → `release.yml` npm publish. (Pre-check: `release.yml` uses bare `npm ci` while `AGENTS.md` mandates `--legacy-peer-deps` — align the workflow first.)

**Total: ~3 weeks** of focused work; Phases 0–2 (~1 week) already deliver the bootstrap one-liner.

---

## 9. Testing & Acceptance Criteria

- [ ] `npx agentvault@latest hypervault bootstrap my-agent --key hv_...` produces a project with pulled memories, built indices, working `.mcp.json` — from a clean machine with only Node 18+.
- [ ] `npx agentvault@latest hypervault archive --all --encrypt --network local --arweave` (local replica + Arweave mock) completes all 7 pipeline steps and `hypervault verify` passes on the result.
- [ ] `hypervault restore ar://<tx>` on a **different machine** reproduces byte-identical memory content and a passing verify — resurrection proven in CI e2e.
- [ ] Mind history survives round-trip: branch/merge structure and author provenance identical before export and after restore (`mind_diff` empty).
- [ ] All `hypervault_*` MCP tools pass protocol conformance and are invocable from Claude Code against the served process.
- [ ] No plaintext `hv_` key ever written to disk (test greps every file written by every command).
- [ ] Incremental flows: second `pull`/`archive` transfers only deltas (cursor-based) and remains verifiable.
- [ ] Existing suites stay green; new suites under `tests/hypervault/`, `tests/mcp-server/`.

---

## 10. Risks & Open Questions

| # | Risk / question | Position |
|---|---|---|
| 1 | **Embedding portability** — exported vectors are `text-embedding-3-small` (1536-d); local re-query needs a compatible embedder. | Ship FTS-first; vectors used when a provider is configured; store `embedding_model` and refuse cross-model mixing (same rule hypervault applies). |
| 2 | **Canister size** — a heavy account (artifacts) exceeds 64 MiB. | Artifacts always live on Arweave; canister stores pointers (§5.6). Memories-only DAG is small (text). |
| 3 | **Schema drift** — hypervault migrations move under us. | Version the export manifest (`schema_version`); client refuses newer-major exports; golden fixtures per version. |
| 4 | **Two mind implementations** (hypervault mind vs on-chain memory-repo) could diverge semantically. | Chain mirror is *derived*, never authored directly in v1 — hypervault stays the write master; on-chain authoring is a v2 question. |
| 5 | **hnswlib-node native dep** on a pure-TS CLI. | Optional/lazy import with pure-TS brute-force fallback below ~20k vectors (fine for typical accounts). |
| 6 | **Key custody for the archive JWK** (Arweave wallet). | Reuse `wallet` module (`--chain arweave` already exists) + secrets vault; document in security guide. |
| 7 | **Should conversations/messages be archived by default?** They're bulky and sensitive. | Default off (`--include conversations` opt-in), always encrypted when included. |
| 8 | **Hosted bridge** — run sync as a service at `agentvault.cloud` (domain already in hypervault's portfolio)? | Out of scope for v1; the CLI/MCP path proves the loop first. Noted as v2. |

---

## 11. Documentation Plan

- `docs/guides/hypervault.md` — end-to-end tutorial (bootstrap → chat → archive → resurrect).
- `docs/architecture/hypervault-integration.md` — the three-tier diagram + bundle format spec (normative).
- README: new "HyperVault" section with the two one-liners under Quick Start.
- `hypervault` repo README: "Sovereign archive with AgentVault" section linking back.
- `AI_DOCS/PRD_HYPERVAULT_INTEGRATION.md` — this document graduates there once approved; phase-completion notes follow the existing `PHASE*_IMPLEMENTATION_COMPLETE` convention.

---

## Appendix A — New/changed files at a glance

```
agentvault/
  src/hypervault/{index,types,client,auth,memory-store,knowledge-store,
                  wiki-store,snapshot,mind-sync,mcp-server}.ts
  src/hypervault/index/{vector-index,fts-index,builder,recall}.ts
  cli/commands/hypervault.ts          (new command group)
  cli/commands/mcp.ts                 (+ `serve` subcommand)
  cli/commands/init.ts                (+ --hypervault flag)
  src/security/vetkeys.ts             (C-1 fix)
  src/backup/thoughtform-bundle.ts    (+ snapshot-v1 recognition)
  package.json                        (+ ./hypervault export, @modelcontextprotocol/sdk,
                                        hnswlib-node optional)
  webapp/src/app/api/hypervault/*     (status/snapshot/archive routes)
  tests/hypervault/**, tests/mcp-server/**
  docs/guides/hypervault.md, docs/architecture/hypervault-integration.md

hypervault/  (companion PRs)
  app/api/export/route.ts             (PR 1 — bulk NDJSON export)
  mcp-server/.../server.py            (PR 1 — export_vault tool)
  app/api/import/vault/route.ts       (PR 2 — full-account restore)
  supabase/migrations/00xx_archive_receipts.sql + app/api/archive-receipts (PR 3)
```

## Appendix B — MCP tool surface after integration

| Server | Tools |
|---|---|
| `hypervault-mcp` (Python, upstream) | 19 existing (`save_to_hypervault`, `memorize`, `recall`, `mind_*`, …) + `export_vault` |
| `agentvault mcp serve` (native, new) | `hypervault_bootstrap`, `hypervault_pull`, `hypervault_push`, `hypervault_snapshot`, `hypervault_archive`, `hypervault_verify`, `hypervault_restore`, `hypervault_status`, `hypervault_recall_local`, `wiki_*` (10), `vault_show`, `vault_fetch`, `vault_health` |
