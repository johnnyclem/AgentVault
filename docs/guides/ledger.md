# Ledger — an on-chain record for agents hosted elsewhere

An agent that runs on an ordinary server keeps its memory in that server's
database. Whoever runs the server can lose it, and can change it without
anyone noticing. The ledger gives such an agent a second copy it cannot
quietly rewrite: the host sends every memory it saves and every action it
takes to an AgentVault gateway, which chains them and anchors them on a
`memory_repo` canister.

The host seals its records before sending them. The gateway, its disk and the
canister only ever hold ciphertext, so the ledger proves *what was recorded
and in what order* without being able to read it.

```
agent host (seals)  ──HTTPS──▶  agentvault ledger serve  ──signed commits──▶  memory_repo canister
                                  hash-chained JSONL                           certified receipts
```

## Run the gateway

```bash
export AGENTVAULT_LEDGER_TOKEN=$(openssl rand -hex 32)   # the host presents this
agentvault ledger serve
```

That stores entries in `~/.agentvault/ledger` (or `--dir`,
`$AGENTVAULT_LEDGER_DIR`) and listens on `127.0.0.1:8787`. The token is read
from the environment only, never a flag, and must be at least 32 characters.

To anchor on a canister, name one. It must already hold a repository
(`agentvault memory init`), and the signing principal must be its owner or
authorized on it (`agentvault memory authorize <principal>`):

```bash
agentvault ledger serve \
  --canister-id <memory_repo id> --ic-host https://icp-api.io \
  --anchor-interval 60
```

Anchors are signed like every other `memory_repo` write: `--identity <pem>`,
else `AGENTVAULT_ICP_IDENTITY_PEM_FILE` or `AGENTVAULT_ICP_IDENTITY_PEM`, else
dfx's selected identity ([signing identities](../memory-repo.md#signing-identities)).

The gateway speaks plain HTTP. Keep it on loopback or a private network next
to the host, or put TLS in front of it.

## What is stored

A ledger holds **streams**: one per agent, or however the host divides its
records. A stream is a sequence of entries numbered from 1.

```json
{"seq":2,"kind":"memory.revision","at":"2026-11-15T12:00:01.000Z","payload":"<base64url ciphertext>",
 "prev":"<hash of entry 1>","hash":"<hash of this entry>"}
```

`kind` and `at` are labels the host chooses and are not secret. `payload` is
opaque. Each entry's hash covers the one before it:

```
hash = SHA-256( "agentvault-ledger/v1" \n stream \n seq \n prev \n kind \n at \n SHA-256(payload bytes) )
```

`prev` is 64 zeros for the first entry. Changing, removing or reordering any
entry changes every hash after it.

On disk a ledger is a directory:

| File | What it is |
|---|---|
| `ledger.json` | format marker |
| `streams/<stream>.jsonl` | one chained entry per line, append-only |
| `anchors.jsonl` | one line per anchored range, with the canister's receipt |

One process owns a directory. An append is fsynced before it is acknowledged.
A crash can leave a partial last line; it was never acknowledged, and opening
the stream drops it. Any other line that does not parse or chain is treated
as corruption: the stream is refused, never repaired.

## Anchoring

Every `--anchor-interval` minutes (60 by default), and once more on a clean
shutdown, the gateway commits what is new in each stream to the `ledger`
branch of the canister (`--branch` to change it). One commit covers one
consecutive range of one stream:

```json
{"format":"agentvault-ledger-anchor/v1","stream":"bot-1","from":3,"to":7,
 "prev":"<hash of entry 2>","head":"<hash of entry 7>","entries":[ … ]}
```

With `entries` inline (the default) the canister holds a full copy: the range
can be rebuilt and re-verified from the chain alone. `--digest-only` leaves
them out and anchors only the hashes. That still proves the gateway held
exactly those entries, but restoring them needs the gateway's files.

Each commit's certified reply is kept as a receipt in `anchors.jsonl`, in the
same format as the webapp's [signed memory writes](../memory-repo.md), so it
can be checked against the Internet Computer's root key without trusting the
gateway.

`agentvault ledger anchor` runs one anchor pass and exits, for a cron job
instead of a long-running gateway.

### What is public

A `memory_repo` canister answers queries from anyone, so with entries inline (the default) everything
anchored is public and permanent: the ciphertext a host sent, and any wrapped keys it sent with it.
What keeps it private is the key the host sealed with, and nothing in the ledger can change that
later. A host that wants only a commitment on chain starts the gateway with `--digest-only`, which
publishes hashes and keeps the entries in the gateway's own files; the cost is that restoring then
needs those files.

### Capacity

One `memory_repo` canister holds at most 10,000 commits and 64 MB. An anchor
run makes one commit per stream that changed (more when a range exceeds
900 KB), so the interval decides how long a canister lasts: ten active agents
anchored hourly use about 240 commits a day and fill a canister in about six
weeks, and anchored daily they last close to three years. Full copies also
spend the 64 MB;
`--digest-only` spends almost none of it. When the canister is full its
commits are refused, the gateway reports the failure and keeps accepting
entries, and nothing stored is lost. Raising these limits, or rolling to a
fresh canister, is not automated yet.

## Check it

```bash
agentvault ledger status                      # each stream's length, head, and what is not anchored yet
agentvault ledger verify                      # re-derive every chain from disk
agentvault ledger verify --canister-id <id> --ic-host https://icp-api.io
```

`verify` exits 1 if any stream fails. With a canister it also reads each
anchored commit back (no key needed: queries are anonymous) and checks that
the canister's copy rebuilds to the anchored head, and that the ledger still
holds the entries that were anchored. An entry edited on disk after it was
anchored fails here even if someone recomputed the whole local chain.

The read-back is a query, so it trusts the replica that answers it. The
receipt in `anchors.jsonl` is the part that needs no trust: it carries the
canister's certified reply to the original commit.

## Rebuild from the canister

The gateway's disk is one copy of the ledger; the canister holds another, so if the disk is lost the
ledger can be brought back from the canister alone:

```bash
agentvault ledger rebuild --canister-id <id> --ic-host https://icp-api.io --dir ./recovered
AGENTVAULT_LEDGER_TOKEN=$(openssl rand -hex 32) agentvault ledger serve --dir ./recovered
```

It reads the `ledger` branch from its head back to the commit it forked from, takes each commit's
checkpoint, and chains the entries again from the first, checking every hash on the way. What it
writes is an ordinary ledger directory, so a host restores from it exactly as it would from the
original gateway. It records the anchors it came from, so a gateway serving the result carries on
from where the chain ends instead of anchoring it all again. Reads are anonymous queries: no key
is needed, and nothing is written to the canister.

What it can and cannot bring back:

- **Only what was anchored.** Entries appended since the last anchor run lived only on the gateway's
  disk. Shorten `--anchor-interval` for what must not be lost; a clean shutdown anchors what is
  pending.
- **Not ranges anchored with `--digest-only`.** Those commit only hashes, so the canister cannot
  give the entries back. Such a stream is rebuilt up to that range, and the command says so.
- **A stream with a range missing, or whose copies disagree**, is written as far as it can be
  trusted and the command exits 1 with the reason. Nothing it could not verify is written.
- **A canister's reply to a query comes from one replica.** It can leave the newest checkpoints out
  (the receipts in `anchors.jsonl` are the certified record of what was anchored); it cannot invent
  entries that chain. A host that sealed its entries, as the ledger expects, rejects any that it
  did not seal.

`--dir` has no default, so a live ledger is never written to by mistake, and a stream the directory
already holds is left alone.

## HTTP API

Every route but health needs `Authorization: Bearer <token>`.

| Route | Does |
|---|---|
| `GET /v1/health` | `{ ok, format, limits }` |
| `POST /v1/streams/<stream>/entries` | append `{ "entries": [{ seq, kind, at, payload }] }` |
| `GET /v1/streams?after=<stream>&limit=<n>` | the streams in id order, each with its head and anchored mark, and `next` to continue from (null at the end). A stream whose file is damaged is listed with `corrupt: true` |
| `GET /v1/streams/<stream>` | `{ head: { seq, hash }, anchored: { seq } }`, or 404 |
| `GET /v1/streams/<stream>/entries?after=<seq>&limit=<n>` | entries after `seq`, with their chain fields |

A read returns at most 500 entries and stops early at 8 MiB, so page with
`after` until it returns none.

A stream id is lowercase: `[a-z0-9][a-z0-9._-]{0,99}`. `kind` follows the same
pattern, up to 64 characters. `at` is an ISO 8601 UTC instant with
milliseconds. A payload is at most 256 KiB, an append at most 500 entries and
8 MiB.

Appends are idempotent. Entries the stream already holds are accepted when
they are identical, so a host that never saw the reply sends the same batch
again. Otherwise:

| Status | `error` | Meaning |
|---|---|---|
| 409 | `gap` | the batch skips ahead of the stream; `head` says where it ends |
| 409 | `conflict` | the batch differs from an entry already stored |
| 400 | `invalid` | malformed stream id, entry or body |
| 413 | `too_large` | body over 8 MiB |

A successful append returns `{ head, appended, anchored }`.

## What it does not do yet

- **Restoring an agent.** The gateway reads entries back, and `ledger rebuild`
  brings the gateway itself back from the canister; turning entries into an
  agent is the host's job (the ledger never reads what it holds).
- **Per-agent canisters and self-custody.** All streams of a gateway share one
  canister owned by whoever runs it. An agent whose owner holds the canister
  and the key is the next step, not this one.
- **Deletion.** A ledger is append-only. A host that must forget a record
  destroys the key it sealed that stream with; the ciphertext stays.
- **Several tokens.** One gateway serves one host.
