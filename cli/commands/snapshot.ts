/**
 * `agentvault snapshot create|restore|verify|list`: back up and restore the
 * data volumes of a container agent.
 *
 * Why it exists: PRD-03 makes "pull the image, restore a snapshot, start" the
 * way an agent is rebuilt on a clean machine. src/container/snapshot.ts does the
 * archiving, encryption and verification; this layer decides where the
 * passphrase comes from, where scratch data goes, and what the user is told.
 *
 * Security stance:
 *  - Snapshots are encrypted by default. The passphrase comes from
 *    AGENTVAULT_SNAPSHOT_PASSPHRASE or a hidden prompt (asked twice on create),
 *    never from a flag. With neither available `create` FAILS; it never falls
 *    back to an unencrypted snapshot. Unencrypted needs the explicit
 *    --no-encrypt and prints a warning.
 *  - Decrypted data is spooled in a 0700 directory under the AgentVault home on
 *    disk, never in os.tmpdir() (often RAM-backed, and shared).
 *  - Restore refuses to write into a volume that already holds data unless
 *    --force is given, and says so in words that name --force.
 *  - The passphrase never appears in output, argv or an error message.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { manifestFromLabels } from '../../src/container/manifest.js';
import { createSnapshot, listSnapshots, readSnapshotManifest, restoreSnapshot, verifySnapshot } from '../../src/container/snapshot.js';
import { ContainerError } from '../../src/container/types.js';
import type { ContainerRuntime } from '../../src/container/types.js';
import { IMAGE_REF_RE, assertAgentName, resourceNames, volumeKeysForPaths } from '../../src/container/validate.js';
import {
  defaultSnapshotsDir,
  formatBytes,
  formatTable,
  noteLine,
  resolveDeps,
  runGuarded,
  snapshotScratchDir,
  warnLine,
  withSpinner,
} from './cli-support.js';
import type { CliContext, ContainerCliDeps } from './cli-support.js';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

interface SnapshotImageInfo {
  image?: { ref: string; id?: string; digest?: string };
  containerPaths?: Record<string, string>;
}

/**
 * What the snapshot manifest should record about the agent's image and volume
 * paths. Best effort: a snapshot of an agent whose container is gone (its
 * volumes were kept) is still worth taking.
 */
async function describeAgentImage(runtime: ContainerRuntime, agent: string): Promise<SnapshotImageInfo> {
  try {
    const names = resourceNames(agent);
    const container = (await runtime.list({ agent, all: true })).find((c) => c.name === names.container && c.role === 'agent');
    if (container === undefined || !IMAGE_REF_RE.test(container.image)) return {};
    const image: NonNullable<SnapshotImageInfo['image']> = { ref: container.image };
    const info = await runtime.inspectImage(container.image);
    if (info === null) return { image };
    if (IMAGE_REF_RE.test(info.id)) image.id = info.id;
    const digest = info.repoDigests.find((d) => IMAGE_REF_RE.test(d));
    if (digest !== undefined) image.digest = digest;
    const manifest = manifestFromLabels(info.labels);
    const containerPaths =
      manifest === null ? undefined : Object.fromEntries(volumeKeysForPaths(manifest.volumes).map(({ key, containerPath }) => [key, containerPath]));
    return { image, ...(containerPaths !== undefined ? { containerPaths } : {}) };
  } catch {
    return {};
  }
}

export interface SnapshotCreateOptions {
  output?: string;
  /** commander sets this to false for --no-encrypt. */
  encrypt?: boolean;
}

export async function executeSnapshotCreate(agentArg: string, options: SnapshotCreateOptions, ctx: CliContext): Promise<void> {
  const agent = assertAgentName(agentArg);
  const encrypt = options.encrypt !== false;
  const runtime = ctx.runtime();

  // Fail closed: if encryption is wanted and no passphrase can be had, stop. Never write plaintext instead.
  const passphrase = encrypt
    ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: true, message: 'Passphrase to encrypt the snapshot:' })
    : undefined;
  if (!encrypt) {
    warnLine(ctx, 'this snapshot will NOT be encrypted: anyone who can read the files can read the agent\'s data (--no-encrypt was given).');
  }

  const outputDir = options.output !== undefined ? path.resolve(ctx.cwd, options.output) : defaultSnapshotsDir(ctx.env);
  const described = await describeAgentImage(runtime, agent);
  const result = await withSpinner(ctx, `Snapshotting ${agent}...`, () =>
    createSnapshot({
      runtime,
      agent,
      outputDir,
      now: ctx.now,
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(described.image !== undefined ? { image: described.image } : {}),
      ...(described.containerPaths !== undefined ? { containerPaths: described.containerPaths } : {}),
    })
  );

  for (const warning of result.warnings) {
    // The unencrypted warning was already printed above, before the work started.
    if (!encrypt && /not encrypted/i.test(warning)) continue;
    warnLine(ctx, warning);
  }
  ctx.log('');
  ctx.log(`${chalk.green('✓')} Snapshot of ${chalk.bold(agent)} written to ${result.dir}`);
  ctx.log('');
  ctx.log(`  Encrypted: ${result.manifest.encryption !== null ? 'yes (AES-256-GCM, key derived from your passphrase)' : chalk.yellow('NO')}`);
  for (const volume of result.manifest.volumes) {
    ctx.log(`  Volume:    ${volume.key} (${volume.entries} entries, ${formatBytes(volume.plaintextBytes)})`);
  }
  ctx.log('');
  ctx.log(chalk.cyan('Next steps:'));
  ctx.log(`  agentvault snapshot verify ${result.dir}`);
  ctx.log(`  agentvault snapshot restore ${result.dir} --to <agent>`);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export interface SnapshotRestoreOptions {
  to?: string;
  force?: boolean;
}

/** The library says "pass force"; the user needs to be told which flag, and what the other way out is. */
function explainNonEmptyVolume(error: unknown, agent: string): unknown {
  if (error instanceof ContainerError && error.code === 'POLICY_VIOLATION' && Array.isArray(error.details?.['volumes'])) {
    const names = resourceNames(agent);
    const volumes = (error.details['volumes'] as unknown[])
      .filter((key): key is string => typeof key === 'string')
      .map((key) => names.volume(key))
      .join(', ');
    return new ContainerError(
      'POLICY_VIOLATION',
      `Refusing to restore into non-empty volume(s) ${volumes}: restoring on top of existing data would mix old and new files. ` +
        `Re-run with --force to restore anyway (files with the same path are overwritten, other files are kept), ` +
        `or delete the old data first with "agentvault rm ${agent} --volumes".`,
      error.details
    );
  }
  return error;
}

export async function executeSnapshotRestore(snapshotArg: string, options: SnapshotRestoreOptions, ctx: CliContext): Promise<void> {
  const snapshotDir = path.resolve(ctx.cwd, snapshotArg);
  const manifest = readSnapshotManifest(snapshotDir);
  const agent = assertAgentName(options.to ?? manifest.agent);
  const passphrase =
    manifest.encryption !== null
      ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: false, message: 'Passphrase to decrypt the snapshot:' })
      : undefined;
  if (options.force === true) {
    warnLine(ctx, '--force: existing files in the target volumes may be overwritten.');
  }

  let result;
  try {
    result = await withSpinner(ctx, `Restoring into ${agent}...`, () =>
      restoreSnapshot({
        runtime: ctx.runtime(),
        snapshotDir,
        agent,
        tempDir: snapshotScratchDir(ctx.env),
        ...(passphrase !== undefined ? { passphrase } : {}),
        ...(options.force === true ? { force: true } : {}),
      })
    );
  } catch (error) {
    throw explainNonEmptyVolume(error, agent);
  }

  for (const warning of result.warnings) warnLine(ctx, warning);
  ctx.log('');
  ctx.log(`${chalk.green('✓')} Restored ${result.entries} entries into ${result.volumes.length} volume(s) of ${chalk.bold(agent)}`);
  for (const volume of result.volumes) {
    ctx.log(`  ${volume.volume} (${volume.entries} entries, ${formatBytes(volume.bytes)})`);
  }
  ctx.log('');
  ctx.log(chalk.cyan('Next steps:'));
  const imageRef = manifest.image?.ref;
  ctx.log(
    imageRef !== undefined
      ? `  agentvault run ${imageRef} --name ${agent} -d`
      : `  agentvault run <image> --name ${agent} -d   (the snapshot does not record which image it belongs to)`
  );
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface SnapshotVerifyOptions {
  ciphertextOnly?: boolean;
}

export async function executeSnapshotVerify(snapshotArg: string, options: SnapshotVerifyOptions, ctx: CliContext): Promise<void> {
  const snapshotDir = path.resolve(ctx.cwd, snapshotArg);
  const manifest = readSnapshotManifest(snapshotDir);
  const passphrase =
    manifest.encryption !== null && options.ciphertextOnly !== true
      ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: false, message: 'Passphrase to decrypt the snapshot:' })
      : undefined;
  const result = await withSpinner(ctx, 'Verifying the snapshot...', () =>
    verifySnapshot({
      snapshotDir,
      tempDir: snapshotScratchDir(ctx.env),
      ...(passphrase !== undefined ? { passphrase } : {}),
    })
  );
  ctx.log(`${chalk.green('✓')} Snapshot ${snapshotDir} of ${chalk.bold(result.manifest.agent)} is ${result.fullyVerified ? 'intact' : 'consistent (ciphertext only)'}`);
  for (const volume of result.volumes) {
    const how = !volume.encrypted ? 'checked' : volume.plaintextVerified ? 'decrypted and checked' : 'ciphertext checked only';
    ctx.log(`  ${volume.key}: ${volume.entries} entries, ${formatBytes(volume.plaintextBytes)}, ${how}`);
  }
  for (const warning of result.warnings) warnLine(ctx, warning);
  if (!result.fullyVerified) {
    noteLine(ctx, 'run again with the passphrase to check the decrypted contents too');
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function executeSnapshotList(dirArg: string | undefined, options: { json?: boolean }, ctx: CliContext): Promise<void> {
  const dir = dirArg !== undefined ? path.resolve(ctx.cwd, dirArg) : defaultSnapshotsDir(ctx.env);
  const snapshots = listSnapshots(dir);
  if (options.json === true) {
    ctx.log(JSON.stringify(snapshots, null, 2));
    return;
  }
  if (snapshots.length === 0) {
    ctx.log(`No snapshots in ${dir}.`);
    return;
  }
  for (const line of formatTable(
    ['NAME', 'AGENT', 'CREATED', 'ENCRYPTED', 'VOLUMES', 'SIZE'],
    snapshots.map((s) => [s.name, s.agent, s.createdAt, s.encrypted ? 'yes' : 'NO', String(s.volumes), formatBytes(s.plaintextBytes)])
  )) {
    ctx.log(line);
  }
  ctx.log(chalk.gray(`  in ${dir}`));
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export function snapshotCommand(deps: ContainerCliDeps = {}): Command {
  const group = new Command('snapshot').description(
    'Back up and restore the data volumes of a container agent (encrypted by default)'
  );

  group
    .command('create')
    .description("Snapshot an agent's data volumes (passphrase from AGENTVAULT_SNAPSHOT_PASSPHRASE or a prompt)")
    .argument('<agent>', 'agent name')
    .option('--output <dir>', 'parent directory for the snapshot (default: <AgentVault home>/snapshots)')
    .option('--no-encrypt', 'write an UNENCRYPTED snapshot (anyone who can read the files can read the data)')
    .action(async (agent: string, options: SnapshotCreateOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSnapshotCreate(agent, options, ctx));
    });

  group
    .command('restore')
    .description('Restore a snapshot into an agent\'s volumes (refuses non-empty volumes unless --force)')
    .argument('<snapshot-dir>', 'a snapshot directory (the one that holds manifest.json)')
    .option('--to <agent>', 'restore into this agent instead of the one the snapshot came from')
    .option('--force', 'restore into volumes that already hold data (same-path files are overwritten)')
    .action(async (snapshotDir: string, options: SnapshotRestoreOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSnapshotRestore(snapshotDir, options, ctx));
    });

  group
    .command('verify')
    .description('Check a snapshot end to end without touching Docker')
    .argument('<snapshot-dir>', 'a snapshot directory')
    .option('--ciphertext-only', 'for an encrypted snapshot: check the ciphertext hashes only, without a passphrase')
    .action(async (snapshotDir: string, options: SnapshotVerifyOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSnapshotVerify(snapshotDir, options, ctx));
    });

  group
    .command('list')
    .description('List the snapshots in a directory')
    .argument('[dir]', 'directory that holds snapshots (default: <AgentVault home>/snapshots)')
    .option('-j, --json', 'machine-readable output')
    .action(async (dir: string | undefined, options: { json?: boolean }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSnapshotList(dir, options, ctx));
    });

  return group;
}
