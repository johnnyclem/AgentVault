# HyperVault ⇄ AgentVault

[HyperVault](https://github.com/johnnyclem/hypervault) is the **living, cloud-hosted mind**: per-user memories with auto-tagging and a knowledge graph, git-versioned mind history ("Git for a Mind"), pgvector semantic search, and saved artifacts, all behind `hypervault.store`.

AgentVault is the **sovereign, permanent body**: ICP canisters with stable on-chain state, a git-style on-chain memory repo (ThoughtForms), ed25519-signed Arweave archival, and passphrase-based AES-256-GCM encryption.

The `agentvault hypervault` command group bridges them across three tiers of the same mind:

- **Hot (HyperVault / Supabase):** the live, queryable, multi-device mind.
- **Warm (ICP canister):** the sovereign mirror — the mind DAG replayed on-chain, survives a HyperVault outage.
- **Cold (Arweave):** the permanent archive — signed, content-addressed, verifiable bundles. A whole account is reconstructible from a single transaction id plus keys.

Every layer can rebuild the layer above it, and every write down the stack carries an integrity receipt back up.

## The two one-liners

```bash
# 1) Bootstrap a HyperVault-backed agent — memories, mind history, and indices included
npx agentvault@latest hypervault bootstrap my-agent --key hv_...

# 2) hypervault.store → fully secure, archived, blockchain-backed AgentVault
npx agentvault@latest hypervault archive --all --encrypt --network ic --arweave
```

Both are also exposed as MCP tools (`hypervault_bootstrap`, `hypervault_archive`) via the native `agentvault mcp serve` server, so any MCP-capable agent can invoke the full pipeline itself.

## Getting your key

Create an API key (`hv_...`) in your hypervault.store dashboard.

Keys flow **only** through the environment, the secrets vault, or an interactive prompt — never as a persisted CLI flag. `--key` is accepted for the one-liner UX, but it is immediately stored in the secrets vault and a warning suggests the env var next time. Preferred:

```bash
export HYPERVAULT_API_KEY=hv_...
agentvault hypervault connect
```

`connect` validates the key, stores it in the secrets vault (`hypervault_api_key`), and writes `.agentvault/hypervault.json` — which records only a **keyRef** (a vault pointer), never the key itself.

## Commands

| Command | What it does |
|---|---|
| `hypervault connect` | Validate the key, vault it, write `hypervault.json`. |
| `hypervault status` | The whole three-tier picture in one screen. |
| `hypervault bootstrap <project>` | Scaffold + connect + pull + build indices + wire MCP. |
| `hypervault pull` | Incremental export → local snapshot, working tree (`.agentvault/memories/`), and indices. |
| `hypervault push [--dry-run]` | Push locally edited memories up as provenance-stamped mind commits. |
| `hypervault snapshot [-o file] [--encrypt]` | Full export → `agentvault-hypervault-snapshot-v1` bundle on disk. |
| `hypervault archive` | The sovereign archive pipeline (see below). |
| `hypervault verify <ref> [--public-key <hex>]` | Verify a local snapshot bundle file: ed25519 manifest signature, per-entry SHA-256 checksums, Merkle root. Without `--public-key`, the signature is checked against the key embedded in the bundle. |
| `hypervault restore <ref> --to <local\|hypervault>` | Rebuild a project or a fresh cloud account from a bundle. |
| `hypervault reindex` | Rebuild local vector/FTS indices from the snapshot. |
| `hypervault recall "<query>"` | Offline hybrid (lexical + semantic) recall over local indices. |

## Flagship flow: bootstrap

```bash
npx agentvault@latest hypervault bootstrap my-agent --key hv_XXXX
```

1. **Scaffold** — project dir, `agent.json` (with a `hypervault` block), `index.js`, `.agentvault/`.
2. **Connect** — validate the key, vault it, write `hypervault.json` with a `keyRef`.
3. **Pull** — stream `/api/export` into `.agentvault/memories/` (one markdown file per memory) and a snapshot bundle.
4. **Build indices** — FTS always; vectors from exported embeddings when an embedding provider is configured.
5. **Wire MCP** — emit `.mcp.json` registering both `agentvault mcp serve` and the upstream `hypervault-mcp`.
6. **Soul detection** — a memory tagged `soul` (or `--soul <slug>`) is written to `soul.md`, activating the existing memory-repo soul path.

## Flagship flow: sovereign archive

```bash
npx agentvault@latest hypervault archive --all --encrypt --network ic --arweave
```

The pipeline prints a checklist as it runs:

1. **Export** — full (or `--since` incremental) NDJSON stream from `hypervault.store`.
2. **Bundle** — build the snapshot bundle; compute per-entry SHA-256 and a Merkle root.
3. **Encrypt** — AES-256-GCM per entry (via the audited `CanisterEncryption`), passphrase-wrapped.
4. **Canister commit** — replay the mind DAG onto a `memory_repo` canister (topological, idempotent). Only with `--canister-id`. The canister refuses anonymous writes, so the commits are signed with `--identity <pem>`, else `AGENTVAULT_ICP_IDENTITY_PEM_FILE`, else dfx's selected identity; with none of these, `archive --canister-id` exits before anything is archived. The principal must be the repo's owner or one it authorized (see [MemoryRepo](../memory-repo.md#who-can-write)).
5. **Arweave upload** — signed bundle tagged `App-Name: AgentVault`, `Agent-Name`, `Bundle-Format`, `State-Hash` and `Public-Key`.
6. **Receipts** — an on-chain `archive-receipt:<tx>` commit (only with `--canister-id`), plus an optional POST to hypervault.
7. **Verify** — re-fetch the bundle from Arweave and check that its manifest is signed by the key this run signed with, its per-entry checksums and its Merkle root.

It closes with the resurrection line:

```
✔ Archived. Resurrect anywhere with:
  npx agentvault@latest hypervault restore ar://<tx-id> --to local
```

## Resurrection

```bash
# chain → local working agent (memories + indices rebuilt)
npx agentvault@latest hypervault restore ar://<tx-id> --to local

# chain → fresh hypervault account (cloud mind rebuilt)
npx agentvault@latest hypervault restore ar://<tx-id> --to hypervault --key hv_NEW
```

## Security notes

- **Key handling:** `hv_` keys never touch argv persistence; `--key` is vaulted immediately and scrubbed from any persisted config. `hypervault.json` refuses to store anything that looks like a plaintext key.
- **Encryption:** all bundle encryption uses `CanisterEncryption` (AES-256-GCM with validated auth tags). Private artifacts and conversations are **always** encrypted, regardless of `--encrypt`.
- **Integrity chain:** content SHA-256 per entry → Merkle root in the manifest → ed25519 manifest signature. `hypervault verify` checks these three in a local snapshot file and exits non-zero if any of them fails; an encrypted bundle needs its passphrase to pass. Without `--public-key <hex>`, the signature is checked against the public key embedded in the bundle, so a pass shows only that the bundle is internally consistent: anyone who edits it can re-sign it with a key of their own. On such a pass the command prints the embedded key; compare it with yours, or pass `--public-key` to require a specific key. The signing key is a local file (`~/.agentvault/arweave-signing.key`), so even a pass with `--public-key` shows which key signed the bundle, not who holds it. The Arweave transaction and the `memory_repo` receipt commit (tag `archive-receipt:<tx>`) are recorded but not checked by `verify`.
- **Provenance:** hypervault `author_kind` / `author_key_prefix` travel into revision records, canister commit tags, and the manifest — "which agent wrote this memory" survives archival.

See [`docs/architecture/hypervault-integration.md`](../architecture/hypervault-integration.md) for the three-tier architecture and the normative bundle-format spec.
