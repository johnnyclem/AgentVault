/**
 * agentvault memory — Git-style memory repository commands
 *
 * Subcommands:
 *   memory init [soul-file]              Initialize repo from soul.md
 *   memory commit <message> -d -t        Create commit
 *   memory log --branch <name>           Git-style log output
 *   memory status                        Repo status
 *   memory branch [name]                 List/create branches
 *   memory checkout <branch>             Switch branch
 *   memory show <commit-id>              Show commit details
 *   memory rebase --from-soul <file>     Rebase with new soul (PRD 3)
 *   memory merge --from-branch <name>    Merge branch (PRD 4)
 *   memory cherry-pick <commit-id>       Cherry-pick commit (PRD 4)
 *
 * Examples:
 *   agentvault memory init soul.md
 *   agentvault memory commit "Add chat memory" -d "user said hello" -t memory,chat
 *   agentvault memory log --branch main
 *   agentvault memory rebase --from-soul new-soul.md
 *   agentvault memory merge --from-branch chat-history
 */

import * as fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createMemoryRepoActor, createAnonymousAgent } from '../../src/canister/memory-repo-actor.js';
import type { Commit, MergeResult } from '../../src/canister/memory-repo-actor.js';

/**
 * Resolve the MemoryRepo canister ID from CLI flag, env var, or canister_ids.json.
 */
function resolveCanisterId(options: { canisterId?: string }): string {
  if (options.canisterId) return options.canisterId;
  if (process.env.MEMORY_REPO_CANISTER_ID) return process.env.MEMORY_REPO_CANISTER_ID;

  // Try dfx-generated canister_ids.json
  try {
    const raw = fs.readFileSync('canister_ids.json', 'utf-8');
    const ids = JSON.parse(raw);
    if (ids.memory_repo?.local) return ids.memory_repo.local;
    if (ids.memory_repo?.ic) return ids.memory_repo.ic;
  } catch {
    // canister_ids.json not found
  }

  // Try .dfx/local/canister_ids.json
  try {
    const raw = fs.readFileSync('.dfx/local/canister_ids.json', 'utf-8');
    const ids = JSON.parse(raw);
    if (ids.memory_repo?.local) return ids.memory_repo.local;
  } catch {
    // .dfx not found
  }

  throw new Error(
    'Cannot resolve MemoryRepo canister ID.\n' +
    'Use --canister-id flag, set MEMORY_REPO_CANISTER_ID env, or run dfx deploy memory_repo.',
  );
}

/**
 * Format a timestamp (nanoseconds from ICP) into a human-readable date string.
 */
function formatTimestamp(ns: number): string {
  const ms = Number(BigInt(ns) / BigInt(1_000_000));
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Print a commit in git-style log format.
 */
function printCommit(c: Commit): void {
  console.log(chalk.yellow(`commit ${c.id}`));
  console.log(`Branch: ${chalk.green(c.branch)}`);
  console.log(`Date:   ${formatTimestamp(c.timestamp)}`);
  if (c.tags.length > 0) {
    console.log(`Tags:   ${c.tags.map(t => chalk.cyan(`[${t}]`)).join(' ')}`);
  }
  if (c.parent.length > 0) {
    console.log(`Parent: ${chalk.gray(c.parent[0])}`);
  }
  console.log();
  console.log(`    ${c.message}`);
  console.log();
}

const memoryCmd = new Command('memory');

memoryCmd
  .description('Git-style memory repository commands for agent identity and versioned memory')
  .option('--canister-id <id>', 'MemoryRepo canister ID (overrides env/config)');

// ─── memory init ────────────────────────────────────────────────────────────

memoryCmd
  .command('init')
  .description('Initialize memory repository from a soul.md file')
  .argument('[soul-file]', 'Path to soul.md file', 'soul.md')
  .action(async (soulFile: string, _opts: unknown, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora('Initializing memory repository...').start();

    try {
      let soulContent: string;
      try {
        soulContent = fs.readFileSync(soulFile, 'utf-8');
      } catch {
        spinner.fail(chalk.red(`Soul file not found: ${soulFile}`));
        process.exit(1);
      }

      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const result = await actor.initRepo(soulContent);

      if ('ok' in result) {
        spinner.succeed(chalk.green(`Repository initialized from ${soulFile}`));
        console.log(chalk.gray(`  Genesis commit: ${result.ok}`));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to initialize repository'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory commit ──────────────────────────────────────────────────────────

memoryCmd
  .command('commit')
  .description('Create a new commit on the current branch')
  .argument('<message>', 'Commit message')
  .requiredOption('-d, --diff <diff>', 'Diff content for the commit')
  .option('-t, --tags <tags>', 'Comma-separated tags', '')
  .action(async (message: string, options: { diff: string; tags: string }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora('Creating commit...').start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const tags = options.tags ? options.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const result = await actor.commit(message, options.diff, tags);

      if ('ok' in result) {
        spinner.succeed(chalk.green(`Commit created: ${result.ok}`));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to create commit'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory log ─────────────────────────────────────────────────────────────

memoryCmd
  .command('log')
  .description('Show commit log for a branch')
  .option('--branch <name>', 'Branch to show log for (default: current)')
  .option('--json', 'Output raw JSON')
  .action(async (options: { branch?: string; json?: boolean }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora('Loading commit log...').start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const branchArg: [string] | [] = options.branch ? [options.branch] : [];
      const commits = await actor.log(branchArg);

      spinner.stop();

      if (commits.length === 0) {
        console.log(chalk.gray('No commits found.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(commits, null, 2));
        return;
      }

      for (const c of commits) {
        printCommit(c);
      }

      console.log(chalk.gray(`  ${commits.length} commit(s) total`));
    } catch (error) {
      spinner.fail(chalk.red('Failed to load log'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory status ──────────────────────────────────────────────────────────

memoryCmd
  .command('status')
  .description('Show repository status')
  .action(async (_opts: unknown, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora('Loading repository status...').start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const status = await actor.getRepoStatus();
      spinner.stop();

      console.log(chalk.bold('\n  MemoryRepo Status'));
      console.log(chalk.gray('  ' + '─'.repeat(40)));
      console.log(`  Initialized:     ${status.initialized ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Current branch:  ${chalk.green(status.currentBranch)}`);
      console.log(`  Total commits:   ${status.totalCommits}`);
      console.log(`  Total branches:  ${status.totalBranches}`);
      console.log(`  Owner:           ${chalk.gray(status.owner)}`);
      console.log();
    } catch (error) {
      spinner.fail(chalk.red('Failed to load status'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory branch ──────────────────────────────────────────────────────────

memoryCmd
  .command('branch')
  .description('List branches or create a new branch')
  .argument('[name]', 'Branch name to create (omit to list)')
  .action(async (name: string | undefined, _opts: unknown, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      if (name) {
        const spinner = ora(`Creating branch '${name}'...`).start();
        const result = await actor.createBranch(name);
        if ('ok' in result) {
          spinner.succeed(chalk.green(result.ok));
        } else {
          spinner.fail(chalk.red(result.err));
          process.exit(1);
        }
      } else {
        const spinner = ora('Loading branches...').start();
        const branchList = await actor.getBranches();
        const status = await actor.getRepoStatus();
        spinner.stop();

        if (branchList.length === 0) {
          console.log(chalk.gray('No branches found. Initialize the repository first.'));
          return;
        }

        console.log(chalk.bold('\n  Branches'));
        for (const [bName, headId] of branchList) {
          const marker = bName === status.currentBranch ? chalk.green('* ') : '  ';
          console.log(`  ${marker}${bName} ${chalk.gray(`-> ${headId}`)}`);
        }
        console.log();
      }
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory checkout ────────────────────────────────────────────────────────

memoryCmd
  .command('checkout')
  .description('Switch to a different branch')
  .argument('<branch>', 'Branch name to switch to')
  .action(async (branch: string, _opts: unknown, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora(`Switching to branch '${branch}'...`).start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const result = await actor.switchBranch(branch);

      if ('ok' in result) {
        spinner.succeed(chalk.green(result.ok));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to switch branch'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory show ────────────────────────────────────────────────────────────

memoryCmd
  .command('show')
  .description('Show details of a specific commit')
  .argument('<commit-id>', 'Commit ID to display')
  .option('--json', 'Output raw JSON')
  .action(async (commitId: string, options: { json?: boolean }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora(`Loading commit ${commitId}...`).start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const result = await actor.getCommit(commitId);
      spinner.stop();

      if (result.length === 0) {
        console.log(chalk.red(`Commit '${commitId}' not found.`));
        process.exit(1);
      }

      const c = result[0];

      if (options.json) {
        console.log(JSON.stringify(c, null, 2));
        return;
      }

      printCommit(c);
      console.log(chalk.bold('  Diff:'));
      console.log(chalk.gray('  ' + '─'.repeat(40)));
      for (const line of c.diff.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log();
    } catch (error) {
      spinner.fail(chalk.red('Failed to load commit'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory rebase (PRD 3) ──────────────────────────────────────────────────

memoryCmd
  .command('rebase')
  .description('Rebase current branch onto a new soul genesis commit')
  .requiredOption('--from-soul <file>', 'Path to new soul.md file')
  .option('--branch <name>', 'Source branch to rebase (default: current)')
  .action(async (options: { fromSoul: string; branch?: string }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora('Rebasing...').start();

    try {
      let soulContent: string;
      try {
        soulContent = fs.readFileSync(options.fromSoul, 'utf-8');
      } catch {
        spinner.fail(chalk.red(`Soul file not found: ${options.fromSoul}`));
        process.exit(1);
      }

      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const branchArg: [string] | [] = options.branch ? [options.branch] : [];
      const result = await actor.rebase(soulContent, branchArg);

      if ('ok' in result) {
        spinner.succeed(chalk.green(
          `Rebase complete: ${result.ok.commitsReplayed} commit(s) replayed on branch '${result.ok.newBranch}'`,
        ));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Rebase failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory merge (PRD 4) ───────────────────────────────────────────────────

memoryCmd
  .command('merge')
  .description('Merge commits from another branch into the current branch')
  .requiredOption('--from-branch <name>', 'Branch to merge from')
  .option('--strategy <strategy>', 'Merge strategy: auto or manual', 'auto')
  .action(async (options: { fromBranch: string; strategy: string }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora(`Merging from '${options.fromBranch}'...`).start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const strategy = options.strategy === 'manual' ? { manual: null } : { auto: null };
      const result: MergeResult = await actor.merge(options.fromBranch, strategy as any);

      if ('ok' in result) {
        spinner.succeed(chalk.green(result.ok.message));
      } else if ('conflicts' in result) {
        spinner.warn(chalk.yellow(`${result.conflicts.length} conflict(s) detected:`));
        for (const conflict of result.conflicts) {
          console.log(`  ${chalk.red('!')} ${conflict.commitId}: ${conflict.message}`);
          console.log(`    Tags: ${conflict.tags.map(t => chalk.cyan(`[${t}]`)).join(' ')}`);
        }
        console.log(chalk.gray('\n  Use `memory cherry-pick <commit-id>` to pick individual commits.'));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Merge failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

// ─── memory cherry-pick (PRD 4) ─────────────────────────────────────────────

memoryCmd
  .command('cherry-pick')
  .description('Cherry-pick a specific commit onto the current branch')
  .argument('<commit-id>', 'Commit ID to cherry-pick')
  .action(async (commitId: string, _opts: unknown, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const spinner = ora(`Cherry-picking ${commitId}...`).start();

    try {
      const canisterId = resolveCanisterId(parentOpts);
      const agent = createAnonymousAgent();
      const actor = createMemoryRepoActor(canisterId, agent);

      const result = await actor.cherryPick(commitId);

      if ('ok' in result) {
        spinner.succeed(chalk.green(`Cherry-picked as ${result.ok}`));
      } else {
        spinner.fail(chalk.red(result.err));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Cherry-pick failed'));
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

export { memoryCmd };
