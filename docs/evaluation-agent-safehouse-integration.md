# Evaluation: AgentVault + Agent Safehouse Integration

**Date:** March 19, 2026
**Status:** Evaluation Complete

---

## Executive Summary

This document evaluates integrating [AgentVault](https://github.com/johnnyclem/agentvault) with [Agent Safehouse](https://agent-safehouse.dev/), a macOS-native sandboxing framework for LLM coding agents. The evaluation covers general integration feasibility and a specific use case: convenience methods allowing Agent Safehouse users to leverage AgentVault as their cloud backup solution.

**Recommendation:** Pursue a lightweight integration via:
1. A documentation section explaining existing interoperability
2. A small generalization of the `cloud-storage` module to support custom source paths, enabling Agent Safehouse users (and anyone else) to back up arbitrary directories through AgentVault's cloud-backup infrastructure

---

## 1. Tool Comparison

| Dimension | AgentVault | Agent Safehouse |
|-----------|-----------|-----------------|
| **Purpose** | On-chain AI agent deployment & management | OS-level sandbox for LLM coding agents |
| **Runtime** | Agents run in ICP WASM canisters | Agents run locally, wrapped by `sandbox-exec` |
| **Platform** | Cross-platform (Node.js 18+) | macOS only |
| **Security model** | VetKeys, multi-sig, TOTP, WebAuthn, scoped secrets, ICP audit log | Deny-first kernel sandbox, layered `.sb` profiles |
| **API surface** | TypeScript library + CLI | Shell script wrapper, no programmatic API |
| **Backup** | Local JSON/encrypted, cloud sync (GDrive/iCloud/Dropbox/OneDrive), Arweave | None (plain config files) |
| **Deny-first scope** | Software-level secret access (`agentvault safehouse` CLI) | OS-level filesystem/process/device access |

## 2. General Integration Assessment

### 2.1 Architectural Alignment

The two tools operate at fundamentally different layers:

- **AgentVault** packages, deploys, and manages agents that execute **on-chain** in ICP canisters. Its security concerns are cryptographic (VetKeys, multi-sig), network-level (canister access control), and operational (monitoring, health checks).

- **Agent Safehouse** restricts what a **local macOS process** can access at the kernel level. It cannot reach into an ICP canister or affect on-chain execution.

The overlap is limited to local development workflows where the `agentvault` CLI is invoked on macOS.

### 2.2 Shared Philosophy

Both tools embrace deny-first security. AgentVault's internal "safehouse" module (`src/vault/secret-management-layer.ts`) was inspired by Agent Safehouse's approach, applying it to secret access control rather than OS sandboxing. This shared philosophy means the tools are complementary rather than competing.

### 2.3 Where Integration Makes Sense

| Scenario | Feasibility | Value |
|----------|-------------|-------|
| Sandbox `agentvault` CLI during local dev | Possible (custom `.sb` profile) | Low-Medium |
| Custom Safehouse profile for AgentVault workflows | Possible (upstream contribution) | Medium |
| Sandbox LLM agents developing with AgentVault | Already works (Safehouse's core use case) | N/A |
| Programmatic sandbox-as-a-service from AgentVault | Not feasible (no API, macOS-only) | N/A |
| **AgentVault as cloud backup for Safehouse configs** | **Feasible with minor changes** | **Medium** |

### 2.4 Where Integration Does NOT Make Sense

- **On-chain agent sandboxing**: Agents run in ICP WASM — OS sandboxing is irrelevant
- **Cross-platform enforcement**: Safehouse is macOS-only; AgentVault serves all platforms
- **Tight coupling**: Creating hard dependencies between the tools increases maintenance burden for both

## 3. AgentVault as Cloud Backup for Safehouse Users

### 3.1 What Safehouse Users Would Back Up

Agent Safehouse users accumulate configuration worth preserving:

- Custom `.sb` sandbox policy profiles (in `profiles/60-agents/`, `profiles/65-apps/`, user overlays)
- Agent investigation configurations and presets
- Wrapper scripts with `--enable` flag combinations
- Audit/violation logs from sandbox enforcement

These are small text files, but losing custom profiles means re-engineering security policies from scratch.

### 3.2 What AgentVault Offers

AgentVault's backup infrastructure provides:

1. **Cloud sync** (`agentvault cloud-backup`): Auto-detects iCloud Drive, Google Drive, Dropbox, OneDrive; copies files with SHA-256 manifest; verify & restore
2. **Local encrypted backup** (`agentvault backup`): AES-256-GCM encryption, ed25519-signed key envelopes, Merkle root integrity verification
3. **Arweave archival** (`agentvault archive`): Permanent decentralized storage

### 3.3 Current Limitation

The `cloud-storage` module is currently coupled to AgentVault's own data layout. The `CloudArchiveOptions` type only supports four fixed categories (`includeConfigs`, `includeWallets`, `includeBackups`, `includeNetworks`), all rooted under `~/.agentvault/`.

To support Safehouse profiles (or any external data), the module needs a `customSources` extension point.

### 3.4 Proposed Change

Add an optional `customSources` field to `CloudArchiveOptions`:

```typescript
export interface CloudArchiveOptions {
  agentName?: string;
  includeConfigs: boolean;
  includeWallets: boolean;
  includeBackups: boolean;
  includeNetworks: boolean;
  /** Additional arbitrary directories to include in the archive */
  customSources?: Array<{ label: string; path: string }>;
}
```

CLI usage:

```bash
# Back up Safehouse profiles alongside AgentVault data
agentvault cloud-backup archive \
  --include-path /usr/local/share/agent-safehouse/profiles:safehouse-profiles

# Back up only Safehouse profiles
agentvault cloud-backup archive \
  --no-configs --no-wallets --no-backups --no-networks \
  --include-path ~/my-safehouse-profiles:safehouse-profiles
```

This is a general-purpose enhancement (~30 lines of code) that happens to enable the Safehouse use case without creating a hard dependency.

## 4. Limitations and Concerns

1. **Narrow user overlap**: Only macOS developers using both Agent Safehouse and AgentVault benefit from direct integration
2. **No bidirectional sync**: AgentVault cloud-backup is one-way archive + restore; it's not a live sync
3. **Safehouse has no backup needs by design**: Its profiles are declarative text files that can be version-controlled with git — backup tooling may be solving a non-problem
4. **macOS-only Safehouse**: iCloud Drive is the most natural cloud target, but AgentVault's cloud-backup already supports it
5. **Maintenance**: If Safehouse changes its directory layout, any path-detection logic in AgentVault would break

## 5. Recommendation

### Do

1. **Generalize the `cloud-storage` module** with `customSources` support — a clean, general-purpose enhancement that enables backing up any directory, including Safehouse profiles
2. **Add documentation** explaining how Agent Safehouse users can use `agentvault cloud-backup` to archive their profiles
3. **Add `--include-path` flag** to the `cloud-backup archive` CLI command

### Do Not

- Create a dedicated `agentvault safehouse-backup` command (too tightly coupled)
- Auto-detect Safehouse installation paths (fragile, narrow audience)
- Create a formal plugin/extension architecture just for this use case
- Attempt to programmatically invoke Safehouse from AgentVault

### Priority

**Low priority.** The `customSources` generalization is a nice-to-have quality-of-life improvement. The primary value is making the cloud-storage module more flexible for all users, with Safehouse backup as one beneficiary.
