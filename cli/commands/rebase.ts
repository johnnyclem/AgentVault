/**
 * Rebase command — Fetch on-chain commits and merge with a local bundle
 *
 * Usage:
 *   agentvault rebase --branch=main --canister=<id> --output=local_bundle.json
 *
 * Steps:
 *   1. Fetch latest commits from the MemoryRepo canister for the given branch.
 *   2. Deserialize on-chain thoughtforms (commits carrying diffs & tags).
 *   3. Merge with the local bundle (compare timestamps; prefer on-chain for conflicts).
 *   4. Write the updated bundle to --output without data loss.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  createMemoryRepoActor,
  createAnonymousAgent,
  validateCanisterId,
} from '../../src/canister/memory-repo-actor.js';
import type { Commit } from '../../src/canister/memory-repo-actor.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A deserialized thoughtform — the local representation of an on-chain commit.
 */
export interface ThoughtForm {
  id: string;
  timestamp: number;
  message: string;
  diff: string;
  tags: string[];
  branch: string;
  parent: string | null;
}

/**
 * A single entry inside a local bundle file.
 */
export interface BundleEntry {
  id: string;
  timestamp: number;
  message: string;
  diff: string;
  tags: string[];
  branch: string;
  parent: string | null;
  source: 'local' | 'on-chain';
}

/**
 * The local bundle JSON structure.
 */
export interface Bundle {
  version: number;
  canisterId: string;
  branch: string;
  updatedAt: string;
  entries: BundleEntry[];
}

/**
 * Options accepted by the rebase command.
 */
export interface RebaseCommandOptions {
  branch: string;
  canister: string;
  output: string;
  host?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert a canister Commit (bigint timestamp in nanoseconds) into a ThoughtForm.
 */
export function deserializeCommit(commit: Commit): ThoughtForm {
  return {
    id: commit.id,
    timestamp: Number(BigInt(commit.timestamp) / BigInt(1_000_000)), // ns → ms
    message: commit.message,
    diff: commit.diff,
    tags: [...commit.tags],
    branch: commit.branch,
    parent: commit.parent.length > 0 ? (commit.parent[0] ?? null) : null,
  };
}

/**
 * Convert a ThoughtForm to a BundleEntry.
 */
function toBundleEntry(tf: ThoughtForm, source: 'local' | 'on-chain'): BundleEntry {
  return { ...tf, source };
}

/**
 * Read an existing local bundle from disk.  Returns `null` when the file does
 * not exist (a fresh rebase will create it).
 */
export function readLocalBundle(filePath: string): Bundle | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Bundle;
}

/**
 * Merge on-chain thoughtforms with an existing local bundle.
 *
 * Strategy:
 *   - Build a map keyed by entry `id`.
 *   - When both local and on-chain have the same id, keep the on-chain version
 *     (authoritative source of truth) **unless** the local timestamp is strictly
 *     newer — which would indicate a local-only edit made after the last sync.
 *   - Entries present only on one side are kept as-is.
 *   - The result is sorted ascending by timestamp for deterministic output.
 */
export function mergeEntries(
  localEntries: BundleEntry[],
  onChainForms: ThoughtForm[],
): BundleEntry[] {
  const merged = new Map<string, BundleEntry>();

  // Seed with local entries
  for (const entry of localEntries) {
    merged.set(entry.id, entry);
  }

  // Overlay on-chain entries, preferring on-chain for conflicts
  for (const tf of onChainForms) {
    const existing = merged.get(tf.id);
    if (!existing) {
      // New on-chain entry not present locally
      merged.set(tf.id, toBundleEntry(tf, 'on-chain'));
    } else if (existing.source === 'local' && existing.timestamp > tf.timestamp) {
      // Local is strictly newer — keep local version
      // (local-only edit after the last sync)
    } else {
      // On-chain wins (same timestamp or on-chain is newer)
      merged.set(tf.id, toBundleEntry(tf, 'on-chain'));
    }
  }

  // Sort ascending by timestamp for deterministic ordering
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// ──────────────────────────────────────────────────────────────────────────────
// Core execution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Execute the rebase: fetch on-chain commits, merge, write bundle.
 */
export async function executeRebase(options: RebaseCommandOptions): Promise<Bundle> {
  const { branch, canister, output, host } = options;

  // Validate canister ID
  validateCanisterId(canister);

  const spinner = ora('Connecting to MemoryRepo canister...').start();

  // 1. Create agent & actor
  const agent = createAnonymousAgent(host);
  const resolvedHost = host ?? process.env.ICP_LOCAL_URL ?? 'http://localhost:4943';
  if (!resolvedHost.includes('ic0.app') && !resolvedHost.includes('icp0.io')) {
    await agent.fetchRootKey();
  }
  const actor = createMemoryRepoActor(canister, agent);

  // 2. Fetch on-chain commits for the target branch
  spinner.text = `Fetching commits from branch '${branch}'...`;
  const branchArg: [string] | [] = branch ? [branch] : [];
  const commits: Commit[] = await actor.log(branchArg);

  if (commits.length === 0) {
    spinner.warn(chalk.yellow(`No commits found on branch '${branch}'.`));
    // Still produce a valid (empty) bundle so the file is never left in a bad state
  } else {
    spinner.succeed(chalk.green(`Fetched ${commits.length} commit(s) from branch '${branch}'.`));
  }

  // 3. Deserialize thoughtforms
  const thoughtForms = commits.map(deserializeCommit);

  // 4. Load existing local bundle (if any)
  const outputPath = path.resolve(output);
  const existingBundle = readLocalBundle(outputPath);

  // 5. Merge
  const localEntries = existingBundle?.entries ?? [];
  const mergedEntries = mergeEntries(localEntries, thoughtForms);

  const newLocalOnly = mergedEntries.filter(e => e.source === 'local').length;
  const newOnChain = mergedEntries.filter(e => e.source === 'on-chain').length;

  // 6. Build the output bundle
  const bundle: Bundle = {
    version: 1,
    canisterId: canister,
    branch,
    updatedAt: new Date().toISOString(),
    entries: mergedEntries,
  };

  // 7. Write to disk (atomic: write to tmp, then rename)
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(bundle, null, 2), 'utf-8');
  fs.renameSync(tmpPath, outputPath);

  // Summary
  console.log();
  console.log(chalk.cyan('Rebase summary:'));
  console.log(`  Branch:           ${chalk.bold(branch)}`);
  console.log(`  Canister:         ${chalk.bold(canister)}`);
  console.log(`  On-chain entries: ${chalk.green(String(newOnChain))}`);
  console.log(`  Local entries:    ${chalk.green(String(newLocalOnly))}`);
  console.log(`  Total entries:    ${chalk.bold(String(mergedEntries.length))}`);
  console.log();
  console.log(chalk.green('✓'), 'Bundle saved to:', chalk.bold(outputPath));

  return bundle;
}

// ──────────────────────────────────────────────────────────────────────────────
// Commander registration
// ──────────────────────────────────────────────────────────────────────────────

export function rebaseCommand(): Command {
  const command = new Command('rebase');

  command
    .description('Fetch on-chain commits and merge with a local bundle file')
    .requiredOption('--branch <name>', 'Branch to rebase from (e.g. main)')
    .requiredOption('--canister <id>', 'MemoryRepo canister ID')
    .option('-o, --output <path>', 'Output bundle file path', 'local_bundle.json')
    .option('--host <url>', 'ICP replica host URL')
    .action(async (options: RebaseCommandOptions) => {
      console.log(chalk.bold('\n🔄 AgentVault Rebase\n'));

      try {
        await executeRebase(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nRebase failed: ${message}`));
        process.exit(1);
      }
    });

  return command;
}
