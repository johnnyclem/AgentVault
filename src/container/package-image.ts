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
 *  - `.env*`, key material, VCS data and node_modules never enter the
 *    context. Secrets reach an agent only through the credential proxy; the
 *    manifest records `env` / `secrets` NAMES, never values, and no value is
 *    read here.
 *  - `dist/` is NOT excluded (it is where `tsc` usually emits the compiled
 *    agent). AgentVault's own output directory is: the one being written is
 *    skipped by path and any directory carrying OUTPUT_MARKER is skipped
 *    wherever it sits, so a default `dist/container` never nests into itself.
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
  type ImageInfo,
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
/** Held (with the owning pid inside) while a run generates or builds from an output directory. */
export const OUTPUT_LOCK = '.agentvault-container-output.lock';

const DEFAULT_VOLUMES = ['/data'];
const CREDENTIAL_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const PLATFORM_RE = /^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of ContainerRuntime that packaging uses. */
export type PackagingRuntime = Pick<ContainerRuntime, 'buildImage' | 'inspectImage' | 'removeImage' | 'tagImage' | 'runner'>;

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
  /**
   * Runs after the scan and before the first file is opened: the window in which
   * another process could swap what the scan saw. Tests use it to swap files
   * deterministically; production callers have no use for it.
   */
  afterScan?: () => void;
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
  /** Identity of the file the scan saw. The copy only accepts a file with the same one. */
  dev: bigint;
  ino: bigint;
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

/**
 * O_NOFOLLOW only covers the LAST path component, so the caller must still check
 * the opened file's identity (an intermediate directory may have become a symlink).
 * O_NONBLOCK makes opening a FIFO that has no writer return at once instead of
 * blocking this process for ever; the caller then rejects it as not a regular file.
 */
function openNoFollow(abs: string): number | 'symlink' | 'gone' {
  try {
    return fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
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
      let st: fs.BigIntStats;
      try {
        st = fs.lstatSync(abs, { bigint: true });
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
        plannedBytes += Number(st.size);
        if (plannedBytes > maxBytes) throw capError('bytes', maxFiles, maxBytes);
        candidates.push({ rel, abs, dev: st.dev, ino: st.ino });
      } else {
        skip(rel, false, SKIP_SPECIAL);
      }
    }
  };
  walk(sourceDir, '');
  candidates.sort(byPath);
  options.afterScan?.();

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
      const st = fs.fstatSync(fd, { bigint: true });
      if (!st.isFile()) {
        skip(candidate.rel, false, SKIP_SPECIAL);
        continue;
      }
      // Not the file the scan saw: an intermediate directory was swapped for a
      // symlink (so the path now leads outside the source) or the file was replaced.
      if (st.dev !== candidate.dev || st.ino !== candidate.ino) {
        skip(candidate.rel, false, 'changed while packaging');
        continue;
      }
      if (bytes + Number(st.size) > maxBytes) throw capError('bytes', maxFiles, maxBytes);
      content = fs.readFileSync(fd);
      executable = (Number(st.mode) & 0o111) !== 0;
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

function refuseSymlink(p: string, what: string): void {
  let isLink = false;
  try {
    isLink = fs.lstatSync(p).isSymbolicLink();
  } catch {
    // does not exist yet: nothing to follow
  }
  if (isLink) {
    throw new ContainerError(
      'INVALID_INPUT',
      `${what} ${p} is a symbolic link, so the build output would be written wherever it points (possibly another project). Remove the link or choose a real directory with --output`
    );
  }
}

/**
 * Refuse an output directory that could clobber user files, then claim it.
 * Returns its real path, which is what the caller reports and builds from.
 *
 * The output location must not itself be a symlink. Only the last component
 * (and, for the default `<source>/dist/container`, `dist`) is checked: a parent
 * that is a link on the way to an explicit --output is the user's own doing
 * (`/tmp` on macOS) and is resolved instead.
 */
function prepareOutputDir(outputDir: string, realSource: string, isDefault: boolean): string {
  if (isDefault) refuseSymlink(path.join(realSource, 'dist'), 'The default output location');
  refuseSymlink(outputDir, 'The output location');
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
  return fs.realpathSync(outputDir);
}

function removeGenerated(outputDir: string): void {
  for (const name of ['context', 'Dockerfile', MANIFEST_FILE]) {
    fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Output lock
// ---------------------------------------------------------------------------

export interface OutputLock {
  /** Idempotent. Only removes the lock file if it still names this process. */
  release(): void;
  /** Set when the lock was taken over from a process that is no longer running. */
  replacedStaleOwner?: number;
}

/** The pid in a lock file; 'gone' if the file vanished, 'unknown' if it does not name one. */
function readLockOwner(lockPath: string): number | 'gone' | 'unknown' {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown';
  }
  const pid = Number(/^(\d{1,10})\s*$/.exec(text)?.[1] ?? 0);
  return pid > 0 ? pid : 'unknown';
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else. Only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Take the exclusive right to generate into, and build from, `outputDir`.
 *
 * Why: `docker build` streams the context lazily, so a second run that deletes
 * and re-creates it mid-build makes the first image silently incomplete (or a
 * mix of both agents) while still passing label verification. Two runs on one
 * source directory share `dist/container`, so this happens to ordinary users.
 *
 * The lock is a file created with O_EXCL holding the owner's pid. A second run
 * fails at once instead of waiting. A lock whose pid is provably dead (a crash
 * or Ctrl-C, which skips 'exit' handlers) is taken over; one that names no pid
 * is never deleted automatically, because it cannot be shown to be stale.
 */
export function acquireOutputLock(outputDir: string): OutputLock {
  const lockPath = path.join(outputDir, OUTPUT_LOCK);
  let replacedStaleOwner: number | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o644);
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } catch (err) {
        fs.rmSync(lockPath, { force: true }); // do not leave an empty lock behind
        throw err;
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = readLockOwner(lockPath);
      if (owner === 'gone' && attempt < 3) continue; // released between our create and our read
      if (typeof owner === 'number' && !processIsRunning(owner) && attempt < 3) {
        // Re-read right before deleting so a lock another run took meanwhile is not removed.
        if (readLockOwner(lockPath) === owner) fs.rmSync(lockPath, { force: true });
        replacedStaleOwner = owner;
        continue;
      }
      const who = typeof owner === 'number' ? `process ${owner}` : 'an unknown process';
      throw new ContainerError(
        'INVALID_INPUT',
        `Another packaging run (${who}) is using ${outputDir}. Wait for it to finish or choose a different --output. ` +
          `If no packaging run is active, delete ${lockPath}`,
        { lockPath, ...(typeof owner === 'number' ? { pid: owner } : {}) }
      );
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    if (readLockOwner(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
  };
  // Ctrl-C and SIGKILL skip this; the dead-pid takeover above covers them.
  process.on('exit', release);
  return { release, ...(replacedStaleOwner !== undefined ? { replacedStaleOwner } : {}) };
}

// ---------------------------------------------------------------------------
// Existing image tags
// ---------------------------------------------------------------------------

/** The agent a built image belongs to, from its manifest label; undefined for anything that is not one of ours. */
function agentOfImage(info: ImageInfo): string | undefined {
  const label = info.labels[LABEL_MANIFEST];
  if (label === undefined) return undefined;
  try {
    return parseManifest(label).name;
  } catch {
    return undefined;
  }
}

/**
 * `docker tag` silently moves a tag, leaving the image that held it untagged. So
 * a tag may only be (re)used when it is free or already belongs to an AgentVault
 * image of this same agent: `--image node:22-slim` must not re-bind the base
 * image, and one agent must not overwrite another's image.
 */
async function assertTagAvailable(runtime: PackagingRuntime, tag: string, agent: string): Promise<void> {
  const existing = await runtime.inspectImage(tag);
  if (existing === null) return;
  const owner = agentOfImage(existing);
  if (owner === agent) return;
  const what = owner === undefined ? 'an image AgentVault did not build' : `the AgentVault image of agent ${JSON.stringify(owner)}`;
  throw new ContainerError(
    'INVALID_INPUT',
    `Image tag ${tag} already names ${what} (${printable(existing.id.slice(0, 19), 40)}). ` +
      'Packaging would move the tag to this agent and leave that image untagged. Choose another tag with --image <name:tag>',
    { tag, existingImageId: existing.id }
  );
}

/** Fail before anything is written when the runtime cannot move a tag (see ContainerRuntime.tagImage). */
function requireTagging(runtime: PackagingRuntime): (source: string, target: string) => Promise<void> {
  const tagImage = runtime.tagImage?.bind(runtime);
  if (tagImage === undefined) {
    throw new ContainerError('COMMAND_FAILED', 'This container runtime cannot tag images, which packaging needs to publish a verified image under its name');
  }
  return tagImage;
}

/** A tag nobody else uses: the image is built and verified here before it is given its real tag. */
function temporaryTag(agent: string): string {
  return `agentvault/${agent}:build-${crypto.randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Verification of the built image
// ---------------------------------------------------------------------------

/**
 * `builtRef` is where the image sits while it is verified (a private tag);
 * `tag` is the name the user asked for, which is what messages should say.
 */
async function verifyBuiltImage(runtime: PackagingRuntime, builtRef: string, tag: string, manifest: ContainerManifest): Promise<void> {
  const info = await runtime.inspectImage(builtRef);
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

  // Refuse a tag that is not ours to move before anything is written or built.
  const runtime = options.runtime;
  const tagImage = options.build === false ? undefined : requireTagging(runtime);
  if (tagImage !== undefined) await assertTagAvailable(runtime, imageTag, detection.name);

  // 4. Output directory. The lock is held until the build has finished reading the context.
  const outputDir = prepareOutputDir(
    path.resolve(options.outputDir ?? path.join(realSource, 'dist', 'container')),
    realSource,
    options.outputDir === undefined
  );
  const lock = acquireOutputLock(outputDir);
  try {
    if (lock.replacedStaleOwner !== undefined) {
      warn(`Replaced a stale packaging lock left by process ${lock.replacedStaleOwner}, which is no longer running`);
    }
    removeGenerated(outputDir);
    const contextDir = path.join(outputDir, 'context');
    const dockerfilePath = path.join(outputDir, 'Dockerfile');
    const manifestPath = path.join(outputDir, MANIFEST_FILE);

    // 5. Stage + write. Anything half-written is removed on failure.
    let manifest: ContainerManifest;
    let stage: StageResult;
    try {
      fs.mkdirSync(contextDir, { mode: 0o755 });
      stage = stageBuildContext(realSource, contextDir, { excludeDirs: [outputDir] });
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
    if (tagImage === undefined) {
      return result; // generate only
    }

    // 6. Build under a private tag, verify THAT, and only then give it the real
    // tag. A failed build or verification can then never untag or move an image
    // that already holds the name, and the name never points at an image we
    // could not vouch for.
    const privateTag = temporaryTag(manifest.name);
    const built = await runtime.buildImage({
      contextDir,
      dockerfile: dockerfilePath,
      tag: privateTag,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.noCache ? { noCache: true } : {}),
    });
    try {
      await verifyBuiltImage(runtime, built.tag, imageTag, manifest);
      // The build can take minutes: someone may have claimed the name meanwhile.
      await assertTagAvailable(runtime, imageTag, manifest.name);
      await tagImage(built.tag, imageTag);
    } catch (err) {
      // Best effort: failing to drop our private tag must not hide the real error.
      try {
        await runtime.removeImage(built.tag);
      } catch {
        // the error below is the one the caller needs to see
      }
      throw err;
    }
    try {
      await runtime.removeImage(built.tag);
    } catch (err) {
      warn(`The image is tagged ${imageTag}, but its temporary tag ${built.tag} could not be removed (${err instanceof Error ? err.message : String(err)}); run docker image rm ${built.tag}`);
    }
    result.imageId = built.imageId;
    return result;
  } finally {
    lock.release();
  }
}
