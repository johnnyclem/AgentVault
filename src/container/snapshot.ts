/**
 * Directory-format snapshots of an agent's Docker volumes.
 *
 *   <outputDir>/<agent>-<UTC timestamp>/manifest.json
 *                                       <volumeKey>.tar        (unencrypted)
 *                                       <volumeKey>.tar.enc    (AVENC1, see crypto.ts)
 *                                       avt-snapshot-<pid>-XXXXXX/   (only while it is being built:
 *                                                                     names the owner, and holds the plaintext
 *                                                                     tar of an encrypted snapshot)
 *
 * Why this exists: PRD-03 makes "pull image + restore snapshot + start" the
 * reconstruction story. Snapshots are tars produced by a locked-down helper
 * container, optionally encrypted, described by a strict versioned manifest
 * that is written LAST and atomically: its presence means the snapshot is
 * complete.
 *
 * Security stance:
 *  - Every function takes an injected ContainerRuntime and reads no
 *    environment variables; the passphrase is a parameter and never appears in
 *    an error message, a log line or argv.
 *  - Every file name used on disk is derived from a volume key checked with
 *    assertVolumeKey, and is re-checked when read back from manifest.json
 *    (the manifest schema pins `file` to exactly `<key>.tar[.enc]`), so a
 *    hostile manifest cannot point at ../../x.
 *  - manifest.json is plain JSON and nothing signs it, so an ENCRYPTED volume
 *    file is bound to it instead: the GCM AAD of every `<key>.tar.enc` carries
 *    volumeBinding(), i.e. the format version, snapshot id, creation time,
 *    agent, image, the full list of volumes (keys and container paths) and
 *    this file's own key. Swapping two volume files, renaming the agent,
 *    editing the image reference or dropping a volume from the manifest then
 *    fails authentication. What is NOT covered: anything in an UNENCRYPTED
 *    snapshot (there is no key to authenticate with, which is why restore and
 *    verify refuse one unless asked), the per-volume hashes, sizes and entry
 *    counts (they are checked against the decrypted data instead), the
 *    `encryption.iterations` echo (the real value is in each file header), and
 *    verify --ciphertext-only, which has no key to check the binding with.
 *  - A plaintext copy of a volume must never outlive the command. The tar of an
 *    ENCRYPTED snapshot is spooled in a private 0700 directory whose name holds
 *    the owning PID, restore/verify decrypt into one in the scratch directory,
 *    and every operation takes an AbortSignal: on abort the helper container is
 *    removed, spools and the half-written snapshot directory are deleted.
 *    sweepStaleSnapshotData() removes what a killed process (SIGKILL, OOM, power
 *    loss) left behind, but only for PIDs that are no longer alive: concurrent
 *    snapshots are legitimate.
 *  - The helper recipes are verified against a real daemon; do not change
 *    them without re-verifying:
 *      snapshot: --network none --cap-drop ALL --cap-add DAC_READ_SEARCH
 *                --read-only, volume mounted :ro, `tar -cf - -C /v .`
 *      restore : --network none --cap-drop ALL --cap-add CHOWN FOWNER
 *                DAC_OVERRIDE --read-only, `tar -xf - -C /v`
 *    Without DAC_READ_SEARCH a root-in-container tar silently omits files it
 *    does not own with mode 0640/0700 yet still emits a valid-looking archive;
 *    the exit code (1) is the only signal, so ANY non-zero exit is a failure.
 *  - Restore order (nothing is written to ANY volume until every validation
 *    for EVERY volume has passed): manifest schema -> files exist, regular,
 *    sizes match -> (encrypted) ciphertext sha256, then decrypt to a private
 *    0700 spool with the GCM tag verified -> plaintext sha256 -> tar
 *    validation (tar-validate.ts) -> target volumes empty (unless `force`;
 *    managed volumes are probed read-only BEFORE anything is created, a name
 *    that turns out to exist unmanaged is probed right after ensureVolume
 *    and still before any write) -> restore helper -> exit code. If a restore
 *    fails, volumes that were empty before are removed again; Docker refuses to
 *    remove a volume a stopped container still references, so those are emptied
 *    with a restore-capability helper instead. The error message states, per
 *    volume, which of removed / emptied / still holds partial data happened and
 *    what to run; a volume that already held data (force) is never touched and
 *    is reported as possibly mixed. An unencrypted snapshot is copied into the
 *    spool while hashing so the bytes validated are the bytes restored (no
 *    time-of-check/time-of-use gap).
 *  - Known BusyBox behaviour (verified on busybox:1.37): `tar -x` uses chown(),
 *    which follows symlinks, so restored symlinks are root-owned and are the
 *    only entries whose owner is not preserved. That chown-through-a-link is
 *    one more reason tar-validate.ts refuses escaping symlinks.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { atomicWriteFileSync, sanitizePathPart } from '../utils/path-validation.js';
import { KDF_ITERATIONS_DEFAULT, KDF_ITERATIONS_MAX, KDF_ITERATIONS_MIN, assertPassphrase, decryptFile, encryptFile } from './crypto.js';
import { validateTarArchive } from './tar-validate.js';
import type { TarSummary } from './tar-validate.js';
import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_ROLE, LABEL_VOLUME_KEY } from './types.js';
import type { CommandResult, ContainerRuntime, ContainerSpec } from './types.js';
import {
  AGENT_NAME_RE,
  CONTAINER_PATH_RE,
  IMAGE_REF_RE,
  VOLUME_KEY_RE,
  assertAgentName,
  assertContainerPath,
  assertImageRef,
  assertVolumeKey,
  resourceNames,
} from './validate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SNAPSHOT_FORMAT = 'agentvault-container-snapshot';
/** 2: adds `snapshotId` and binds the manifest into the AAD of every encrypted volume file. */
export const SNAPSHOT_VERSION = 2 as const;
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
export const DEFAULT_HELPER_IMAGE = 'busybox:1.37';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VOLUMES = 64;
const MAX_DIR_SUFFIX = 99;
const MOUNT_POINT = '/v';
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_STDERR_IN_MESSAGE = 500;
/** How long, and how often, to keep trying to remove a helper whose `docker run` had not created it yet. */
const KILL_RETRY_MS = 200;
const KILL_ATTEMPTS = 25;
/** Slack for ciphertext framing and filesystem rounding when checking free space. */
const FREE_SPACE_MARGIN_BYTES = 8 * 1024 * 1024;

/** Private scratch directory: `avt-snapshot-<owning pid>-<6 random characters>`. */
const SPOOL_PREFIX = 'avt-snapshot-';
const SPOOL_NAME_RE = /^avt-snapshot-(\d{1,10})-[A-Za-z0-9]{6}$/;
/** What `createSnapshot` names a directory: `<agent>-<UTC stamp>[-<n>]`. The sweep touches nothing else. */
const SNAPSHOT_DIR_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}-\d{8}T\d{6}Z(?:-\d{1,2})?$/;
/** The plaintext file an earlier build wrote next to the ciphertext: `.<key>.tar.plain`. */
const LEGACY_PLAINTEXT_RE = /^\.[a-z0-9][a-z0-9_-]{0,31}\.tar\.plain$/;

/**
 * The user (or a signal handler) stopped the operation. Nothing partial was
 * kept except what the message says. Deliberately not a ContainerError: none of
 * its codes describe "the user changed their mind", and a docker hint under it
 * would mislead.
 */
export class SnapshotInterruptedError extends Error {
  constructor(message = 'Interrupted.') {
    super(message);
    this.name = 'SnapshotInterruptedError';
  }
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SnapshotInterruptedError();
}

/** Delete `leftover` (which may hold plaintext) and build the interruption error, honest about whether that worked. */
function interruptedAfterCleanup(leftover: string, outcome: string): SnapshotInterruptedError {
  removeQuietly(leftover);
  return new SnapshotInterruptedError(
    fs.existsSync(leftover)
      ? `Interrupted. ${leftover} could not be deleted and may hold unencrypted volume data: delete it by hand.`
      : `Interrupted. ${outcome}`
  );
}

/** Test seam, like crypto.ts `internals`: lets a test simulate a full disk. Not for production use. */
export const internals = {
  freeBytes(dir: string): number {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};

/** Refuse before writing, with a message that says what is short, instead of failing halfway with ENOSPC. */
function assertFreeSpace(dir: string, needed: number, what: string): void {
  let free: number;
  try {
    free = internals.freeBytes(dir);
  } catch {
    return; // cannot tell on this platform or filesystem: let the write decide
  }
  if (free < needed + FREE_SPACE_MARGIN_BYTES) {
    throw new ContainerError(
      'COMMAND_FAILED',
      `Not enough free space in ${dir} for ${what}: about ${needed} bytes are needed, ${free} are free. Free some space or use another location.`,
      { dir, needed, free }
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** On-disk file name for a volume. The ONLY place file names are built. */
export function snapshotFileName(key: string, encrypted: boolean): string {
  const name = `${assertVolumeKey(key)}.tar${encrypted ? '.enc' : ''}`;
  return sanitizePathPart(name);
}

const volumeSchema = z
  .strictObject({
    key: z.string().regex(VOLUME_KEY_RE),
    containerPath: z
      .string()
      .regex(CONTAINER_PATH_RE)
      .refine((p) => p !== '/' && !p.endsWith('/') && !p.split('/').some((s) => s === '..' || s === '.'), 'path must be normalized')
      .optional(),
    file: z.string().max(64),
    encrypted: z.boolean(),
    plaintextSha256: sha256Schema,
    plaintextBytes: countSchema,
    ciphertextSha256: sha256Schema.optional(),
    ciphertextBytes: countSchema.optional(),
    entries: countSchema,
  })
  .superRefine((v, ctx) => {
    if (v.file !== `${v.key}.tar${v.encrypted ? '.enc' : ''}`) {
      ctx.addIssue({ code: 'custom', path: ['file'], message: 'file must be exactly <key>.tar (or <key>.tar.enc when encrypted)' });
    }
    const hasCipher = v.ciphertextSha256 !== undefined || v.ciphertextBytes !== undefined;
    if (v.encrypted && (v.ciphertextSha256 === undefined || v.ciphertextBytes === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['ciphertextSha256'], message: 'an encrypted volume needs ciphertextSha256 and ciphertextBytes' });
    }
    if (!v.encrypted && hasCipher) {
      ctx.addIssue({ code: 'custom', path: ['ciphertextSha256'], message: 'an unencrypted volume must not carry ciphertext fields' });
    }
  });

export const snapshotManifestSchema = z
  .strictObject({
    format: z.literal(SNAPSHOT_FORMAT),
    version: z.literal(SNAPSHOT_VERSION),
    /** Random per snapshot, so a file from one snapshot cannot be passed off as part of another. */
    snapshotId: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: z.iso.datetime(),
    agent: z.string().regex(AGENT_NAME_RE),
    image: z
      .strictObject({
        ref: z.string().regex(IMAGE_REF_RE),
        id: z.string().regex(IMAGE_REF_RE).optional(),
        digest: z.string().regex(IMAGE_REF_RE).optional(),
      })
      .nullable(),
    volumes: z.array(volumeSchema).min(1).max(MAX_VOLUMES),
    encryption: z
      .strictObject({
        alg: z.literal('aes-256-gcm'),
        kdf: z.literal('pbkdf2-sha256'),
        iterations: z.number().int().min(KDF_ITERATIONS_MIN).max(KDF_ITERATIONS_MAX),
      })
      .nullable(),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const [i, v] of m.volumes.entries()) {
      if (seen.has(v.key)) ctx.addIssue({ code: 'custom', path: ['volumes', i, 'key'], message: 'duplicate volume key' });
      seen.add(v.key);
      if (v.encrypted !== (m.encryption !== null)) {
        ctx.addIssue({ code: 'custom', path: ['volumes', i, 'encrypted'], message: 'volume encryption disagrees with the manifest encryption block' });
      }
    }
  });

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export type SnapshotVolume = SnapshotManifest['volumes'][number];

/** The manifest fields that are known before any volume is encrypted, and so can be authenticated. */
export interface SnapshotBinding {
  snapshotId: string;
  createdAt: string;
  agent: string;
  image: SnapshotManifest['image'];
  volumes: ReadonlyArray<{ key: string; containerPath?: string | undefined }>;
}

/**
 * The context mixed into the GCM AAD of volume `key`'s file (see crypto.ts). A
 * JSON array of fixed shape and order, so two different bindings can never
 * encode to the same text. create and restore/verify both build it with this
 * one function from the same fields, so they cannot drift apart.
 */
export function volumeBinding(binding: SnapshotBinding, key: string): string {
  const image = binding.image === null ? null : [binding.image.ref, binding.image.id ?? null, binding.image.digest ?? null];
  const volumes = binding.volumes.map((v) => [v.key, v.containerPath ?? null] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify([SNAPSHOT_FORMAT, SNAPSHOT_VERSION, binding.snapshotId, binding.createdAt, binding.agent, image, volumes, key]);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function tail(text: string, max = MAX_STDERR_IN_MESSAGE): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `...${trimmed.slice(-max)}` : trimmed;
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // never mask the error that brought us here
  }
}

async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: HASH_CHUNK_BYTES })) {
    throwIfInterrupted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Copy while hashing in a single read, so the digest describes the copied bytes. */
async function copyAndHash(src: string, dest: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  async function* tee(): AsyncGenerator<Buffer> {
    for await (const chunk of fs.createReadStream(src, { highWaterMark: HASH_CHUNK_BYTES })) {
      throwIfInterrupted(signal);
      const buf = chunk as Buffer;
      hash.update(buf);
      bytes += buf.length;
      yield buf;
    }
  }
  await pipeline(tee(), fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  return { sha256: hash.digest('hex'), bytes };
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function requireHelperImage(runtime: ContainerRuntime, image: string): Promise<void> {
  if ((await runtime.inspectImage(image)) === null) {
    throw new ContainerError(
      'NOT_FOUND',
      `The helper image ${image} is not present locally and is never pulled implicitly. Run: docker pull ${image}`,
      { image }
    );
  }
}

function readManifestFile(snapshotDir: string): SnapshotManifest {
  const file = path.join(snapshotDir, SNAPSHOT_MANIFEST_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ContainerError('NOT_FOUND', `No ${SNAPSHOT_MANIFEST_FILE} in ${snapshotDir}: the snapshot does not exist or was never completed`);
    }
    throw err;
  }
  if (!stat.isFile()) throw new ContainerError('INTEGRITY', `${SNAPSHOT_MANIFEST_FILE} must be a regular file (not a symlink)`);
  if (stat.size > MAX_MANIFEST_BYTES) throw new ContainerError('INTEGRITY', `${SNAPSHOT_MANIFEST_FILE} is implausibly large`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ContainerError('INTEGRITY', `${SNAPSHOT_MANIFEST_FILE} is not valid JSON`);
  }
  const parsed = snapshotManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new ContainerError('INTEGRITY', `${SNAPSHOT_MANIFEST_FILE} is invalid${where}: ${(issue?.message ?? 'schema mismatch').slice(0, 300)}`);
  }
  return parsed.data;
}

/** The manifest of a snapshot directory, schema-checked. Throws NOT_FOUND / INTEGRITY. */
export function readSnapshotManifest(snapshotDir: string): SnapshotManifest {
  return readManifestFile(path.resolve(snapshotDir));
}

// ---------------------------------------------------------------------------
// Helper containers
// ---------------------------------------------------------------------------

type HelperKind = 'snapshot' | 'restore' | 'list' | 'empty';

interface HelperRecipe {
  command: string[];
  capAdd: string[];
  readOnlyVolume: boolean;
}

const RECIPES: Record<HelperKind, HelperRecipe> = {
  snapshot: { command: ['tar', '-cf', '-', '-C', MOUNT_POINT, '.'], capAdd: ['DAC_READ_SEARCH'], readOnlyVolume: true },
  restore: { command: ['tar', '-xf', '-', '-C', MOUNT_POINT], capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'], readOnlyVolume: false },
  list: { command: ['ls', '-A', MOUNT_POINT], capAdd: ['DAC_READ_SEARCH'], readOnlyVolume: true },
  // Undoes a failed restore. Same capabilities as the restore it undoes (to delete what restore wrote,
  // whatever its owner and mode), and no others.
  empty: { command: ['find', MOUNT_POINT, '-mindepth', '1', '-delete'], capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'], readOnlyVolume: false },
};

const HELPER_NAME_PART: Record<HelperKind, string> = { snapshot: 'snap', restore: 'rst', list: 'ls', empty: 'clr' };

function helperSpec(kind: HelperKind, agent: string, volume: string, image: string): ContainerSpec {
  const recipe = RECIPES[kind];
  return {
    name: `av-${agent}-${HELPER_NAME_PART[kind]}-${randomBytes(4).toString('hex')}`,
    image,
    role: 'helper',
    command: [...recipe.command],
    user: '0:0',
    allowRoot: true,
    network: 'none',
    mounts: [{ kind: 'volume', source: volume, target: MOUNT_POINT, readOnly: recipe.readOnlyVolume }],
    tmpfs: [],
    env: {},
    labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'helper', [LABEL_AGENT]: agent },
    limits: { cpus: 1, memory: '512m', pidsLimit: 64 },
    readOnlyRootfs: true,
    capAdd: [...recipe.capAdd],
    detach: false,
    autoRemove: true,
    init: false,
  };
}

function helperFailed(result: CommandResult): boolean {
  return result.exitCode !== 0 || result.timedOut || result.spawnFailed;
}

type ForegroundIo = Parameters<ContainerRuntime['runForeground']>[1];

/**
 * Run a helper container; if `signal` aborts meanwhile, remove it. Interrupting
 * this process does not stop a helper: PID 1 in a container ignores SIGINT and
 * SIGTERM, and the docker client only forwards them, so the helper would go on
 * streaming volume data into a file nobody is going to clean up. `docker rm -f`
 * kills it, which also ends the blocked `docker run`. The container may not
 * exist yet when the signal arrives (docker is still creating it), so the
 * removal is retried until the run returns.
 */
async function runHelper(runtime: ContainerRuntime, spec: ContainerSpec, io: ForegroundIo, signal: AbortSignal | undefined): Promise<CommandResult> {
  throwIfInterrupted(signal);
  if (signal === undefined) return runtime.runForeground(spec, io);
  let finished = false;
  const kill = async (): Promise<void> => {
    for (let attempt = 0; attempt < KILL_ATTEMPTS && !finished; attempt += 1) {
      try {
        await runtime.remove(spec.name, { force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, KILL_RETRY_MS));
      }
    }
  };
  const onAbort = (): void => void kill();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await runtime.runForeground(spec, io);
    throwIfInterrupted(signal);
    return result;
  } catch (err) {
    // A removed helper surfaces as a failed run: that is the interruption, not a docker problem.
    throwIfInterrupted(signal);
    throw err;
  } finally {
    finished = true;
    signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

export interface CreateSnapshotRequest {
  runtime: ContainerRuntime;
  agent: string;
  /** Parent directory; the snapshot lives in <outputDir>/<agent>-<UTC timestamp>. */
  outputDir: string;
  /** Omitted => unencrypted (a warning is returned). */
  passphrase?: string;
  /** Default busybox:1.37. Never pulled implicitly. */
  helperImage?: string;
  /** Default: every managed volume of the agent. */
  volumeKeys?: string[];
  /** Recorded in the manifest so the snapshot knows which image it belongs to. */
  image?: { ref: string; id?: string; digest?: string };
  /** volume key -> container path, recorded in the manifest (informational). */
  containerPaths?: Record<string, string>;
  /** Clock, for deterministic directory names in tests. */
  now?: () => Date;
  /**
   * Aborting stops the helper container, deletes every plaintext spool and the
   * half-written snapshot directory, and rejects with SnapshotInterruptedError.
   */
  signal?: AbortSignal;
}

export interface CreateSnapshotResult {
  dir: string;
  manifest: SnapshotManifest;
  warnings: string[];
}

function makeSnapshotDir(outputDir: string, agent: string, date: Date): string {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const base = sanitizePathPart(`${agent}-${utcStamp(date)}`);
  for (let attempt = 1; attempt <= MAX_DIR_SUFFIX; attempt += 1) {
    const dir = path.join(outputDir, attempt === 1 ? base : sanitizePathPart(`${base}-${attempt}`));
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new ContainerError('INVALID_INPUT', `Too many snapshots of ${agent} in the same second in ${outputDir}`);
}

export async function createSnapshot(request: CreateSnapshotRequest): Promise<CreateSnapshotResult> {
  const { runtime } = request;
  const agent = assertAgentName(request.agent);
  const helperImage = assertImageRef(request.helperImage ?? DEFAULT_HELPER_IMAGE);
  const passphrase = request.passphrase;
  if (passphrase !== undefined) assertPassphrase(passphrase);
  const requestedKeys = request.volumeKeys !== undefined ? [...new Set(request.volumeKeys.map(assertVolumeKey))] : undefined;
  const containerPaths = new Map<string, string>();
  for (const [key, value] of Object.entries(request.containerPaths ?? {})) {
    containerPaths.set(assertVolumeKey(key), assertContainerPath(value));
  }
  const outputDir = path.resolve(request.outputDir);
  const now = (request.now ?? ((): Date => new Date()))();
  const { signal } = request;
  const warnings: string[] = [];

  throwIfInterrupted(signal);
  await requireHelperImage(runtime, helperImage);

  const managed = (await runtime.listVolumes({ agent })).filter((v) => v.agent === agent);
  const byKey = new Map(managed.map((v) => [v.key, v.name]));
  let selected: string[];
  if (requestedKeys !== undefined) {
    for (const key of requestedKeys) {
      if (!byKey.has(key)) throw new ContainerError('NOT_FOUND', `Agent ${agent} has no managed volume with key ${JSON.stringify(key)}`);
    }
    selected = requestedKeys;
  } else {
    selected = [...byKey.keys()].sort();
  }
  if (selected.length === 0) {
    throw new ContainerError('NOT_FOUND', `Agent ${agent} has no managed volumes: there is nothing to snapshot`);
  }
  if (selected.length > MAX_VOLUMES) {
    throw new ContainerError('INVALID_INPUT', `Agent ${agent} has more than ${MAX_VOLUMES} volumes`);
  }

  const running = await runtime.list({ agent }).then(
    (all) => all.some((c) => c.state === 'running'),
    () => false
  );
  if (running) {
    warnings.push(`Agent ${agent} is running: files may change while they are archived. Stop it first for a consistent snapshot.`);
  }
  if (passphrase === undefined) {
    warnings.push('This snapshot is NOT encrypted: anyone who can read it can read the agent\'s data. Provide a passphrase to encrypt it.');
  }

  throwIfInterrupted(signal);
  const binding: SnapshotBinding = {
    snapshotId: randomBytes(16).toString('hex'),
    createdAt: now.toISOString(),
    agent,
    image: request.image !== undefined ? { ...request.image } : null,
    volumes: selected.map((key) => ({ key, containerPath: containerPaths.get(key) })),
  };

  const dir = makeSnapshotDir(outputDir, agent, now);
  try {
    // Names this process as the owner of the directory while it is incomplete (see sweepStaleSnapshotData). The
    // plaintext tar of an encrypted snapshot lives here too, nowhere else, and only until it is encrypted.
    const spool = makeSpool(dir);
    const seal = passphrase !== undefined ? { passphrase, spool } : undefined;
    const volumes: SnapshotVolume[] = [];
    for (const key of selected) {
      const volumeName = byKey.get(key);
      if (volumeName === undefined) continue;
      volumes.push(
        await snapshotVolume({
          runtime,
          agent,
          key,
          volumeName,
          dir,
          helperImage,
          seal: seal !== undefined ? { ...seal, context: volumeBinding(binding, key) } : undefined,
          containerPath: containerPaths.get(key),
          signal,
        })
      );
    }

    throwIfInterrupted(signal);
    const manifest = snapshotManifestSchema.parse({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      snapshotId: binding.snapshotId,
      createdAt: binding.createdAt,
      agent,
      image: binding.image,
      volumes,
      encryption:
        passphrase !== undefined ? { alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: KDF_ITERATIONS_DEFAULT } : null,
    });
    // Last, and atomic: its presence means the snapshot is complete.
    atomicWriteFileSync(path.join(dir, SNAPSHOT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    removeQuietly(spool);
    return { dir, manifest, warnings };
  } catch (err) {
    if (signal?.aborted === true) throw interruptedAfterCleanup(dir, 'The unfinished snapshot was deleted and nothing was kept.');
    removeQuietly(dir);
    throw err;
  }
}

interface SnapshotVolumeJob {
  runtime: ContainerRuntime;
  agent: string;
  key: string;
  volumeName: string;
  dir: string;
  helperImage: string;
  /** Set exactly when the snapshot is encrypted. */
  seal: { passphrase: string; spool: string; context: string } | undefined;
  containerPath: string | undefined;
  signal: AbortSignal | undefined;
}

async function snapshotVolume(job: SnapshotVolumeJob): Promise<SnapshotVolume> {
  const { runtime, agent, key, volumeName, dir, helperImage, seal, signal } = job;
  const finalName = snapshotFileName(key, seal !== undefined);
  // An unencrypted snapshot is written straight to its final name. An encrypted one never has its
  // plaintext outside the private spool, and the spool copy is deleted as soon as it is encrypted.
  const tarPath = seal !== undefined ? path.join(seal.spool, sanitizePathPart(`${key}.tar`)) : path.join(dir, finalName);

  const spec = helperSpec('snapshot', agent, volumeName, helperImage);
  const result = await runHelper(runtime, spec, { stdoutFile: tarPath }, signal);
  if (helperFailed(result)) {
    // A partial tar still looks valid: the exit code is the only signal.
    throw new ContainerError(
      'COMMAND_FAILED',
      `Snapshot helper for volume ${JSON.stringify(key)} failed (exit code ${result.exitCode}); the archive may be incomplete, so no snapshot was kept. ${tail(result.stderr)}`.trim(),
      { volume: key, exitCode: result.exitCode }
    );
  }
  if (!fs.existsSync(tarPath)) {
    throw new ContainerError('COMMAND_FAILED', `Snapshot helper for volume ${JSON.stringify(key)} produced no archive`, { volume: key });
  }

  let summary: TarSummary;
  try {
    summary = await validateTarArchive(tarPath);
    throwIfInterrupted(signal);
  } catch (err) {
    if (err instanceof ContainerError && err.code === 'INTEGRITY') {
      throw new ContainerError(
        'INTEGRITY',
        `Volume ${JSON.stringify(key)} cannot be snapshotted because the archive could not be restored safely later. ${err.message}`,
        { volume: key, ...(err.details ?? {}) }
      );
    }
    throw err;
  }

  const base = { key, ...(job.containerPath !== undefined ? { containerPath: job.containerPath } : {}), entries: summary.entries };
  if (seal === undefined) {
    return {
      ...base,
      file: finalName,
      encrypted: false,
      plaintextSha256: await sha256File(tarPath, signal),
      plaintextBytes: fs.statSync(tarPath).size,
    };
  }
  assertFreeSpace(dir, fs.statSync(tarPath).size, `the encrypted copy of volume ${JSON.stringify(key)}`);
  const encrypt = await encryptFile(tarPath, path.join(dir, finalName), seal.passphrase, {
    context: seal.context,
    ...(signal !== undefined ? { signal } : {}),
  });
  removeQuietly(tarPath);
  return {
    ...base,
    file: finalName,
    encrypted: true,
    plaintextSha256: encrypt.plaintextSha256,
    plaintextBytes: encrypt.plaintextBytes,
    ciphertextSha256: encrypt.ciphertextSha256,
    ciphertextBytes: encrypt.ciphertextBytes,
  };
}

// ---------------------------------------------------------------------------
// Staging: shared by verifySnapshot and restoreSnapshot
// ---------------------------------------------------------------------------

interface StagedVolume {
  volume: SnapshotVolume;
  /** Plaintext tar whose sha256 and structure have been verified. */
  plainPath: string;
  summary: TarSummary;
}

interface StageOptions {
  snapshotDir: string;
  passphrase: string | undefined;
  /** Private 0700 directory for decrypted (or copied) tars. */
  spoolDir: string;
  /** Copy unencrypted tars into the spool so validated bytes == restored bytes. */
  copyPlain: boolean;
  /** Verify ciphertext only (no decryption) when an encrypted snapshot has no passphrase. */
  allowCiphertextOnly: boolean;
  signal: AbortSignal | undefined;
}

interface StageResult {
  manifest: SnapshotManifest;
  staged: StagedVolume[];
  /** Volumes whose plaintext could not be checked (no passphrase). */
  ciphertextOnly: string[];
}

function lstatRegular(file: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ContainerError('INTEGRITY', `${label} is missing from the snapshot`);
    }
    throw err;
  }
  if (!stat.isFile()) throw new ContainerError('INTEGRITY', `${label} is not a regular file`);
  return stat;
}

async function stageSnapshot(options: StageOptions): Promise<StageResult> {
  const { signal } = options;
  const manifest = readManifestFile(options.snapshotDir);
  const staged: StagedVolume[] = [];
  const ciphertextOnly: string[] = [];

  // Everything staged stays in the spool until the caller is done: say so now, not with ENOSPC halfway.
  const spooled = manifest.volumes
    .filter((v) => (v.encrypted ? options.passphrase !== undefined : options.copyPlain))
    .reduce((sum, v) => sum + v.plaintextBytes, 0);
  if (spooled > 0) assertFreeSpace(options.spoolDir, spooled, 'the decrypted copy of the snapshot');

  for (const volume of manifest.volumes) {
    throwIfInterrupted(signal);
    const fileName = snapshotFileName(volume.key, volume.encrypted);
    if (fileName !== volume.file) throw new ContainerError('INTEGRITY', `Volume ${JSON.stringify(volume.key)} names an unexpected file`);
    const source = path.join(options.snapshotDir, fileName);
    const label = `${fileName} (volume ${JSON.stringify(volume.key)})`;
    const stat = lstatRegular(source, label);
    const expectedBytes = volume.encrypted ? volume.ciphertextBytes : volume.plaintextBytes;
    if (stat.size !== expectedBytes) {
      throw new ContainerError('INTEGRITY', `${label} is ${stat.size} bytes but the manifest says ${expectedBytes}`);
    }

    let plainPath: string;
    if (volume.encrypted) {
      if ((await sha256File(source, signal)) !== volume.ciphertextSha256) {
        throw new ContainerError('INTEGRITY', `${label} does not match its sha256 in the manifest`);
      }
      if (options.passphrase === undefined) {
        if (!options.allowCiphertextOnly) {
          throw new ContainerError('INVALID_INPUT', `Volume ${JSON.stringify(volume.key)} is encrypted: a passphrase is required`);
        }
        ciphertextOnly.push(volume.key);
        continue;
      }
      plainPath = path.join(options.spoolDir, sanitizePathPart(`${volume.key}.tar`));
      // Resolves only after the GCM tag verified; wrong passphrase => INTEGRITY and nothing left behind.
      const decrypted = await decryptFile(source, plainPath, options.passphrase, {
        context: volumeBinding(manifest, volume.key),
        ...(signal !== undefined ? { signal } : {}),
      });
      if (decrypted.plaintextSha256 !== volume.plaintextSha256 || decrypted.plaintextBytes !== volume.plaintextBytes) {
        throw new ContainerError('INTEGRITY', `Decrypted ${label} does not match the sha256 in the manifest`);
      }
    } else if (options.copyPlain) {
      plainPath = path.join(options.spoolDir, sanitizePathPart(`${volume.key}.tar`));
      const copied = await copyAndHash(source, plainPath, signal);
      if (copied.sha256 !== volume.plaintextSha256 || copied.bytes !== volume.plaintextBytes) {
        throw new ContainerError('INTEGRITY', `${label} does not match its sha256 in the manifest`);
      }
    } else {
      plainPath = source;
      if ((await sha256File(source, signal)) !== volume.plaintextSha256) {
        throw new ContainerError('INTEGRITY', `${label} does not match its sha256 in the manifest`);
      }
    }

    const summary = await validateTarArchive(plainPath);
    throwIfInterrupted(signal);
    if (summary.entries !== volume.entries) {
      throw new ContainerError('INTEGRITY', `${label} holds ${summary.entries} entries but the manifest says ${volume.entries}`);
    }
    staged.push({ volume, plainPath, summary });
  }
  return { manifest, staged, ciphertextOnly };
}

function makeSpool(parent: string | undefined): string {
  // mkdtemp creates the directory 0700. The owning PID is in the name so that a later run can tell the
  // leftovers of a dead process (sweepStaleSnapshotData) from the work of a live one.
  return fs.mkdtempSync(path.join(parent ?? os.tmpdir(), `${SPOOL_PREFIX}${process.pid}-`));
}

// ---------------------------------------------------------------------------
// verifySnapshot
// ---------------------------------------------------------------------------

export interface VerifySnapshotRequest {
  snapshotDir: string;
  /** Needed to decrypt and check the plaintext of an encrypted snapshot. */
  passphrase?: string;
  /** Parent for the private spool directory. Default os.tmpdir(). */
  tempDir?: string;
  /** Aborting deletes the decrypted spool and rejects with SnapshotInterruptedError. */
  signal?: AbortSignal;
}

export interface VerifySnapshotResult {
  manifest: SnapshotManifest;
  volumes: Array<{ key: string; entries: number; plaintextBytes: number; encrypted: boolean; plaintextVerified: boolean }>;
  /** False when an encrypted snapshot was checked without a passphrase (ciphertext hash only). */
  fullyVerified: boolean;
  warnings: string[];
}

/**
 * Check a snapshot end to end without touching Docker. Throws NOT_FOUND for a
 * missing/incomplete snapshot and INTEGRITY for anything wrong with it
 * (including a wrong passphrase).
 */
export async function verifySnapshot(request: VerifySnapshotRequest): Promise<VerifySnapshotResult> {
  if (request.passphrase !== undefined) assertPassphrase(request.passphrase);
  const { signal } = request;
  throwIfInterrupted(signal);
  const snapshotDir = path.resolve(request.snapshotDir);
  const spoolDir = makeSpool(request.tempDir);
  try {
    const { manifest, staged, ciphertextOnly } = await stageSnapshot({
      snapshotDir,
      passphrase: request.passphrase,
      spoolDir,
      copyPlain: false,
      allowCiphertextOnly: true,
      signal,
    });
    const warnings: string[] = [];
    if (ciphertextOnly.length > 0) {
      warnings.push('No passphrase was given: only the ciphertext hashes were checked, not the decrypted contents or the tar structure.');
    }
    const summaryByKey = new Map(staged.map((s) => [s.volume.key, s]));
    return {
      manifest,
      volumes: manifest.volumes.map((v) => ({
        key: v.key,
        entries: v.entries,
        plaintextBytes: v.plaintextBytes,
        encrypted: v.encrypted,
        plaintextVerified: summaryByKey.has(v.key),
      })),
      fullyVerified: ciphertextOnly.length === 0,
      warnings,
    };
  } catch (err) {
    if (signal?.aborted === true) throw interruptedAfterCleanup(spoolDir, 'The decrypted scratch copy was deleted; the snapshot was not changed.');
    throw err;
  } finally {
    removeQuietly(spoolDir);
  }
}

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

export interface SnapshotSummary {
  status: 'complete';
  dir: string;
  name: string;
  createdAt: string;
  agent: string;
  encrypted: boolean;
  volumes: number;
  plaintextBytes: number;
}

/**
 * A directory that looks like one of ours (`<agent>-<UTC stamp>`) but has no
 * usable manifest: a run that was killed before it finished, or damage. It
 * cannot be restored; listing it is how the user learns it exists.
 */
export interface IncompleteSnapshot {
  status: 'incomplete';
  dir: string;
  name: string;
}

/**
 * Snapshots directly under `parentDir`: complete ones newest first, then the
 * incomplete ones by name. Directories whose name is not one createSnapshot
 * would have chosen are not snapshots and are not listed, so pointing this at a
 * directory full of other things lists nothing of them. Use verifySnapshot on a
 * listed directory to find out why it cannot be used.
 */
export function listSnapshots(parentDir: string): Array<SnapshotSummary | IncompleteSnapshot> {
  const parent = path.resolve(parentDir);
  const complete: SnapshotSummary[] = [];
  const incomplete: IncompleteSnapshot[] = [];
  for (const dirent of readDirQuietly(parent)) {
    if (!dirent.isDirectory()) continue; // symlinked directories are deliberately skipped
    const dir = path.join(parent, dirent.name);
    let manifest: SnapshotManifest;
    try {
      manifest = readManifestFile(dir);
    } catch {
      if (SNAPSHOT_DIR_NAME_RE.test(dirent.name)) incomplete.push({ status: 'incomplete', dir, name: dirent.name });
      continue;
    }
    complete.push({
      status: 'complete',
      dir,
      name: dirent.name,
      createdAt: manifest.createdAt,
      agent: manifest.agent,
      encrypted: manifest.encryption !== null,
      volumes: manifest.volumes.length,
      plaintextBytes: manifest.volumes.reduce((sum, v) => sum + v.plaintextBytes, 0),
    });
  }
  complete.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.name < b.name ? 1 : -1));
  incomplete.sort((a, b) => (a.name < b.name ? -1 : 1));
  return [...complete, ...incomplete];
}

// ---------------------------------------------------------------------------
// Sweeping what a killed process left behind
// ---------------------------------------------------------------------------

function readDirQuietly(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing, unreadable, or not a directory: nothing of ours in there
  }
}

/** Only ESRCH proves a process is gone; EPERM means it exists and is someone else's. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function spoolOwner(name: string): number | undefined {
  const match = SPOOL_NAME_RE.exec(name);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

export interface SweepRequest {
  /** Directories that hold snapshots (`<agent>-<stamp>/`), such as <AgentVault home>/snapshots or an --output. */
  snapshotDirs?: readonly string[];
  /** Directories that hold restore/verify spools, such as <AgentVault home>/tmp. */
  scratchDirs?: readonly string[];
}

export interface SweepResult {
  /** Everything that was deleted (absolute paths). */
  removed: string[];
}

/**
 * Delete the plaintext and half-written snapshots that a process which died
 * without cleaning up (SIGKILL, OOM, power loss) left behind. Best effort and
 * never throws: it runs at the start of every snapshot command.
 *
 * What it will delete, and nothing else:
 *  - a spool directory `avt-snapshot-<pid>-XXXXXX` whose process is gone, in a
 *    scratch directory or inside a snapshot directory;
 *  - a snapshot directory with no manifest.json whose name is one createSnapshot
 *    chooses and which holds such a spool (an interrupted create), or the
 *    `.<key>.tar.plain` file an earlier build left (no PID in it, so a
 *    manifest-less directory with one is taken to be dead too);
 *  - `.<key>.tar.plain` files in a snapshot directory that has a manifest.
 * Anything a LIVE process owns is skipped, because concurrent snapshots are
 * legitimate. A PID that has been reused by an unrelated process counts as alive
 * (the leftover then stays until that process exits): wrongly keeping is safe,
 * wrongly deleting is not.
 */
export function sweepStaleSnapshotData(request: SweepRequest): SweepResult {
  const removed: string[] = [];
  const remove = (target: string): void => {
    removeQuietly(target);
    removed.push(target);
  };

  for (const scratch of request.scratchDirs ?? []) {
    const parent = path.resolve(scratch);
    for (const entry of readDirQuietly(parent)) {
      const pid = spoolOwner(entry.name);
      if (entry.isDirectory() && pid !== undefined && !processIsAlive(pid)) remove(path.join(parent, entry.name));
    }
  }

  for (const snapshots of request.snapshotDirs ?? []) {
    const parent = path.resolve(snapshots);
    for (const entry of readDirQuietly(parent)) {
      if (!entry.isDirectory() || !SNAPSHOT_DIR_NAME_RE.test(entry.name)) continue;
      const dir = path.join(parent, entry.name);
      const children = readDirQuietly(dir);
      const spools = children.filter((c) => c.isDirectory() && spoolOwner(c.name) !== undefined);
      if (spools.some((c) => processIsAlive(spoolOwner(c.name) ?? 0))) continue; // being written right now
      const plain = children.filter((c) => c.isFile() && LEGACY_PLAINTEXT_RE.test(c.name));
      const hasManifest = children.some((c) => c.name === SNAPSHOT_MANIFEST_FILE);
      if (!hasManifest && (spools.length > 0 || plain.length > 0)) {
        remove(dir);
        continue;
      }
      for (const stale of [...spools, ...plain]) remove(path.join(dir, stale.name));
    }
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// restoreSnapshot
// ---------------------------------------------------------------------------

export interface RestoreSnapshotRequest {
  runtime: ContainerRuntime;
  snapshotDir: string;
  /** TARGET agent: its volumes (av-<agent>-<key>) receive the data. May differ from the snapshot's agent. */
  agent: string;
  passphrase?: string;
  helperImage?: string;
  /** Restore into volumes that already hold data (files are merged/overwritten). Default false. */
  force?: boolean;
  /** Parent for the private spool directory. Default os.tmpdir(). */
  tempDir?: string;
  /**
   * Aborting stops the helper, undoes the volumes exactly as after any failed
   * restore, deletes the decrypted spool and rejects with SnapshotInterruptedError
   * (whose message says what state each volume is in).
   */
  signal?: AbortSignal;
}

export interface RestoreSnapshotResult {
  volumes: Array<{ key: string; volume: string; entries: number; bytes: number }>;
  /** Total tar entries restored. */
  entries: number;
  warnings: string[];
}

async function volumeIsEmpty(runtime: ContainerRuntime, agent: string, volume: string, image: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runHelper(runtime, helperSpec('list', agent, volume, image), {}, signal);
  if (helperFailed(result)) {
    // Fail closed: if we cannot look, we do not write.
    throw new ContainerError(
      'COMMAND_FAILED',
      `Could not inspect volume ${volume} (exit code ${result.exitCode}); refusing to restore into it. ${tail(result.stderr)}`.trim(),
      { volume, exitCode: result.exitCode }
    );
  }
  return result.stdout.trim().length === 0;
}

/** Writing under a running agent corrupts its data whether or not the volume was empty, so `force` does not lift this. */
async function assertAgentStopped(runtime: ContainerRuntime, agent: string): Promise<void> {
  const running = (await runtime.list({ agent })).filter((c) => c.state === 'running');
  if (running.length === 0) return;
  throw new ContainerError(
    'POLICY_VIOLATION',
    `Agent ${agent} is running (${running.map((c) => c.name).join(', ')}): restoring into the volumes of a running agent would corrupt its data, with or without force. Stop it first with "agentvault stop ${agent}", then restore.`,
    { reason: 'agent_running', agent }
  );
}

/** A volume the restore helper started writing to. */
interface TouchedVolume {
  key: string;
  name: string;
  /** False when it held data before (force): that data is never deleted. */
  wasEmpty: boolean;
}

type VolumeState = 'removed' | 'emptied' | 'partial' | 'mixed';

interface VolumeOutcome {
  key: string;
  volume: string;
  state: VolumeState;
  /** One sentence for the user: what state the volume is in and, if it is not clean, what to run. */
  message: string;
}

const EMPTY_TIMEOUT_MS = 10 * 60 * 1000;

async function emptyVolume(runtime: ContainerRuntime, agent: string, volume: string, image: string): Promise<void> {
  const result = await runtime.runForeground(helperSpec('empty', agent, volume, image), { timeoutMs: EMPTY_TIMEOUT_MS });
  if (helperFailed(result)) {
    throw new ContainerError('COMMAND_FAILED', `the emptying helper failed (exit code ${result.exitCode}). ${tail(result.stderr)}`.trim());
  }
  // Believe the volume, not the exit code.
  if (!(await volumeIsEmpty(runtime, agent, volume, image))) {
    throw new ContainerError('COMMAND_FAILED', 'files remained after the emptying helper');
  }
}

function reasonOf(err: unknown): string {
  return tail(err instanceof Error ? err.message : 'unknown error', 200);
}

/**
 * Take a failed restore back. A volume that was empty is removed; Docker
 * refuses that while any container, even a stopped one, references the volume,
 * which is the normal state of an agent that has run before, and then it is
 * emptied with the restore helper instead. Never throws: it reports, per
 * volume, what state it ended up in.
 */
async function undoFailedRestore(
  runtime: ContainerRuntime,
  agent: string,
  touched: readonly TouchedVolume[],
  helperImage: string
): Promise<VolumeOutcome[]> {
  const outcomes: VolumeOutcome[] = [];
  for (const { key, name, wasEmpty } of touched) {
    const quoted = JSON.stringify(name);
    if (!wasEmpty) {
      outcomes.push({
        key,
        volume: name,
        state: 'mixed',
        message: `Volume ${quoted} held data before and was left alone: it may now mix the old files with a partial restore. Run the restore again with --force once the cause is fixed.`,
      });
      continue;
    }
    let removeFailure: string;
    try {
      await runtime.removeVolume(name);
      outcomes.push({ key, volume: name, state: 'removed', message: `Volume ${quoted} was removed again: no partial data remains.` });
      continue;
    } catch (err) {
      removeFailure = reasonOf(err);
    }
    try {
      await emptyVolume(runtime, agent, name, helperImage);
      outcomes.push({
        key,
        volume: name,
        state: 'emptied',
        message: `Volume ${quoted} could not be removed (${removeFailure}) and was emptied instead: no partial data remains.`,
      });
    } catch (err) {
      outcomes.push({
        key,
        volume: name,
        state: 'partial',
        message:
          `Volume ${quoted} STILL CONTAINS PARTIAL DATA: it could not be removed (${removeFailure}) and could not be emptied (${reasonOf(err)}). ` +
          `Do not start the agent on it. Empty it with: docker run --rm --network none -v ${name}:${MOUNT_POINT} ${helperImage} find ${MOUNT_POINT} -mindepth 1 -delete ` +
          `(or delete it with: agentvault rm ${agent} --volumes).`,
      });
    }
  }
  return outcomes;
}

/** The original failure, then what became of each volume. */
function withCleanupReport(err: unknown, outcomes: readonly VolumeOutcome[]): ContainerError {
  const report = outcomes.map((o) => o.message).join(' ');
  const states = outcomes.map(({ key, volume, state }) => ({ key, volume, state }));
  if (err instanceof ContainerError) {
    return new ContainerError(err.code, `${err.message} ${report}`, { ...err.details, volumeStates: states });
  }
  return new ContainerError('COMMAND_FAILED', `${err instanceof Error ? err.message : 'The restore failed.'} ${report}`, { volumeStates: states });
}

export async function restoreSnapshot(request: RestoreSnapshotRequest): Promise<RestoreSnapshotResult> {
  const { runtime, signal } = request;
  const agent = assertAgentName(request.agent);
  const helperImage = assertImageRef(request.helperImage ?? DEFAULT_HELPER_IMAGE);
  const force = request.force === true;
  if (request.passphrase !== undefined) assertPassphrase(request.passphrase);
  const snapshotDir = path.resolve(request.snapshotDir);
  const names = resourceNames(agent);
  const warnings: string[] = [];

  throwIfInterrupted(signal);
  await requireHelperImage(runtime, helperImage);
  // Fail before decrypting gigabytes, then again right before the first write (staging takes a while).
  await assertAgentStopped(runtime, agent);

  const spoolDir = makeSpool(request.tempDir);
  /** Volumes the restore helper has started on. A failure takes them back. */
  const touched: TouchedVolume[] = [];
  try {
    // 1-5. Everything about every volume is verified before any volume is touched.
    const { staged } = await stageSnapshot({
      snapshotDir,
      passphrase: request.passphrase,
      spoolDir,
      copyPlain: true,
      allowCiphertextOnly: false,
      signal,
    });
    if (request.passphrase !== undefined && staged.every((s) => !s.volume.encrypted)) {
      warnings.push('The snapshot is not encrypted; the passphrase was not used.');
    }
    await assertAgentStopped(runtime, agent);

    // 6a. Existing managed volumes: look before creating anything.
    // Only a volume that has exactly the name we would write to counts as existing: a labelled
    // volume with another name must not make us probe (and thereby auto-create) the real name.
    const existing = new Set(
      (await runtime.listVolumes({ agent })).filter((v) => v.agent === agent && v.name === names.volume(v.key)).map((v) => v.key)
    );
    const emptyBefore = new Set<string>();
    const nonEmpty: string[] = [];
    for (const { volume } of staged) {
      if (!existing.has(volume.key)) continue;
      if (await volumeIsEmpty(runtime, agent, names.volume(volume.key), helperImage, signal)) emptyBefore.add(volume.key);
      else nonEmpty.push(volume.key);
    }
    if (nonEmpty.length > 0 && !force) {
      throw new ContainerError(
        'POLICY_VIOLATION',
        `Refusing to restore into non-empty volume(s) ${nonEmpty.map((k) => JSON.stringify(names.volume(k))).join(', ')}: restoring on top of existing data would mix old and new files. Empty them first, or pass force to restore anyway.`,
        { volumes: nonEmpty }
      );
    }

    // 7. Create the missing volumes (labelled so snapshot/list/rm find them). A name that existed
    // unmanaged is only discovered now, so these are checked for emptiness too, before any write.
    for (const { volume } of staged) {
      if (existing.has(volume.key)) continue;
      throwIfInterrupted(signal);
      const volumeName = names.volume(volume.key);
      await runtime.ensureVolume(volumeName, { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: volume.key });
      if (await volumeIsEmpty(runtime, agent, volumeName, helperImage, signal)) {
        emptyBefore.add(volume.key);
      } else if (!force) {
        throw new ContainerError(
          'POLICY_VIOLATION',
          `Refusing to restore into ${JSON.stringify(volumeName)}: a volume with that name already holds data. Empty it first, or pass force to restore anyway.`,
          { volumes: [volume.key] }
        );
      }
    }

    // 8. Restore. Past this point a failure takes back what was written (undoFailedRestore).
    const restored: RestoreSnapshotResult['volumes'] = [];
    for (const { volume, plainPath, summary } of staged) {
      const volumeName = names.volume(volume.key);
      touched.push({ key: volume.key, name: volumeName, wasEmpty: emptyBefore.has(volume.key) });
      const result = await runHelper(runtime, helperSpec('restore', agent, volumeName, helperImage), { stdinFile: plainPath }, signal);
      if (helperFailed(result)) {
        throw new ContainerError(
          'COMMAND_FAILED',
          `Restore helper for volume ${JSON.stringify(volume.key)} failed (exit code ${result.exitCode}); the volume may be partially written. ${tail(result.stderr)}`.trim(),
          { volume: volume.key, exitCode: result.exitCode }
        );
      }
      restored.push({ key: volume.key, volume: volumeName, entries: summary.entries, bytes: summary.totalBytes });
    }
    return { volumes: restored, entries: restored.reduce((sum, v) => sum + v.entries, 0), warnings };
  } catch (err) {
    // Never leave a half-restored volume that looks like real data, and say what became of each one.
    // Only volumes that were empty when we started are removed or emptied; one that held data (force) is never deleted.
    const outcomes = await undoFailedRestore(runtime, agent, touched, helperImage);
    if (signal?.aborted === true) {
      throw interruptedAfterCleanup(
        spoolDir,
        outcomes.length === 0 ? 'Nothing was written to any volume.' : `${outcomes.map((o) => o.message).join(' ')} The decrypted scratch copy was deleted.`
      );
    }
    throw outcomes.length === 0 ? err : withCleanupReport(err, outcomes);
  } finally {
    removeQuietly(spoolDir);
  }
}
