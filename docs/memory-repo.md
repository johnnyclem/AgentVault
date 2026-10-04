# MemoryRepo

MemoryRepo is a git-style version-controlled memory system built as an ICP canister. It gives agents persistent, branching, auditable memory — anchored by a genesis commit from a `soul.md` document.

## Architecture

MemoryRepo runs as a separate canister (`memory_repo`) alongside the main `agent_vault` canister:

- **Independent upgrade cycles** — upgrade memory without touching agent execution
- **Separate cycle budgets** — memory operations don't compete with WASM execution
- **Clean separation** — agent execution vs. memory versioning are distinct concerns

## Concepts

### Commits

Every state change is recorded as a commit:

```
{ id, timestamp, message, diff, tags, parent, branch }
```

- **id**: Auto-generated (`c_<timestamp>_<index>`)
- **diff**: The actual content/state change
- **tags**: Labels for categorization (e.g., `chat`, `config`, `soul`)
- **parent**: Previous commit ID (null for genesis)

### Branches

Branches are named pointers to commit IDs. Every repo starts with a `main` branch.

```bash
# List branches
agentvault memory branch

# Create a new branch
agentvault memory branch experiments

# Switch branches
agentvault memory checkout experiments
```

### Genesis Commits

The first commit in a repository is the genesis commit, created from a `soul.md` document. This establishes the agent's baseline configuration:

```bash
agentvault memory init soul.md
```

### Rebase

Rebase creates a new branch with a new genesis commit (from a new `soul.md`), then replays all non-genesis commits. The original branch is preserved:

```bash
agentvault memory rebase --from-soul new-soul.md
```

This creates a `rebase/<timestamp>` branch with the replayed history.

### Merge

Merge brings commits from one branch into another:

```bash
# Auto merge (fails on conflicts)
agentvault memory merge --from-branch feature

# Manual merge (returns all commits for cherry-picking)
agentvault memory merge --from-branch feature --strategy manual
```

**Conflict detection**: Two commits conflict if they share overlapping tags but have different diffs.

### Cherry-Pick

Pick individual commits from any branch:

```bash
agentvault memory cherry-pick c_1234567890_3
```

## Who can write

The canister answers queries from anyone, but refuses every write (every update call) from the anonymous
principal. Two kinds of principal can write:

- **The owner:** the principal that called `initRepo` first (`agentvault memory init`). `agentvault memory status`
  shows it.
- **Authorized principals:** the ones the owner added with `addAuthorizedPrincipal`
  (`agentvault memory authorize <principal>`). Only the owner can add or remove them.

A write from any other principal traps with `caller principal is not authorized`. AgentVault reports that as
`SIGNER_NOT_AUTHORIZED` (403 from the webapp), with a message that names the principal and the `authorize`
command the owner can run. A frozen or killed repo refuses all writes until the owner calls `manualUnlock` or
`reviveCanister`; the webapp answers 423 `REPO_FROZEN` or `REPO_KILLED`. A canister built from a
`memory-repo.mo` older than this release has no `commitToBranch` method, which the webapp's routes need: they
answer 502 `MEMORY_REPO_OUTDATED` until the canister is upgraded (see [Deployment](#deployment)).

### Signing identities

AgentVault signs every write with a key loaded from a PEM file, in the format `dfx identity export <name>` (or
icp-cli) writes:

- secp256k1, as SEC1 (`-----BEGIN EC PRIVATE KEY-----`, with or without a leading `EC PARAMETERS` block) or
  PKCS#8. This is the key type `dfx identity new` creates by default.
- Ed25519, as PKCS#8 (`-----BEGIN PRIVATE KEY-----`), including the form older dfx releases wrote.

Encrypted PEMs are refused: AgentVault never asks for or stores a passphrase. Keys on other curves or algorithms
(P-256, brainpool, RSA, DSA and so on) and secp256k1 keys with an out-of-range private scalar are refused as well.
AgentVault never logs key material or puts it in an error message.

Keep an exported key outside your project, readable only by you. A plain `dfx identity export <name> > <name>.pem`
writes it into the current directory, usually the project, with the default mode (0644 under the usual umask),
where `git add .` would pick it up. Export it like this instead:

```bash
(umask 077; mkdir -p ~/.config/agentvault && dfx identity export <name> > ~/.config/agentvault/<name>.pem)
```

AgentVault loads a key file that users other than its owner can read or write, but warns about it: the CLI on
stderr, the webapp in its server log (once per file). The repository's `.gitignore`, and the one
`agentvault init` writes, ignore `*.pem`.

**CLI.** The first of these that is set up is used:

1. `--identity <pem>`, the path of a PEM file. It takes a path, not a dfx identity name; `--identity alice` with
   no file called `alice` tells you how to export the dfx identity `alice` instead.
2. `AGENTVAULT_ICP_IDENTITY_PEM_FILE`, the same path from the environment.
3. dfx's selected identity: the name in `~/.config/dfx/identity.json` (`default` when that file is missing) and
   its key in `~/.config/dfx/identity/<name>/identity.pem`. `DFX_CONFIG_ROOT` replaces the home directory, as
   it does for dfx. dfx's `anonymous` identity counts as no identity.

A source that is set but cannot be used (a missing file, an encrypted or unsupported key, a dfx identity whose
key is password-protected or kept in the system keyring) is an error; AgentVault does not fall through to the
next source. For a password-protected or keyring dfx identity, export it as shown above and pass
`--identity ~/.config/agentvault/<name>.pem`. `ICP_IDENTITY` does not select the signing identity.

Every write command prints `Signing as <principal> (<source>)` before it calls the canister. With no identity
configured it prints what to set up and exits 1 without calling the canister. The commands that sign are
`memory init`, `commit`, `branch <name>`, `checkout`, `rebase`, `merge`, `cherry-pick`, `authorize` and
`deauthorize`, the top-level `agentvault merge`, and `agentvault hypervault archive` when it is given
`--canister-id` (each takes `--identity`). Reads (`memory log`, `status`, `branch` with no name, `show`, and the
top-level `agentvault rebase`) stay anonymous and need no identity.

**Webapp server.** The webapp's memory_repo write routes (`POST /api/memory-repo/commits` and
`POST /api/memory-repo/tombstone`) read the environment only, never the home directory of the user the server
runs as:

- `AGENTVAULT_ICP_IDENTITY_PEM_FILE`: the path of a PEM file, or
- `AGENTVAULT_ICP_IDENTITY_PEM`: the PEM text itself, for hosts with no filesystem to mount a key on (Vercel,
  for example). PEM text stored on one line with literal `\n` sequences is accepted.

Set one of them, not both. With neither, the write routes answer 503 `SIGNING_IDENTITY_NOT_CONFIGURED` with
setup guidance, without calling the canister. A key that cannot be loaded, for whatever reason, gets 503
`SIGNING_IDENTITY_INVALID`; the reason goes to the server log only. `GET /api/memory-repo/branches/:branch` only
queries the canister and stays anonymous.

The webapp never passes these variables on to the Polytician processes it starts (nor `AGENTVAULT_MNEMONIC`,
`AGENTVAULT_PRIVATE_KEY`, `AGENTVAULT_PASSWORD` or `AGENTVAULT_BUNDLE_SECRET`): Polytician reaches memory_repo
through the webapp's API, and a key that reached another process could not be revoked by rotating the API token.
The CLI and `orchestrate` withhold them the same way.

These routes are the ones Polytician's AgentVault client calls, so every error they return is in the shape that
client reads: `{ "success": false, "code": "<CODE>", "error": "<CODE>: <message>" }`, with `error` a string that
starts with the code (Polytician passes on only that string). The same goes for `/api/archival/upload`,
`/api/inference` and `/api/secrets/:name`, and for the 401 the API answers on those paths when the token is
wrong. The webapp's other routes keep their `error: { message, code }` object.

The replica's root key is fetched only for a local replica (a host of `localhost`, `*.localhost`, `127.0.0.1` or
`[::1]`); any other host is verified against the IC root key.

### Setting up the webapp's identity

Give the webapp its own identity rather than the owner's key, so its access can be revoked without touching the
owner's:

```bash
# 1. As the owner (here, dfx's selected identity), initialize the repo once
agentvault memory init soul.md
# Signing as <owner principal> (dfx identity 'default')
#   Owner: <owner principal>

# 2. Create an identity for the webapp and export its key, outside the project and owner-only
dfx identity new agentvault-webapp --storage-mode plaintext
(umask 077; mkdir -p ~/.config/agentvault && dfx identity export agentvault-webapp > ~/.config/agentvault/agentvault-webapp.pem)

# 3. Print its principal (the principal alone goes to stdout)
agentvault memory whoami --identity ~/.config/agentvault/agentvault-webapp.pem

# 4. As the owner, let it write
agentvault memory authorize "$(agentvault memory whoami --identity ~/.config/agentvault/agentvault-webapp.pem)"
```

Then give the webapp the key and the canister:

```bash
MEMORY_REPO_CANISTER_ID=<memory_repo canister id>
AGENTVAULT_ICP_IDENTITY_PEM_FILE=/etc/agentvault/agentvault-webapp.pem   # owned by the server's user, mode 600
# or, on a host without a filesystem: AGENTVAULT_ICP_IDENTITY_PEM="$(cat ~/.config/agentvault/agentvault-webapp.pem)"
# ICP_LOCAL_URL=http://localhost:4943   # only for a local replica; the default is https://ic0.app
```

`agentvault memory deauthorize <principal>` revokes it. The routes read these variables on every request.

### Branches and concurrent writers

The canister's current branch (`switchBranch`, `agentvault memory checkout`) is one setting for the whole repo,
shared by every writer. Switching to a branch and then committing takes two calls, and another writer can switch
in between, so the commit lands on its branch instead. The webapp serves many requests at once, so its routes
never use the current branch:

- `POST /api/memory-repo/commits` commits with `commitToBranch(branch, message, diff, tags)`, which appends to the
  named branch in one call. A branch that does not exist yet is created with `createBranchFrom(branch, "main")`,
  so a new sync branch such as `polytician-main` starts from `main` and not from whatever branch was current. Two
  pushes creating the same branch at once are fine. The response's `timestamp` is the commit's own.
- `POST /api/memory-repo/tombstone` commits with `commitToBranch` too, and answers 404 `BRANCH_NOT_FOUND` for a
  branch that does not exist.
- The top-level `agentvault merge` commits its merged snapshot with `commitToBranch` onto `--branch`.

None of them moves the current branch. `agentvault memory commit`, `merge`, `cherry-pick` and `rebase` still work
on the current branch, as git does, and `memory commit` prints the branch the canister recorded the commit on.

## CLI Reference

Every `memory` subcommand takes these options:

| Option | Description |
|--------|-------------|
| `--canister-id <id>` | MemoryRepo canister ID (else `MEMORY_REPO_CANISTER_ID`, else `canister_ids.json`) |
| `--host <url>` | Replica host (else `ICP_LOCAL_URL`, else `http://localhost:4943`) |
| `--identity <pem>` | PEM key to sign writes with (else `AGENTVAULT_ICP_IDENTITY_PEM_FILE`, else dfx's selected identity) |

### `memory init [soul-file]`

Initialize a new memory repository from a soul document. The signing identity becomes the repo's owner.

| Option | Description |
|--------|-------------|
| `soul-file` | Path to soul.md (default: `soul.md`) |

### `memory commit <message>`

Create a new commit on the current branch.

| Option | Description |
|--------|-------------|
| `-d, --diff` | Diff content (required) |
| `-t, --tags` | Comma-separated tags |

### `memory log`

Show the commit log.

| Option | Description |
|--------|-------------|
| `--branch` | Branch name (default: current) |
| `--json` | Output raw JSON |

### `memory status`

Show repository status: initialization state, current branch, commit/branch counts, owner.

### `memory branch [name]`

List all branches (no argument) or create a new branch.

### `memory checkout <branch>`

Switch the current branch.

### `memory show <commit-id>`

Display full details of a specific commit, including its diff.

| Option | Description |
|--------|-------------|
| `--json` | Output raw JSON |

### `memory rebase`

Rebase onto a new soul document.

| Option | Description |
|--------|-------------|
| `--from-soul` | Path to new soul.md (required) |
| `--branch` | Source branch (default: current) |

### `memory merge`

Merge commits from another branch.

| Option | Description |
|--------|-------------|
| `--from-branch` | Branch to merge from (required) |
| `--strategy` | `auto` (default) or `manual` |

### `memory cherry-pick <commit-id>`

Cherry-pick a single commit onto the current branch.

### `memory whoami`

Print the principal of the configured signing identity, and nothing else, on stdout, so
`$(agentvault memory whoami)` can be passed on. The key type and where it was loaded from go to stderr. Exits 1
with guidance when no identity is configured. It does not call the canister.

### `memory authorize <principal>` / `memory deauthorize <principal>`

Let a principal write to the repo, or revoke it. The canister accepts these from the owner only, so they must
be signed by the owner's identity. A malformed principal is refused before anything is sent.

## Canister API

The Motoko canister exposes these methods:

| Method | Type | Description |
|--------|------|-------------|
| `initRepo(text)` | update | Initialize with soul content |
| `commit(text, text, vec text)` | update | Create commit (message, diff, tags) |
| `log(opt text)` | query | Get commit log for branch |
| `getCurrentState()` | query | Get HEAD commit diff |
| `getRepoStatus()` | query | Get repo status |
| `getBranches()` | query | List all branches |
| `createBranch(text)` | update | Create new branch at the current branch's HEAD |
| `createBranchFrom(text, text)` | update | Create a branch (name) at another branch's (base) HEAD |
| `switchBranch(text)` | update | Switch current branch |
| `commitToBranch(text, text, text, vec text)` | update | Commit onto a named branch (branch, message, diff, tags) without moving the current branch |
| `getCommit(text)` | query | Get commit by ID |
| `rebase(text, opt text)` | update | Rebase with new soul |
| `merge(text, MergeStrategy)` | update | Merge branch |
| `cherryPick(text)` | update | Cherry-pick commit |
| `addAuthorizedPrincipal(principal)` | update | Let a principal write (owner only) |
| `removeAuthorizedPrincipal(principal)` | update | Revoke a principal (owner only) |
| `getSecurityStatus()` | query | Owner, frozen and killed flags, authorized principal count |

Every update call refuses the anonymous principal (see [Who can write](#who-can-write)).

## Deployment

```bash
# Add to dfx.json (already configured). dfx.json sets a wasm_memory_limit, and dfx
# will not create a canister with one through the cycles wallet, so create it first:
dfx canister create memory_repo --no-wallet
dfx deploy memory_repo

# Initialize: the identity that signs this becomes the owner
agentvault memory init soul.md
# or with dfx, as dfx's selected identity:
dfx canister call memory_repo initRepo '("Soul content here")'
```

To let the webapp (and Polytician's `vault_memory_push`, which goes through it) write, see
[Setting up the webapp's identity](#setting-up-the-webapps-identity).

`canister/memory-repo.mo` is a `persistent actor`, as current Motoko compilers require (it was checked with dfx
0.32.0, moc 1.4.1), and `dfx.json` builds it with `--enhanced-orthogonal-persistence`. Upgrading a memory_repo
built from an earlier release (classical persistence) is a plain `dfx deploy memory_repo`: the explicit flag is
what lets the upgrade migrate it, and the commits, branches, owner and authorized principals are kept. The
migration is one-way. Without the flag, moc 1.x builds with enhanced persistence implicitly and the upgrade
traps with `Detected implicit upgrade from classical orthogonal persistence to enhanced orthogonal persistence`,
leaving the canister as it was. Upgrade a canister that is still serving an older webapp before (or together
with) the webapp: the webapp's routes call `commitToBranch` and `createBranchFrom`, which an older canister does
not have (`MEMORY_REPO_OUTDATED`).

## Example: Vale Agent

See `examples/vale-agent/` for a complete walkthrough of setting up an autonomous agent with MemoryRepo.
