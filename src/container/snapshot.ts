/**
 * Directory-format snapshots of an agent's Docker volumes.
 *
 *   <outputDir>/<agent>-<UTC timestamp>/manifest.json
 *                                       <volumeKey>.tar        (unencrypted)
 *                                       <volumeKey>.tar.enc    (AVENC1, see crypto.ts)
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
 *    fails, volumes that were empty before are removed again so no half-restored
 *    state survives. An unencrypted snapshot is copied into the spool while
 *    hashing so the bytes validated are the bytes restored (no
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
export const SNAPSHOT_VERSION = 1 as const;
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
export const DEFAULT_HELPER_IMAGE = 'busybox:1.37';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VOLUMES = 64;
const MAX_DIR_SUFFIX = 99;
const MOUNT_POINT = '/v';
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_STDERR_IN_MESSAGE = 500;

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

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: HASH_CHUNK_BYTES })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Copy while hashing in a single read, so the digest describes the copied bytes. */
async function copyAndHash(src: string, dest: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  async function* tee(): AsyncGenerator<Buffer> {
    for await (const chunk of fs.createReadStream(src, { highWaterMark: HASH_CHUNK_BYTES })) {
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

type HelperKind = 'snapshot' | 'restore' | 'list';

interface HelperRecipe {
  command: string[];
  capAdd: string[];
  readOnlyVolume: boolean;
}

const RECIPES: Record<HelperKind, HelperRecipe> = {
  snapshot: { command: ['tar', '-cf', '-', '-C', MOUNT_POINT, '.'], capAdd: ['DAC_READ_SEARCH'], readOnlyVolume: true },
  restore: { command: ['tar', '-xf', '-', '-C', MOUNT_POINT], capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'], readOnlyVolume: false },
  list: { command: ['ls', '-A', MOUNT_POINT], capAdd: ['DAC_READ_SEARCH'], readOnlyVolume: true },
};

function helperSpec(kind: HelperKind, agent: string, volume: string, image: string): ContainerSpec {
  const recipe = RECIPES[kind];
  return {
    name: `av-${agent}-${kind === 'snapshot' ? 'snap' : kind === 'restore' ? 'rst' : 'ls'}-${randomBytes(4).toString('hex')}`,
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
  const warnings: string[] = [];

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

  const dir = makeSnapshotDir(outputDir, agent, now);
  try {
    const volumes: SnapshotVolume[] = [];
    for (const key of selected) {
      const volumeName = byKey.get(key);
      if (volumeName === undefined) continue;
      volumes.push(await snapshotVolume({ runtime, agent, key, volumeName, dir, helperImage, passphrase, containerPath: containerPaths.get(key) }));
    }

    const manifest = snapshotManifestSchema.parse({
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      createdAt: now.toISOString(),
      agent,
      image: request.image !== undefined ? { ...request.image } : null,
      volumes,
      encryption:
        passphrase !== undefined ? { alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: KDF_ITERATIONS_DEFAULT } : null,
    });
    // Last, and atomic: its presence means the snapshot is complete.
    atomicWriteFileSync(path.join(dir, SNAPSHOT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { dir, manifest, warnings };
  } catch (err) {
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
  passphrase: string | undefined;
  containerPath: string | undefined;
}

async function snapshotVolume(job: SnapshotVolumeJob): Promise<SnapshotVolume> {
  const { runtime, agent, key, volumeName, dir, helperImage, passphrase } = job;
  const encrypted = passphrase !== undefined;
  const finalName = snapshotFileName(key, encrypted);
  // The plaintext tar of an encrypted snapshot lives only in the private snapshot dir, hidden, and is deleted below.
  const tarPath = path.join(dir, encrypted ? sanitizePathPart(`.${key}.tar.plain`) : finalName);

  const spec = helperSpec('snapshot', agent, volumeName, helperImage);
  const result = await runtime.runForeground(spec, { stdoutFile: tarPath });
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
  if (!encrypted) {
    return {
      ...base,
      file: finalName,
      encrypted: false,
      plaintextSha256: await sha256File(tarPath),
      plaintextBytes: fs.statSync(tarPath).size,
    };
  }
  const encrypt = await encryptFile(tarPath, path.join(dir, finalName), passphrase);
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
  const manifest = readManifestFile(options.snapshotDir);
  const staged: StagedVolume[] = [];
  const ciphertextOnly: string[] = [];

  for (const volume of manifest.volumes) {
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
      if ((await sha256File(source)) !== volume.ciphertextSha256) {
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
      const decrypted = await decryptFile(source, plainPath, options.passphrase);
      if (decrypted.plaintextSha256 !== volume.plaintextSha256 || decrypted.plaintextBytes !== volume.plaintextBytes) {
        throw new ContainerError('INTEGRITY', `Decrypted ${label} does not match the sha256 in the manifest`);
      }
    } else if (options.copyPlain) {
      plainPath = path.join(options.spoolDir, sanitizePathPart(`${volume.key}.tar`));
      const copied = await copyAndHash(source, plainPath);
      if (copied.sha256 !== volume.plaintextSha256 || copied.bytes !== volume.plaintextBytes) {
        throw new ContainerError('INTEGRITY', `${label} does not match its sha256 in the manifest`);
      }
    } else {
      plainPath = source;
      if ((await sha256File(source)) !== volume.plaintextSha256) {
        throw new ContainerError('INTEGRITY', `${label} does not match its sha256 in the manifest`);
      }
    }

    const summary = await validateTarArchive(plainPath);
    if (summary.entries !== volume.entries) {
      throw new ContainerError('INTEGRITY', `${label} holds ${summary.entries} entries but the manifest says ${volume.entries}`);
    }
    staged.push({ volume, plainPath, summary });
  }
  return { manifest, staged, ciphertextOnly };
}

function makeSpool(parent: string | undefined): string {
  // mkdtemp creates the directory 0700.
  return fs.mkdtempSync(path.join(parent ?? os.tmpdir(), 'avt-snapshot-'));
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
  const snapshotDir = path.resolve(request.snapshotDir);
  const spoolDir = makeSpool(request.tempDir);
  try {
    const { manifest, staged, ciphertextOnly } = await stageSnapshot({
      snapshotDir,
      passphrase: request.passphrase,
      spoolDir,
      copyPlain: false,
      allowCiphertextOnly: true,
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
  } finally {
    removeQuietly(spoolDir);
  }
}

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

export interface SnapshotSummary {
  dir: string;
  name: string;
  createdAt: string;
  agent: string;
  encrypted: boolean;
  volumes: number;
  plaintextBytes: number;
}

/**
 * Snapshots directly under `parentDir`, newest first. A directory without a
 * valid manifest.json (never completed, or damaged) is not listed; use
 * verifySnapshot on it to find out why.
 */
export function listSnapshots(parentDir: string): SnapshotSummary[] {
  const parent = path.resolve(parentDir);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(parent, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SnapshotSummary[] = [];
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue; // symlinked directories are deliberately skipped
    const dir = path.join(parent, dirent.name);
    let manifest: SnapshotManifest;
    try {
      manifest = readManifestFile(dir);
    } catch {
      continue;
    }
    out.push({
      dir,
      name: dirent.name,
      createdAt: manifest.createdAt,
      agent: manifest.agent,
      encrypted: manifest.encryption !== null,
      volumes: manifest.volumes.length,
      plaintextBytes: manifest.volumes.reduce((sum, v) => sum + v.plaintextBytes, 0),
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.name < b.name ? 1 : -1));
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
}

export interface RestoreSnapshotResult {
  volumes: Array<{ key: string; volume: string; entries: number; bytes: number }>;
  /** Total tar entries restored. */
  entries: number;
  warnings: string[];
}

async function volumeIsEmpty(runtime: ContainerRuntime, agent: string, volume: string, image: string): Promise<boolean> {
  const result = await runtime.runForeground(helperSpec('list', agent, volume, image));
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

export async function restoreSnapshot(request: RestoreSnapshotRequest): Promise<RestoreSnapshotResult> {
  const { runtime } = request;
  const agent = assertAgentName(request.agent);
  const helperImage = assertImageRef(request.helperImage ?? DEFAULT_HELPER_IMAGE);
  const force = request.force === true;
  if (request.passphrase !== undefined) assertPassphrase(request.passphrase);
  const snapshotDir = path.resolve(request.snapshotDir);
  const names = resourceNames(agent);
  const warnings: string[] = [];

  await requireHelperImage(runtime, helperImage);

  const spoolDir = makeSpool(request.tempDir);
  /** Volumes verified empty before we wrote, and written (or about to be). Removed again if the restore fails. */
  const written: string[] = [];
  try {
    // 1-5. Everything about every volume is verified before any volume is touched.
    const { staged } = await stageSnapshot({
      snapshotDir,
      passphrase: request.passphrase,
      spoolDir,
      copyPlain: true,
      allowCiphertextOnly: false,
    });
    if (request.passphrase !== undefined && staged.every((s) => !s.volume.encrypted)) {
      warnings.push('The snapshot is not encrypted; the passphrase was not used.');
    }

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
      if (await volumeIsEmpty(runtime, agent, names.volume(volume.key), helperImage)) emptyBefore.add(volume.key);
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
      const volumeName = names.volume(volume.key);
      await runtime.ensureVolume(volumeName, { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: volume.key });
      if (await volumeIsEmpty(runtime, agent, volumeName, helperImage)) {
        emptyBefore.add(volume.key);
      } else if (!force) {
        throw new ContainerError(
          'POLICY_VIOLATION',
          `Refusing to restore into ${JSON.stringify(volumeName)}: a volume with that name already holds data. Empty it first, or pass force to restore anyway.`,
          { volumes: [volume.key] }
        );
      }
    }

    // 8. Restore. Past this point a failure removes the volumes we found empty.
    const restored: RestoreSnapshotResult['volumes'] = [];
    for (const { volume, plainPath, summary } of staged) {
      const volumeName = names.volume(volume.key);
      if (emptyBefore.has(volume.key)) written.push(volumeName);
      const result = await runtime.runForeground(helperSpec('restore', agent, volumeName, helperImage), { stdinFile: plainPath });
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
    // Never leave a half-restored volume that looks like real data. Only volumes that were empty
    // when we started are removed; anything that held data before (force) is never deleted.
    for (const volumeName of written) {
      await runtime.removeVolume(volumeName).catch(() => undefined);
    }
    throw err;
  } finally {
    removeQuietly(spoolDir);
  }
}
