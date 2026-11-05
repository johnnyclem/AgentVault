/**
 * Package an agent directory into a locked-down container image (PRD-02).
 *
 * Pipeline: detect runtime -> STAGE a filtered build context -> write
 * Dockerfile + agentvault.json -> `docker build` -> verify the built image.
 *
 * Why a staged copy instead of `COPY . .` of the source tree: the build context
 * is what the Docker daemon reads, so anything in it can end up in an image
 * layer and in `docker history`. Staging copies REGULAR FILES ONLY (lstat, never
 * following symlinks, opened with O_NOFOLLOW), drops a denylist of secrets and
 * build output, enforces size caps, and hashes exactly the bytes it wrote.
 *
 * Security stance:
 *  - Symlinks, sockets, FIFOs and devices are skipped and reported, never
 *    followed: `index.js -> /etc/passwd` cannot leak a host file.
 *  - `.env*`, key material, VCS data, node_modules and `dist` never enter the
 *    context. Secrets reach an agent only through the credential proxy; the
 *    manifest records `env` / `secrets` NAMES, never values, and no value is
 *    read here.
 *  - A built image is accepted only if it carries the exact manifest label and
 *    runs as a numeric non-root user; otherwise its tag is removed.
 *  - The output directory is only (re)used when it is empty or was created by
 *    this packager, so a wrong --output cannot delete or overwrite user files.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSourcePath } from '../packaging/detector.js';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import {
  ContainerError,
  DEFAULT_AGENT_USER,
  LABEL_MANIFEST,
  type ContainerRuntime,
  type NetworkMode,
} from './types.js';
import { assertContainerPath, assertEnvName, assertImageRef, assertSecretName, volumeKeysForPaths } from './validate.js';
import {
  DEFAULT_ISOLATION,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  manifestToLabel,
  parseManifest,
  type ContainerManifest,
} from './manifest.js';
import { hasControlChars, healthcheckForUrl, printable, renderDockerfile, type RuntimeKind } from './dockerfile.js';
import { detectContainerRuntime, exclusionReason } from './runtime-detect.js';

export const MAX_CONTEXT_BYTES = 200 * 1024 * 1024;
export const MAX_CONTEXT_FILES = 20_000;
/** Written first into an output directory so later runs know it is ours. */
export const OUTPUT_MARKER = '.agentvault-container-output';

const DEFAULT_VOLUMES = ['/data'];
const CREDENTIAL_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of ContainerRuntime that packaging uses. */
export type PackagingRuntime = Pick<ContainerRuntime, 'buildImage' | 'inspectImage' | 'removeImage' | 'runner'>;

export interface ContainerPackageOptions {
  sourceDir: string;
  /** Default: <sourceDir>/dist/container */
  outputDir?: string;
  runtime: PackagingRuntime;
  /** Image tag. Default: agentvault/<name>:<version> */
  image?: string;
  base?: string;
  /** Exec-form argv override, for example ['node', 'server.js']. */
  entrypoint?: string[];
  /** http://localhost:<port>/<path>; becomes the image HEALTHCHECK. */
  healthUrl?: string;
  /** Container paths persisted in named volumes. Default ['/data']. */
  volumes?: string[];
  /** Environment variable NAMES the agent reads. Values are never read. */
  env?: string[];
  /** Credential-proxy service names the agent needs. */
  secrets?: string[];
  /** Default: 'proxy' when secrets is non-empty, otherwise 'none'. */
  network?: NetworkMode;
  /** Single platform such as linux/amd64. */
  platform?: string;
  noCache?: boolean;
  /** Default true. false = generate the context, Dockerfile and manifest only. */
  build?: boolean;
  onWarning?: (message: string) => void;
  /** Agent name override (slugified). */
  name?: string;
  /** Force node or python instead of detecting it. */
  runtimeKind?: RuntimeKind;
}

export interface SkippedEntry {
  /** Source-relative POSIX path; directories end in "/". */
  path: string;
  reason: string;
}

export interface ContainerPackageResult {
  imageTag: string;
  /** Present only when the image was built. */
  imageId?: string;
  manifest: ContainerManifest;
  outputDir: string;
  contextDir: string;
  dockerfilePath: string;
  manifestPath: string;
  warnings: string[];
  skipped: SkippedEntry[];
  /** What was staged into the build context. */
  stats: { files: number; bytes: number };
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StageOptions {
  maxBytes?: number;
  maxFiles?: number;
  /** Absolute directories to skip (the output directory). */
  excludeDirs?: string[];
}

export interface StageResult {
  contentHash: string;
  files: number;
  bytes: number;
  skipped: SkippedEntry[];
}

interface StagedCandidate {
  rel: string;
  abs: string;
  size: number;
}

const SKIP_SYMLINK = 'symbolic link (never copied)';
const SKIP_SPECIAL = 'not a regular file (socket, FIFO or device)';

function byPath(a: { rel: string }, b: { rel: string }): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

function capError(kind: 'files' | 'bytes', maxFiles: number, maxBytes: number): ContainerError {
  const limit = kind === 'files' ? `${maxFiles}-file` : `${Math.round(maxBytes / (1024 * 1024))} MB`;
  return new ContainerError(
    'INVALID_INPUT',
    `Build context exceeds the ${limit} limit. Remove build output, data and caches from the agent directory, or package a smaller directory`,
    { limit: kind === 'files' ? maxFiles : maxBytes, kind }
  );
}

function openNoFollow(abs: string): number | 'symlink' | 'gone' {
  try {
    return fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return 'symlink';
    if (code === 'ENOENT') return 'gone';
    throw err;
  }
}

/**
 * Copy the regular files of `sourceDir` that survive the denylist into
 * `contextDir` and return a content hash over what was written. `sourceDir`
 * should already be a realpath. Throws (leaving partial output for the caller
 * to remove) if a cap is exceeded.
 */
export function stageBuildContext(sourceDir: string, contextDir: string, options: StageOptions = {}): StageResult {
  const maxBytes = options.maxBytes ?? MAX_CONTEXT_BYTES;
  const maxFiles = options.maxFiles ?? MAX_CONTEXT_FILES;
  const excludedDirs = new Set((options.excludeDirs ?? []).map((d) => path.resolve(d)));
  const skipped: SkippedEntry[] = [];
  const candidates: StagedCandidate[] = [];
  let plannedBytes = 0;

  const skip = (rel: string, isDir: boolean, reason: string): void => {
    skipped.push({ path: printable(rel, 300) + (isDir ? '/' : ''), reason });
  };

  const walk = (dirAbs: string, relDir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dirAbs).sort();
    } catch (err) {
      throw new ContainerError('INVALID_INPUT', `Cannot read directory ${printable(relDir || '.', 200)}: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`);
    }
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (excludedDirs.has(abs)) {
        skip(rel, true, 'output directory');
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        skip(rel, false, 'unreadable entry');
        continue;
      }
      const reason = exclusionReason(name);
      if (reason !== undefined) {
        skip(rel, st.isDirectory(), reason);
      } else if (hasControlChars(name)) {
        skip(rel, st.isDirectory(), 'name contains a control character');
      } else if (st.isSymbolicLink()) {
        skip(rel, false, SKIP_SYMLINK);
      } else if (st.isDirectory()) {
        if (fs.existsSync(path.join(abs, OUTPUT_MARKER))) {
          skip(rel, true, 'AgentVault packaging output');
        } else {
          walk(abs, rel);
        }
      } else if (st.isFile()) {
        if (candidates.length + 1 > maxFiles) throw capError('files', maxFiles, maxBytes);
        plannedBytes += st.size;
        if (plannedBytes > maxBytes) throw capError('bytes', maxFiles, maxBytes);
        candidates.push({ rel, abs, size: st.size });
      } else {
        skip(rel, false, SKIP_SPECIAL);
      }
    }
  };
  walk(sourceDir, '');
  candidates.sort(byPath);

  const madeDirs = new Set<string>(['']);
  fs.chmodSync(contextDir, 0o755);
  const ensureDir = (relDir: string): void => {
    if (madeDirs.has(relDir)) return;
    ensureDir(path.posix.dirname(relDir) === '.' ? '' : path.posix.dirname(relDir));
    const abs = path.join(contextDir, ...relDir.split('/'));
    fs.mkdirSync(abs, { mode: 0o755 });
    fs.chmodSync(abs, 0o755);
    madeDirs.add(relDir);
  };

  const hash = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const candidate of candidates) {
    const fd = openNoFollow(candidate.abs);
    if (fd === 'symlink' || fd === 'gone') {
      skip(candidate.rel, false, fd === 'symlink' ? SKIP_SYMLINK : 'changed while packaging');
      continue;
    }
    let content: Buffer;
    let executable: boolean;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        skip(candidate.rel, false, SKIP_SPECIAL);
        continue;
      }
      if (bytes + st.size > maxBytes) throw capError('bytes', maxFiles, maxBytes);
      content = fs.readFileSync(fd);
      executable = (st.mode & 0o111) !== 0;
    } finally {
      fs.closeSync(fd);
    }
    bytes += content.length;
    if (bytes > maxBytes) throw capError('bytes', maxFiles, maxBytes);

    const dir = path.posix.dirname(candidate.rel);
    ensureDir(dir === '.' ? '' : dir);
    const dest = path.join(contextDir, ...candidate.rel.split('/'));
    const mode = executable ? 0o755 : 0o644;
    fs.writeFileSync(dest, content, { flag: 'wx', mode });
    fs.chmodSync(dest, mode);

    hash.update(`${candidate.rel}\0${executable ? 'x' : '-'}\0${content.length}\0`);
    hash.update(content);
    files++;
  }
  return { contentHash: hash.digest('hex'), files, bytes, skipped };
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** An image tag docker build -t accepts: lowercase repository, no digest. */
function validateImageTag(ref: string): string {
  assertImageRef(ref);
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  const repository = colon === -1 ? ref : ref.slice(0, colon);
  const tag = colon === -1 ? '' : ref.slice(colon + 1);
  if (ref.includes('@')) {
    throw new ContainerError('INVALID_INPUT', `Invalid image tag ${JSON.stringify(ref)}: digests cannot be used as a build tag`);
  }
  if (/[A-Z]/.test(repository)) {
    throw new ContainerError('INVALID_INPUT', `Invalid image tag ${JSON.stringify(ref)}: repository names must be lowercase`);
  }
  if (colon !== -1 && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new ContainerError('INVALID_INPUT', `Invalid image tag ${JSON.stringify(ref)}: tag must match [A-Za-z0-9_][A-Za-z0-9._-]{0,127}`);
  }
  return ref;
}

function realpathLoose(p: string): string {
  const missing: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Refuse an output directory that could clobber user files, then claim it. */
function prepareOutputDir(outputDir: string, realSource: string): void {
  if (isSameOrInside(realpathLoose(outputDir), realSource)) {
    throw new ContainerError('INVALID_INPUT', `Output directory ${outputDir} must not be the source directory or contain it`);
  }
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory()) {
      throw new ContainerError('INVALID_INPUT', `Output path is not a directory: ${outputDir}`);
    }
    const entries = fs.readdirSync(outputDir);
    if (entries.length > 0 && !entries.includes(OUTPUT_MARKER)) {
      throw new ContainerError(
        'INVALID_INPUT',
        `Output directory ${outputDir} is not empty and was not created by AgentVault; choose an empty or new directory`
      );
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const marker = path.join(outputDir, OUTPUT_MARKER);
  if (!fs.existsSync(marker)) {
    atomicWriteFileSync(marker, `${JSON.stringify({ tool: 'agentvault', kind: 'container-build-output', schemaVersion: 1 })}\n`, { mode: 0o644 });
  }
}

function removeGenerated(outputDir: string): void {
  for (const name of ['context', 'Dockerfile', MANIFEST_FILE]) {
    fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Verification of the built image
// ---------------------------------------------------------------------------

async function verifyBuiltImage(runtime: PackagingRuntime, tag: string, manifest: ContainerManifest): Promise<void> {
  const info = await runtime.inspectImage(tag);
  if (info === null) {
    throw new ContainerError('INTEGRITY', `Image ${tag} was not found after the build`);
  }
  const user = info.user.trim();
  if (user === '' || user === 'root' || /^(root|0)(:|$)/.test(user)) {
    throw new ContainerError('POLICY_VIOLATION', `Built image ${tag} would run as root (USER ${JSON.stringify(user)}); refusing`);
  }
  if (user !== manifest.isolation.user) {
    throw new ContainerError('INTEGRITY', `Built image ${tag} runs as ${JSON.stringify(user)}, expected ${manifest.isolation.user}`);
  }
  const label = info.labels[LABEL_MANIFEST];
  if (label === undefined) {
    throw new ContainerError('INTEGRITY', `Built image ${tag} has no ${LABEL_MANIFEST} label`);
  }
  let embedded: ContainerManifest;
  try {
    embedded = parseManifest(label);
  } catch (err) {
    throw new ContainerError('INTEGRITY', `Built image ${tag} carries an invalid manifest label: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifestToLabel(embedded) !== manifestToLabel(manifest)) {
    throw new ContainerError('INTEGRITY', `The ${LABEL_MANIFEST} label of image ${tag} does not match the generated agentvault.json`);
  }
}

// ---------------------------------------------------------------------------
// packageContainer
// ---------------------------------------------------------------------------

export async function packageContainer(options: ContainerPackageOptions): Promise<ContainerPackageResult> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  // 1. Source
  const absoluteSource = path.resolve(options.sourceDir);
  const check = validateSourcePath(absoluteSource);
  if (!check.valid) {
    throw new ContainerError(fs.existsSync(absoluteSource) ? 'INVALID_INPUT' : 'NOT_FOUND', check.error ?? `Invalid source path: ${absoluteSource}`);
  }

  // 2. Detection (throws on ambiguity, TypeScript, unsafe entrypoints)
  const detection = detectContainerRuntime(absoluteSource, {
    ...(options.runtimeKind !== undefined ? { runtimeKind: options.runtimeKind } : {}),
    ...(options.entrypoint !== undefined ? { entrypoint: options.entrypoint } : {}),
    ...(options.base !== undefined ? { base: options.base } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  });
  detection.warnings.forEach(warn);
  const realSource = detection.sourceDir;

  // 3. Options -> manifest fields
  const volumes = dedupe(options.volumes ?? DEFAULT_VOLUMES);
  volumes.forEach((v) => assertContainerPath(v));
  volumeKeysForPaths(volumes);
  const env = dedupe(options.env ?? []);
  env.forEach((n) => assertEnvName(n));
  const secrets = dedupe(options.secrets ?? []);
  secrets.forEach((n) => assertSecretName(n));
  for (const name of env) {
    if (CREDENTIAL_NAME_RE.test(name)) {
      warn(`Environment variable ${name} looks like a credential: declare it with --secret so the proxy holds it instead of the agent`);
    }
  }

  const network: NetworkMode = options.network ?? (secrets.length > 0 ? 'proxy' : 'none');
  if (network !== 'none' && network !== 'proxy' && network !== 'bridge') {
    throw new ContainerError('INVALID_INPUT', `Invalid network mode ${JSON.stringify(String(network))}: expected none, proxy or bridge`);
  }
  if (network === 'none' && secrets.length > 0) {
    throw new ContainerError('INVALID_INPUT', 'Secrets need the credential proxy: use network "proxy" (or omit network) when declaring secrets');
  }
  if (network === 'bridge') {
    warn('Network mode "bridge" gives the agent unrestricted internet access');
  }

  const imageTag = validateImageTag(options.image ?? `agentvault/${detection.name}:${detection.version}`);
  if (options.platform !== undefined && !PLATFORM_RE.test(options.platform)) {
    throw new ContainerError('INVALID_INPUT', `Invalid platform ${JSON.stringify(printable(options.platform, 40))}: expected os/arch such as linux/amd64`);
  }
  const healthcheck =
    options.healthUrl === undefined
      ? undefined
      : { test: healthcheckForUrl(detection.runtime, options.healthUrl), intervalSec: 30, timeoutSec: 5, retries: 3, startPeriodSec: 10 };

  const draftManifest = (contentHash: string): ContainerManifest =>
    parseManifest({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      name: detection.name,
      version: detection.version,
      runtime: detection.runtime,
      entrypoint: detection.entrypoint,
      volumes,
      env,
      secrets,
      ...(healthcheck ? { healthcheck } : {}),
      isolation: { ...DEFAULT_ISOLATION, user: DEFAULT_AGENT_USER, network },
      source: { type: detection.agentType, contentHash },
    });
  // Dry run with a placeholder hash: every injection / validation failure
  // surfaces before anything is written to disk.
  renderDockerfile({ manifest: draftManifest('0'.repeat(64)), base: detection.base, install: detection.install });

  // 4. Output directory
  const outputDir = path.resolve(options.outputDir ?? path.join(realSource, 'dist', 'container'));
  prepareOutputDir(outputDir, realSource);
  removeGenerated(outputDir);
  const contextDir = path.join(outputDir, 'context');
  const dockerfilePath = path.join(outputDir, 'Dockerfile');
  const manifestPath = path.join(outputDir, MANIFEST_FILE);

  // 5. Stage + write. Anything half-written is removed on failure.
  let manifest: ContainerManifest;
  let stage: StageResult;
  try {
    fs.mkdirSync(contextDir, { mode: 0o755 });
    stage = stageBuildContext(realSource, contextDir, { excludeDirs: [fs.realpathSync(outputDir)] });
    if (detection.entryFile !== undefined && !fs.existsSync(path.join(contextDir, ...detection.entryFile.split('/')))) {
      throw new ContainerError('INTEGRITY', `Entrypoint ${detection.entryFile} was not staged into the build context`);
    }
    manifest = draftManifest(stage.contentHash);
    atomicWriteFileSync(dockerfilePath, renderDockerfile({ manifest, base: detection.base, install: detection.install }), { mode: 0o644 });
    atomicWriteFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  } catch (err) {
    removeGenerated(outputDir);
    throw err;
  }

  const symlinks = stage.skipped.filter((s) => s.reason === SKIP_SYMLINK);
  if (symlinks.length > 0) {
    const shown = symlinks.slice(0, 3).map((s) => s.path).join(', ');
    warn(`${symlinks.length} symbolic link(s) were not copied into the image (${shown}${symlinks.length > 3 ? ', ...' : ''})`);
  }
  const envFiles = stage.skipped.filter((s) => s.reason.startsWith('environment file'));
  if (envFiles.length > 0) {
    warn(`${envFiles.map((s) => s.path).join(', ')} not copied into the image: pass credentials with --secret or declare variable names with --env`);
  }

  const result: ContainerPackageResult = {
    imageTag,
    manifest,
    outputDir,
    contextDir,
    dockerfilePath,
    manifestPath,
    warnings,
    skipped: stage.skipped,
    stats: { files: stage.files, bytes: stage.bytes },
  };
  if (options.build === false) {
    return result;
  }

  // 6. Build + verify
  const built = await options.runtime.buildImage({
    contextDir,
    dockerfile: dockerfilePath,
    tag: imageTag,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.noCache ? { noCache: true } : {}),
  });
  try {
    await verifyBuiltImage(options.runtime, built.tag, manifest);
  } catch (err) {
    // Do not leave a tag that points at an image we could not vouch for. This is
    // best effort: failing to untag must not hide the verification error.
    try {
      await options.runtime.removeImage(built.tag);
    } catch {
      // the verification error below is the one the caller needs to see
    }
    throw err;
  }
  result.imageTag = built.tag;
  result.imageId = built.imageId;
  return result;
}
