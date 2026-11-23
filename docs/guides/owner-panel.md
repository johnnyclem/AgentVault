# Owner panel

A page in the webapp (`/owner`) for the person who owns a `memory_repo` canister: see how it is doing,
and change who may write to it, with the owner's key. The key never leaves the browser tab.

## Running it

```bash
NEXT_PUBLIC_ICP_NETWORK=mainnet npm run dev:webapp     # then open http://localhost:3000/owner
```

`NEXT_PUBLIC_ICP_NETWORK` is `local` unless set, and a production build bakes the value in, so build
with it set too. `NEXT_PUBLIC_ICP_LOCAL_URL` and `NEXT_PUBLIC_ICP_MAINNET_URL` change the hosts.

Type a canister id, or open `/owner?canister=<id>`.

## What it shows

Without a key, from queries anyone can make:

- the **state**: running, frozen, or killed
- the **owner**, the number of **writers**, the **commits** and the **heap**
- the **controllers** and the **code hash**, read from the subnet-certified state and checked against
  the Internet Computer's root key, so they do not depend on trusting a server

With the owner's key (or any controller's), the management canister also reports:

- **cycles**, how long they **last** at the idle burn the canister reports, that burn, and the memory used

## What it changes

Only the owner can, and only while the canister allows it:

| | Needs |
|---|---|
| **Freeze** / **Unfreeze** | running / frozen |
| **Authorize** a writer | running |
| **Remove** a writer (after a confirmation) | running |

The panel reads the canister again after every change, so what it shows is what the canister says.

## How the key is kept

- The key is read in the tab, held in memory, and used to sign calls that go straight to the Internet
  Computer. It is not written to browser storage or a cookie, not logged, and not sent to the
  webapp's server. **Lock**, a reload, or closing the tab forgets it. The box that took it is a
  password field, and is emptied as soon as the key is read.
- A key is accepted as a PEM, pasted (including one kept on a single line) or chosen as a file. Error
  messages never contain any part of it.
- The page and its code are checked, by a test, for browser storage, calls to the webapp's own API,
  `fetch` and the console. A browser test also records every request a full session makes: none
  carried either key, and the webapp's server received no request body.

What that does not protect against: **whoever can change the page's code can read what is typed
into it.** Run the webapp yourself, from a machine you trust, rather than from a shared host. The
panel is not a way to let a server operate on your behalf; that is what the gateway's separate
writer identity is for.

## Limits

- **Ed25519 keys only.** Keys made in the browser by Rakazo, and `openssl genpkey -algorithm ed25519`,
  work. A key from `dfx identity new` can be secp256k1 and is refused, with a message saying so.
- **No kill, revive, or transfer of ownership.** They are one-way enough to deserve a slower path:
  use `agentvault memory transfer-ownership` and the canister's `killCanister`/`reviveCanister`.
- **Writers cannot be listed**, only counted, because the canister reports no list. To remove one,
  type its principal.
- **A frozen or killed canister refuses to change its writers**, even for its owner: the canister
  runs those calls through the same write guard. If a writer's key is compromised, remove the writer
  first, then freeze. The panel disables the writer controls while frozen and says why.
- **"Lasts" is an estimate at the idle burn the canister reports.** On the first mainnet canister
  the balance fell about 13% faster than that over 34 minutes, so treat it as a ceiling.
- Checked, in a browser: the whole flow against a local replica, and on the first mainnet
  canister the public view, the owner's view, freezing and unfreezing, and authorizing and then
  removing a writer. The canister's state was identical before and after. Removing a *real* writer,
  and anything with a key that is not the owner's, were only checked on the replica.
