# Quick Start

Deploy your first AgentVault agent in under 10 minutes.

:::note Prerequisites
- Node.js 18+
- `dfx` installed and reachable in PATH
- AgentVault CLI installed (`npm install -g agentvault`)
:::

## 1. Initialize your project

```bash
agentvault init my-first-agent
cd my-first-agent
```

This creates a baseline project with config, source, and package metadata.

## 2. Start the local ICP runtime

```bash
dfx start --background
dfx ping
```

## 3. Package the agent

```bash
agentvault package ./
```

This compiles the agent and prepares deterministic deployment output.

## 4. Deploy to Local Network

```bash
agentvault deploy --network local
```

Copy the canister ID printed in the command output — you'll need it in the next steps.

## 5. Verify it's running

```bash
agentvault status
agentvault info
agentvault health
```

## 6. Run a task

```bash
agentvault exec --canister-id <YOUR_CANISTER_ID> "hello world"
```

## 7. Read and back up state

```bash
agentvault show --canister-id <YOUR_CANISTER_ID>
agentvault backup --canister-id <YOUR_CANISTER_ID>
```

:::tip Pro tip
Automate `status`, `health`, and `backup` checks in your local CI before promoting deployments.
:::

## Next Steps

| Goal | Guide |
| --- | --- |
| Full walkthrough | [Tutorial](/docs/user/tutorial-v1.0) |
| Deploy to mainnet | [Deployment Guide](/docs/user/deployment) |
| Manage wallets across chains | [Wallet Guide](/docs/user/wallets) |
| All CLI commands | [CLI Reference](/docs/cli/reference) |

## Common Commands

```bash
# List all local agents
agentvault list

# View runtime logs
agentvault logs <canister-id>

# Fetch state to restore locally
agentvault fetch --canister-id <canister-id>

# Inspect cycle balance
agentvault cycles balance <canister-id>
```

## Help

```bash
agentvault --help
agentvault <command> --help
```

See [Troubleshooting](/docs/user/troubleshooting) if a command fails or the output doesn't match what you expect.
