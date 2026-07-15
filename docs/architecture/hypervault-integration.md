# HyperVault Integration Architecture

This document describes how the `src/hypervault/` module bridges the HyperVault cloud mind with the AgentVault sovereign stack, and specifies the snapshot bundle format (normative).

## Three tiers of one mind

```
        ┌────────────────────────────────────────────┐
        │              hypervault.store               │
        │  Supabase Postgres: memories · mind DAG ·   │
        │  artifacts · connections · pgvector index   │
        │  REST API (X-HyperVault-Key) + GET /api/export
        └───────▲──────────────────────▲──────────────┘
                │                      │
     hypervault-mcp (19 tools)        │ HTTPS (typed client)
                │                      │
┌───────────────┴──────────────────────┴───────────────────┐
│                    AgentVault CLI / SDK                    │
│  src/hypervault/                                          │
│  ├── client.ts        typed REST over undici              │
│  ├── auth.ts          key resolution (env/vault/prompt)   │
│  ├── snapshot.ts      export → snapshot-v1 bundle         │
│  ├── index/           local FTS + vector indices          │
│  ├── memory/knowledge/wiki-store.ts  backbone adapters    │
│  ├── mind-sync.ts     mind DAG → memory_repo canister     │
│  ├── pipeline.ts      connect/pull/push/archive/restore   │
│  └── mcp-server.ts    native MCP server (agentvault mcp serve)
└──────────┬───────────────────────────────────┬────────────┘
           │ dfx / @dfinity/agent               │ arweave upload
           ▼                                    ▼
┌───────────────────────────┐      ┌──────────────────────────┐
│  ICP canister (warm)      │◀────▶│  Arweave (cold)          │
│  memory_repo: mind DAG    │recpt │  signed snapshot bundle  │
│  mirror + ThoughtForms    │ txid │  ed25519 manifest, State-│
│  + archive receipts       │      │  Hash tags               │
└───────────────────────────┘      └──────────────────────────┘
```

- **Hot (HyperVault):** the live, queryable mind. Agents write through MCP.
- **Warm (ICP canister):** the sovereign mirror. `memory_repo` holds the mind DAG; survives a HyperVault outage.
- **Cold (Arweave):** the permanent archive. A whole account is reconstructible from one tx id plus keys.

The chain mirror is **derived**, never authored directly (v1): HyperVault stays the write master.

## Module map

| File | Responsibility |
|---|---|
| `types.ts` | Zod-validated mirrors of the hypervault schema + export wire format + local state. |
| `client.ts` | `HyperVaultClient` — typed REST over undici, retry/backoff, NDJSON export streaming. |
| `auth.ts` | Key resolution chain (flag → env → vault) and the `hypervault.json` state file (keyRef only). |
| `snapshot.ts` | Build/verify the snapshot bundle; encryption via `CanisterEncryption`; restore to records. |
| `index/` | `FtsIndex` (pure-TS weighted inverted index), `VectorIndex` (cosine), `builder.ts`, `recall.ts` (RRF fusion). |
| `memory-store.ts`, `knowledge-store.ts`, `wiki-store.ts` | Backbone/wiki interface adapters over the cloud mind. |
| `mind-sync.ts` | Topological, idempotent DAG replay onto `memory_repo`; archive receipts. |
| `pipeline.ts` | The flows behind the CLI/MCP: connect, pull, push, snapshot, archive, verify, restore, status, recall, bootstrap. |
| `mcp-server.ts` | Native stdio JSON-RPC MCP server exposing `hypervault_*` + `wiki_*` tools. |

## Snapshot bundle format — `agentvault-hypervault-snapshot-v1` (normative)

A snapshot reuses the proven thoughtform-bundle envelope: `gzip(JSON({ format, createdAt, manifest, signature, publicKey, entries }))`, where `entries` maps a logical path to base64 content.

### Entries

```
manifest (in the envelope, not an entry) — HvExportManifest-derived metadata
memories.ndjson        — live memories (embeddings stripped into the sidecar)
mind/commits.ndjson    — memory_commits (full DAG incl. merge parents, author provenance)
mind/revisions.ndjson  — memory_revisions (full snapshots per change)
mind/branches.json     — memory_branches
mind/links.ndjson      — memory_links + memory_link_changes
artifacts/<hash>.html  — artifact content, content-addressed by content_hash
artifacts/index.ndjson — artifact metadata (slug, title, tags, visibility, entry pointer)
connections.ndjson     — artifact graph edges + memory_artifact_links
embeddings.bin         — packed float32 vectors (row-major)
embeddings.idx.json    — { dims, model, ids[] } sidecar for embeddings.bin
conversations.ndjson   — optional (--include-conversations), always encrypted
```

### Manifest fields

- `version`, `format`, `createdAt`, `schemaVersion`, `cursor`, `branchHeads`, `rowCounts`.
- `checksums` — SHA-256 (hex) of each entry's **plaintext** bytes.
- `merkleRoot` — Merkle root over all plaintext entries (`src/backup/merkle.ts` construction: sorted leaves, odd nodes promoted).
- `encryptedEntries` — entry paths stored encrypted.
- `encryption` — `{ mode, algorithm, salt, iterations }` when any entry is encrypted.
- `derived` — rebuild-only artifacts (never part of the integrity surface).

### Integrity chain

content SHA-256 per entry → Merkle root in manifest → ed25519 signature over the canonical (alphabetically-keyed) manifest, using `~/.agentvault/arweave-signing.key`. This mirrors `ArweaveArchiver.verifyBundle` semantics, so verification is uniform across the archive stack.

### Encryption

Entries are encrypted with `CanisterEncryption` (AES-256-GCM, validated auth tags — deliberately **not** the legacy `vetkeys.decryptJSON` path, whose C-1 auth-tag gap is fixed separately). The data key is derived from a passphrase via PBKDF2 (210k iterations, per-bundle random salt). Private artifacts and conversations are encrypted even when a snapshot-wide passphrase is not otherwise requested.

### Indices are derived, not archived

Local FTS/vector indices are always rebuildable from the snapshot, so they are listed as `derived` and are never part of the archived bundle's integrity surface. Cross-model embedding mixing is refused: the recorded `embedding_model` guards query-time compatibility.

## On-chain mirror mapping

| HyperVault | `memory_repo` canister |
|---|---|
| `memory_branches.name` | `createBranch` / `switchBranch` |
| `memory_commits` | `commit(message, diff, tags)` with the hypervault UUID, author provenance, and merge-parent recorded in `tags` (`hv:commit:<uuid>`, `hv:parent:…`, `hv:author:…`) |
| `memory_revisions` per commit | the commit `diff` payload (JSON of revision ops) |
| memory content at head | `storeThoughtForm` entries, content-addressed by hash |

Replay is topological (parents before children) and idempotent (commits whose UUID tag is already on-chain are skipped). Payloads over the on-chain chunk limit become content-hash pointers; large artifact blobs live on Arweave, and the canister stores `{ content_hash, arweave_tx }` pointers.
