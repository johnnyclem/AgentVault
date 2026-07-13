# Quick Start

Deploy your first AgentVault agent in under 10 minutes.

:::note Prerequisites
- Node.js 18+
- `dfx` installed and reachable in PATH
:::

No install step is required — `npx agentvault@latest` fetches the CLI on demand. If you prefer a global install, run `npm install -g agentvault` and use `agentvault` in place of `npx agentvault@latest` below.

## 1. Initialize your project

```bash
npx agentvault@latest init my-first-agent --template default
cd my-first-agent
```

This scaffolds a new project directory containing:

- `agent.json` — agent metadata (name, version, entry point)
- `index.js` — your agent's entry point, with a working task handler
- `.agentvault/` — local project state used by the CLI
- `README.md` and `.gitignore`

Use `--template minimal` if you only want `agent.json` and `index.js`.

## 2. Start the local ICP runtime

```bash
dfx start --background
dfx ping
```

## 3. Package the agent

```bash
npx agentvault@latest package ./
```

This compiles the agent and prepares deterministic deployment output.

## 4. Deploy to Local Network

```bash
npx agentvault@latest deploy --network local
```

Copy the canister ID printed in the command output — you'll need it in the next steps.

## 5. Verify it's running

```bash
npx agentvault@latest status
npx agentvault@latest info
npx agentvault@latest health
```

## 6. Run a task

```bash
npx agentvault@latest exec --canister-id <YOUR_CANISTER_ID> "hello world"
```

## 7. Read and back up state

```bash
npx agentvault@latest show --canister-id <YOUR_CANISTER_ID>
npx agentvault@latest backup --canister-id <YOUR_CANISTER_ID>
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
