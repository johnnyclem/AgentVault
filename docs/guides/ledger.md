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

`--canister-id` is where streams that name no place of their own are anchored.
A stream can name its own ([below](#several-owners-on-one-gateway)), and a
gateway given a replica (`--ic-host`) but no `--canister-id` anchors only those.

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

## A canister its owner holds

By default whoever runs the gateway also owns the canister it anchors to, so the host that could
rewrite the gateway's disk also holds the on-chain copy. To keep the record with someone else, the
owner holds the canister and the gateway is only allowed to write to it. Each step is run by the
person named:

```bash
# The owner: create the canister with their own identity, so they control it, and initialize it.
# --no-wallet makes the identity itself the creator and controller.
dfx deploy memory_repo --identity owner --no-wallet
agentvault memory --canister-id <id> --host https://icp-api.io --identity owner.pem init soul.md

# The host: a key of its own, and its principal (the principal alone goes to stdout).
agentvault memory whoami --identity gateway.pem

# The owner: allow that principal to write.
agentvault memory --canister-id <id> --host https://icp-api.io --identity owner.pem authorize <gateway principal>

# The host: run the gateway as that identity.
agentvault ledger serve --canister-id <id> --ic-host https://icp-api.io --identity gateway.pem
```

**What an authorized gateway can and cannot do.** Checked against a local replica running this
canister's code:

| It can | It cannot |
|---|---|
| Create branches and add commits to them | Authorize or deauthorize anyone, freeze or unlock writes, switch the canister off or on (owner only: the canister traps) |
| | Replace or reinstall the canister's code, stop it, delete it, or add a controller (controllers only: the Internet Computer rejects it) |
| | Rewrite or remove a commit: a branch only ever moves forward by adding one, and `rebase` writes a new branch |

**What the owner can do.** `agentvault memory deauthorize <principal>` stops the gateway at once: its next
anchor is refused, the entries it already holds stay on its disk, and once the owner authorizes it
again the backlog is anchored. `freeze` and `manualUnlock` (call them with `dfx canister call`) stop
and resume every writer. Reading needs no key, so the owner can always `ledger rebuild` from the
canister whatever the host does.

**What delegation does not protect.**

- A writer can fill the canister (10,000 commits, 64 MB), after which anchoring fails for everyone.
  Revoke it and start a new canister; rolling over is not automated.
- A writer can add a checkpoint that is wrong. `ledger rebuild` reports it (a commit that is not a
  checkpoint, or anchors that disagree) and it cannot erase the honest ones.
- Everything on a canister is public ([What is public](#what-is-public)); sealing is what keeps it
  private.
- The canister's **controllers**, not its repository owner, decide who can replace its code and so
  erase it. Whoever created the canister is a controller, so the owner should be the one who ran
  `dfx deploy`.

**Checking it.** The controllers are published by the Internet Computer in a certificate the subnet
signs, so anyone can look without a key, and without trusting the host:

```bash
agentvault ledger check --canister-id <id> --ic-host https://icp-api.io --identity gateway.pem
```

It reports who controls the canister, who owns the repository, whether writes are frozen or the
canister is off, and the role the gateway holds (`--identity` only names it; no key is used to
read). It warns when anyone besides the owner controls the canister, or when the gateway signs as
the owner, and it fails (exit 1) when nothing can be anchored: no repository, the canister off, or
nobody authorized. `--strict` fails on warnings too. `ledger serve` and `ledger anchor` run the same
check at start and print any warning, so a gateway that is not authorized yet says so at once
instead of at the end of its first interval. The canister does not say *which* principals are
authorized, only how many, so the check cannot tell you the gateway is one of them: the first
anchor is refused, with the command to run, if it is not.

## Several owners on one gateway

A hosted service can keep every owner's record in a canister that owner holds without running a
gateway for each. A stream names the canister it is anchored to, and the gateway signs as one
identity that every owner has allowed on their own canister, as [above](#a-canister-its-owner-holds).

```bash
# Give the gateway a replica and an identity. With no --canister-id it anchors only streams that name a canister.
agentvault ledger serve --ic-host https://icp-api.io --identity gateway.pem
```

The host asks the gateway which identity an owner has to allow, and names each stream's canister:

```
GET    /v1/identity                      → { "principal": "<what the owner runs `memory authorize` with>" }
PUT    /v1/streams/<stream>/anchor       { "destination": "<canister id>" }
GET    /v1/streams/<stream>/anchor       → { destination, named, anchoredSeq, headSeq, error }
DELETE /v1/streams/<stream>/anchor       back to the default canister, or none
```

The stream need not hold entries yet, so a host can name the canister before it sends the first one.
What follows, checked against local replicas with two owners and one gateway:

- **How far a stream is anchored is counted at each canister.** Moving a stream anchors all of it at
  the new canister, from its first entry, so that canister can be rebuilt on its own. The old one
  keeps what it holds: a canister cannot be told to forget.
- **A canister that refuses, or cannot be reached, holds up only the streams that use it.** The
  others are anchored in the same pass, and the failures are reported together. An owner who
  revoked the gateway sees nothing happen to anyone else.
- **`GET …/anchor` says why a stream is behind**, in the words the canister gave, including the
  `memory authorize` command the owner has to run. It is empty once the stream catches up, which it
  does by itself when the owner allows the gateway again.
- **A stream with no canister, on a gateway with no default, is not anchored.** `ledger status` shows
  it as not anchored.
- **`ledger verify --ic-host`** reads each anchor back from the canister it names (`--canister-id`
  limits it to one), and `ledger rebuild` from an owner's canister returns only that owner's streams.
- The gateway needs a token that lets a host choose where its streams are anchored, so that token
  belongs to the host and not to the owners.

## Creating a canister for an owner

For an owner who is not running `dfx`, the gateway can make the canister and hand it over. The host
asks with the owner's principal; the gateway creates a canister, pays for it, installs `memory_repo`,
makes the owner its repository owner and its only controller, and keeps a writer's access for itself.
The owner's record is then somewhere the host can write to but cannot rewrite, take down or hand to
someone else.

```bash
# Build the code once: dfx build memory_repo --network ic → .dfx/ic/canisters/memory_repo/memory_repo.wasm
agentvault ledger serve --ic-host https://icp-api.io --identity gateway.pem \
  --provision-wasm memory_repo.wasm --max-canisters 500 --provision-cycles 1
```

This is off unless asked for, and it spends the gateway's cycles, so `--max-canisters` is required: it
is the most canisters this gateway will ever create. `--provision-cycles` (trillions, from 0.75 to 20,
default 1) is what each is funded with, and the amount is fixed here, never taken from a request. On
the Internet Computer the gateway's identity pays from its **cycles ledger balance**: convert ICP with
`dfx cycles convert`, then send cycles to the gateway's principal (`GET /v1/identity` or
`agentvault memory whoami --identity gateway.pem`) with `dfx cycles transfer`. A local replica has no
cycles ledger, so there the management canister's provisional API pays instead.

What it costs, as observed on the Internet Computer on 2026-11-23: the network takes its charge for
creating a canister out of what the canister is sent. One was created with 1 trillion cycles and held
0.498 trillion afterwards (after its installation and one anchor), so about 0.5 trillion went on
creating and setting it up. That is close to the 0.5 trillion the
[cost page](https://docs.internetcomputer.org/building-apps/essentials/gas-cost) gives for a 13-node
subnet; which subnet this canister landed on was not checked. The cycles ledger also takes 100 million cycles per creation from the gateway's
balance, on top of the amount, so each canister costs the gateway 1.0001 trillion at the default. That
is why the minimum is 0.75 trillion: it leaves a canister at least about 0.25 trillion to run on. The
floor is inferred from that one creation and the cost page; creating below it was not tried, and the
default of 1 is the value that was used. That canister reports an idle burn of about 1.0 billion cycles
a day at 5.7 MB, and its balance fell by about 1.14 billion a day over 34 minutes, so it lasts about
14 months at that size, and storage adds to it (the cost page lists about 4 trillion per GiB-year).
Why it burns more than it reports was not found.

```
POST /v1/canisters          { "key": "order-1042", "owner": "<principal>" }   → 202 while it is made, 200 when ready
GET  /v1/canisters/<key>    { key, owner, state, canisterId, moduleHash, error }
```

`state` is `pending`, `ready` or `failed`. The key is the host's own idempotency key: ask again with it
and nothing is made twice, and a request that failed is picked up from the step it stopped at. The
steps are separate calls to the Internet Computer, so each run reads what the canister already is and
does only what is missing. Once `ready`, the host names the canister for the owner's streams
([above](#several-owners-on-one-gateway)) and the owner allows nothing more: the gateway is already a
writer.

| After the handover the host can | The host cannot |
|---|---|
| Write commits and branches (it is an authorized writer) | Authorize or deauthorize anyone, freeze, or switch the repository off: owner only |
| Top the canister up with cycles (no control needed) | Reinstall, stop or delete the canister, or change its controllers: the Internet Computer refuses |

Checked against a local replica, and once on the Internet Computer (below): the owner ends as the repository's owner and the canister's only
controller; the gateway can write but is refused every one of the rest; an interrupted run resumes on
the same canister; and `ledger check` on the result says only the owner controls it. The code a
canister was installed with is shown by `ledger check`, and its hash is printed when the gateway
starts, so an owner can compare the two.

What to know:

- **Nothing tops a canister up later.** It starts with the cycles above, which last about 14 months
  at the size the first one had; the host (or the owner) can send more at any time. Letting the gateway
  do it is not built.
- **Upgrading is the owner's job.** They are the only controller, so a new `memory_repo` is theirs to
  install.
- **The cycles ledger path has been run once, on the Internet Computer.** On 2026-11-23, from the build
  that merged this feature, one canister was created for a separate owner key with
  `--max-canisters 1 --provision-cycles 1`; it was `ready` about 30 seconds after the request. What
  was observed: the gateway's cycles ledger balance fell by exactly 1.0001 trillion in that one
  creation (the 1 trillion plus the ledger's 100 million fee); `ledger check` and the canister's own
  status showed the owner as the only controller and the installed code hash equal to the wasm's;
  asked for the canister's status, the owner was answered and the gateway was refused ("not allowed to
  read the canister status"); and the gateway's first anchor was accepted. That last one is the only
  way to see that the gateway is a writer, because the canister reports how many writers it has, not
  who they are. It is one creation from one build on one day: evidence that this works, not a
  guarantee, and it tried neither a second canister nor any failure. The identities involved are not
  published here. Do the same before relying on it with your own build: keep the build and its
  `memory_repo` hash (printed at start), the gateway's cycles ledger balance before and after, the
  `POST` and `GET` answers, `ledger check`, and the first accepted anchor.
- **A crash between creating a canister and writing its record** can leave one canister the gateway
  does not know about. On the cycles ledger, retrying with the same creation time lets the ledger
  answer `Duplicate` with the canister it made, which is returned instead of paying again. That reply
  was observed on the Internet Computer: replaying the identical creation call returned `Duplicate`
  carrying the canister's id, the gateway's handler returned that same canister, and nothing was
  charged. The replay was made with too little balance left to pay for a second canister, so it could
  not have created one. An actual crash between creating the canister and saving its record was not
  staged. The ledger only recognizes a repeat for about a day, after which it answers `TooOld` and the
  gateway stops and says so rather than risk paying twice; that was not tried. Off the cycles ledger
  there is no such check; the canister stays under the gateway's control and its cycles can be
  recovered.
- The token that can ask for canisters can spend the gateway's cycles, so it belongs to the host.

## Selling canisters for ICP

A gateway that creates canisters can also let people pay for them, in ICP, from any wallet. A host asks
for an order, shows the buyer where to send ICP and how much, and the gateway does the rest: it turns the
ICP into cycles and has the canister created and handed over, as above. Nobody has to hold an account
with the host or the gateway, and the gateway converts what an order receives as soon as the order is paid.

```bash
agentvault ledger serve --ic-host https://icp-api.io --identity gateway.pem \
  --provision-wasm memory_repo.wasm --max-canisters 20 --provision-cycles 1 \
  --order-price-xdr 2
```

`--order-price-xdr` is the price in XDR, the unit cycles are priced in (one XDR is one trillion
cycles). It must be at least what a canister costs the gateway (the cycles it is created with and the
cycles ledger's fee), and at most 1,000. The buyer pays in ICP: the price at the rate the cycles minting
canister states, rounded up, plus the ledger fee for the transfer that mints. With the rate seen when this
was written (1 ICP = 1.4723 XDR), 2 XDR is about 1.3585 ICP. Because the price is set in XDR, what the
gateway earns does not move with ICP's price in dollars. Orders need the Internet Computer: the ICP ledger
and the minting canister are not on a local replica.

```bash
curl -s -X POST localhost:8787/v1/orders -H "authorization: Bearer $AGENTVAULT_LEDGER_TOKEN" \
  -d '{"key":"order-1","owner":"<owner principal>"}'
```

```json
{
  "key": "order-1", "owner": "…", "state": "awaiting_payment",
  "deposit": { "owner": "<the gateway>", "subaccount": "<64 hex>", "accountId": "<64 hex>" },
  "price": { "e8s": "135851881", "expiresAt": "2026-11-23T04:06:28.545Z" },
  "paidE8s": "0", "shortfallE8s": "135851881", "canisterId": null, "error": null
}
```

The buyer sends ICP to `deposit.accountId` (a wallet or exchange that takes an ICP account identifier) or
to the `owner` and `subaccount` (an ICRC-1 account). Each order has an account of its own, made from its
key, and only the gateway can move what is sent there. `GET /v1/orders/<key>` says where it has got to:

| `state` | |
|---|---|
| `awaiting_payment` | the account holds less than `price.e8s`; `shortfallE8s` is the difference, and sending the rest to the same account completes it |
| `converting` | the ICP is being sent to the minting canister, and cycles minted from it |
| `provisioning` | the canister is being created, installed and handed over |
| `ready` | `canisterId` is the owner's |
| `failed` | something no retry will change went wrong after payment; `error` says what, and the operator has to look |
| `expired` | nothing was paid within a week |

How it behaves:

- **A quote holds for `--order-quote-minutes` (30), and five minutes more.** A payment seen inside that
  time is taken at the quoted amount, even if ICP has moved since. After it, the price is worked out
  again at the current rate. Once an unpaid order's quote has run out, asking for the same order again gives a new one.
- **An overpayment is converted whole**, and the extra stays with the gateway as cycles. Nothing is
  refunded.
- **Orders count against `--max-canisters` when they are opened**, so nobody can pay for a canister the
  gateway is no longer allowed to create.
- **Each step is written down before it is taken.** The transfer to the minting canister is sent with a
  creation time fixed in the order, so a restart repeats the same transfer, which the ledger recognizes
  and answers with the block it already made, instead of paying twice. Minting from a block is asked
  again until it answers. The canister's creation is the same safe, resumable process as above, and is
  started again after a restart.
- **The ledger only recognizes a repeated transfer for a day.** If an order cannot be converted for longer
  than that, it fails with `TxTooOld` rather than risk sending twice; check the order's account and the
  minting canister's account before trying again.
- **ICP that arrives after an order has expired, or after its conversion started, is not converted.** It
  stays in the order's account. Sending it back is by hand, from that subaccount of the gateway's account.

What was checked, and what was not:

- The account derivation reproduces two real addresses: the account an earlier deposit to this gateway was
  sent to, and the minting canister's account for it that the same gateway's conversion went to.
- Against the Internet Computer, from the code in this repository, read-only: the rate, an account's
  balance (both through the interfaces the canisters publish), and an order opened and watched, which
  stayed `awaiting_payment` and called nothing that spends.
- The calls that spend, the transfer to the minting canister and the request to mint, are built to the
  published interfaces and tested against replies encoded as the canisters send them (including the
  `TxDuplicate` reply, whose payload is read). **They have not been run with real ICP.** Before relying on
  this, make one small purchase with your own build and keep the order's `GET` answers, the ledger block,
  and the gateway's cycles ledger balance before and after.

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
| `GET /v1/identity` | `{ principal, provisioning, orders }`: the identity the gateway anchors as, whether it was started with `--provision-wasm`, and whether with `--order-price-xdr`; 404 `anchoring_not_configured` when it has no replica |
| `POST /v1/canisters`, `GET /v1/canisters/<key>` | create a canister for an owner and hand it over, and say where that has got to; 404 `provisioning_not_configured` unless started with `--provision-wasm`; see [above](#creating-a-canister-for-an-owner) |
| `POST /v1/orders`, `GET /v1/orders/<key>` | sell a canister for ICP: say where to pay and how much, and where the order has got to; 404 `orders_not_configured` unless started with `--order-price-xdr`; see [above](#selling-canisters-for-icp) |
| `GET`, `PUT`, `DELETE /v1/streams/<stream>/anchor` | where a stream is anchored and how far, naming it (`{ destination }`), and putting it back with the rest; 409 `anchoring_not_configured` without a replica, 400 for a destination that is not a canister id |

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
- **Topping canisters up.** A canister it creates for an owner
  ([above](#creating-a-canister-for-an-owner)) starts with the cycles you set and
  runs on them; nothing sends more later.
- **Refunds.** An overpayment, a payment after an order expired, and ICP sent for an order that failed all
  stay in the order's account on the gateway. Returning them is by hand.
- **Deletion.** A ledger is append-only. A host that must forget a record
  destroys the key it sealed that stream with; the ciphertext stays.
- **Several tokens.** One gateway serves one host.
