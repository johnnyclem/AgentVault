# Backups Guide

This guide covers backing up an agent with `agentvault backup`, restoring it
to a fresh canister, and managing the backup files on your machine.

Every `agentvault backup` command and flag below is defined in
`cli/commands/backup.ts`. Run `agentvault backup <command> --help` for the
same list in your terminal.

## Commands at a glance

| Command | What it does |
| --- | --- |
| `agentvault backup export <agent-name>` | Writes a backup. The flags choose the format: a JSON manifest (default), an encrypted full-state zip (`--encrypted`), a signed encrypted envelope (`--full`) or a thoughtform bundle (`--type thoughtform-bundle`). |
| `agentvault backup restore --zip <path>` | Decrypts an encrypted zip, restores the agent's state and installs its WASM on a fresh canister. |
| `agentvault backup import <file>` | Checks a backup file and reports what it holds. |
| `agentvault backup list` | Lists the backup manifests in `~/.agentvault/backups/`. |
| `agentvault backup preview <backup-path>` | Prints a manifest's agent name, creation time and components. |
| `agentvault backup delete <backup-path>` | Deletes a backup file. |

The examples use an agent called `my-agent`. Quote any name or path that
contains spaces or shell characters.

## Encrypted full-state backup

This is the backup you can restore from. It needs `zip` and `unzip` on your
`PATH`, and you run it from the agent's project folder.

### 1. Store the passphrase

The export and the restore read the passphrase from the agent's
`backup-passphrase` secret, so it never lands in your shell history. That
needs a configured secret backend, HashiCorp Vault or the Bitwarden CLI:

```bash
# Once per machine: choose HashiCorp Vault or Bitwarden and connect to it
agentvault vault init

# Once per agent: prompts for the passphrase
agentvault vault put my-agent backup-passphrase
```

Instead of `vault init`, you can set `VAULT_ADDR` and `VAULT_TOKEN` for
HashiCorp Vault, or `AGENTVAULT_VAULT_BACKEND=bitwarden` for Bitwarden. To read
a different secret, pass `--vault-passphrase-key <key>` to both commands.
`--passphrase <value>` works without any backend, but the passphrase is then
saved in your shell history.

### 2. Export

```bash
agentvault package ./
agentvault backup export my-agent --encrypted --wasm ./dist/my-agent.wasm --output ./my-agent.zip.enc
```

`agentvault package` writes the WASM to `dist/<name>.wasm`. Include it with
`--wasm`: the restore deploys that file, and it fails without it.

The zip holds whichever of these exist, and the command prints the list it
included:

| Component | Source |
| --- | --- |
| `state` | `~/.agentvault/agents/my-agent` |
| `encrypted-keys` | the agent's wallet files in `~/.agentvault/wallets/my-agent` |
| `logs` | `~/.agentvault/logs` |
| `deps` | `node_modules` in the folder you run the command from |
| `wasm` | the file passed with `--wasm` |
| `canister-state` | the canister's status, with `--canister-id <id>` (read from the local replica) |

The zip is encrypted with AES-256-GCM under a key derived from the passphrase
(PBKDF2-SHA256). Next to it, the command writes a plaintext
`my-agent.manifest.json` with the agent name, the components and the SHA-256
of the encrypted file.

Without `--output`, the backup goes to `./backup.zip.enc`. An output path
that does not end in `.enc` gets `.zip.enc` appended. End your path in
`.zip.enc`: the manifest's file name is made by swapping that ending for
`.manifest.json`, so with any other `.enc` name the manifest is written over
the backup itself.

Other export flags for this format:

- `--canister-id <id>` adds the canister's status. `--no-canister-state`
  skips it even when an ID is given.
- `--arweave-jwk <path>` uploads the manifest to Arweave (see below).
- `--passphrase <value>` and `--vault-passphrase-key <key>` are covered in
  step 1.

### 3. Anchor the manifest on Arweave (optional)

```bash
agentvault backup export my-agent --encrypted --wasm ./dist/my-agent.wasm --output ./my-agent.zip.enc --arweave-jwk ./arweave-key.json
```

With `--arweave-jwk`, the manifest and the encrypted zip's SHA-256 are
uploaded to Arweave in a transaction signed with that wallet key, and the
wallet pays the Arweave fee. The encrypted zip itself stays on your machine.
The command prints the transaction ID and also saves it in the manifest as
`arweaveManifestTxId`.

### 4. Restore

```bash
agentvault backup restore --zip ./my-agent.zip.enc --agent my-agent --network local
```

| Flag | Meaning |
| --- | --- |
| `--zip <path>` | The encrypted backup (required). |
| `--agent <name>` | The agent whose Vault secret holds the passphrase. |
| `--passphrase <value>` | Use this passphrase instead of Vault. |
| `--vault-passphrase-key <key>` | The secret to read (default `backup-passphrase`). |
| `--network <name>` | Where to deploy the fresh canister: `local` (default) or `ic`. |

The restore:

1. Decrypts the zip.
2. Refuses to go on if any entry has an absolute path or `..`, or the
   extracted files contain a symbolic link.
3. Copies the agent's `state` back into `~/.agentvault`, overwriting the files
   there.
4. Installs the backed-up WASM on a fresh canister and prints its ID.

The restore does not put the wallet files, logs or dependencies back. Keep a
separate wallet backup (see the [Wallets Guide](./wallets.md)).

## Other export formats

### JSON manifest (default)

```bash
agentvault backup export my-agent --output ./my-agent-backup.json
```

This writes a small JSON manifest: the agent name, the canister ID and the
components. It holds no files. With `--canister-id <id>`, it also records the
canister's status from the local replica, plus its tasks, memory and context
if the canister answers those calls. Without `--output`, it goes to
`./backup.json`. A path that does not end in `.json` gets `.json` appended.

### Signed encrypted envelope (`--full`)

```bash
agentvault backup export my-agent --full --output ./my-agent-full.zip
```

This encrypts a config entry (agent name and canister ID), plus the canister
state when you pass `--canister-id <id>`, under a random AES-256-GCM key. That
key is wrapped with a key derived from an ed25519 signing key and signed, and
the manifest records a SHA-256 Merkle root of the entries. The signing key
defaults to `~/.agentvault/backup-signing.key` and is created if it is
missing. Choose another with `--signing-key <path>`. Without `--output`, the
file is `./backup-my-agent.zip`. It is a JSON file despite the `.zip` name.

No `agentvault backup` command decrypts this format yet. Use `--encrypted`
when you need to restore.

### Thoughtform bundle (`--type thoughtform-bundle`)

```bash
agentvault backup export my-agent --type thoughtform-bundle
```

This writes `my-agent.thoughtform-bundle.json.gz`, a gzipped JSON bundle with
a config entry, plus the canister state when you pass `--canister-id <id>`.
Add `--store` with `--canister-id <id>` to send the bundle to that canister's
`store_thoughtform` method. `--network <network>` (`local` or `ic`, default
`local`) picks the network for that call.

## Importing

```bash
agentvault backup import ./my-agent-backup.json
agentvault backup import ./my-agent.thoughtform-bundle.json.gz
```

For a JSON manifest, `import` reads the file and reports the agent name and
components. `--name <name>` changes the name it reports. Today it does not
write any agent configuration, with or without `--overwrite`.

A file ending in `.thoughtform-bundle.json.gz`, or any file with
`--type thoughtform-bundle`, is checked against the bundle format. The command
then reports its components, creation time and entry count. Add `--store` with
`--canister-id <id>` (and `--network <network>`) to send it to the canister's
`store_thoughtform` method.

## Listing, previewing and deleting

```bash
agentvault backup list
agentvault backup list --agent my-agent
```

`list` prints every JSON manifest in `~/.agentvault/backups/`, newest first.
`--agent <name>` keeps the files whose names start with that agent name and
whose manifest names it. The CLI writes exports where `--output` points (the
current folder by default). To have an export show up in `list`, point
`--output` into that folder and start the file name with the agent name, for
example `--output ~/.agentvault/backups/my-agent-backup.json`. The dashboard's
archive flow saves its backup manifests there already.

```bash
agentvault backup preview ./my-agent-backup.json
agentvault backup preview ./my-agent.manifest.json
```

`preview` prints a manifest's agent name, creation time and components. It
reads JSON manifests, including the `.manifest.json` written next to an
encrypted backup. It cannot read a `.zip.enc` file, a `--full` envelope or a
thoughtform bundle.

```bash
agentvault backup delete ./my-agent-backup.json
```

`delete` removes the file at the path you give, whatever it is, so check the
path first. For an encrypted backup, delete both the `.zip.enc` file and its
`.manifest.json`.

## Troubleshooting

- **"Vault is not configured"**: run `agentvault vault init`, or set
  `VAULT_ADDR` and `VAULT_TOKEN` (or `AGENTVAULT_VAULT_BACKEND=bitwarden`).
  See step 1.
- **"Passphrase not provided and --agent was not set for Vault lookup"**: add
  `--agent <name>` (or `--passphrase <value>`) to `backup restore`.
- **"No WASM module found in decrypted backup; cannot deploy fresh
  canister"**: the export ran without `--wasm`. Run `agentvault package ./`
  and export again with `--wasm ./dist/my-agent.wasm`.
- **"Unsupported state or unable to authenticate data"**: the passphrase is
  wrong, or the file was changed after export.
- **"Backup zip not found"**: check the `--zip` path, and quote it if it
  contains spaces.
- **"Refusing to extract archive" or "Refusing to restore archive"**: the zip
  has an absolute path, a `..` entry or a symbolic link. `backup export` never
  writes those, so the file was changed or did not come from AgentVault.
- **`zip` or `unzip` not found**: install them with your system's package
  manager. The encrypted export and the restore both call them.

## Related tools

- The web dashboard's **Archive My Agent** flow deploys an agent to its own
  canister and records an archive receipt on Arweave. See the
  [Web Dashboard guide](./webapp.md).
- `agentvault cloud-backup` copies AgentVault's data (agents, wallets, backups
  and networks) into the local sync folder of Google Drive, iCloud Drive,
  Dropbox or OneDrive, or into a folder you choose. Run
  `agentvault cloud-backup --help` for its commands.
- `agentvault archive` (experimental) manages the local archive records in
  `~/.agentvault/archives`; it uploads nothing to Arweave. Run
  `agentvault archive --help` for its commands.

## Next steps

- Read the [Wallets Guide](./wallets.md) for exporting wallets.
- Read the [Deployment Guide](./deployment.md) for canister deployment.
- Read [Troubleshooting](./troubleshooting.md) for other issues.
