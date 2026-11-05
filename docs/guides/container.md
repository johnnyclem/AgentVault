# Running agents in containers

AgentVault can run an agent in a locked-down Docker container on your own machine, instead of compiling it to WASM for an ICP canister. The agent gets a private data volume, no network by default, and (if it needs a model API) a credential proxy that holds the real key so the agent never does.

This is the **Container MVP**. It does one thing well: package an agent into an image, run it isolated, keep its data, and snapshot that data encrypted. Remote deployment (SSH, Kubernetes), migration from canisters, and Podman are not in this release (see [Limitations](#limitations)). The existing `package` command still produces WASM unless you pass `--target container`.

## Quickstart

You need Docker running. An agent is a directory with a `package.json` (Node) or a `requirements.txt`/`main.py` (Python).

```bash
# 1. Package the agent as an image
agentvault package ./my-agent --target container

# 2. Run it in the background
agentvault run ./my-agent -d

# 3. Look at it, read its output, stop it, clean up
agentvault ps
agentvault container logs my-agent --follow
agentvault stop my-agent
agentvault rm my-agent               # keeps the data
agentvault rm my-agent --volumes     # also deletes the data (asks first)
```

`run` accepts either an image reference or the directory you packaged. The agent name defaults to the directory name (the same rule the WASM `package` command uses); override the image with `--image` and the running name with `--name`.

A TypeScript agent must be compiled first (AgentVault does not run `tsc` for you). Build to `dist/`, set `"main": "dist/index.js"` in `package.json` (or pass `--entrypoint '["node","dist/index.js"]'`), then package as above.

## What "locked down" means

Every agent container starts with these, and `run` has no flag that turns most of them off:

| Property | Default |
|---|---|
| User | numeric non-root `10001:10001` (a manifest asking for uid 0 is refused) |
| Capabilities | all dropped, plus `no-new-privileges` |
| Root filesystem | read-only; a 128 MB `tmpfs` at `/tmp` and `/home/agent` |
| Network | **none** (see [credentials](#giving-an-agent-an-api-key) for the way out) |
| Limits | 2 CPUs, 2 GB memory, 512 processes (`--cpus`, `--memory`, `--pids-limit`) |
| Process 1 | `tini` (`--init`), so signals work and zombies are reaped |
| Never | host network, `--privileged`, host PID/IPC, devices, the Docker socket |

Your data lives in a named Docker volume, mounted at `/data` by default (`--volume` on `package` changes or adds paths). It survives `stop` and `rm`; only `rm --volumes` deletes it.

Two flags weaken isolation and say so when used: `--network bridge` (unrestricted network access) and `--writable-rootfs`. `--volume /host/path:/container/path` bind-mounts a host directory; the Docker socket, `/`, `/run` and any unix socket are refused, even through a symlink.

Environment variables reach the agent only if you name them: `--env KEY=VALUE`, or `--env KEY` to copy it from your shell. Values travel in a mode-0600 env file, never on a command line. Anything starting with `AGENTVAULT_` or `AV_SECRET_`, and `DOCKER_HOST` and `SSH_AUTH_SOCK`, is never forwarded. Note that `--env KEY=VALUE` is typed into your shell and so lands in its history; use `--env KEY` for anything sensitive.

## Giving an agent an API key

An agent that calls a model API needs a credential, but the agent itself is the thing you trust least. So it never gets one. Instead:

1. You store the key once, encrypted, or hand it over from your environment for a single run.
2. AgentVault starts a small **credential proxy** sidecar next to the agent. The sidecar holds the real key.
3. The agent is put on a private network that has no internet. Its only route out is the sidecar, which forwards requests to a fixed upstream (for `anthropic`, `https://api.anthropic.com`) with the real key attached.
4. The agent sees `ANTHROPIC_BASE_URL=http://agentvault-proxy:8080/anthropic` and a placeholder key, which standard SDKs pick up with no code changes.

```bash
# Store the key (the value comes from an env var or a hidden prompt, never a flag)
export AGENTVAULT_SECRETS_PASSPHRASE=...        # or you will be prompted
export ANTHROPIC_API_KEY=sk-ant-...
agentvault secrets add anthropic --from-env ANTHROPIC_API_KEY
agentvault secrets list                          # names only

# Package an agent that declares it needs it, then run
agentvault package ./my-agent --target container --secret anthropic
agentvault run ./my-agent -d

# Or skip the store for one run: read the conventional env var instead
agentvault run ./my-agent -d --service anthropic --secrets-from-env
```

Presets exist for `anthropic`, `openai`, `venice` and `ollama` (a local Ollama on the host, no key). A run that needs a credential it cannot find fails before creating anything, and says which one.

What the proxy does and does not protect:

- The agent cannot read the key, send it elsewhere, or reach any host except the preset's. A key the agent *sends* is replaced, not forwarded.
- Other containers on your machine cannot use the key: the sidecar sits on a dedicated per-agent network, not the shared bridge.
- The key is visible to anyone who can run `docker inspect` on the sidecar. It is never on a command line and never in the agent container.
- It injects a header only. No query or body injection, no WebSocket, no spend caps or rate limits. If an upstream echoes your key in a response *body*, the agent sees it (headers are filtered, bodies are not scanned).

The sidecar writes one audit line per request (method, path, status, byte counts; never headers, bodies or query strings): `docker logs av-<agent>-proxy`.

## Keeping and moving data

A snapshot is a directory with a `manifest.json` and one archive per volume, encrypted with AES-256-GCM unless you ask otherwise.

```bash
export AGENTVAULT_SNAPSHOT_PASSPHRASE=...        # or you will be prompted
agentvault snapshot create my-agent              # -> <AgentVault home>/snapshots/...
agentvault snapshot list
agentvault snapshot verify <snapshot-dir>        # checks everything, no Docker needed
agentvault snapshot verify <snapshot-dir> --ciphertext-only   # no passphrase: hashes only

agentvault snapshot restore <snapshot-dir>                # back into the same agent
agentvault snapshot restore <snapshot-dir> --to other     # into a different agent
```

Restore validates every archive (manifest, checksums, authentication tag, tar structure, destination empty) for **all** volumes before it writes any, and refuses a volume that already holds data unless you pass `--force`. A snapshot is taken from the volume as it is at that moment; stop the agent first for a consistent copy of anything it writes continuously. `--no-encrypt` writes plaintext and says so loudly.

Passphrases are read from `AGENTVAULT_SNAPSHOT_PASSPHRASE` / `AGENTVAULT_SECRETS_PASSPHRASE` or an interactive prompt, never from a flag, and are withheld from any MCP server AgentVault spawns. Lose the passphrase and the snapshot or secret store cannot be recovered.

## What goes into an image

`package --target container` builds from a **filtered copy** of your directory, not `COPY . .`. Left out, always:

- environment files: any name that starts or ends with `.env` (`.env`, `.env.local`, `.env-prod`, `.envrc`, `prod.env`)
- key and credential files: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.ppk`, `*.jks`, `*.keystore`, `*.kdbx`, `*.gpg`, SSH keys (`id_rsa*`, `my_id_rsa`, ...), `credentials.json`, `secrets` and `secrets.*`, service-account `*.json`, `*.tfstate`, `*.tfvars`, `.htpasswd`, `.vault-token`, `kubeconfig`, `.boto`, `.s3cfg`, `.dockercfg`, `.npmrc`, `.pypirc`, `.netrc`, shell history
- `.git`, `.agentvault`, `node_modules`, virtualenvs, `*.log`
- anything that is a symlink or other special file

An editor or backup suffix (`~`, `.bak`, `.old`, `.orig`, `.swp`, `.tmp`) does not hide a name: `.env~` and `server.key.bak` are left out too. Ordinary source such as `env`, `env.py`, `env.js` and `environment.js` is kept. A source file named `secrets.py` or `secrets.js` is left out as well; rename it. The command reports how many entries it skipped, and names the environment files and symbolic links among them. `dist/` **is** included (it is where `tsc` writes), but AgentVault's own output directory (`dist/container` by default) is not.

Files are read through `O_NOFOLLOW | O_NONBLOCK` and checked to be the same file the scan saw, so swapping a directory for a symlink, or a file for a FIFO, while packaging runs cannot pull in a host file or hang the command; a file that changed is skipped and counted. An `agent.json`, `agent.yaml` (and the other agent config files) that is a symlink is ignored with a warning, so a link cannot choose the image's name or version.

The image's `agentvault.json` manifest (also stored as an image label) lists the environment variable *names* and credential service names the agent needs, never values. `--no-build` writes the Dockerfile and manifest without calling Docker. Volume paths may not be system locations: `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/run`, `/var/run`, `/root` (or anything below them), nor exactly `/tmp` or `/home/agent`. The same rule applies to the manifest label of an image you run, so an image cannot ask for them.

### Image tags and the output directory

The image is built under a private temporary tag, checked (label, non-root user), and only then given the name from `--image`. If that name already belongs to an image AgentVault did not build (for example `--image node:22-slim`), or to another agent's image, `package` refuses before writing anything and tells you to choose another `--image`. It never moves or removes a tag it did not create, and a failed build leaves the previous image exactly as it was. Packaging the same agent again replaces its own earlier image. Two different directories that resolve to the same agent name and version cannot be told apart, so give one of them its own `--image`.

An output directory is locked while a run uses it (a `.agentvault-container-output.lock` file holding the process id). A second `package` into the same directory, which is what two terminals on one source directory do by default, fails at once with the other process id, instead of corrupting the build that is still reading the context. A lock left by a crashed run is taken over once its process is gone; a lock that names no process is never deleted for you, and the message names the file. The output location (and `dist` when it is the default) must not be a symlink, and the printed `Output:` path is the real one.

### Building a Python agent runs third-party code

npm installs use `--ignore-scripts`, so a dependency's install scripts do not run. pip has no such switch: `pip install -r requirements.txt` and `pip install .` execute each package's build code, as root in the build container, with network access. AgentVault runs pip with `--no-input` and warns, without blocking, when `requirements.txt` has `--index-url`/`-i`, `--extra-index-url`, `--trusted-host`, `--find-links`/`-f`, `-e`, a `-r`/`-c` that points outside the source tree, or a URL, and when `pyproject.toml` declares `backend-path` or a `build-backend` outside the well-known ones. The warning names the line and option, never the value, which may hold a credential. Package a Python agent only from sources you trust.

| `package` flag | Meaning |
|---|---|
| `--image <name:tag>` | image tag (default `agentvault/<name>:<version>`); an existing tag is reused only for this agent's own image |
| `--base <image>` | base image (default `node:22-slim` / `python:3.12-slim`) |
| `--entrypoint '["node","index.js"]'` | override the detected entrypoint; a file in your tree stays path-like (`./run.sh`) |
| `--volume <path>` | container path to persist (repeatable, default `/data`); not a system location |
| `--env-name <NAME>` | variable name the agent reads (repeatable) |
| `--secret <service>` | credential-proxy service the agent needs (repeatable) |
| `--health-url <url>` | `http://localhost:<port>/<path>` for the image `HEALTHCHECK` |
| `--no-build` | generate only |

## Command reference

| Command | What it does |
|---|---|
| `package <dir> --target container` | build the image |
| `run <image\|dir> [-d] [-- cmd]` | start an agent (and its proxy, if it needs one) |
| `ps [-a] [--json]` | list agents |
| `container logs <agent> [-f] [--tail n]` | the agent's output |
| `container exec <agent> -- cmd` | run a command in a running agent |
| `container stats <agent>` / `inspect <agent>` | resource use / details (env values redacted) |
| `stop <agent> [-t sec]` | stop the agent, then its proxy; data kept |
| `rm <agent> [--volumes] [-y]` | remove containers and networks; `--volumes` deletes data |
| `snapshot create\|restore\|verify\|list` | see above |
| `secrets add\|list\|rm` | the encrypted credential store |

`logs`, `stats` and `exec` at the top level remain the canister commands; the container versions live under `container`.

| Environment variable | Purpose |
|---|---|
| `AGENTVAULT_HOME` | where AgentVault keeps secrets, snapshots and scratch files (absolute path; default `~/.agentvault`) |
| `AGENTVAULT_SNAPSHOT_PASSPHRASE` | passphrase for `snapshot` (else a prompt) |
| `AGENTVAULT_SECRETS_PASSPHRASE` | passphrase for the secret store (else a prompt) |

## Troubleshooting

**`run -d` says started, then a warning says the agent exited immediately.** Docker reports success when a container *starts*, even if its entrypoint then fails. AgentVault watches a detached agent for about a second and a half and tells you the exit code (127: command not found; 126: not executable; 137: killed, often memory). The container is kept: `agentvault container logs <agent>`. A start that exits 0 straight away is treated as a finished job, not a failure, and `run -d` itself still exits 0 as `docker run -d` does.

**The agent gets `502 {"error":"bad_gateway"}` from the proxy.** The body is deliberately generic. The reason is in the sidecar log: `docker logs av-<agent>-proxy` shows an `upstreamError` code on the failing line. `ENOTFOUND` / `EAI_AGAIN` means the sidecar could not resolve the host; `ECONNREFUSED` that nothing is listening; `SELF_SIGNED_CERT_IN_CHAIN` (or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) that something between you and the API, such as a corporate TLS-inspecting proxy, is re-signing traffic with a certificate the sidecar does not trust. The sidecar currently has no option to add a CA, so that last case needs a network path without interception.

**The agent cannot reach the internet.** That is the default (`--network none`). Use the credential proxy for model APIs. `--network bridge` is the unrestricted escape hatch.

**`Cannot connect to the Docker daemon`.** Start Docker. AgentVault reports unreachable, permission-denied and missing-binary separately.

## Limitations

What this release does not do, so you do not find out the hard way:

- **Docker only.** No Podman, no rootless-specific testing, not tested on Windows. No SSH or Kubernetes deployment, no migration from canisters, and the default `package` target is still WASM.
- **No TypeScript compilation**, and only Node and Python agents. Only dependency-light npm and pip agents were built against a real daemon.
- **Base images are tags** (`node:22-slim`), not pinned digests.
- **One model-API credential path:** header injection through the proxy. Multi-line secrets such as PEM keys cannot be delivered. There is no per-agent policy, rate limit or spend cap, and no shared proxy for several agents.
- **Snapshots are not live.** A volume that holds an absolute symlink makes the snapshot fail, by design. The network stays internal-only, so a restored agent that expects the internet needs the proxy or `--network bridge`.
- **Not verified end to end in the project's own test environment:** a live call to a real vendor API through the proxy (the sandbox's egress re-signs TLS; the proxy code was checked against the real Anthropic endpoint from the host and the failure mode was isolated to the sandbox), the `ollama` preset against a real Ollama, interactive terminal behaviour (`run -i`, `exec -i`, Ctrl-C handling, `logs --follow`) on a real daemon.
