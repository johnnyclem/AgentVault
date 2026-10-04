# Polytician ⇄ AgentVault

[Polytician](https://polytician.smallchat.dev) 3.0 is a local-first MCP server for semantic memory: it stores
concepts as vectors, markdown and ThoughtForm JSON, and searches them by meaning. AgentVault starts a Polytician
server over stdio from three places:

- `agentvault orchestrate --polytician-entry "<command>"` adds the concepts most relevant to the task to Claude's
  prompt and saves each session's result as a concept.
- `agentvault polytician -e "<command>" <status|search|push-all|pull|archive|register>` works with the concepts
  directly. `agentvault polytician config` writes Polytician's config file and starts nothing.
- The webapp's `/api/polytician/[agentId]/*` routes start the command in `POLYTICIAN_ENTRY_POINT`.

In the other direction, Polytician's opt-in `vault_*` tools call AgentVault's webapp:

| Polytician tool | AgentVault route |
|---|---|
| `vault_memory_push` | `POST /api/memory-repo/commits`, a signed write to the `memory_repo` canister |
| `vault_memory_pull` | `GET /api/memory-repo/branches/:branch`, an anonymous read |
| `vault_archive_concept`, and archival on save | `POST /api/archival/upload` |

The examples below use `polytician` (the command `npm install -g polytician@^3` installs) as the entry point.

## Namespaces

Each agent's concepts live in their own Polytician namespace, whichever AgentVault surface wrote them. Every call
AgentVault makes to a Polytician tool that takes a namespace names the agent's: `save_concept`, `read_concept`,
`delete_concept`, `list_concepts`, `search_concepts`, `get_stats`, `health_check`, `vault_memory_push`,
`vault_memory_pull` and `vault_archive_concept`. (`vault_memory_repo_log` takes none: it reads the whole branch.)

| Surface | Namespace | When not given |
|---|---|---|
| `agentvault polytician` | `-n, --namespace <name>` | the project's agent name, else `default` |
| `agentvault orchestrate` | `--polytician-namespace <name>` | the project's agent name, else `default` |
| Webapp `/api/polytician/[agentId]/*` | the `agentId` in the path | (always given) |

The project's agent name is `name` in `agent.json`, else in `.agentvault/config/agent.config.json`, in the
current directory or, failing that, the nearest directory above it that has either file, so a command run from
anywhere inside the project finds it. It is the name the webapp keys agents by and uses as their `agentId`, so the
CLI, `orchestrate` and the webapp all use one namespace for that agent.

A namespace must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. An invalid `--namespace` or
`--polytician-namespace` is refused before Polytician starts. So is a project agent name that is not a valid
namespace: AgentVault does not fall back to `default` (which every agent without a name shares), and asks you to
choose one with the option. The webapp answers an invalid `agentId` with 400 `INVALID_AGENT_ID`.

`orchestrate` prints the namespace in its session header, `polytician status` and `register` print it, `search`,
`push-all` and `pull` name it in their result line, and the webapp's stats response carries it as `namespace`.

`--polytician-namespace` used to name the server registration only, and every concept went to `default` whatever
it said. It is now the Polytician namespace. AgentVault still registers the server as `polytician`.

### `POLYTICIAN_NAMESPACES`

If Polytician's operator has set an allowlist (`POLYTICIAN_NAMESPACES`, or `namespaces` in Polytician's config
file), every namespace AgentVault uses must be on it, or Polytician refuses the call with `NAMESPACE_DENIED`.
AgentVault's message names the namespace it addressed and says to add it to the allowlist; the webapp answers
403. `POLYTICIAN_NAMESPACES=*` allows every namespace. The Polytician AgentVault starts inherits AgentVault's
environment, so an allowlist set there applies too.

### Pushing and pulling across namespaces

`vault_memory_push` records each concept's namespace with its memory_repo entry. Every namespace pushes to the
same branch (`polytician-main` unless configured otherwise), one commit per concept. `vault_memory_pull` imports
into the agent's namespace the entries recorded for it (and entries with no namespace recorded). It reports the
others as skipped with the reason `other-namespace`, as it does an entry whose concept id already lives in
another namespace.

### Concepts saved before namespaces

Before this change every concept AgentVault saved went to Polytician's `default` namespace. AgentVault now
addresses the agent's namespace, so those concepts no longer appear in enrichment, `search`, the webapp's list or
`stats`, and `push-all` does not push them. Polytician cannot move a concept between namespaces. Either:

- keep using `default` for that agent: `--namespace default`, `--polytician-namespace default`, or `default` as the
  webapp `agentId`; or
- copy the concepts you need into the agent's namespace by saving their markdown again there. The copies get new
  ids. `agentvault mcp call` sends arguments as given, without a namespace of its own:

  ```bash
  agentvault mcp call polytician list_concepts --entry polytician \
    --args '{"namespace":"default","limit":100}'
  agentvault mcp call polytician read_concept --entry polytician \
    --args '{"id":"<concept id>","namespace":"default","representations":["markdown"]}'
  agentvault mcp call polytician save_concept --entry polytician \
    --args '{"namespace":"my-agent","markdown":"# Title\n...","tags":["orchestration"]}'
  ```

## Connecting Polytician to AgentVault

Polytician registers its `vault_*` tools only when it is configured for AgentVault: an AgentVault URL
(`POLYTICIAN_AV_API_URL`, or `agentVault.apiBaseUrl` in its config file) and a token (`POLYTICIAN_AV_API_TOKEN`, or
`agentVault.apiToken`). The token must equal the `AGENTVAULT_POLYTICIAN_API_TOKEN` AgentVault's webapp checks.
Without them, `polytician status` shows `AgentVault tools: not configured`, and `push-all`, `pull` and `archive`
say which settings are missing.

### From AgentVault's environment

When AgentVault starts Polytician (the `agentvault polytician` commands, `orchestrate --polytician-entry` and the
webapp routes), it adds two variables to Polytician's environment:

| Set for AgentVault | Polytician gets |
|---|---|
| `AGENTVAULT_API_URL`: the webapp's base URL (Polytician appends `/api/...`) | `POLYTICIAN_AV_API_URL` |
| `AGENTVAULT_POLYTICIAN_API_TOKEN`: the webapp's API token | `POLYTICIAN_AV_API_TOKEN` |

It adds them only when both AgentVault variables are set and neither Polytician variable is: values the operator
set for Polytician win, and AgentVault's token never goes to a URL AgentVault did not choose. An empty
`POLYTICIAN_AV_*` variable counts as unset, as it does for Polytician. The URL must use https, or plain http to
`localhost`, `127.0.0.1` or `[::1]`, which is what Polytician accepts, and must not carry credentials
(`https://user:password@...`): Polytician authenticates with the token, and its HTTP client refuses such a URL
on every request. For any other URL AgentVault does not start Polytician and says why (showing only the URL's
scheme and host, never its credentials); the webapp answers 503 `POLYTICIAN_CONFIG_ERROR`.

AgentVault's own secrets are not passed on: the Polytician it starts (like any MCP server it starts) gets
AgentVault's environment without `AGENTVAULT_ICP_IDENTITY_PEM`, `AGENTVAULT_ICP_IDENTITY_PEM_FILE`,
`AGENTVAULT_MNEMONIC`, `AGENTVAULT_PRIVATE_KEY`, `AGENTVAULT_PASSWORD` and `AGENTVAULT_BUNDLE_SECRET`.

```bash
export AGENTVAULT_API_URL=https://agentvault.example.com
export AGENTVAULT_POLYTICIAN_API_TOKEN=<the webapp's token>
agentvault polytician -e polytician status
# ...
# AgentVault tools: vault_get_secret, vault_infer, vault_memory_pull, vault_memory_push, vault_memory_repo_log
```

That is enough for `push-all` and `pull`, which sync with the `polytician-main` branch. On the webapp,
`AGENTVAULT_POLYTICIAN_API_TOKEN` is already set (it guards the API); set `AGENTVAULT_API_URL` to the webapp's own
URL, for example `http://localhost:3000` when Polytician runs on the same machine.

### Polytician's config file

`agentvault polytician config` writes the `agentVault` section of Polytician's JSON config file, which archival,
another branch, or a Polytician started by another MCP client needs:

```bash
agentvault polytician config --api-url https://agentvault.example.com
```

```json
{
  "agentVault": {
    "apiBaseUrl": "https://agentvault.example.com",
    "apiToken": "${POLYTICIAN_AV_API_TOKEN}",
    "memoryRepoBranch": "polytician-main"
  }
}
```

- **Where:** `~/.polytician/config.json`, which Polytician reads when it is started without `--config`.
  `agentvault polytician --config <path> config` writes another file. Give the same path to Polytician:
  `agentvault polytician --config <path> <subcommand>` and `agentvault orchestrate --polytician-config <path>`
  pass it as `--config <path>`. The webapp passes none: add `--config <path>` to `POLYTICIAN_ENTRY_POINT` (the
  command is split on whitespace, so use a path without spaces), or Polytician reads
  `~/.polytician/config.json` of the user the webapp runs as.
- **URL:** `--api-url`, else `AGENTVAULT_API_URL`, with the same https and no-credentials rules.
- **Token:** the literal `${POLYTICIAN_AV_API_TOKEN}`, which Polytician fills in from its environment, so no
  secret is written to disk. The file supplies the URL, not the token: Polytician still needs
  `POLYTICIAN_AV_API_TOKEN` set. AgentVault sets it as above for the Polytician it starts, which takes
  `AGENTVAULT_API_URL` as well as `AGENTVAULT_POLYTICIAN_API_TOKEN` (set it to the same URL as the file); for a
  Polytician another MCP client starts, set `POLYTICIAN_AV_API_TOKEN` to the webapp's
  `AGENTVAULT_POLYTICIAN_API_TOKEN`. Without it Polytician sends the reference itself and the webapp refuses the
  request with `UNAUTHORIZED`. `config` says so when it sees `AGENTVAULT_POLYTICIAN_API_TOKEN` without
  `AGENTVAULT_API_URL`, and `status` warns when Polytician offers its `vault_*` tools with no token to send (a
  token written into the file itself counts).
- **Branch:** `--branch <name>`, default `polytician-main`.
- **File:** mode 0600 (a new directory for it, 0700). An existing file is refused. `--force` sets `apiBaseUrl`,
  `apiToken` and `memoryRepoBranch` and keeps everything else, in the `agentVault` section (`sync`, `inference`,
  `agentPrincipal`, an `archival` block) and outside it, and lists the `agentVault` settings it kept. Archival
  options replace the archival tags and wallet and keep its other settings (`debounceMs`, `timeoutMs`);
  `--no-archival --force` removes the archival block.

Once the file has an `agentVault` section, Polytician offers its `vault_*` tools every time it starts with it.

### Archival (opt-in)

```bash
agentvault polytician config --api-url https://agentvault.example.com \
  --archival-tag archive --arweave-jwk ./arweave-wallet.json
```

adds `"archival": { "enabled": true, "tagFilter": ["archive"], "arweaveJwk": "<absolute path>" }`. It takes both
options or neither: at least one `--archival-tag` (repeat it for several; a concept is archived only when it
carries every one) and `--arweave-jwk`, the Arweave wallet that pays. The wallet must be an Arweave keyfile (a
JSON RSA private key: `kty` `"RSA"`, with `n` and `d`); anything else is refused, without repeating the file's
content, rather than written to a config with which every archive would fail. It is written as an absolute path. Polytician then offers `vault_archive_concept`, which `agentvault polytician archive <concept id>`
and the webapp's `POST /api/polytician/[agentId]/archive` call. Without archival the CLI says what is missing
and the webapp answers 503 `NOT_CONFIGURED`.

:::warning Arweave uploads are permanent, public and paid
With archival on, Polytician uploads every concept carrying all the archival tags each time it is saved or
updated, and `vault_archive_concept` uploads one on request. An upload cannot be deleted, anyone can fetch it,
and each one is paid from the wallet. Polytician encrypts the concept with its backup key before the upload
(the concept id, its version and the key's fingerprint stay readable) and does not start with archival on
unless it has a key: `POLYTICIAN_BACKUP_KEY`, or the `backup.key` file in its data directory. Keep a copy of
the key off the machine; an archive cannot be decrypted without it.
:::

Polytician sends the wallet with each upload to AgentVault's `POST /api/archival/upload`, which signs and posts
the transaction, so the wallet travels to the webapp at the URL you configured. The route answers errors in the
shape Polytician's client reads; a paid upload through it has not been tried against Polytician 3.0. An archive
that gets no answer in time is reported as outcome unknown, not as a failure: check before retrying, since the
paid upload may have happened.

## Push and pull

`agentvault polytician push-all` calls `vault_memory_push` for every concept in the agent's namespace, and
Polytician posts each one to the webapp's `POST /api/memory-repo/commits`. The webapp signs the commit with its
own identity, so pushes need that identity set up and authorized by the repo owner: see
[MemoryRepo: setting up the webapp's identity](../memory-repo.md#setting-up-the-webapps-identity). Your own
identity plays no part in a push. Without the webapp's identity the route answers 503
`SIGNING_IDENTITY_NOT_CONFIGURED`, and with an identity the owner has not authorized, 403
`SIGNER_NOT_AUTHORIZED` naming its principal. The webapp answers in the shape Polytician's client reads, with
the code at the start of the message, so `push-all` shows it with the guidance:

```
- <concept id>: vault_memory_push failed (UPSTREAM_ERROR): SIGNER_NOT_AUTHORIZED: memory_repo refused the write:
  <principal> is neither the repo owner nor an authorized principal. The owner can allow it with
  `agentvault memory authorize <principal>`.
```

`push-all` lists each concept that failed and exits 1. A push that gets no answer in time is reported as outcome
unknown, since the commit may have happened.

The webapp commits onto the sync branch in one canister call (`commitToBranch`), so concurrent pushes, and
anyone running `agentvault memory checkout`, cannot move a push to another branch. The first push creates the
branch from `main`, so it starts with none of another branch's entries. This needs a memory_repo canister from
this release: an older one answers 502 `MEMORY_REPO_OUTDATED` until it is upgraded (see
[MemoryRepo: deployment](../memory-repo.md#deployment)).

`agentvault polytician pull` calls `vault_memory_pull`, which reads the branch through
`GET /api/memory-repo/branches/:branch` (a query, so no signing identity is needed) and imports the entries for
the agent's namespace.

## Troubleshooting

| Message or response | Cause | Fix |
|---|---|---|
| `AgentVault tools: not configured`, `Polytician does not offer vault_memory_push` | Polytician has no AgentVault URL and token | Set `AGENTVAULT_API_URL` and `AGENTVAULT_POLYTICIAN_API_TOKEN`. A file from `agentvault polytician config` supplies the URL only; the token still comes from the environment |
| `Warning: Polytician offers its vault_* tools but has no POLYTICIAN_AV_API_TOKEN`, push fails with `UNAUTHORIZED: Invalid API token` | Polytician has the URL (from its config file) but no token, and sends the `${POLYTICIAN_AV_API_TOKEN}` reference; or the token differs from the webapp's | Set `AGENTVAULT_API_URL` as well as `AGENTVAULT_POLYTICIAN_API_TOKEN`, or set `POLYTICIAN_AV_API_TOKEN`, to the webapp's token |
| `vault_archive_concept also needs agentVault.archival`, webapp archive 503 `NOT_CONFIGURED` | Archival is off | `agentvault polytician config --archival-tag ... --arweave-jwk ... --force` |
| `AGENTVAULT_API_URL (http://...) must use https`, webapp 503 `POLYTICIAN_CONFIG_ERROR` | A URL Polytician would refuse | Use https, or http to `localhost` |
| `AGENTVAULT_API_URL carries credentials` | The URL has `user:password@` in it | Give the base URL without them; the token authenticates |
| `is not an Arweave wallet` | `--arweave-jwk` is not an Arweave keyfile | Pass the wallet's JSON keyfile |
| `NAMESPACE_DENIED`, webapp 403 | The namespace is not on Polytician's allowlist | Add it to `POLYTICIAN_NAMESPACES` |
| `is not a valid Polytician namespace`, webapp 400 `INVALID_AGENT_ID` | The namespace, agent name or `agentId` breaks the namespace rule | Pass a valid `--namespace` / `--polytician-namespace` |
| Push fails with `SIGNING_IDENTITY_NOT_CONFIGURED` (503) | The webapp has no signing identity | Set `AGENTVAULT_ICP_IDENTITY_PEM_FILE` or `AGENTVAULT_ICP_IDENTITY_PEM` on the webapp |
| Push fails with `SIGNING_IDENTITY_INVALID` (503) | The webapp's key cannot be loaded | The webapp's server log says why |
| Push fails with `SIGNER_NOT_AUTHORIZED` (403) | The repo owner has not authorized the webapp's principal | `agentvault memory authorize <principal>`, as the owner |
| Push fails with `MEMORY_REPO_OUTDATED` (502) | The memory_repo canister predates `commitToBranch` | Upgrade it: `dfx deploy memory_repo` |
| Concepts saved earlier are missing | They are in the `default` namespace | See [Concepts saved before namespaces](#concepts-saved-before-namespaces) |

See the [engineering guide](../ecosystem/engineering-guide.md) for the files behind this integration and what has
been checked against Polytician 3.0.
