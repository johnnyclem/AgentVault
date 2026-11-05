/**
 * `agentvault package <dir> --target container`: turn an agent directory into a
 * locked-down container image.
 *
 * Why a separate module: package.ts is the WASM packager, its tests pin its
 * literal strings and mock chalk down to five styles, and none of the WASM
 * machinery (icp.yaml, wasm sizes, "deploy to ICP") applies to a container.
 * package.ts branches to runContainerPackage() before any WASM code runs.
 *
 * Security stance: the engine (src/container/package-image.ts) stages only
 * regular files, drops secrets and build output and refuses a root image. This
 * layer adds nothing that reads values: --env-name takes variable NAMES,
 * --secret takes credential-proxy service names, and nothing here ever reads
 * a secret or environment value. Flags that would silently do something other
 * than what the user asked (--dry-run, which the engine cannot honour) are
 * refused instead of ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { packageContainer } from '../../src/container/package-image.js';
import type { ContainerPackageOptions, ContainerPackageResult, PackagingRuntime } from '../../src/container/package-image.js';
import { listPresetServices } from '../../src/container/proxy/presets.js';
import { ContainerError } from '../../src/container/types.js';
import { assertImageRef } from '../../src/container/validate.js';
import { atomicWriteFileSync } from '../../src/utils/path-validation.js';
import { noteLine, resolveDeps, runGuarded, warnLine, withSpinner } from './cli-support.js';
import type { CliContext, ContainerCliDeps } from './cli-support.js';

/** Written next to agentvault.json so `run <dir>` finds the image whatever --image was. */
export const IMAGE_RECORD_FILE = 'agentvault-image.json';

export interface ContainerPackageCliOptions {
  output?: string;
  force?: boolean;
  dryRun?: boolean;
  image?: string;
  base?: string;
  entrypoint?: string;
  volume?: string[];
  envName?: string[];
  secret?: string[];
  healthUrl?: string;
  /** commander sets this to false for --no-build. */
  build?: boolean;
  // WASM-only flags: accepted by the shared command, ignored here (and reported).
  skipValidation?: boolean;
  debug?: boolean;
  icWasmOptimize?: boolean;
  icWasmShrink?: boolean;
  validate?: string;
  memoryLimit?: string;
  computeQuota?: string;
}

export interface ImageRecord {
  schemaVersion: 1;
  image: string;
  imageId?: string;
}

/** The recorded image of a packaged output directory, or null when absent or unusable. */
export function readImageRecord(outputDir: string): ImageRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(outputDir, IMAGE_RECORD_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const image = (parsed as { image?: unknown }).image;
    if (typeof image !== 'string') return null;
    assertImageRef(image);
    const imageId = (parsed as { imageId?: unknown }).imageId;
    return { schemaVersion: 1, image, ...(typeof imageId === 'string' ? { imageId } : {}) };
  } catch {
    return null;
  }
}

function parseEntrypoint(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item): item is string => typeof item === 'string' && item.length > 0)) {
    throw new ContainerError('INVALID_INPUT', '--entrypoint must be a JSON array of strings, for example \'["node","index.js"]\'');
  }
  return parsed;
}

function ignoredWasmFlags(options: ContainerPackageCliOptions): string[] {
  const ignored: string[] = [];
  if (options.skipValidation) ignored.push('--skip-validation');
  if (options.debug) ignored.push('--debug');
  if (options.icWasmOptimize) ignored.push('--ic-wasm-optimize');
  if (options.icWasmShrink) ignored.push('--ic-wasm-shrink');
  if (options.validate !== undefined) ignored.push('--validate');
  if (options.memoryLimit !== undefined) ignored.push('--memory-limit');
  if (options.computeQuota !== undefined) ignored.push('--compute-quota');
  if (options.force) ignored.push('--force');
  return ignored;
}

/** Everything the command prints on success. */
function printResult(ctx: CliContext, result: ContainerPackageResult, built: boolean): void {
  const { manifest } = result;
  ctx.log('');
  ctx.log(
    built
      ? `${chalk.green('✓')} Packaged agent ${chalk.bold(manifest.name)} as container image ${chalk.bold(result.imageTag)}`
      : `${chalk.green('✓')} Generated the build context for ${chalk.bold(manifest.name)} (image ${result.imageTag} was NOT built)`
  );
  ctx.log('');
  ctx.log(`  Image:       ${result.imageTag}${result.imageId !== undefined ? ` (${result.imageId})` : ''}`);
  ctx.log(`  Runtime:     ${manifest.runtime}`);
  ctx.log(`  Entrypoint:  ${manifest.entrypoint.join(' ')}`);
  ctx.log(`  Volumes:     ${manifest.volumes.length > 0 ? manifest.volumes.join(', ') : '(none)'}`);
  ctx.log(`  Env names:   ${manifest.env.length > 0 ? manifest.env.join(', ') : '(none)'}`);
  ctx.log(`  Secrets:     ${manifest.secrets.length > 0 ? `${manifest.secrets.join(', ')} (delivered by the credential proxy)` : '(none)'}`);
  ctx.log(`  Network:     ${manifest.isolation.network}`);
  ctx.log(`  Staged:      ${result.stats.files} files, ${result.stats.bytes} bytes (${result.skipped.length} entries skipped)`);
  ctx.log(`  Output:      ${result.outputDir}`);
  ctx.log('');
  ctx.log(chalk.cyan('Next steps:'));
  if (built) {
    ctx.log(`  1. Run it:             agentvault run ${result.imageTag} -d`);
    ctx.log(`  2. Check on it:        agentvault ps`);
    if (manifest.secrets.length > 0) {
      ctx.log(`  3. Store credentials:  agentvault secrets add ${manifest.secrets[0] ?? '<name>'} --from-env <VAR>`);
    }
  } else {
    ctx.log(`  1. Build it:           docker build -f ${result.dockerfilePath} -t ${result.imageTag} ${result.contextDir}`);
    ctx.log('     or package again without --no-build');
  }
}

export async function executeContainerPackage(
  source: string,
  options: ContainerPackageCliOptions,
  ctx: CliContext,
  runtimeOverride?: PackagingRuntime
): Promise<ContainerPackageResult> {
  if (options.dryRun) {
    throw new ContainerError(
      'INVALID_INPUT',
      '--dry-run is not supported with --target container (it would still write files and build an image). Use --no-build to generate the Dockerfile and manifest only.'
    );
  }
  const ignored = ignoredWasmFlags(options);
  if (ignored.length > 0) noteLine(ctx, `${ignored.join(', ')} only apply to the WASM target and are ignored for --target container`);

  const entrypoint = options.entrypoint !== undefined ? parseEntrypoint(options.entrypoint) : undefined;
  const secrets = options.secret ?? [];
  const known = listPresetServices();
  const unknown = secrets.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    warnLine(ctx, `no credential-proxy preset named ${unknown.join(', ')} (known: ${known.join(', ')}); starting this agent will fail until one exists`);
  }

  const build = options.build !== false;
  const sourceDir = path.resolve(ctx.cwd, source);
  const packageOptions: ContainerPackageOptions = {
    sourceDir,
    runtime: runtimeOverride ?? ctx.runtime(),
    build,
    onWarning: (message) => warnLine(ctx, message),
    ...(options.output !== undefined ? { outputDir: path.resolve(ctx.cwd, options.output) } : {}),
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(options.healthUrl !== undefined ? { healthUrl: options.healthUrl } : {}),
    ...(options.volume !== undefined && options.volume.length > 0 ? { volumes: options.volume } : {}),
    ...(options.envName !== undefined && options.envName.length > 0 ? { env: options.envName } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
  };

  const result = await withSpinner(
    ctx,
    build ? 'Building the container image...' : 'Generating the build context...',
    () => packageContainer(packageOptions)
  );

  // Remember which image this directory produced, so `run <dir>` does not have to guess the tag.
  const record: ImageRecord = {
    schemaVersion: 1,
    image: result.imageTag,
    ...(result.imageId !== undefined ? { imageId: result.imageId } : {}),
  };
  atomicWriteFileSync(path.join(result.outputDir, IMAGE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });

  printResult(ctx, result, build);
  return result;
}

/** The action package.ts runs for --target container. Prints errors, exits 1 on failure. */
export async function runContainerPackage(source: string, options: ContainerPackageCliOptions, deps: ContainerCliDeps = {}): Promise<void> {
  const ctx = resolveDeps(deps);
  ctx.log(chalk.bold('\nAgentVault Package (container)\n'));
  await runGuarded(ctx, async () => {
    await executeContainerPackage(source, options, ctx);
  });
}
