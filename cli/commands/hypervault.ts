/**
 * `agentvault hypervault` — the HyperVault ⇄ AgentVault bridge
 *
 * Three tiers of one mind from a single command group:
 *   connect · status · bootstrap · pull · push · snapshot · archive ·
 *   verify · restore · reindex · recall
 *
 * Key handling follows the AGENTS.md wallet-secret policy: `hv_` keys flow
 * only through env / secrets vault / prompt. `--key` is accepted for the
 * one-liner UX but is immediately vaulted and a warning is printed.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import {
  archiveHyperVault,
  bootstrapHyperVault,
  clientFromProject,
  connectHyperVault,
  pullHyperVault,
  pushHyperVault,
  recallLocal,
  reindexHyperVault,
  restoreHyperVault,
  snapshotHyperVault,
  statusHyperVault,
  verifySnapshotFile,
  projectAgentId,
} from '../../src/hypervault/pipeline.js';
import { createMemoryRepoActor } from '../../src/canister/memory-repo-actor.js';

const hypervaultCmd = new Command('hypervault');

hypervaultCmd
  .alias('hv')
  .description('Bridge HyperVault (cloud mind) with AgentVault (sovereign chain + archive)')
  .action(() => {
    console.log(chalk.yellow('Specify a subcommand:'));
    console.log(
      chalk.gray(`
  ${chalk.cyan('agentvault hypervault connect')}                 Validate & vault your API key
  ${chalk.cyan('agentvault hypervault status')}                  The three-tier picture
  ${chalk.cyan('agentvault hypervault bootstrap my-agent')}      Cloud account → running agent
  ${chalk.cyan('agentvault hypervault pull')}                    Incremental sync down
  ${chalk.cyan('agentvault hypervault push --dry-run')}          Push local edits as mind commits
  ${chalk.cyan('agentvault hypervault snapshot -o bundle')}      Full export → bundle on disk
  ${chalk.cyan('agentvault hypervault archive --all --encrypt --network ic --arweave')}
  ${chalk.cyan('agentvault hypervault verify <ref>')}            Verify a bundle / tx / commit
  ${chalk.cyan('agentvault hypervault restore ar://<tx> --to local')}
  ${chalk.cyan('agentvault hypervault recall "<query>"')}        Offline hybrid recall
`),
    );
  });

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('connect')
  .description('Validate the HyperVault API key, store it in the secrets vault, write hypervault.json')
  .option('--key <key>', 'API key (discouraged — prefer HYPERVAULT_API_KEY or the vault)')
  .option('--api-url <url>', 'HyperVault API base URL')
  .action(async (options: { key?: string; apiUrl?: string }) => {
    let key = options.key;
    if (!key && !process.env.HYPERVAULT_API_KEY) {
      const agentId = projectAgentId(process.cwd());
      // Only prompt when the vault can't supply one; connectHyperVault will
      // still try the vault first if we pass no key.
      const probe = await connectHyperVault({ apiUrl: options.apiUrl, agentId }).catch(() => null);
      if (!probe) {
        const answer = await inquirer.prompt<{ key: string }>([
          {
            type: 'password',
            name: 'key',
            message: 'Enter your HyperVault API key (hv_...):',
            validate: (v: string) => (v.trim().length > 0 ? true : 'Key is required'),
          },
        ]);
        key = answer.key.trim();
      }
    }

    const spinner = ora('Validating HyperVault key...').start();
    try {
      const result = await connectHyperVault({ key, apiUrl: options.apiUrl });
      if (!result.valid) {
        spinner.fail(chalk.red('HyperVault key was rejected. Create one at your hypervault.store dashboard.'));
        process.exit(1);
      }
      spinner.succeed(chalk.green('HyperVault key validated and connected'));
      if (result.vaulted) {
        console.log(chalk.gray(`  Key stored in secrets vault${result.keyRef ? ` (${result.keyRef})` : ''}`));
      }
      if (result.userIdHint) console.log(chalk.gray(`  Account: ${result.userIdHint}`));
      if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('status')
  .description('Show the whole three-tier picture: cloud, local, canister, Arweave')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--no-remote', 'Skip the cloud check (local/canister only)')
  .action(async (options: { apiUrl?: string; remote?: boolean }) => {
    const spinner = ora('Gathering HyperVault status...').start();
    try {
      const client = options.remote === false ? undefined : await clientFromProject({ apiUrl: options.apiUrl }).catch(() => undefined);
      const status = await statusHyperVault({ client });
      spinner.stop();

      console.log(chalk.bold('\nHyperVault status\n'));
      if (!status.configured) {
        console.log(chalk.yellow('  Not connected. Run `agentvault hypervault connect`.'));
        return;
      }
      console.log(chalk.cyan('  Hot (cloud):'));
      if (status.cloud) {
        console.log(`    ${status.keyValid ? chalk.green('✓') : chalk.red('✗')} ${status.apiUrl}`);
        console.log(chalk.gray(`      memories ${status.cloud.memories} · artifacts ${status.cloud.artifacts} · branches ${status.cloud.branches}`));
      } else {
        console.log(chalk.gray(`    ${status.apiUrl ?? 'unknown'} (${status.keyValid === false ? 'key invalid' : 'not checked'})`));
      }

      console.log(chalk.cyan('  Warm (local + canister):'));
      console.log(
        chalk.gray(
          `    snapshot ${status.local.snapshotPresent ? '✓' : '—'} · working-tree ${status.local.memoriesInWorkingTree} · FTS ${status.local.ftsIndexed} · vectors ${status.local.vectorsIndexed}`,
        ),
      );
      if (status.canister) {
        console.log(chalk.gray(`    canister ${status.canister.id}${status.canister.currentBranch ? ` @${status.canister.currentBranch}` : ''}${status.canister.totalCommits ? ` (${status.canister.totalCommits} commits)` : ''}`));
      }
      if (status.local.lastSync) console.log(chalk.gray(`    last sync ${status.local.lastSync}`));

      console.log(chalk.cyan('  Cold (Arweave):'));
      console.log(chalk.gray(`    ${status.arweave?.lastTx ? `✓ ${status.arweave.lastTx}` : '— never archived'}`));
      console.log();
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('bootstrap')
  .description('One-liner: HyperVault account → running agent (scaffold + connect + pull + indices + MCP)')
  .argument('<project>', 'Project directory to create')
  .option('--key <key>', 'API key (discouraged — prefer HYPERVAULT_API_KEY or the vault)')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--branch <name>', 'Mind branch to pull')
  .option('--no-artifacts', 'Skip artifact content')
  .option('--no-index', 'Skip building local indices')
  .option('--soul <slug>', 'Memory slug to use as the agent soul')
  .action(async (project: string, options: { key?: string; apiUrl?: string; branch?: string; artifacts?: boolean; index?: boolean; soul?: string }) => {
    console.log(chalk.bold('\n🧠 HyperVault bootstrap\n'));
    const spinner = ora('Starting...').start();
    try {
      const result = await bootstrapHyperVault({
        project,
        key: options.key,
        apiUrl: options.apiUrl,
        branch: options.branch,
        includeArtifacts: options.artifacts,
        buildIndex: options.index,
        soulSlug: options.soul,
        onStep: (step, detail) => {
          spinner.text = `${step}${detail ? `: ${detail}` : ''}`;
        },
      });
      if (!result.connected) {
        spinner.fail(chalk.red(result.warning ?? 'Bootstrap failed to connect'));
        process.exit(1);
      }
      spinner.succeed(chalk.green(`Agent bootstrapped at ${result.projectPath}`));
      if (result.pull) {
        console.log(chalk.gray(`  Pulled ${result.pull.totalRecords} records · ${result.pull.memoriesWritten} memories · indices ${result.pull.indicesBuilt ? 'built' : 'skipped'}`));
      }
      console.log(chalk.gray(`  MCP config: ${result.mcpConfigPath}`));
      if (result.soulDetected) console.log(chalk.gray('  Soul detected → soul.md written'));
      if (result.warning) console.log(chalk.yellow(`  ⚠ ${result.warning}`));
      console.log(chalk.cyan('\n  Next: ') + chalk.bold(`cd ${project} && agentvault hypervault status`));
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('pull')
  .description('Incremental export → local snapshot, working tree, and indices')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--branch <name>', 'Mind branch to pull')
  .option('--since <iso>', 'Export cursor (default: derived from last sync)')
  .option('--no-artifacts', 'Skip artifact content')
  .option('--no-index', 'Skip building local indices')
  .action(async (options: { apiUrl?: string; branch?: string; since?: string; artifacts?: boolean; index?: boolean }) => {
    const spinner = ora('Pulling from HyperVault...').start();
    try {
      const client = await clientFromProject({ apiUrl: options.apiUrl });
      const result = await pullHyperVault({
        client,
        branch: options.branch,
        since: options.since,
        includeArtifacts: options.artifacts,
        buildIndex: options.index,
      });
      spinner.succeed(chalk.green(`Pulled ${result.recordsPulled} records (${result.totalRecords} total)`));
      console.log(chalk.gray(`  ${result.memoriesWritten} memories written · indices ${result.indicesBuilt ? 'rebuilt' : 'skipped'}`));
      console.log(chalk.gray(`  Snapshot: ${result.snapshotFile}`));
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('push')
  .description('Push locally created/edited memories up as provenance-stamped mind commits')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--dry-run', 'Print the diff-as-mind-commits without writing')
  .action(async (options: { apiUrl?: string; dryRun?: boolean }) => {
    const spinner = ora('Diffing local working tree...').start();
    try {
      const client = await clientFromProject({ apiUrl: options.apiUrl });
      const result = await pushHyperVault({ client, dryRun: options.dryRun });
      spinner.stop();
      if (result.changes.length === 0) {
        console.log(chalk.gray('Nothing to push — local working tree matches the last snapshot.'));
        return;
      }
      for (const change of result.changes) {
        const marker = change.kind === 'create' ? chalk.green('+ create') : chalk.yellow('~ update');
        console.log(`  ${marker} ${change.title}`);
      }
      if (result.dryRun) {
        console.log(chalk.gray(`\n${result.changes.length} change(s) would be pushed (dry run).`));
      } else {
        console.log(chalk.green(`\n✓ Pushed ${result.pushed} change(s) as mind commits.`));
      }
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('snapshot')
  .description('Full export → agentvault-hypervault-snapshot-v1 bundle on disk')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('-o, --output <path>', 'Output bundle path')
  .option('--encrypt', 'Encrypt entries (prompts for a passphrase unless HYPERVAULT_SNAPSHOT_PASSPHRASE is set)')
  .option('--include-conversations', 'Include conversations/messages (always encrypted)')
  .action(async (options: { apiUrl?: string; output?: string; encrypt?: boolean; includeConversations?: boolean }) => {
    try {
      const passphrase = await maybePassphrase(options.encrypt || options.includeConversations);
      const spinner = ora('Exporting and bundling...').start();
      const client = await clientFromProject({ apiUrl: options.apiUrl });
      const result = await snapshotHyperVault({
        client,
        outputPath: options.output,
        passphrase,
        includeConversations: options.includeConversations,
      });
      spinner.succeed(chalk.green(`Snapshot written: ${result.path}`));
      console.log(chalk.gray(`  ${formatBytes(result.sizeBytes)} · ${summarizeCounts(result.rowCounts)}`));
    } catch (error) {
      console.error(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('archive')
  .description('Sovereign archive: snapshot → encrypt → canister replay → Arweave → receipts → verify')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--all', 'Archive the full account (default; use --since for incremental)')
  .option('--encrypt', 'Encrypt the bundle (AES-256-GCM, passphrase-wrapped)')
  .option('--network <net>', 'ICP network: local | ic')
  .option('--canister-id <id>', 'memory_repo canister id (skip the warm tier if omitted)')
  .option('--arweave', 'Upload the cold copy to Arweave')
  .option('--arweave-jwk <file>', 'Path to the Arweave wallet JWK')
  .option('--since <iso>', 'Incremental archive from this cursor')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (options: {
    apiUrl?: string;
    all?: boolean;
    encrypt?: boolean;
    network?: string;
    canisterId?: string;
    arweave?: boolean;
    arweaveJwk?: string;
    since?: string;
    yes?: boolean;
  }) => {
    console.log(chalk.bold('\n🗄  HyperVault sovereign archive\n'));
    try {
      if (!options.encrypt && !options.yes) {
        const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
          { type: 'confirm', name: 'proceed', message: chalk.red('Archiving WITHOUT --encrypt stores memories in plaintext. Continue?'), default: false },
        ]);
        if (!proceed) {
          console.log(chalk.yellow('Aborted. Re-run with --encrypt.'));
          return;
        }
      }

      const passphrase = await maybePassphrase(options.encrypt);
      const client = await clientFromProject({ apiUrl: options.apiUrl });

      // Warm tier: canister actor
      let actor;
      if (options.canisterId) {
        const { createAnonymousAgent } = await import('../../src/canister/memory-repo-actor.js');
        const host = options.network === 'ic' ? 'https://ic0.app' : undefined;
        actor = createMemoryRepoActor(options.canisterId, createAnonymousAgent(host));
      }

      // Cold tier: Arweave JWK
      let arweaveJwk: Record<string, unknown> | undefined;
      if (options.arweave || options.arweaveJwk) {
        arweaveJwk = await loadArweaveJwk(options.arweaveJwk);
      }

      const spinner = ora('Archiving...').start();
      const result = await archiveHyperVault({
        client,
        passphrase,
        actor,
        canisterId: options.canisterId,
        arweaveJwk,
        since: options.since,
        onStep: (step, detail) => {
          spinner.text = `${step}${detail ? `: ${detail}` : ''}`;
        },
      });
      spinner.stop();

      console.log(chalk.green('✔ Archive pipeline complete'));
      console.log(chalk.gray(`  Bundle: ${result.snapshotFile}`));
      console.log(chalk.gray(`  Rows: ${summarizeCounts(result.rowCounts)}`));
      if (result.mindSync) {
        console.log(chalk.gray(`  Canister: ${result.mindSync.commitsReplayed} replayed, ${result.mindSync.commitsSkipped} already synced, ${result.mindSync.thoughtformsStored} thoughtforms`));
      }
      if (result.arweaveTx) {
        console.log(chalk.gray(`  Arweave: ${result.arweaveTx}`));
        console.log(chalk.gray(`  Receipts: ${result.receiptOnChain ? 'on-chain ✓' : '—'}${result.receiptPosted ? ' cloud ✓' : ''}`));
        console.log(chalk.gray(`  Verified: ${result.verified ? '✓' : '✗'}`));
        console.log(chalk.bold('\n✔ Archived. Resurrect anywhere with:'));
        console.log(chalk.cyan(`  npx agentvault@latest hypervault restore ar://${result.arweaveTx} --to local`));
      }
      if (result.errors.length > 0) {
        console.log(chalk.yellow(`\n  ${result.errors.length} warning(s):`));
        for (const err of result.errors) console.log(chalk.yellow(`    - ${err}`));
      }
    } catch (error) {
      console.error(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('verify')
  .description('Verify a snapshot bundle: manifest hash, ed25519 signature, Merkle root, per-entry checksums')
  .argument('<ref>', 'Snapshot bundle file path')
  .option('--passphrase <phrase>', 'Passphrase for encrypted bundles (prefer the env var)')
  .action(async (ref: string, options: { passphrase?: string }) => {
    const spinner = ora('Verifying...').start();
    try {
      const passphrase = options.passphrase ?? process.env.HYPERVAULT_SNAPSHOT_PASSPHRASE;
      const result = await verifySnapshotFile(ref, { passphrase });
      if (result.valid) {
        spinner.succeed(chalk.green('Bundle verified — signature, checksums, and Merkle root all pass'));
      } else {
        spinner.fail(chalk.red('Verification FAILED'));
        console.log(chalk.gray(`  signature ${result.signatureValid ? '✓' : '✗'} · checksums ${result.checksumsValid ? '✓' : '✗'} · merkle ${result.merkleRootValid ? '✓' : '✗'}`));
        for (const err of result.errors) console.log(chalk.yellow(`    - ${err}`));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('restore')
  .description('Chain → anywhere: restore a snapshot (ar://<tx> or file) to a local project or fresh hypervault account')
  .argument('<ref>', 'ar://<tx-id> or a snapshot file path')
  .option('--to <target>', 'Restore target: local | hypervault', 'local')
  .option('--key <key>', 'Destination HyperVault key (for --to hypervault)')
  .option('--api-url <url>', 'HyperVault API base URL')
  .option('--passphrase <phrase>', 'Passphrase for encrypted bundles (prefer the env var)')
  .action(async (ref: string, options: { to?: string; key?: string; apiUrl?: string; passphrase?: string }) => {
    const to = options.to === 'hypervault' ? 'hypervault' : 'local';
    const spinner = ora(`Restoring to ${to}...`).start();
    try {
      const passphrase = options.passphrase ?? process.env.HYPERVAULT_SNAPSHOT_PASSPHRASE;
      const client = to === 'hypervault' ? await clientFromProject({ key: options.key, apiUrl: options.apiUrl }) : undefined;
      const result = await restoreHyperVault({ ref, to, passphrase, client });
      spinner.succeed(chalk.green(`Restored ${result.records} records (verify ${result.verify.valid ? '✓' : 'partial'})`));
      if (result.memoriesWritten !== undefined) console.log(chalk.gray(`  ${result.memoriesWritten} memories written to .agentvault/memories/`));
      if (result.importedToHypervault !== undefined) console.log(chalk.gray(`  ${result.importedToHypervault} records imported to hypervault`));
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('reindex')
  .description('Rebuild local vector/FTS indices from the pulled snapshot')
  .option('--passphrase <phrase>', 'Passphrase for encrypted snapshots (prefer the env var)')
  .action(async (options: { passphrase?: string }) => {
    const spinner = ora('Rebuilding indices...').start();
    try {
      const passphrase = options.passphrase ?? process.env.HYPERVAULT_SNAPSHOT_PASSPHRASE;
      const result = await reindexHyperVault({ passphrase });
      spinner.succeed(chalk.green(`Reindexed ${result.memoriesIndexed} memories (${result.vectorsIndexed} vectors)`));
    } catch (error) {
      spinner.fail(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

hypervaultCmd
  .command('recall')
  .description('Offline hybrid (lexical + semantic) recall over the local indices')
  .argument('<query>', 'Search query')
  .option('-n, --limit <n>', 'Number of results', (v) => parseInt(v, 10), 10)
  .action(async (query: string, options: { limit?: number }) => {
    try {
      const results = await recallLocal(query, { limit: options.limit });
      if (results.length === 0) {
        console.log(chalk.gray('No matches.'));
        return;
      }
      console.log(chalk.bold(`\n${results.length} result(s) for "${query}":\n`));
      for (const r of results) {
        console.log(`  ${chalk.cyan(r.score.toFixed(3))} ${chalk.bold(r.memory.title || r.memory.id)} ${chalk.gray(`[${r.matchedBy.join('+')}]`)}`);
        const preview = r.memory.content.replace(/\s+/g, ' ').slice(0, 120);
        console.log(chalk.gray(`      ${preview}${r.memory.content.length > 120 ? '…' : ''}`));
      }
      console.log();
    } catch (error) {
      console.error(chalk.red(errMsg(error)));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function maybePassphrase(encrypt?: boolean): Promise<string | undefined> {
  if (!encrypt) return undefined;
  const fromEnv = process.env.HYPERVAULT_SNAPSHOT_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const { passphrase } = await inquirer.prompt<{ passphrase: string }>([
    {
      type: 'password',
      name: 'passphrase',
      message: 'Passphrase to encrypt the bundle:',
      validate: (v: string) => (v.length >= 8 ? true : 'Use at least 8 characters'),
    },
  ]);
  return passphrase;
}

async function loadArweaveJwk(jwkPath?: string): Promise<Record<string, unknown>> {
  const fs = await import('node:fs');
  const resolved = jwkPath ?? process.env.ARWEAVE_JWK_PATH;
  if (!resolved) {
    throw new Error('Arweave upload requires --arweave-jwk <file> or the ARWEAVE_JWK_PATH env var');
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Arweave JWK not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as Record<string, unknown>;
}

function summarizeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`)
    .join(' · ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { hypervaultCmd };
