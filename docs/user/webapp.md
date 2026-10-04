# Web Dashboard Guide

This guide covers using the AgentVault web application for managing AI agents.

## Overview

The AgentVault web dashboard provides a graphical interface for:
- **Agent Management** - Create, configure, deploy, and monitor agents
- **Canister Monitoring** - View status, cycles, memory, and health
- **Task Queue** - Monitor background operations and workflows
- **Log Viewing** - Filter and search canister logs
- **Wallet Management** - Manage wallets and transactions
- **Network Status** - Monitor ICP network connectivity
- **Settings** - Configure preferences and application settings

## Getting Started

### Installation

Install and start the web dashboard:

```bash
# from repo root
npm run dev:dashboard   # core + dashboard
# or dashboard only
npm run dev:webapp
```

The dashboard will be available at: `http://localhost:3000`

### Accessing Dashboard

Open browser and navigate to: `http://localhost:3000`

First time users will see:
- **Canisters Page** - Overview of deployed canisters
- **Sidebar Navigation** - Quick access to all features

## Authentication

The web dashboard uses local-only mode (v1):
- **No user account required**
- **Connects to local ICP network automatically**
- **Wallet integration in future versions**

## Pages and Features

### Canisters

View and manage deployed canisters:

**Features:**
- View canister status (running, stopped, error)
- Check cycles balance and memory usage
- View canister metrics (requests, errors, latency)
- Access canister health details
- Stop/start/restart canisters

**Usage:**
```
1. Navigate to Canisters page
2. View status cards for each canister
3. Click canister for details
4. Use actions: Start, Stop, Restart
```

### Agents

Manage your AI agents:

**Features:**
- Create new agents with configuration
- View agent status (active, inactive, deploying)
- Configure agent settings (memory, compute, entry point)
- Deploy agents to canisters
- View agent metrics (requests, uptime, errors)
- View deployment history

**Usage:**
```
1. Navigate to Agents page
2. Click "New Agent" button
3. Fill in agent configuration form
4. Click "1-Click Deploy" to package + deploy automatically
5. Monitor deployment progress in Tasks page
```

**Note:** One-click deploy resolves the agent source from `sourcePath` (or `workingDirectory`) in the saved agent config.

### Tasks

Monitor background operations:

**Features:**
- View task queue (deploy, backup, restore, upgrade)
- Track task progress with progress bars
- View task status (pending, running, completed, failed)
- View task details and error messages
- Retry failed tasks

**Usage:**
```
1. Navigate to Tasks page
2. Filter tasks by type and status
3. Click task for details
4. Monitor real-time progress
5. View task logs and errors
```

### Logs

View and filter canister logs:

**Features:**
- Real-time log streaming
- Filter by log level (debug, info, warn, error)
- Filter by canister ID
- Search log messages
- Export logs for analysis
- View log entry details

**Log Levels:**
- **Debug** - Detailed debugging information
- **Info** - General informational messages
- **Warn** - Warning messages for potential issues
- **Error** - Error messages for failures

**Usage:**
```
1. Navigate to Logs page
2. Use filter bar to select canister and log level
3. Search for specific messages
4. Click log entry for details
5. Export logs for offline analysis
```

### Wallets

Manage wallets and transactions:

**Features:**
- View connected wallets
- Check wallet balances
- View transaction history
- Send transactions
- Connect new wallets

**Usage:**
```
1. Navigate to Wallets page
2. View wallet overview cards
3. Click "Send" to transfer cycles
4. View transaction history
5. Connect additional wallets
```

### Networks

Monitor ICP network connectivity:

**Features:**
- View network status (connected, disconnected, degraded)
- Switch between local and production networks
- View network configuration
- Monitor node count and health

**Usage:**
```
1. Navigate to Networks page
2. View network status cards
3. Click "Connect" to switch networks
4. Monitor node health and latency
```

### Backups

Manage backups and archival:

**Features:**
- View list of local backups
- View Arweave archive status
- Create new backups
- Download backups
- Delete backups
- View backup statistics

**Usage:**
```
1. Navigate to Backups page
2. View backup list and status
3. Click "Create Backup" for canister backup
4. Click "Archive" to upload to Arweave
5. View backup size and cost information
```

### Settings

Configure application preferences:

**Features:**
- Theme selection (light, dark, system)
- Auto-refresh settings
- Notification preferences
- Security settings
- Backup configuration

**Usage:**
```
1. Navigate to Settings page
2. Select preferred theme
3. Configure auto-refresh interval
4. Enable/disable notifications
5. Save preferences
```

## Keyboard Shortcuts

Navigate the dashboard efficiently:

| Shortcut | Action |
|-----------|--------|
| `Ctrl/Cmd + K` | Open command palette |
| `Ctrl/Cmd + /` | Focus search bar |
| `Ctrl/Cmd + 1` | Navigate to Canisters |
| `Ctrl/Cmd + 2` | Navigate to Agents |
| `Ctrl/Cmd + 3` | Navigate to Tasks |
| `Ctrl/Cmd + 4` | Navigate to Logs |
| `Ctrl/Cmd + 5` | Navigate to Wallets |
| `Ctrl/Cmd + N` | Create new item (context-dependent) |
| `Ctrl/Cmd + R` | Refresh current page |
| `Esc` | Close modal/drawer |

## Troubleshooting

### Dashboard Not Loading

**Browser not supported:**
```
Use Chrome 90+, Firefox 88+, Safari 14+, or Edge
Enable JavaScript
```

**Connection refused:**
```
Verify backend is running: npm run dev
Check port 3000 is not in use
```

### Features Not Working

**Real-time updates not showing:**
```
Check WebSocket connection
Verify network connectivity
Refresh the page
```

**Wallet not connecting:**
```
Check wallet configuration
Verify browser extensions are not blocking
Try different browser (Chrome vs Firefox)
```

### Performance Issues

**Slow page loads:**
```
Check internet connection
Close unused tabs
Clear browser cache
```

**High memory usage:**
```
Limit log entries per page
Use filters instead of loading all logs
Refresh canisters less frequently
```

## Tips and Best Practices

### Monitoring

- [ ] **Keep dashboard open** - Monitor agent health in real-time
- [ ] **Set up alerts** - Get notified of failures
- [ ] **Review logs regularly** - Catch issues early
- [ ] **Check cycles balance** - Prevent out-of-cycles errors

### Navigation

- [ ] **Use keyboard shortcuts** - Navigate faster
- [ ] **Bookmark frequently used pages** - Quick access
- [ ] **Use browser tabs** - Work with multiple agents simultaneously
- [ ] **Use command palette** - Quick access to any feature

### Data Management

- [ ] **Export logs regularly** - For offline analysis
- [ ] **Create backups before major changes** - Easy rollback
- [ ] **Review metrics over time** - Identify trends and issues
- [ ] **Clean up old tasks** - Keep task queue manageable

## Mobile Access

The web dashboard is responsive and works on mobile devices:

- **Responsive layout** - Sidebar collapses on mobile
- **Touch-friendly controls** - Larger tap targets
- **Optimized tables** - Horizontal scroll for data tables

## Browser Extensions

Recommended extensions for enhanced experience:

- **ICP Wallet** - Browser wallet integration (future)
- **React Developer Tools** - Debug component issues
- **Redux DevTools** - Debug state management

## Advanced Features

### Real-time Metrics

View live metrics and charts:

```
Canisters page -> Click canister -> View charts
- Request rate over time
- Error rate over time
- Latency histogram
- Memory usage timeline
```

### Task Dependencies

View task dependency graphs:

```
Tasks page -> Click task -> View dependencies
- Shows which tasks must complete first
- Parallel execution visualization
- Critical path highlighting
```

### Search

Search across all dashboard entities:

```
Ctrl/Cmd + K -> Search
- Search canisters, agents, tasks, logs
- Filter by name, ID, status
- Jump to results
```

## API Integration

The dashboard exposes internal APIs for custom integrations:

```javascript
// Get canister status
GET /api/canisters/:id

// Get agent list
GET /api/agents

// Get task status
GET /api/tasks/:id

// Get logs
GET /api/logs?canisterId=:id&level=:level
```

### MemoryRepo and Polytician routes

These routes serve Polytician's `vault_*` tools and Polytician's concepts. Each one requires
`Authorization: Bearer <token>`, where the token is the server's `AGENTVAULT_POLYTICIAN_API_TOKEN`.

| Route | What it does |
|---|---|
| `POST /api/memory-repo/commits` | Commit entries to a `memory_repo` branch (Polytician's `vault_memory_push`). Signed. |
| `POST /api/memory-repo/tombstone` | Commit a deletion of one key. Signed. |
| `GET /api/memory-repo/branches/:branch` | The branch's current entries, replayed from every commit (Polytician's `vault_memory_pull`). Anonymous query. |
| `/api/polytician/:agentId/{stats,search,concepts,concepts/:id,archive}` | Polytician's concepts in the namespace `agentId`. |

The `memory_repo` canister refuses anonymous writes, so the two write routes sign with the server's own
identity, which the repo owner must authorize. With no identity configured they answer 503
`SIGNING_IDENTITY_NOT_CONFIGURED` without calling the canister; a principal the owner has not authorized gets 403
`SIGNER_NOT_AUTHORIZED`, a frozen or killed repo 423, and a canister older than this release 502
`MEMORY_REPO_OUTDATED`. They commit onto the named branch in one canister call, so concurrent requests cannot
land on each other's branch, and create a missing branch from `main`. A successful commit reports the signing
principal as `author`. See [MemoryRepo: who can write](../memory-repo.md#who-can-write) for setting the identity
up.

These routes, and `/api/archival/upload`, `/api/inference` and `/api/secrets/:name`, are the ones Polytician's
AgentVault client calls, so their errors (including a 401 for a wrong token) are in the shape it reads:
`{ "success": false, "code": "<CODE>", "error": "<CODE>: <message>" }`. The other routes answer
`{ "success": false, "error": { "message", "code" } }`. The Polytician the webapp starts never gets the signing
key or AgentVault's wallet secrets in its environment.

The Polytician routes start Polytician with `POLYTICIAN_ENTRY_POINT` and use the `agentId` in the path as the
Polytician namespace: the agent's name, which `agentvault polytician` and `agentvault orchestrate` also default
to. An `agentId` that is not a valid namespace gets 400 `INVALID_AGENT_ID`. See the
[Polytician guide](../guides/polytician.md).

### Server environment

Set these where the webapp runs (`webapp/.env.local` in development, your host's settings in production). The
routes read them on every request.

| Variable | Used by | Description |
|---|---|---|
| `AGENTVAULT_POLYTICIAN_API_TOKEN` | all routes above | The bearer token the routes require. Polytician's `POLYTICIAN_AV_API_TOKEN` must equal it. |
| `MEMORY_REPO_CANISTER_ID` | `/api/memory-repo/*` | The `memory_repo` canister. |
| `ICP_LOCAL_URL` | `/api/memory-repo/*` | Replica host for a local replica; the default is `https://ic0.app`. |
| `AGENTVAULT_ICP_IDENTITY_PEM_FILE` | memory_repo writes | Path of the PEM key the write routes sign with. |
| `AGENTVAULT_ICP_IDENTITY_PEM` | memory_repo writes | The PEM text itself, for hosts without a filesystem (literal `\n` sequences are accepted). Set this or the file, not both. |
| `POLYTICIAN_ENTRY_POINT` | `/api/polytician/*` | The command that starts Polytician over stdio, e.g. `polytician`. Add `--config <path>` to give it a config file. |
| `AGENTVAULT_API_URL` | `/api/polytician/*` | The webapp's own base URL. With the token, it is passed to Polytician as `POLYTICIAN_AV_API_URL` and `POLYTICIAN_AV_API_TOKEN`, so Polytician offers its `vault_*` tools. https, or http to localhost. |

The server never reads a signing key from the home directory of the user it runs as. `webapp/.env.example`
lists these variables.

## Next Steps

- [ ] Read [Getting Started](./getting-started.md) for CLI usage
- [ ] Read [Deployment Guide](./deployment.md) for deployment details
- [ ] Read [MemoryRepo](../memory-repo.md) and the [Polytician guide](../guides/polytician.md) to connect Polytician
- [ ] Review [Security Best Practices](../security/best-practices.md)
