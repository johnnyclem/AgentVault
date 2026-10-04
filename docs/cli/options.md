# CLI Options

Global options and environment variables for AgentVault CLI.

## Global Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--version` | `-V` | Output version number | - |
| `--help` | `-h` | Display help | - |
| `--debug` | | Enable debug mode | `false` |
| `--verbose` | `-v` | Verbose output | `false` |
| `--config` | `-c` | Path to config file | `./agent.yaml` |
| `--network` | `-n` | Network (local, ic) | `local` |
| `--quiet` | `-q` | Suppress output | `false` |
| `--no-color` | | Disable colored output | `false` |
| `--json` | | JSON output format | `false` |

## Environment Variables

### ICP Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `ICP_LOCAL_URL` | Local replica URL | `http://127.0.0.1:4943` |
| `ICP_MAINNET_URL` | Mainnet URL | `https://ic0.app` |
| `ICP_NETWORK` | Default network | `local` |
| `ICP_IDENTITY` | dfx identity name | `default` |
| `ICP_TIMEOUT` | Request timeout (ms) | `30000` |

### Ethereum Configuration

| Variable | Description |
|----------|-------------|
| `ETHEREUM_RPC_URL` | Ethereum mainnet RPC URL |
| `SEPOLIA_RPC_URL` | Sepolia testnet RPC URL |
| `INFURA_API_KEY` | Infura API key |
| `ETHERSCAN_API_KEY` | Etherscan API key |

### Solana Configuration

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Solana RPC URL |
| `SOLANA_MAINNET_RPC_URL` | Solana mainnet URL |
| `SOLANA_DEVNET_RPC_URL` | Solana devnet URL |

### Polkadot Configuration

| Variable | Description |
|----------|-------------|
| `POLKADOT_RPC_URL` | Polkadot RPC URL |
| `KUSAMA_RPC_URL` | Kusama RPC URL |

### Application Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTVAULT_DEBUG` | Enable debug mode | `false` |
| `AGENTVAULT_LOG_LEVEL` | Log level | `info` |
| `AGENTVAULT_CACHE_DIR` | Cache directory | `~/.agentvault` |
| `AGENTVAULT_CONFIG_DIR` | Config directory | `~/.agentvault/config` |
| `AGENTVAULT_DATA_DIR` | Data directory | `~/.agentvault/data` |

### MemoryRepo Signing

The `memory_repo` canister refuses anonymous writes. Write commands (`memory init`, `commit`, `authorize`, the
top-level `merge`, `hypervault archive --canister-id`, ...) sign with `--identity <pem>`, else
`AGENTVAULT_ICP_IDENTITY_PEM_FILE`, else dfx's selected identity, and exit 1 when none is set up. Reads stay
anonymous. See [MemoryRepo: who can write](../memory-repo.md#who-can-write).

| Variable | Description | Default |
|----------|-------------|---------|
| `MEMORY_REPO_CANISTER_ID` | `memory_repo` canister for `agentvault memory` | `canister_ids.json` |
| `AGENTVAULT_ICP_IDENTITY_PEM_FILE` | PEM key (Ed25519 or secp256k1, unencrypted) to sign writes with | dfx's selected identity |
| `DFX_CONFIG_ROOT` | Directory that holds `.config/dfx`, as for dfx | home directory |

`ICP_IDENTITY` does not select the signing identity.

### Polytician

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTVAULT_API_URL` | AgentVault webapp base URL; passed to the Polytician AgentVault starts as `POLYTICIAN_AV_API_URL` | - |
| `AGENTVAULT_POLYTICIAN_API_TOKEN` | The webapp's API token; passed to Polytician as `POLYTICIAN_AV_API_TOKEN` | - |
| `POLYTICIAN_AV_API_URL`, `POLYTICIAN_AV_API_TOKEN` | Set explicitly, they win, and AgentVault passes neither of its own | - |

AgentVault passes the two values only when both are set (an empty `POLYTICIAN_AV_*` counts as unset), and
refuses an `AGENTVAULT_API_URL` that carries credentials. The namespace comes from `--namespace` /
`--polytician-namespace`, else the agent name in the nearest `agent.json` or
`.agentvault/config/agent.config.json` (in the current directory or above). See the
[Polytician guide](../guides/polytician.md).

## Configuration Files

### agent.yaml

Agent configuration file (project root):

```yaml
name: my-agent
entry: src/index.ts
memory: 256
compute: medium
cycles: 1000000000000
```

### icp.yaml

ICP deployment configuration:

```yaml
environments:
  local:
    network:
      type: local
  production:
    network:
      type: ic
```

### .env

Environment variables file:

```env
ICP_LOCAL_URL=http://127.0.0.1:4943
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/KEY
```

## Directory Structure

```
~/.agentvault/
├── config/           # Configuration files
├── data/             # Local data storage
├── wallets/          # Wallet storage
│   └── {agentId}/
│       └── {walletId}.wallet
├── backups/          # Backup storage
├── cache/            # Cache directory
└── logs/             # Log files
```

## Exit Codes

| Code | Description |
|------|-------------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Configuration error |
| 4 | Network error |
| 5 | Authentication error |
| 6 | Permission denied |
| 7 | Resource not found |
| 8 | Timeout |
| 9 | Interrupted |

## Output Formats

Most commands support multiple output formats:

```bash
# Table format (default)
agentvault list

# JSON format
agentvault list --json

# ID only
agentvault list --format ids
```

## Logging

Control log verbosity:

```bash
# Debug level
agentvault --debug deploy

# Environment variable
AGENTVAULT_LOG_LEVEL=debug agentvault deploy

# Quiet mode
agentvault --quiet deploy
```

## Configuration Precedence

Configuration values are resolved in this order (highest priority first):

1. CLI flags
2. Environment variables
3. `.env` file
4. `icp.yaml`
5. `agent.yaml`
6. Default values

## Examples

### Using Environment Variables

```bash
# Set network
export ICP_NETWORK=ic
agentvault deploy

# Set RPC URL
export ETHEREUM_RPC_URL=https://eth.example.com
agentvault wallet balance --chain ethereum
```

### Using .env File

```bash
# Create .env
cat > .env << EOF
ICP_NETWORK=local
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/KEY
EOF

# Run command (automatically loads .env)
agentvault deploy
```

### Using Config File

```bash
# Specify config file
agentvault deploy --config ./staging.yaml
```
