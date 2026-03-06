/**
 * agentvault merge — Merge local thoughtform bundle with on-chain canister state
 *
 * Usage:
 *   agentvault merge --input=local_bundle.json --branch=main --canister=<canister-id>
 *
 * Steps:
 *   1. Deserialize local bundle JSON (array of thoughtforms with id + updatedAt).
 *   2. Fetch the current on-chain commit from the MemoryRepo canister.
 *   3. Resolve conflicts:
 *      - Matching IDs → keep the entry with the greater updatedAt.
 *      - New IDs → add them.
 *   4. Create a new commit on the canister with the merged thoughtforms.
 *
 * Acceptance: merged data pushed; canister has combined data, no duplicates.
 */

import * as fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  createMemoryRepoActor,
  createAnonymousAgent,
  validateCanisterId,
} from '../src/canister/memory-repo-actor.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single thoughtform entry.
 * `id` is the unique identifier; `updatedAt` is a numeric timestamp (ms epoch).
 */
export interface ThoughtForm {
  id: string;
  content: string;
  updatedAt: number;
  tags?: string[];
  [key: string]: unknown;
}

/**
 * The expected shape of a local bundle JSON file.
 */
export interface Bundle {
  thoughtforms: ThoughtForm[];
}

/**
 * Summary returned after a successful merge.
 */
export interface MergeSummary {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
  commitId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read and validate a local bundle file.
 */
function readBundle(filePath: string): Bundle {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read input file: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in bundle file: ${filePath}`);
  }

  // Accept either { thoughtforms: [...] } or a bare array
  if (Array.isArray(parsed)) {
    return { thoughtforms: validateThoughtforms(parsed) };
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.thoughtforms || !Array.isArray(obj.thoughtforms)) {
    throw new Error(
      'Bundle must contain a "thoughtforms" array or be a JSON array of thoughtforms.',
    );
  }

  return { thoughtforms: validateThoughtforms(obj.thoughtforms) };
}

/**
 * Validate that each entry has the required fields.
 */
function validateThoughtforms(items: unknown[]): ThoughtForm[] {
  const validated: ThoughtForm[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Record<string, unknown>;

    if (!item || typeof item !== 'object') {
      throw new Error(`thoughtforms[${i}]: must be an object`);
    }
    if (typeof item.id !== 'string' || !item.id) {
      throw new Error(`thoughtforms[${i}]: missing or invalid "id" (string required)`);
    }
    if (typeof item.content !== 'string') {
      throw new Error(`thoughtforms[${i}]: missing or invalid "content" (string required)`);
    }
    if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)) {
      throw new Error(`thoughtforms[${i}]: missing or invalid "updatedAt" (number required)`);
    }

    validated.push(item as unknown as ThoughtForm);
  }

  return validated;
}

/**
 * Parse on-chain commit diff back into thoughtforms.
 *
 * The diff is stored as a JSON-serialised array of thoughtforms.
 * If parsing fails (e.g. the commit used a free-text diff), return an empty array.
 */
function parseThoughtformsFromDiff(diff: string): ThoughtForm[] {
  if (!diff || !diff.trim()) return [];

  try {
    const parsed = JSON.parse(diff);
    if (Array.isArray(parsed)) {
      return validateThoughtforms(parsed);
    }
    // If it's a wrapper object with thoughtforms
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.thoughtforms)) {
      return validateThoughtforms(parsed.thoughtforms);
    }
  } catch {
    // Not JSON — might be a plain-text diff; return empty
  }

  return [];
}

/**
 * Merge local thoughtforms with on-chain thoughtforms.
 *
 * Conflict resolution:
 *   - Same ID → keep the one with the greater `updatedAt`.
 *   - New IDs → add them.
 *
 * Returns the merged list along with counts.
 */
export function mergeThoughtforms(
  local: ThoughtForm[],
  remote: ThoughtForm[],
): { merged: ThoughtForm[]; added: number; updated: number; unchanged: number } {
  // Index remote by id
  const remoteMap = new Map<string, ThoughtForm>();
  for (const tf of remote) {
    remoteMap.set(tf.id, tf);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  // Start with a copy of the remote map, then apply local changes
  const mergedMap = new Map<string, ThoughtForm>(remoteMap);

  for (const localTf of local) {
    const existing = mergedMap.get(localTf.id);

    if (!existing) {
      // New entry — add it
      mergedMap.set(localTf.id, localTf);
      added++;
    } else if (localTf.updatedAt > existing.updatedAt) {
      // Local is newer — update
      mergedMap.set(localTf.id, localTf);
      updated++;
    } else {
      // Remote is same or newer — keep remote
      unchanged++;
    }
  }

  return {
    merged: Array.from(mergedMap.values()),
    added,
    updated,
    unchanged,
  };
}

// ─── Execution ──────────────────────────────────────────────────────────────

/**
 * Create an initialized ICP agent, fetching root key for local replicas.
 */
async function createInitializedAgent(host?: string): Promise<ReturnType<typeof createAnonymousAgent>> {
  const agent = createAnonymousAgent(host);
  const resolvedHost = host ?? process.env.ICP_LOCAL_URL ?? 'http://localhost:4943';
  if (!resolvedHost.includes('ic0.app') && !resolvedHost.includes('icp0.io')) {
    await agent.fetchRootKey();
  }
  return agent;
}

/**
 * Execute the merge operation.
 */
export async function executeMerge(options: {
  input: string;
  branch: string;
  canister: string;
  host?: string;
}): Promise<MergeSummary> {
  // 1. Deserialise local bundle
  const bundle = readBundle(options.input);
  if (bundle.thoughtforms.length === 0) {
    throw new Error('Local bundle contains no thoughtforms.');
  }

  // 2. Validate canister and create actor
  validateCanisterId(options.canister);
  const agent = await createInitializedAgent(options.host);
  const actor = createMemoryRepoActor(options.canister, agent);

  // 3. Fetch current on-chain state from the target branch
  //    First switch to the target branch, then get the latest commit.
  const switchResult = await actor.switchBranch(options.branch);
  if ('err' in switchResult) {
    throw new Error(`Cannot switch to branch '${options.branch}': ${switchResult.err}`);
  }

  const commits = await actor.log([options.branch]);
  const remoteThoughtforms: ThoughtForm[] = [];

  if (commits.length > 0) {
    // Parse thoughtforms from the latest (head) commit diff
    const headCommit = commits[0];
    const parsed = parseThoughtformsFromDiff(headCommit.diff);
    remoteThoughtforms.push(...parsed);
  }

  // 4. Resolve conflicts
  const { merged, added, updated, unchanged } = mergeThoughtforms(
    bundle.thoughtforms,
    remoteThoughtforms,
  );

  // 5. Create new commit with merged data
  const diffPayload = JSON.stringify(merged, null, 2);
  const message = `merge: ${added} added, ${updated} updated, ${unchanged} unchanged (${merged.length} total)`;
  const tags = ['merge', 'cli'];

  const commitResult = await actor.commit(message, diffPayload, tags);

  if ('err' in commitResult) {
    throw new Error(`Commit failed: ${commitResult.err}`);
  }

  return {
    added,
    updated,
    unchanged,
    total: merged.length,
    commitId: commitResult.ok,
  };
}

// ─── CLI Command ────────────────────────────────────────────────────────────

export function mergeCommand(): Command {
  const command = new Command('merge');

  command
    .description('Merge a local thoughtform bundle with on-chain canister state')
    .requiredOption('--input <path>', 'Path to local bundle JSON file')
    .requiredOption('--branch <name>', 'Target branch on the canister (e.g. main)')
    .requiredOption('--canister <id>', 'MemoryRepo canister ID')
    .option('--host <url>', 'ICP replica host URL (overrides ICP_LOCAL_URL env)')
    .action(async (options: { input: string; branch: string; canister: string; host?: string }) => {
      console.log(chalk.bold('\n  AgentVault Merge\n'));

      const spinner = ora('Merging local bundle with on-chain state...').start();

      try {
        const summary = await executeMerge(options);

        spinner.succeed(chalk.green('Merge complete'));
        console.log();
        console.log(chalk.bold('  Summary'));
        console.log(chalk.gray('  ' + '─'.repeat(40)));
        console.log(`  Added:     ${chalk.green(String(summary.added))}`);
        console.log(`  Updated:   ${chalk.yellow(String(summary.updated))}`);
        console.log(`  Unchanged: ${chalk.gray(String(summary.unchanged))}`);
        console.log(`  Total:     ${chalk.bold(String(summary.total))}`);
        console.log(`  Commit:    ${chalk.cyan(summary.commitId)}`);
        console.log();
      } catch (error) {
        spinner.fail(chalk.red('Merge failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  return command;
}
