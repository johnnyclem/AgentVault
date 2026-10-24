# CLI Reference

Complete reference for all AgentVault CLI commands.

## Global Options

```bash
agentvault [options] <command>

Options:
  -V, --version          Output version number
  -h, --help             Display help
  --debug                Enable debug mode
  --config <path>        Path to config file
  --network <network>    Network (local, ic)
  --verbose              Verbose output
```

## Core Commands

### init

Initialize a new AgentVault project.

```bash
agentvault init [options] [project-name]

Creates the project directory if it does not exist. When a project name is
given on the command line, init runs non-interactively; run bare
`agentvault init` for interactive prompts in the current directory.

Options:
  -n, --name <name>          Agent name (defaults to the project directory name)
  -t, --template <template>  Project template: default, minimal (default: "default")
  --force                    Re-initialize an existing AgentVault project
  -y, --yes                  Skip prompts and use defaults

Examples:
  agentvault init my-agent
  agentvault init my-agent --template minimal
  npx agentvault@latest init my-agent --template default
```

### package

Package agent directory to WASM.

```bash
agentvault package [options] <path>

Options:
  -o, --output <dir>     Output directory
  --optimize             Enable optimizations
  --no-optimize          Disable optimizations

Examples:
  agentvault package ./
  agentvault package ./my-agent --output ./dist
```

### deploy

Deploy agent to ICP canister.

```bash
agentvault deploy [options]

Options:
  -n, --network <network>  Network (local, ic)
  --canister-id <id>       Upgrade existing canister
  --cycles <amount>        Cycles to allocate
  --upgrade                Upgrade mode
  --no-verify              Skip post-deployment verification
  --timeout <ms>           Deployment timeout

Examples:
  agentvault deploy --network local
  agentvault deploy --network ic --cycles 2000000000000
  agentvault deploy --canister-id abcde-aaaab --upgrade
```

### exec

Execute task on canister.

```bash
agentvault exec [options] <task>

Options:
  -c, --canister-id <id>   Canister ID (required)
  --timeout <ms>           Execution timeout
  --async                  Execute asynchronously

Examples:
  agentvault exec --canister-id abcde-aaaab "analyze data"
  agentvault exec -c abcde-aaaab "process input" --async
```

### show

Show agent state.

```bash
agentvault show [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --format <format>        Output format (json, table)
  --field <field>          Show specific field

Examples:
  agentvault show --canister-id abcde-aaaab
  agentvault show -c abcde-aaaab --format json
```

### fetch

Download agent state from canister.

```bash
agentvault fetch [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  -o, --output <path>      Output file path
  --include-memory         Include memory dump

Examples:
  agentvault fetch --canister-id abcde-aaaab
  agentvault fetch -c abcde-aaaab -o ./state.json
```

### status

Display project status.

```bash
agentvault status [options]

Options:
  -c, --canister-id <id>   Specific canister ID
  --json                   JSON output

Examples:
  agentvault status
  agentvault status --canister-id abcde-aaaab
```

### list

List all agents.

```bash
agentvault list [options]

Options:
  --format <format>        Output format (table, json, ids)
  --filter <pattern>       Filter by name pattern
  --network <network>      Filter by network

Examples:
  agentvault list
  agentvault list --format json
  agentvault list --filter "my-*"
```

---

## Wallet Commands

### wallet

Manage agent wallets.

```bash
agentvault wallet [command] [options]

Subcommands:
  create                  Create new wallet
  list                    List wallets
  balance                 Check wallet balance
  export                  Export wallet
  import                  Import wallet
  delete                  Delete wallet
  sign                    Sign a transfer (ckETH, Solana, Polkadot; not
                          implemented for ICP or Arweave)
  transfer                Transfer tokens

Options:
  --chain <chain>         Chain type (icp, ethereum, solana, polkadot)
  --wallet-id <id>        Wallet ID

Examples:
  agentvault wallet create --chain ethereum
  agentvault wallet list
  agentvault wallet balance --wallet-id wallet-123
  agentvault wallet transfer --to <address> --amount 1.5
```

### wallet create

Create a new wallet.

```bash
agentvault wallet create [options]

Options:
  --chain <chain>         Chain type (required)
  --agent-id <id>         Associate with agent
  --name <name>           Wallet name

Examples:
  agentvault wallet create --chain ethereum
  agentvault wallet create --chain solana --name "main-sol"
```

### wallet import

Import existing wallet.

```bash
agentvault wallet import [options]

Options:
  --chain <chain>         Chain type
  --mnemonic              Import from mnemonic
  --private-key           Import from private key
  --file <path>           Import from file

Examples:
  agentvault wallet import --chain ethereum --mnemonic
  agentvault wallet import --chain solana --private-key
```

### wallet export

Export wallet for backup.

```bash
agentvault wallet export [options] <wallet-id>

Options:
  --format <format>       Output format (json, mnemonic)
  --show                  Show sensitive data

Examples:
  agentvault wallet export wallet-123 --format json
  agentvault wallet export wallet-123 --show --format mnemonic
```

### identity

Manage ICP identities.

```bash
agentvault identity [command] [options]

Subcommands:
  list                    List identities
  create                  Create new identity
  use                     Switch identity
  export                  Export identity
  import                  Import identity
  whoami                  Show current identity

Examples:
  agentvault identity list
  agentvault identity create my-identity
  agentvault identity use my-identity
  agentvault identity whoami
```

### cycles

Manage canister cycles.

```bash
agentvault cycles [command] [options]

Subcommands:
  balance                 Check cycles balance
  top-up                  Top-up canister cycles
  transfer                Transfer cycles
  history                 View cycles history

Examples:
  agentvault cycles balance <canister-id>
  agentvault cycles top-up <canister-id> --amount 1000000000000
  agentvault cycles history <canister-id>
```

### tokens

Query token balances.

```bash
agentvault tokens [options]

Options:
  --chain <chain>         Chain type
  --address <address>     Wallet address
  --token <token>         Token symbol or canister ID

Examples:
  agentvault tokens --chain ethereum
  agentvault tokens --chain solana --address <address>
  agentvault tokens --chain icp --token ckBTC
```

---

## Monitoring Commands

### monitor

Monitor canister health.

```bash
agentvault monitor [options]

Options:
  -c, --canister-id <id>   Canister ID
  --interval <ms>          Check interval (default: 5000)
  --alert                  Enable alerts
  --webhook <url>          Alert webhook URL

Examples:
  agentvault monitor --canister-id abcde-aaaab
  agentvault monitor -c abcde-aaaab --interval 10000 --alert
```

### health

Run health checks.

```bash
agentvault health [options]

Options:
  -c, --canister-id <id>   Canister ID
  --detailed               Detailed health report
  --json                   JSON output

Examples:
  agentvault health
  agentvault health --canister-id abcde-aaaab --detailed
```

### info

Get canister information.

```bash
agentvault info [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --json                   JSON output

Examples:
  agentvault info --canister-id abcde-aaaab
  agentvault info -c abcde-aaaab --json
```

### stats

View canister statistics.

```bash
agentvault stats [options]

Options:
  -c, --canister-id <id>   Canister ID
  --period <period>        Time period (1h, 24h, 7d, 30d)
  --format <format>        Output format (table, json)

Examples:
  agentvault stats --canister-id abcde-aaaab
  agentvault stats -c abcde-aaaab --period 24h
```

### logs

View canister logs.

```bash
agentvault logs [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  -n, --lines <n>          Number of lines (default: 100)
  -f, --follow             Follow log output
  --level <level>          Filter by level (debug, info, warn, error)
  --since <time>           Show logs since time

Examples:
  agentvault logs --canister-id abcde-aaaab
  agentvault logs -c abcde-aaaab -f
  agentvault logs -c abcde-aaaab --level error --since 1h
```

---

## Backup Commands

### backup

Backup agent data.

```bash
agentvault backup [command] [options]

Subcommands:
  create                  Create backup
  list                    List backups
  restore                 Restore from backup
  delete                  Delete backup
  export                  Export backup
  schedule                Schedule backups

Options:
  -c, --canister-id <id>   Canister ID
  -o, --output <path>      Output path
  --no-canister-state      Skip fetching canister state

Examples:
  agentvault backup --canister-id abcde-aaaab
  agentvault backup export my-agent -o ./backup.json
  agentvault backup list --canister-id abcde-aaaab
```

### rebuild

Rebuild agent from state.

```bash
agentvault rebuild [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --state-file <path>      State file path
  --verify                 Verify after rebuild

Examples:
  agentvault rebuild --canister-id abcde-aaaab
  agentvault rebuild -c abcde-aaaab --state-file ./state.json
```

---

## Deployment Commands

### promote

Promote canister between environments.

```bash
agentvault promote [options] <agent-name>

Options:
  -f, --from <env>         Source environment
  -t, --to <env>           Target environment
  --target-canister <id>   Target canister ID
  --blue-green             Enable blue-green deployment
  -w, --wasm-path <path>   Path to WASM file
  --skip-deploy            Skip actual deploy, only update history

Examples:
  agentvault promote my-agent --from staging --to production
  agentvault promote my-agent -f local -t staging --blue-green
  agentvault promote my-agent -f staging -t prod -w ./dist/agent.wasm
```

### rollback

Rollback canister deployment.

```bash
agentvault rollback [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --version <n>            Version to rollback to
  --list                   List available versions
  --force                  Force rollback without confirmation

Examples:
  agentvault rollback --canister-id abcde-aaaab --list
  agentvault rollback -c abcde-aaaab --version 3
```

---

## Advanced Commands

### inference

Query AI inference services (Bittensor).

```bash
agentvault inference [options]

Options:
  --prompt <text>          Prompt text
  --model <model>          Model identifier
  --network <network>      Network endpoint
  --timeout <ms>           Request timeout

Examples:
  agentvault inference --prompt "Hello, world"
  agentvault inference --prompt "Analyze this" --model text-generation
```

### archive

Manage the local archive records kept in `~/.agentvault/archives`
(experimental). This command uploads nothing to Arweave; the web dashboard's
Archive flow is what uploads a deployment receipt.

```bash
agentvault archive <command> [options]

Subcommands:
  prepare <agent-name> <version>   Create a local archive record (not uploaded)
  list [--agent <name>] [--status <status>]
                                   List archive records; status is pending,
                                   uploading, submitted or failed
  stats [--agent <name>]           Count records by status
  delete <archive-id>              Delete a local archive record
  verify <archive-id>              Check the local copy against its recorded
                                   SHA-256 (Arweave is not checked)

Examples:
  agentvault archive prepare my-agent 1.0.0
  agentvault archive list --status submitted
  agentvault archive verify <archive-id>
```

"Submitted" means a node accepted the upload and its transaction ID was
recorded; this command does not check whether it was mined.

### approve

Approval requests with a signer quorum, tracked locally in
`~/.agentvault/approvals` (experimental). Signer names are not authenticated,
an approval is not a cryptographic signature, and no deploy, upgrade or
transfer waits for one.

```bash
agentvault approve <command> [options]

Subcommands:
  create <type> <agent-name> <description>
                                   Create a request (type: deploy, upgrade,
                                   transfer, config_change, rollback)
  list [--agent <name>] [--status <status>]
                                   List requests
  sign <request-id> <signer>       Record an approval by <signer>
  reject <request-id> <signer>     Reject a request
  pending <signer>                 List pending requests for a signer
  delete <request-id>              Delete a request
  cleanup                          Mark pending requests past their timeout as expired
  mfa <command>                    Optional TOTP and device checks with a local
                                   audit log; sign does not require them

Examples:
  agentvault approve create deploy my-agent "Deploy v1.2" --policy majority --signers 3
  agentvault approve list --status pending
  agentvault approve sign <request-id> alice
```

### profile

Profile canister performance.

```bash
agentvault profile [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --duration <ms>          Profile duration
  --output <path>          Output file

Examples:
  agentvault profile --canister-id abcde-aaaab
  agentvault profile -c abcde-aaaab --duration 60000
```

### trace

View execution traces.

```bash
agentvault trace [options]

Options:
  -c, --canister-id <id>   Canister ID (required)
  --limit <n>              Number of traces
  --format <format>        Output format (table, json)

Examples:
  agentvault trace --canister-id abcde-aaaab
  agentvault trace -c abcde-aaaab --limit 50
```

---

## Command Summary

| Category | Commands |
|----------|----------|
| Core | `init`, `package`, `deploy`, `exec`, `show`, `fetch`, `status`, `list` |
| Wallet | `wallet`, `identity`, `cycles`, `tokens` |
| Monitoring | `monitor`, `health`, `info`, `stats`, `logs` |
| Backup | `backup`, `rebuild` |
| Deployment | `promote`, `rollback` |
| Advanced | `inference`, `archive`, `approve`, `profile`, `trace` |

## Getting Help

```bash
# General help
agentvault --help

# Command-specific help
agentvault <command> --help

# Examples
agentvault deploy --help
agentvault wallet --help
```
