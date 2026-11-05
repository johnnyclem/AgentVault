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
 *  - manifest.json is unauthenticated, so "this snapshot is not encrypted" is
 *    something anyone who can write the directory can arrange. Restore and
 *    verify therefore say `Encrypted: NO` and refuse such a snapshot unless
 *    --allow-unencrypted is given; --no-encrypt on create is unchanged.
 *  - Every command that spools plaintext installs the signal handler the
 *    foreground `run` uses: SIGINT, SIGTERM and SIGHUP abort the work, which
 *    stops the helper container and deletes the spool before the process exits
 *    non-zero. A process that is killed outright (SIGKILL, power loss) cannot
 *    do that, so every command first sweeps the leftovers of dead runs.
 *  - The passphrase never appears in output, argv or an error message.
 */

import * as path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { manifestFromLabels } from '../../src/container/manifest.js';
import {
  createSnapshot,
  listSnapshots,
  readSnapshotManifest,
  restoreSnapshot,
  sweepStaleSnapshotData,
  verifySnapshot,
} from '../../src/container/snapshot.js';
import type { SnapshotManifest } from '../../src/container/snapshot.js';
import { ContainerError } from '../../src/container/types.js';
import type { ContainerRuntime } from '../../src/container/types.js';
import { IMAGE_REF_RE, assertAgentName, resourceNames, volumeKeysForPaths } from '../../src/container/validate.js';
import {
  PASSPHRASE_ENV,
  defaultSnapshotsDir,
  formatBytes,
  formatTable,
  noteLine,
  resolveDeps,
  runGuarded,
  snapshotScratchDir,
  snapshotScratchPath,
  warnLine,
  withSpinner,
} from './cli-support.js';
import type { CliContext, ContainerCliDeps } from './cli-support.js';

// ---------------------------------------------------------------------------
// Shared by every command
// ---------------------------------------------------------------------------

/**
 * Remove what an earlier run that was killed left behind (spools, half-written
 * snapshots), in the default snapshots directory, the scratch directory and any
 * extra snapshot directory this command was pointed at. Best effort: a sweep
 * must never be the reason a command fails.
 */
function sweepLeftovers(ctx: CliContext, ...extraSnapshotDirs: string[]): void {
  try {
    const { removed } = sweepStaleSnapshotData({
      snapshotDirs: [...new Set([defaultSnapshotsDir(ctx.env), ...extraSnapshotDirs])],
      scratchDirs: [snapshotScratchPath(ctx.env)],
    });
    if (removed.length > 0) {
      noteLine(ctx, `removed ${removed.length} leftover(s) of an earlier snapshot run that was interrupted: ${removed.join(', ')}`);
    }
  } catch {
    // see above
  }
}

/**
 * Run `work` with a signal that SIGINT, SIGTERM and SIGHUP abort (the same
 * handler hook the foreground `run` uses). Aborting stops the helper container
 * and deletes the plaintext before the work rejects, so the command exits
 * non-zero with nothing sensitive left on disk.
 */
async function withInterrupt<T>(ctx: CliContext, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const uninstall = ctx.installSignalHandler(() => controller.abort());
  try {
    return await work(controller.signal);
  } finally {
    uninstall();
  }
}

/**
 * restore and verify read `encryption` from manifest.json, which anyone who can
 * write the snapshot directory can edit, together with a crafted plaintext tar.
 * So an unencrypted snapshot is never taken on trust: it is said out loud and
 * refused unless the user states that this is what they expect.
 */
function requireEncryptionOrConsent(ctx: CliContext, snapshotDir: string, manifest: SnapshotManifest, action: 'restore' | 'verify', allowed: boolean): void {
  if (manifest.encryption !== null) return;
  if (!allowed) {
    const expected = (ctx.env[PASSPHRASE_ENV.snapshot] ?? '') !== '';
    throw new ContainerError(
      'POLICY_VIOLATION',
      `Encrypted: NO. ${snapshotDir} is not encrypted, so nothing proves who wrote it: anyone who can write to that directory could have replaced an encrypted snapshot with a crafted plain one. ` +
        `Refusing to ${action} it. ` +
        (expected ? `${PASSPHRASE_ENV.snapshot} is set, which suggests you expected an encrypted snapshot: treat this one as suspect. ` : '') +
        `If you made it yourself with --no-encrypt and trust where it has been, pass --allow-unencrypted.`
    );
  }
  warnLine(ctx, `Encrypted: NO. ${snapshotDir} is not encrypted: it is only as trustworthy as everyone who could write to it.`);
}

function encryptionLine(manifest: SnapshotManifest): string {
  return `  Encrypted: ${manifest.encryption !== null ? 'yes (AES-256-GCM, key derived from your passphrase)' : chalk.red('NO')}`;
}

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

/**
 * A create never decrypts anything, so an INTEGRITY failure here is a volume the
 * restore-safety check refused (a sticky bit, a FIFO, an absolute symlink), not
 * a wrong passphrase: do not let the generic INTEGRITY hint say so.
 */
function explainUnsafeVolume(error: unknown): unknown {
  return error instanceof ContainerError && error.code === 'INTEGRITY' ? new ContainerError('POLICY_VIOLATION', error.message, error.details) : error;
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
  const outputDir = options.output !== undefined ? path.resolve(ctx.cwd, options.output) : defaultSnapshotsDir(ctx.env);
  sweepLeftovers(ctx, outputDir);

  // Fail closed: if encryption is wanted and no passphrase can be had, stop. Never write plaintext instead.
  const passphrase = encrypt
    ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: true, message: 'Passphrase to encrypt the snapshot:' })
    : undefined;
  if (!encrypt) {
    warnLine(ctx, 'this snapshot will NOT be encrypted: anyone who can read the files can read the agent\'s data (--no-encrypt was given).');
  }

  const described = await describeAgentImage(runtime, agent);
  let result;
  try {
    result = await withInterrupt(ctx, (signal) =>
      withSpinner(ctx, `Snapshotting ${agent}...`, () =>
        createSnapshot({
          runtime,
          agent,
          outputDir,
          now: ctx.now,
          signal,
          ...(passphrase !== undefined ? { passphrase } : {}),
          ...(described.image !== undefined ? { image: described.image } : {}),
          ...(described.containerPaths !== undefined ? { containerPaths: described.containerPaths } : {}),
        })
      )
    );
  } catch (error) {
    throw explainUnsafeVolume(error);
  }

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
  allowUnencrypted?: boolean;
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
  sweepLeftovers(ctx);
  const snapshotDir = path.resolve(ctx.cwd, snapshotArg);
  const manifest = readSnapshotManifest(snapshotDir);
  const agent = assertAgentName(options.to ?? manifest.agent);
  requireEncryptionOrConsent(ctx, snapshotDir, manifest, 'restore', options.allowUnencrypted === true);
  const passphrase =
    manifest.encryption !== null
      ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: false, message: 'Passphrase to decrypt the snapshot:' })
      : undefined;
  if (options.force === true) {
    warnLine(ctx, '--force: existing files in the target volumes may be overwritten.');
  }

  let result;
  try {
    result = await withInterrupt(ctx, (signal) =>
      withSpinner(ctx, `Restoring into ${agent}...`, () =>
        restoreSnapshot({
          runtime: ctx.runtime(),
          snapshotDir,
          agent,
          tempDir: snapshotScratchDir(ctx.env),
          signal,
          ...(passphrase !== undefined ? { passphrase } : {}),
          ...(options.force === true ? { force: true } : {}),
        })
      )
    );
  } catch (error) {
    throw explainNonEmptyVolume(error, agent);
  }

  for (const warning of result.warnings) warnLine(ctx, warning);
  ctx.log('');
  ctx.log(`${chalk.green('✓')} Restored ${result.entries} entries into ${result.volumes.length} volume(s) of ${chalk.bold(agent)}`);
  ctx.log(encryptionLine(manifest));
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
  allowUnencrypted?: boolean;
}

export async function executeSnapshotVerify(snapshotArg: string, options: SnapshotVerifyOptions, ctx: CliContext): Promise<void> {
  sweepLeftovers(ctx);
  const snapshotDir = path.resolve(ctx.cwd, snapshotArg);
  const manifest = readSnapshotManifest(snapshotDir);
  requireEncryptionOrConsent(ctx, snapshotDir, manifest, 'verify', options.allowUnencrypted === true);
  const passphrase =
    manifest.encryption !== null && options.ciphertextOnly !== true
      ? await ctx.getPassphrase({ purpose: 'snapshot', confirm: false, message: 'Passphrase to decrypt the snapshot:' })
      : undefined;
  const result = await withInterrupt(ctx, (signal) =>
    withSpinner(ctx, 'Verifying the snapshot...', () =>
      verifySnapshot({
        snapshotDir,
        tempDir: snapshotScratchDir(ctx.env),
        signal,
        ...(passphrase !== undefined ? { passphrase } : {}),
      })
    )
  );
  ctx.log(`${chalk.green('✓')} Snapshot ${snapshotDir} of ${chalk.bold(result.manifest.agent)} is ${result.fullyVerified ? 'intact' : 'consistent (ciphertext only)'}`);
  ctx.log(encryptionLine(result.manifest));
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
  sweepLeftovers(ctx, dir);
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
    snapshots.map((s) =>
      s.status === 'complete'
        ? [s.name, s.agent, s.createdAt, s.encrypted ? 'yes' : 'NO', String(s.volumes), formatBytes(s.plaintextBytes)]
        : [s.name, '-', 'incomplete', '-', '-', '-']
    )
  )) {
    ctx.log(line);
  }
  ctx.log(chalk.gray(`  in ${dir}`));
  const incomplete = snapshots.filter((s) => s.status === 'incomplete');
  if (incomplete.length > 0) {
    ctx.log(
      chalk.yellow(
        `  ${incomplete.length} incomplete: a snapshot run that never finished, or damage. It cannot be restored. ` +
          `"agentvault snapshot verify <dir>" says what is wrong; delete it with: rm -r ${incomplete.map((s) => JSON.stringify(s.dir)).join(' ')}`
      )
    );
  }
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
    .description(
      "Restore a snapshot into an agent's volumes (refuses a running agent, non-empty volumes unless --force, and unencrypted snapshots unless --allow-unencrypted)"
    )
    .argument('<snapshot-dir>', 'a snapshot directory (the one that holds manifest.json)')
    .option('--to <agent>', 'restore into this agent instead of the one the snapshot came from')
    .option('--force', 'restore into volumes that already hold data (same-path files are overwritten)')
    .option('--allow-unencrypted', 'accept a snapshot that is NOT encrypted (refused by default: anyone who can write the directory could have swapped an encrypted snapshot for a crafted plain one)')
    .action(async (snapshotDir: string, options: SnapshotRestoreOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSnapshotRestore(snapshotDir, options, ctx));
    });

  group
    .command('verify')
    .description('Check a snapshot end to end without touching Docker (refuses an unencrypted snapshot unless --allow-unencrypted)')
    .argument('<snapshot-dir>', 'a snapshot directory')
    .option('--ciphertext-only', 'for an encrypted snapshot: check the ciphertext hashes only, without a passphrase')
    .option('--allow-unencrypted', 'accept a snapshot that is NOT encrypted (refused by default: its manifest proves nothing about who wrote it)')
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
