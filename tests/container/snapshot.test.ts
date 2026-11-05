/**
 * Snapshot create / verify / list / restore against a FAKE runtime. The fake
 * records every helper spec and every volume operation, which is what lets
 * these tests prove the ORDER guarantees (nothing is written to any volume
 * until everything is validated) and the exit-code rule. The real-daemon
 * behaviour is covered by snapshot.integration.test.ts.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptFile } from '../../src/container/crypto.js';
import { buildRunArgs } from '../../src/container/docker.js';
import {
  SNAPSHOT_FORMAT,
  createSnapshot,
  listSnapshots,
  readSnapshotManifest,
  restoreSnapshot,
  snapshotFileName,
  snapshotManifestSchema,
  verifySnapshot,
} from '../../src/container/snapshot.js';
import type { SnapshotManifest } from '../../src/container/snapshot.js';
import { ContainerError, LABEL_AGENT, LABEL_VOLUME_KEY } from '../../src/container/types.js';
import type {
  CommandResult,
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ImageInfo,
} from '../../src/container/types.js';

const PASS = 'a perfectly good passphrase';
const CANARY = 'CANARY-VOLUME-CONTENT-8f14e45fceea167a5a36dedd4bea2543';

let work: string;
let counter = 0;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-snapshot-test-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function fresh(label: string): string {
  counter += 1;
  const dir = path.join(work, `${counter}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Tiny tar builder (valid ustar), for what the fake "helper container" emits
// ---------------------------------------------------------------------------

interface TarEntry {
  name: string;
  data?: string;
  type?: string;
  link?: string;
  mode?: number;
}

function tarHeader(e: TarEntry, size: number): Buffer {
  const b = Buffer.alloc(512);
  const put = (off: number, text: string, max: number): void => {
    Buffer.from(text, 'latin1').copy(b, off, 0, max);
  };
  const oct = (n: number, w: number): string => `${n.toString(8).padStart(w - 1, '0')}\0`;
  put(0, e.name, 100);
  put(100, oct(e.mode ?? 0o644, 8), 8);
  put(108, oct(10001, 8), 8);
  put(116, oct(10001, 8), 8);
  put(124, oct(size, 12), 12);
  put(136, oct(0, 12), 12);
  b.fill(0x20, 148, 156);
  b[156] = (e.type ?? '0').charCodeAt(0);
  put(157, e.link ?? '', 100);
  put(257, 'ustar  \0', 8);
  let sum = 0;
  for (const byte of b) sum += byte;
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
  return b;
}

function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'latin1');
    const size = e.type === '5' || e.type === '2' || e.type === '1' ? 0 : data.length;
    parts.push(tarHeader(e, size));
    if (size > 0) parts.push(data, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function goodTar(label = 'data'): Buffer {
  return makeTar([
    { name: './', type: '5', mode: 0o755 },
    { name: './secret.txt', data: `${CANARY}:${label}`, mode: 0o640 },
    { name: './link', type: '2', link: 'secret.txt', mode: 0o777 },
    { name: './dir/', type: '5', mode: 0o700 },
    { name: './dir/inner', data: 'inner' },
  ]);
}

const GOOD_ENTRIES = 5;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

interface HelperCall {
  kind: 'snapshot' | 'restore' | 'list';
  spec: ContainerSpec;
  io: { stdinFile?: string; stdoutFile?: string } | undefined;
  /** For restore: the exact bytes the helper would have read from stdin. */
  stdinBytes?: Buffer;
}

interface FakeOptions {
  agent?: string;
  /** key -> tar bytes the snapshot helper writes to stdout. */
  tars?: Record<string, Buffer>;
  images?: string[];
  snapshotExit?: number;
  snapshotFlags?: Partial<CommandResult>;
  restoreExit?: number;
  /** Docker volume names that already exist (and are managed). */
  existing?: string[];
  /** Existing/created volume names that are NOT empty. */
  nonEmpty?: string[];
  listExit?: number;
  running?: boolean;
  /** Called at the start of every restore helper run. */
  onRestore?: (call: HelperCall) => void;
  /** Called at the start of every snapshot helper run. */
  onSnapshot?: (call: HelperCall) => void;
  /** Fail the snapshot helper of this key. */
  failKey?: string;
}

class FakeRuntime implements ContainerRuntime {
  readonly runner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false });
  readonly calls: HelperCall[] = [];
  readonly ensured: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  readonly removed: string[] = [];
  readonly events: string[] = [];
  existing: Set<string>;

  constructor(readonly options: FakeOptions = {}) {
    this.existing = new Set(options.existing ?? []);
  }

  ensureAvailable(): Promise<{ serverVersion: string }> {
    return Promise.resolve({ serverVersion: 'fake' });
  }

  removeImage(ref: string): Promise<void> {
    this.events.push(`removeImage ${ref}`);
    return Promise.resolve();
  }

  inspectImage(ref: string): Promise<ImageInfo | null> {
    this.events.push(`inspectImage ${ref}`);
    const present = (this.options.images ?? ['busybox:1.37']).includes(ref);
    return Promise.resolve(present ? { id: 'sha256:fake', repoTags: [ref], repoDigests: [], labels: {}, user: '', sizeBytes: 1 } : null);
  }

  listVolumes(filter?: { agent?: string }): Promise<Array<{ name: string; key: string; agent: string }>> {
    this.events.push('listVolumes');
    const agent = filter?.agent ?? this.options.agent ?? 'src-agent';
    const out: Array<{ name: string; key: string; agent: string }> = [];
    if (this.options.tars !== undefined && this.options.existing === undefined) {
      for (const key of Object.keys(this.options.tars)) out.push({ name: `av-${agent}-${key}`, key, agent });
    }
    for (const name of this.existing) {
      const prefix = `av-${agent}-`;
      if (name.startsWith(prefix)) out.push({ name, key: name.slice(prefix.length), agent });
    }
    return Promise.resolve(out);
  }

  inspectVolume(name: string): Promise<{ name: string; labels: Record<string, string> } | null> {
    // Snapshot code never asks; present only to satisfy the interface.
    return Promise.resolve(this.existing.has(name) ? { name, labels: {} } : null);
  }

  ensureVolume(name: string, labels?: Record<string, string>): Promise<void> {
    this.events.push(`ensureVolume ${name}`);
    this.ensured.push({ name, labels });
    this.existing.add(name);
    return Promise.resolve();
  }

  removeVolume(name: string): Promise<void> {
    this.events.push(`removeVolume ${name}`);
    this.removed.push(name);
    this.existing.delete(name);
    return Promise.resolve();
  }

  list(): Promise<ContainerInfo[]> {
    if (this.options.running === true) {
      return Promise.resolve([
        { id: 'x', name: 'av-x', image: 'img', state: 'running', status: 'Up', role: 'agent', agent: 'x', createdAt: '', labels: {} },
      ]);
    }
    return Promise.resolve([]);
  }

  runForeground(spec: ContainerSpec, io?: { stdinFile?: string; stdoutFile?: string }): Promise<CommandResult> {
    const verb = spec.command?.[0] === 'ls' ? 'list' : spec.command?.[1] === '-cf' ? 'snapshot' : 'restore';
    const call: HelperCall = { kind: verb, spec, io };
    this.calls.push(call);
    this.events.push(`${verb} ${spec.mounts[0]?.source ?? ''}`);
    const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, spawnFailed: false });

    if (verb === 'snapshot') {
      this.options.onSnapshot?.(call);
      const key = (spec.mounts[0]?.source ?? '').replace(/^av-.*?-(?=[a-z0-9_-]+$)/, '');
      const source = spec.mounts[0]?.source ?? '';
      const tarKey = Object.keys(this.options.tars ?? {}).find((k) => source.endsWith(`-${k}`)) ?? key;
      const tar = this.options.tars?.[tarKey] ?? goodTar();
      if (io?.stdoutFile !== undefined) fs.writeFileSync(io.stdoutFile, tar, { mode: 0o600 });
      if (this.options.failKey !== undefined && source.endsWith(`-${this.options.failKey}`)) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: "tar: can't open './x': Permission denied", timedOut: false, spawnFailed: false });
      }
      return Promise.resolve({ ...ok(), exitCode: this.options.snapshotExit ?? 0, stderr: this.options.snapshotExit ? 'tar: trouble' : '', ...this.options.snapshotFlags });
    }
    if (verb === 'list') {
      const name = spec.mounts[0]?.source ?? '';
      if (this.options.listExit !== undefined) return Promise.resolve({ exitCode: this.options.listExit, stdout: '', stderr: 'ls: nope', timedOut: false, spawnFailed: false });
      return Promise.resolve(ok((this.options.nonEmpty ?? []).includes(name) ? 'some-file\n' : ''));
    }
    if (io?.stdinFile !== undefined) call.stdinBytes = fs.readFileSync(io.stdinFile);
    this.options.onRestore?.(call);
    return Promise.resolve({ exitCode: this.options.restoreExit ?? 0, stdout: '', stderr: this.options.restoreExit ? 'tar: restore trouble' : '', timedOut: false, spawnFailed: false });
  }

  private nope(): never {
    throw new Error('not implemented in FakeRuntime');
  }
  buildImage(): never {
    return this.nope();
  }
  ensureNetwork(): never {
    return this.nope();
  }
  removeNetwork(): never {
    return this.nope();
  }
  connectNetwork(): never {
    return this.nope();
  }
  start(): never {
    return this.nope();
  }
  logs(): never {
    return this.nope();
  }
  stop(): never {
    return this.nope();
  }
  remove(): never {
    return this.nope();
  }
  inspect(): never {
    return this.nope();
  }
  stats(): never {
    return this.nope();
  }
  exec(): never {
    return this.nope();
  }

  helpers(kind: HelperCall['kind']): HelperCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }
}

const FIXED = (): Date => new Date('2026-11-05T05:15:00.000Z');

/** Build a real snapshot through createSnapshot with a fake runtime. */
async function makeSnapshot(opts: { passphrase?: string; keys?: Record<string, Buffer>; agent?: string } = {}): Promise<{ dir: string; manifest: SnapshotManifest }> {
  const agent = opts.agent ?? 'src-agent';
  const tars = opts.keys ?? { data: goodTar('data') };
  const runtime = new FakeRuntime({ agent, tars });
  const result = await createSnapshot({
    runtime,
    agent,
    outputDir: fresh('out'),
    ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
    now: FIXED,
  });
  return { dir: result.dir, manifest: result.manifest };
}

/** Write a snapshot directory by hand, bypassing every create-time check (an attacker-built snapshot). */
async function forgeSnapshot(opts: {
  tars: Record<string, Buffer>;
  passphrase?: string;
  mutate?: (m: Record<string, unknown>) => void;
}): Promise<string> {
  const dir = fresh('forged');
  const volumes: Array<Record<string, unknown>> = [];
  for (const [key, tar] of Object.entries(opts.tars)) {
    const plain = path.join(dir, `.${key}.plain`);
    fs.writeFileSync(plain, tar);
    if (opts.passphrase === undefined) {
      fs.renameSync(plain, path.join(dir, `${key}.tar`));
      volumes.push({ key, file: `${key}.tar`, encrypted: false, plaintextSha256: sha256(tar), plaintextBytes: tar.length, entries: GOOD_ENTRIES });
    } else {
      const enc = await encryptFile(plain, path.join(dir, `${key}.tar.enc`), opts.passphrase);
      fs.rmSync(plain);
      volumes.push({
        key,
        file: `${key}.tar.enc`,
        encrypted: true,
        plaintextSha256: enc.plaintextSha256,
        plaintextBytes: enc.plaintextBytes,
        ciphertextSha256: enc.ciphertextSha256,
        ciphertextBytes: enc.ciphertextBytes,
        entries: GOOD_ENTRIES,
      });
    }
  }
  const manifest: Record<string, unknown> = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    createdAt: FIXED().toISOString(),
    agent: 'forger',
    image: null,
    volumes,
    encryption: opts.passphrase === undefined ? null : { alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: 210000 },
  };
  opts.mutate?.(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

async function expectError(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<ContainerError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'expected a rejection').toBeInstanceOf(ContainerError);
  const ce = err as ContainerError;
  expect(ce.code).toBe(code);
  if (pattern !== undefined) expect(ce.message).toMatch(pattern);
  return ce;
}

function leaks(text: string): boolean {
  return text.includes(PASS) || text.includes(CANARY);
}

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

describe('createSnapshot', () => {
  it('writes a complete unencrypted snapshot and warns about it', async () => {
    const outputDir = fresh('out');
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } });
    const result = await createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED });

    expect(result.dir).toBe(path.join(outputDir, 'src-agent-20261105T051500Z'));
    expect(fs.readdirSync(result.dir).sort()).toEqual(['data.tar', 'manifest.json']);
    expect(result.warnings.join(' ')).toMatch(/NOT encrypted/);

    const m = result.manifest;
    expect(m).toMatchObject({ format: 'agentvault-container-snapshot', version: 1, agent: 'src-agent', image: null, encryption: null });
    expect(m.createdAt).toBe('2026-11-05T05:15:00.000Z');
    const tar = fs.readFileSync(path.join(result.dir, 'data.tar'));
    expect(m.volumes).toEqual([
      { key: 'data', file: 'data.tar', encrypted: false, plaintextSha256: sha256(tar), plaintextBytes: tar.length, entries: GOOD_ENTRIES },
    ]);
    // the manifest on disk is the same object and validates against the exported schema
    expect(snapshotManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8')))).toEqual(m);
    expect(readSnapshotManifest(result.dir)).toEqual(m);
  });

  it('creates private files: directory 0700, tar and manifest 0600', async () => {
    const { dir } = await makeSnapshot();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'data.tar')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777).toBe(0o600);
  });

  it('encrypts when given a passphrase: only .tar.enc and manifest remain, no plaintext anywhere', async () => {
    const outputDir = fresh('out');
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } });
    const { dir, manifest, warnings } = await createSnapshot({ runtime, agent: 'src-agent', outputDir, passphrase: PASS, now: FIXED });

    expect(warnings.join(' ')).not.toMatch(/NOT encrypted/);
    expect(fs.readdirSync(dir).sort()).toEqual(['data.tar.enc', 'manifest.json']);
    const enc = fs.readFileSync(path.join(dir, 'data.tar.enc'));
    expect(enc.includes(Buffer.from(CANARY))).toBe(false);
    expect(manifest.encryption).toEqual({ alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: 210000 });
    expect(manifest.volumes[0]).toMatchObject({
      file: 'data.tar.enc',
      encrypted: true,
      ciphertextSha256: sha256(enc),
      ciphertextBytes: enc.length,
      plaintextSha256: sha256(goodTar()),
    });
    expect(leaks(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toBe(false);
    expect(fs.statSync(path.join(dir, 'data.tar.enc')).mode & 0o777).toBe(0o600);
  });

  it('runs the VERIFIED helper recipe, and the spec survives the real argv builder', async () => {
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } });
    await createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), now: FIXED });
    const call = runtime.helpers('snapshot')[0];
    expect(call).toBeDefined();
    const spec = call?.spec as ContainerSpec;
    expect(spec).toMatchObject({
      image: 'busybox:1.37',
      role: 'helper',
      user: '0:0',
      allowRoot: true,
      network: 'none',
      capAdd: ['DAC_READ_SEARCH'],
      readOnlyRootfs: true,
      autoRemove: true,
      detach: false,
      tmpfs: [],
      env: {},
      command: ['tar', '-cf', '-', '-C', '/v', '.'],
      mounts: [{ kind: 'volume', source: 'av-src-agent-data', target: '/v', readOnly: true }],
      labels: { 'agentvault.managed': 'true', 'agentvault.role': 'helper', 'agentvault.agent': 'src-agent' },
    });
    expect(spec.limits.pidsLimit).toBeGreaterThan(0);
    expect(call?.io?.stdoutFile).toBeDefined();

    const argv = buildRunArgs(spec);
    expect(argv).toEqual(
      expect.arrayContaining([
        '--cap-drop=ALL',
        '--cap-add=DAC_READ_SEARCH',
        '--security-opt=no-new-privileges',
        '--network=none',
        '--read-only',
        '--user=0:0',
        '--rm',
        '--mount=type=volume,source=av-src-agent-data,target=/v,readonly',
      ])
    );
    expect(argv.slice(-7)).toEqual(['busybox:1.37', 'tar', '-cf', '-', '-C', '/v', '.']);
  });

  it('snapshots every managed volume, or just the requested keys', async () => {
    const tars = { data: goodTar('d'), cache: goodTar('c'), logs: goodTar('l') };
    const all = await createSnapshot({ runtime: new FakeRuntime({ agent: 'src-agent', tars }), agent: 'src-agent', outputDir: fresh('out'), now: FIXED });
    expect(all.manifest.volumes.map((v) => v.key)).toEqual(['cache', 'data', 'logs']);

    const runtime = new FakeRuntime({ agent: 'src-agent', tars });
    const some = await createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), volumeKeys: ['logs', 'data', 'logs'], now: FIXED });
    expect(some.manifest.volumes.map((v) => v.key)).toEqual(['logs', 'data']);
    expect(runtime.helpers('snapshot')).toHaveLength(2);
    expect(fs.readFileSync(path.join(some.dir, 'logs.tar')).includes(Buffer.from(':l'))).toBe(true);
  });

  it('records image info and container paths in the manifest', async () => {
    const result = await createSnapshot({
      runtime: new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } }),
      agent: 'src-agent',
      outputDir: fresh('out'),
      image: { ref: 'my-agent:1.0', id: 'sha256:abc', digest: 'registry/my-agent@sha256:def' },
      containerPaths: { data: '/data' },
      now: FIXED,
    });
    expect(result.manifest.image).toEqual({ ref: 'my-agent:1.0', id: 'sha256:abc', digest: 'registry/my-agent@sha256:def' });
    expect(result.manifest.volumes[0]?.containerPath).toBe('/data');
  });

  it('refuses an agent with zero managed volumes and creates nothing', async () => {
    const outputDir = fresh('out');
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: {} });
    await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED }), 'NOT_FOUND', /nothing to snapshot/);
    expect(fs.readdirSync(outputDir)).toEqual([]);
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects an unknown requested volume key before running anything', async () => {
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } });
    await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), volumeKeys: ['nope'], now: FIXED }), 'NOT_FOUND', /no managed volume/);
    expect(runtime.calls).toHaveLength(0);
  });

  describe('exit code handling (a partial tar still looks valid)', () => {
    it('throws on exit 1 even though the helper wrote a perfectly valid tar, and leaves NOTHING behind', async () => {
      const outputDir = fresh('out');
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, snapshotExit: 1 });
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED }), 'COMMAND_FAILED', /exit code 1/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it('does the same for an encrypted snapshot', async () => {
      const outputDir = fresh('out');
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, snapshotExit: 1 });
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, passphrase: PASS, now: FIXED }), 'COMMAND_FAILED');
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it.each([
      ['exit 2', { exitCode: 2 }],
      ['exit 137 (killed)', { exitCode: 137 }],
      ['timeout', { exitCode: 124, timedOut: true }],
      ['spawn failure', { exitCode: 127, spawnFailed: true }],
      ['exit 0 but flagged timed out', { exitCode: 0, timedOut: true }],
    ])('treats %s as failure', async (_label, flags) => {
      const outputDir = fresh('out');
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, snapshotFlags: flags });
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED }), 'COMMAND_FAILED');
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it('a failure on the second volume removes the first volume too (all or nothing)', async () => {
      const outputDir = fresh('out');
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { alpha: goodTar('a'), beta: goodTar('b') }, failKey: 'beta' });
      const err = await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED }), 'COMMAND_FAILED', /"beta"/);
      expect(err.details).toMatchObject({ volume: 'beta', exitCode: 1 });
      expect(runtime.helpers('snapshot')).toHaveLength(2);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });

    it('includes the helper stderr (file names, not secrets) in the message', async () => {
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, failKey: 'data' });
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), now: FIXED }), 'COMMAND_FAILED', /Permission denied/);
    });

    it('fails when the helper reported success but wrote no archive', async () => {
      const outputDir = fresh('out');
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, onSnapshot: () => undefined });
      // a runtime that "succeeds" without honouring stdoutFile
      const silent: ContainerRuntime = Object.assign(Object.create(runtime) as ContainerRuntime, {
        runForeground: (): Promise<CommandResult> => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false }),
      });
      await expectError(createSnapshot({ runtime: silent, agent: 'src-agent', outputDir, now: FIXED }), 'COMMAND_FAILED', /produced no archive/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    });
  });

  it('writes the manifest LAST: it does not exist while any helper is still running', async () => {
    const outputDir = fresh('out');
    const seen: boolean[] = [];
    const runtime = new FakeRuntime({
      agent: 'src-agent',
      tars: { alpha: goodTar('a'), beta: goodTar('b') },
      onSnapshot: (call) => {
        const dir = path.dirname(call.io?.stdoutFile ?? '');
        seen.push(fs.existsSync(path.join(dir, 'manifest.json')));
      },
    });
    const { dir } = await createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED });
    expect(seen).toEqual([false, false]);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a volume whose archive could not be restored safely, and says why', async () => {
    const outputDir = fresh('out');
    const hostile = makeTar([{ name: './', type: '5' }, { name: './abs', type: '2', link: '/etc/passwd' }]);
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: hostile } });
    const err = await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, now: FIXED }), 'INTEGRITY', /could not be restored safely/);
    expect(err.message).toMatch(/absolute target/);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('adds a second snapshot taken in the same second under a numbered name', async () => {
    const outputDir = fresh('out');
    const make = (): Promise<{ dir: string }> =>
      createSnapshot({ runtime: new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } }), agent: 'src-agent', outputDir, now: FIXED });
    const a = await make();
    const b = await make();
    expect(path.basename(a.dir)).toBe('src-agent-20261105T051500Z');
    expect(path.basename(b.dir)).toBe('src-agent-20261105T051500Z-2');
  });

  it('warns when the agent is running', async () => {
    const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, running: true });
    const result = await createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), passphrase: PASS, now: FIXED });
    expect(result.warnings.join(' ')).toMatch(/is running/);
  });

  describe('helper image', () => {
    it('is never pulled implicitly: a missing image is NOT_FOUND with the exact pull command', async () => {
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, images: [] });
      const err = await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), now: FIXED }), 'NOT_FOUND');
      expect(err.message).toContain('docker pull busybox:1.37');
      expect(runtime.calls).toHaveLength(0);
    });

    it('honours a custom helper image', async () => {
      const runtime = new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() }, images: ['registry.local/tools/busybox:9'] });
      await createSnapshot({ runtime, agent: 'src-agent', outputDir: fresh('out'), helperImage: 'registry.local/tools/busybox:9', now: FIXED });
      expect(runtime.helpers('snapshot')[0]?.spec.image).toBe('registry.local/tools/busybox:9');
    });
  });

  describe('input validation (before any docker call)', () => {
    const base = (): { runtime: FakeRuntime; outputDir: string } => ({ runtime: new FakeRuntime({ agent: 'src-agent', tars: { data: goodTar() } }), outputDir: fresh('out') });

    it.each([['../escape'], ['UPPER'], ['has space'], ['-leading'], ['']])('rejects agent name %j', async (agent) => {
      const { runtime, outputDir } = base();
      await expectError(createSnapshot({ runtime, agent, outputDir }), 'INVALID_INPUT');
      expect(runtime.calls).toHaveLength(0);
      expect(runtime.events).toEqual([]);
    });

    it.each([['../x'], ['a/b'], ['A'], ['']])('rejects volume key %j', async (key) => {
      const { runtime, outputDir } = base();
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, volumeKeys: [key] }), 'INVALID_INPUT');
      expect(runtime.events).toEqual([]);
    });

    it('rejects a short passphrase without echoing it', async () => {
      const { runtime, outputDir } = base();
      const err = await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, passphrase: 'short' }), 'INVALID_INPUT');
      expect(err.message).not.toContain('short');
      expect(runtime.events).toEqual([]);
    });

    it('rejects a bad helper image and a bad container path', async () => {
      const { runtime, outputDir } = base();
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, helperImage: '--privileged' }), 'INVALID_INPUT');
      await expectError(createSnapshot({ runtime, agent: 'src-agent', outputDir, containerPaths: { data: '/a/../b' } }), 'INVALID_INPUT');
      expect(runtime.events).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

describe('manifest schema (strict)', () => {
  let good: Record<string, unknown>;

  beforeAll(async () => {
    const { manifest } = await makeSnapshot({ passphrase: PASS });
    good = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  });

  function mutated(fn: (m: Record<string, unknown>, v: Record<string, unknown>) => void): unknown {
    const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    fn(copy, (copy['volumes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>);
    return copy;
  }

  it('accepts the manifest createSnapshot wrote', () => {
    expect(snapshotManifestSchema.safeParse(good).success).toBe(true);
  });

  it.each([
    ['a file that traverses', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['file'] = '../../x')],
    ['an absolute file', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['file'] = '/etc/passwd')],
    ['a file that is not derived from the key', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['file'] = 'other.tar.enc')],
    ['a key with a slash', (_m: Record<string, unknown>, v: Record<string, unknown>) => ((v['key'] = 'a/b'), (v['file'] = 'a/b.tar.enc'))],
    ['a key with ..', (_m: Record<string, unknown>, v: Record<string, unknown>) => ((v['key'] = '..'), (v['file'] = '...tar.enc'))],
    ['an uppercase key', (_m: Record<string, unknown>, v: Record<string, unknown>) => ((v['key'] = 'Data'), (v['file'] = 'Data.tar.enc'))],
    ['an unknown field on a volume', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['extra'] = 1)],
    ['an unknown top-level field', (m: Record<string, unknown>) => (m['extra'] = 1)],
    ['another version', (m: Record<string, unknown>) => (m['version'] = 2)],
    ['another format', (m: Record<string, unknown>) => (m['format'] = 'something-else')],
    ['a bad agent', (m: Record<string, unknown>) => (m['agent'] = '../agent')],
    ['a bad timestamp', (m: Record<string, unknown>) => (m['createdAt'] = 'yesterday')],
    ['a bad sha256', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['plaintextSha256'] = 'zz')],
    ['an uppercase sha256', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['plaintextSha256'] = 'A'.repeat(64))],
    ['a negative size', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['plaintextBytes'] = -1)],
    ['a fractional entry count', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['entries'] = 1.5)],
    ['no volumes', (m: Record<string, unknown>) => (m['volumes'] = [])],
    ['duplicate volume keys', (m: Record<string, unknown>) => (m['volumes'] = [...(m['volumes'] as unknown[]), ...(m['volumes'] as unknown[])])],
    ['an encrypted volume without ciphertext fields', (_m: Record<string, unknown>, v: Record<string, unknown>) => delete v['ciphertextSha256']],
    ['encryption null on an encrypted volume', (m: Record<string, unknown>) => (m['encryption'] = null)],
    ['a weak kdf iteration count', (m: Record<string, unknown>) => ((m['encryption'] as Record<string, unknown>)['iterations'] = 1000)],
    ['another algorithm', (m: Record<string, unknown>) => ((m['encryption'] as Record<string, unknown>)['alg'] = 'aes-128-cbc')],
    ['a bad container path', (_m: Record<string, unknown>, v: Record<string, unknown>) => (v['containerPath'] = '/a/../b')],
    ['a bad image ref', (m: Record<string, unknown>) => (m['image'] = { ref: '--privileged' })],
  ])('rejects %s', (_label, fn) => {
    expect(snapshotManifestSchema.safeParse(mutated(fn)).success).toBe(false);
  });

  it('rejects an unencrypted volume that carries ciphertext fields, or the wrong file extension', () => {
    const plain = mutated((m, v) => {
      m['encryption'] = null;
      v['encrypted'] = false;
    });
    expect(snapshotManifestSchema.safeParse(plain).success).toBe(false);
    const ok = mutated((m, v) => {
      m['encryption'] = null;
      v['encrypted'] = false;
      v['file'] = 'data.tar';
      delete v['ciphertextSha256'];
      delete v['ciphertextBytes'];
    });
    expect(snapshotManifestSchema.safeParse(ok).success).toBe(true);
  });

  it('snapshotFileName builds only from valid keys', () => {
    expect(snapshotFileName('data', false)).toBe('data.tar');
    expect(snapshotFileName('data', true)).toBe('data.tar.enc');
    expect(() => snapshotFileName('../x', false)).toThrow(ContainerError);
    expect(() => snapshotFileName('a/b', true)).toThrow(ContainerError);
  });
});

// ---------------------------------------------------------------------------
// verifySnapshot
// ---------------------------------------------------------------------------

describe('verifySnapshot', () => {
  it('verifies an unencrypted snapshot', async () => {
    const { dir } = await makeSnapshot();
    const result = await verifySnapshot({ snapshotDir: dir });
    expect(result.fullyVerified).toBe(true);
    expect(result.volumes).toEqual([{ key: 'data', entries: GOOD_ENTRIES, plaintextBytes: goodTar().length, encrypted: false, plaintextVerified: true }]);
  });

  it('verifies an encrypted snapshot with the passphrase and leaves no spool behind', async () => {
    const { dir } = await makeSnapshot({ passphrase: PASS });
    const tempDir = fresh('tmp');
    const result = await verifySnapshot({ snapshotDir: dir, passphrase: PASS, tempDir });
    expect(result.fullyVerified).toBe(true);
    expect(result.volumes[0]).toMatchObject({ encrypted: true, plaintextVerified: true });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('without a passphrase it checks the ciphertext only, says so, and still catches tampering', async () => {
    const { dir } = await makeSnapshot({ passphrase: PASS });
    const result = await verifySnapshot({ snapshotDir: dir });
    expect(result.fullyVerified).toBe(false);
    expect(result.volumes[0]?.plaintextVerified).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/only the ciphertext hashes/);

    const file = path.join(dir, 'data.tar.enc');
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    fs.writeFileSync(file, bytes);
    await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /sha256/);
  });

  it('a wrong passphrase is INTEGRITY and leaves no plaintext spool', async () => {
    const { dir } = await makeSnapshot({ passphrase: PASS });
    const tempDir = fresh('tmp');
    const err = await expectError(verifySnapshot({ snapshotDir: dir, passphrase: 'not the right one', tempDir }), 'INTEGRITY', /wrong passphrase or the file was modified/);
    expect(leaks(err.message)).toBe(false);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  describe('tampering', () => {
    it('detects a flipped byte in an unencrypted tar', async () => {
      const { dir } = await makeSnapshot();
      const file = path.join(dir, 'data.tar');
      const bytes = fs.readFileSync(file);
      bytes[600] = (bytes[600] ?? 0) ^ 1;
      fs.writeFileSync(file, bytes);
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /sha256/);
    });

    it('detects a truncated file by size before hashing', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const file = path.join(dir, 'data.tar.enc');
      fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 100));
      await expectError(verifySnapshot({ snapshotDir: dir, passphrase: PASS }), 'INTEGRITY', /bytes but the manifest says/);
    });

    it('detects a wrong plaintext hash in the manifest', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const manifestPath = path.join(dir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      (m.volumes[0] as { plaintextSha256: string }).plaintextSha256 = 'a'.repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(m));
      await expectError(verifySnapshot({ snapshotDir: dir, passphrase: PASS }), 'INTEGRITY', /does not match the sha256/);
    });

    it('detects a wrong entry count', async () => {
      const { dir } = await makeSnapshot();
      const manifestPath = path.join(dir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      (m.volumes[0] as { entries: number }).entries = 99;
      fs.writeFileSync(manifestPath, JSON.stringify(m));
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /holds 5 entries but the manifest says 99/);
    });

    it('detects a missing volume file', async () => {
      const { dir } = await makeSnapshot();
      fs.rmSync(path.join(dir, 'data.tar'));
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /missing from the snapshot/);
    });

    it('refuses a volume file that is a symlink', async () => {
      const { dir } = await makeSnapshot();
      const real = path.join(dir, 'data.tar');
      const moved = path.join(fresh('elsewhere'), 'data.tar');
      fs.renameSync(real, moved);
      fs.symlinkSync(moved, real);
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /not a regular file/);
    });
  });

  describe('hostile manifests', () => {
    it('a missing manifest means the snapshot is incomplete: NOT_FOUND', async () => {
      await expectError(verifySnapshot({ snapshotDir: fresh('empty') }), 'NOT_FOUND', /never completed/);
    });

    it('rejects invalid JSON', async () => {
      const dir = fresh('bad');
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{nope');
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /not valid JSON/);
    });

    it('rejects an implausibly large manifest', async () => {
      const dir = fresh('big');
      fs.writeFileSync(path.join(dir, 'manifest.json'), Buffer.alloc(2 * 1024 * 1024, 0x20));
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /implausibly large/);
    });

    it('rejects a manifest that is a symlink', async () => {
      const { dir } = await makeSnapshot();
      const real = path.join(dir, 'manifest.json');
      const moved = path.join(fresh('elsewhere'), 'm.json');
      fs.renameSync(real, moved);
      fs.symlinkSync(moved, real);
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /regular file/);
    });

    it('rejects file:"../../x" and never opens it', async () => {
      const secretOutside = path.join(fresh('outside'), 'x.tar');
      fs.writeFileSync(secretOutside, goodTar());
      const dir = await forgeSnapshot({
        tars: { data: goodTar() },
        mutate: (m) => {
          const v = (m['volumes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
          v['file'] = path.relative(path.join(work, 'x'), secretOutside);
        },
      });
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /manifest\.json is invalid at volumes\.0\.file/);
    });

    it('rejects a hostile volume key', async () => {
      const dir = await forgeSnapshot({
        tars: { data: goodTar() },
        mutate: (m) => {
          const v = (m['volumes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
          v['key'] = '../../etc';
          v['file'] = '../../etc.tar';
        },
      });
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', /invalid at volumes\.0\.key/);
    });
  });

  describe('tar content inside an otherwise self-consistent snapshot', () => {
    const hostile: Array<[string, Buffer, RegExp]> = [
      ['path traversal', makeTar([{ name: '../evil', data: 'x' }]), /"\.\." component/],
      ['write through a symlink', makeTar([{ name: 'real/', type: '5' }, { name: 'link', type: '2', link: 'real' }, { name: 'link/evil', data: 'x' }]), /passes through the earlier symlink/],
      ['an absolute symlink', makeTar([{ name: 'l', type: '2', link: '/etc/shadow' }]), /absolute target/],
      ['a setuid file', makeTar([{ name: 'suid', data: 'x', mode: 0o4755 }]), /setuid, setgid or sticky/],
      ['a device node', makeTar([{ name: 'dev', type: '3' }]), /unsupported entry type/],
    ];

    it.each(hostile)('unencrypted: rejects %s even though the hashes match', async (_label, tar, pattern) => {
      const dir = await forgeSnapshot({ tars: { data: tar } });
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest;
      expect(m.volumes[0]?.plaintextSha256).toBe(sha256(tar));
      await expectError(verifySnapshot({ snapshotDir: dir }), 'INTEGRITY', pattern);
    });

    it.each(hostile)('encrypted: rejects %s even though the tag verifies', async (_label, tar, pattern) => {
      const dir = await forgeSnapshot({ tars: { data: tar }, passphrase: PASS });
      await expectError(verifySnapshot({ snapshotDir: dir, passphrase: PASS }), 'INTEGRITY', pattern);
    });
  });
});

// ---------------------------------------------------------------------------
// listSnapshots
// ---------------------------------------------------------------------------

describe('listSnapshots', () => {
  it('lists complete snapshots newest first and skips everything else', async () => {
    const parent = fresh('list');
    const make = (agent: string, iso: string, passphrase?: string): Promise<unknown> =>
      createSnapshot({
        runtime: new FakeRuntime({ agent, tars: { data: goodTar() } }),
        agent,
        outputDir: parent,
        now: () => new Date(iso),
        ...(passphrase !== undefined ? { passphrase } : {}),
      });
    await make('alpha', '2026-11-01T00:00:00.000Z');
    await make('beta', '2026-11-03T00:00:00.000Z', PASS);
    await make('alpha', '2026-11-02T00:00:00.000Z');

    fs.mkdirSync(path.join(parent, 'incomplete-no-manifest'));
    fs.writeFileSync(path.join(parent, 'incomplete-no-manifest', 'data.tar'), 'partial');
    fs.mkdirSync(path.join(parent, 'broken'));
    fs.writeFileSync(path.join(parent, 'broken', 'manifest.json'), '{"format": "wrong"}');
    fs.writeFileSync(path.join(parent, 'stray-file.txt'), 'x');
    fs.symlinkSync(path.join(parent, 'alpha-20261101T000000Z'), path.join(parent, 'linked'));

    const listed = listSnapshots(parent);
    expect(listed.map((s) => s.name)).toEqual(['beta-20261103T000000Z', 'alpha-20261102T000000Z', 'alpha-20261101T000000Z']);
    expect(listed[0]).toMatchObject({ agent: 'beta', encrypted: true, volumes: 1, plaintextBytes: goodTar().length });
    expect(listed[1]).toMatchObject({ agent: 'alpha', encrypted: false });
  });

  it('returns [] for a directory that does not exist', () => {
    expect(listSnapshots(path.join(work, 'no-such-dir'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// restoreSnapshot
// ---------------------------------------------------------------------------

describe('restoreSnapshot', () => {
  describe('happy path', () => {
    it('restores an unencrypted snapshot into the TARGET agent\'s volumes with the verified recipe', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ agent: 'new-agent', existing: [] });
      const result = await restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' });

      expect(result.volumes).toEqual([{ key: 'data', volume: 'av-new-agent-data', entries: GOOD_ENTRIES, bytes: `${CANARY}:data`.length + 5 }]);
      expect(result.entries).toBe(GOOD_ENTRIES);
      expect(runtime.ensured).toEqual([{ name: 'av-new-agent-data', labels: { [LABEL_AGENT]: 'new-agent', [LABEL_VOLUME_KEY]: 'data' } }]);

      const restore = runtime.helpers('restore');
      expect(restore).toHaveLength(1);
      const spec = restore[0]?.spec as ContainerSpec;
      expect(spec).toMatchObject({
        image: 'busybox:1.37',
        role: 'helper',
        user: '0:0',
        allowRoot: true,
        network: 'none',
        capAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
        readOnlyRootfs: true,
        autoRemove: true,
        tmpfs: [],
        env: {},
        command: ['tar', '-xf', '-', '-C', '/v'],
        mounts: [{ kind: 'volume', source: 'av-new-agent-data', target: '/v', readOnly: false }],
      });
      expect(restore[0]?.stdinBytes?.equals(goodTar())).toBe(true);
      const argv = buildRunArgs(spec);
      expect(argv).toEqual(
        expect.arrayContaining(['--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=FOWNER', '--cap-add=DAC_OVERRIDE', '--network=none', '--read-only', '--mount=type=volume,source=av-new-agent-data,target=/v'])
      );
      expect(argv).not.toContain('--cap-add=DAC_READ_SEARCH');
      expect(runtime.removed).toEqual([]);
    });

    it('restores an encrypted snapshot, several volumes in manifest order', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS, keys: { alpha: goodTar('a'), beta: goodTar('b') } });
      const spoolModes: number[] = [];
      const runtime = new FakeRuntime({
        existing: [],
        onRestore: (call) => spoolModes.push(fs.statSync(path.dirname(call.io?.stdinFile ?? '')).mode & 0o777),
      });
      const result = await restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', passphrase: PASS });
      // decrypted plaintext only ever sits in a private 0700 directory
      expect(spoolModes).toEqual([0o700, 0o700]);
      expect(result.volumes.map((v) => v.volume)).toEqual(['av-new-agent-alpha', 'av-new-agent-beta']);
      expect(runtime.helpers('restore').map((c) => c.stdinBytes?.toString('latin1').includes(':a') ?? false)).toEqual([true, false]);
    });

    it('works when a managed, EMPTY volume already exists', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'] });
      await restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' });
      expect(runtime.helpers('list')).toHaveLength(1);
      expect(runtime.helpers('list')[0]?.spec.capAdd).toEqual(['DAC_READ_SEARCH']);
      expect(runtime.helpers('list')[0]?.spec.mounts[0]?.readOnly).toBe(true);
      expect(runtime.helpers('restore')).toHaveLength(1);
    });

    it('removes its private spool directory on success', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const tempDir = fresh('tmp');
      await restoreSnapshot({ runtime: new FakeRuntime({ existing: [] }), snapshotDir: dir, agent: 'new-agent', passphrase: PASS, tempDir });
      expect(fs.readdirSync(tempDir)).toEqual([]);
    });

    it('notes that a passphrase was ignored for an unencrypted snapshot', async () => {
      const { dir } = await makeSnapshot();
      const result = await restoreSnapshot({ runtime: new FakeRuntime({ existing: [] }), snapshotDir: dir, agent: 'new-agent', passphrase: PASS });
      expect(result.warnings.join(' ')).toMatch(/not encrypted/);
    });
  });

  describe('nothing is written until EVERYTHING has been validated', () => {
    function expectUntouched(runtime: FakeRuntime): void {
      expect(runtime.ensured).toEqual([]);
      expect(runtime.removed).toEqual([]);
      expect(runtime.helpers('restore')).toEqual([]);
      expect(runtime.helpers('list')).toEqual([]);
      expect(runtime.helpers('snapshot')).toEqual([]);
    }

    it('a wrong passphrase writes NOTHING: no volume created, no helper started', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const runtime = new FakeRuntime({ existing: [] });
      const tempDir = fresh('tmp');
      const err = await expectError(
        restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', passphrase: 'definitely wrong', tempDir }),
        'INTEGRITY',
        /wrong passphrase or the file was modified/
      );
      expect(leaks(err.message)).toBe(false);
      expectUntouched(runtime);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    });

    it('a valid FIRST volume is not restored when the SECOND volume is bad', async () => {
      const { dir } = await makeSnapshot({ keys: { alpha: goodTar('a'), beta: goodTar('b') } });
      const file = path.join(dir, 'beta.tar');
      const bytes = fs.readFileSync(file);
      bytes[700] = (bytes[700] ?? 0) ^ 1;
      fs.writeFileSync(file, bytes);
      const runtime = new FakeRuntime({ existing: [] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'INTEGRITY', /beta/);
      expectUntouched(runtime);
    });

    it('a hostile tar in the SECOND volume (valid hashes) blocks the whole restore', async () => {
      const dir = await forgeSnapshot({
        tars: { alpha: goodTar('a'), beta: makeTar([{ name: 'real/', type: '5' }, { name: 'l', type: '2', link: 'real' }, { name: 'l/x', data: 'x' }]) },
        passphrase: PASS,
      });
      const runtime = new FakeRuntime({ existing: [] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', passphrase: PASS }), 'INTEGRITY', /passes through the earlier symlink/);
      expectUntouched(runtime);
    });

    it('a hostile manifest (file traversal) is rejected before any docker call except the image check', async () => {
      const dir = await forgeSnapshot({
        tars: { data: goodTar() },
        mutate: (m) => ((((m['volumes'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['file']) = '../../x'),
      });
      const runtime = new FakeRuntime({ existing: [] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'INTEGRITY', /invalid at volumes\.0\.file/);
      expectUntouched(runtime);
      expect(runtime.events).toEqual(['inspectImage busybox:1.37']);
    });

    it('an encrypted snapshot without a passphrase is INVALID_INPUT and touches nothing', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const runtime = new FakeRuntime({ existing: [] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'INVALID_INPUT', /passphrase is required/);
      expectUntouched(runtime);
    });

    it('a missing helper image is NOT_FOUND with the pull command, before anything else', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: [], images: [] });
      const err = await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'NOT_FOUND');
      expect(err.message).toContain('docker pull busybox:1.37');
      expectUntouched(runtime);
    });

    it('validation order: sha256 and tar checks run before the emptiness check', async () => {
      const dir = await forgeSnapshot({ tars: { data: makeTar([{ name: '../evil', data: 'x' }]) } });
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'], nonEmpty: ['av-new-agent-data'] });
      // the volume is non-empty AND the tar is hostile: the tar verdict must come first
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'INTEGRITY', /"\.\." component/);
      expectUntouched(runtime);
    });

    it('rejects invalid input before touching docker', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: [] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: '../x' }), 'INVALID_INPUT');
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'ok', helperImage: '-bad' }), 'INVALID_INPUT');
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'ok', passphrase: 'short' }), 'INVALID_INPUT');
      expect(runtime.events).toEqual([]);
    });
  });

  describe('the bytes restored are the bytes validated (no time-of-check/time-of-use gap)', () => {
    it('swapping the snapshot file after validation does not change what the helper reads', async () => {
      const { dir } = await makeSnapshot();
      const original = fs.readFileSync(path.join(dir, 'data.tar'));
      const runtime = new FakeRuntime({
        existing: [],
        onRestore: () => {
          // an attacker swaps the file between validation and restore
          fs.writeFileSync(path.join(dir, 'data.tar'), makeTar([{ name: '../evil', data: 'pwned' }]));
        },
      });
      await restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' });
      const call = runtime.helpers('restore')[0];
      expect(call?.stdinBytes?.equals(original)).toBe(true);
      expect(call?.io?.stdinFile).not.toBe(path.join(dir, 'data.tar'));
    });
  });

  describe('target volume must be empty', () => {
    it('refuses a non-empty existing volume without force, and writes nothing', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'], nonEmpty: ['av-new-agent-data'] });
      const err = await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'POLICY_VIOLATION', /non-empty volume/);
      expect(err.message).toContain('av-new-agent-data');
      expect(runtime.helpers('restore')).toEqual([]);
      expect(runtime.ensured).toEqual([]);
      expect(runtime.removed).toEqual([]);
    });

    it('with force it restores on top', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'], nonEmpty: ['av-new-agent-data'] });
      const result = await restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', force: true });
      expect(result.volumes).toHaveLength(1);
      expect(runtime.helpers('restore')).toHaveLength(1);
    });

    it('catches a same-named volume that existed WITHOUT our labels (found after ensureVolume, before any write)', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: [], nonEmpty: ['av-new-agent-data'] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'POLICY_VIOLATION', /already holds data/);
      expect(runtime.helpers('restore')).toEqual([]);
      expect(runtime.removed).toEqual([]);
    });

    it('ignores a labelled volume whose name is not the canonical one (it must not make us probe the real name)', async () => {
      const { dir } = await makeSnapshot();
      const base = new FakeRuntime({ existing: [] });
      const decoy: ContainerRuntime = Object.assign(Object.create(base) as ContainerRuntime, {
        listVolumes: (): Promise<Array<{ name: string; key: string; agent: string }>> =>
          Promise.resolve([{ name: 'some-other-name', key: 'data', agent: 'new-agent' }]),
      });
      await restoreSnapshot({ runtime: decoy, snapshotDir: dir, agent: 'new-agent' });
      // treated as missing: created (with labels) BEFORE the first probe of the canonical name
      const events = base.events;
      expect(events.indexOf('ensureVolume av-new-agent-data')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('ensureVolume av-new-agent-data')).toBeLessThan(events.indexOf('list av-new-agent-data'));
    });

    it('fails closed when the emptiness check itself fails', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'], listExit: 1 });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'COMMAND_FAILED', /refusing to restore into it/);
      expect(runtime.helpers('restore')).toEqual([]);
    });

    it('one non-empty volume out of two blocks both', async () => {
      const { dir } = await makeSnapshot({ keys: { alpha: goodTar('a'), beta: goodTar('b') } });
      const runtime = new FakeRuntime({ existing: ['av-new-agent-beta'], nonEmpty: ['av-new-agent-beta'] });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'POLICY_VIOLATION');
      expect(runtime.helpers('restore')).toEqual([]);
      expect(runtime.ensured).toEqual([]);
    });
  });

  describe('restore helper failure', () => {
    it('is an error, and the volumes that were empty before are removed so no half-restored state survives', async () => {
      const { dir } = await makeSnapshot({ keys: { alpha: goodTar('a'), beta: goodTar('b') } });
      const runtime = new FakeRuntime({ existing: [], restoreExit: 1 });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent' }), 'COMMAND_FAILED', /exit code 1/);
      expect(runtime.removed).toEqual(['av-new-agent-alpha']);
    });

    it('removes every empty volume restored so far when a later one fails', async () => {
      const { dir } = await makeSnapshot({ keys: { alpha: goodTar('a'), beta: goodTar('b') } });
      let n = 0;
      const base = new FakeRuntime({ existing: [] });
      const failSecond: ContainerRuntime = Object.assign(Object.create(base) as ContainerRuntime, {
        runForeground: (spec: ContainerSpec, io?: { stdinFile?: string }): Promise<CommandResult> => {
          if (spec.command?.[0] === 'tar') {
            n += 1;
            if (n === 2) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, spawnFailed: false });
          }
          return base.runForeground(spec, io);
        },
      });
      await expectError(restoreSnapshot({ runtime: failSecond, snapshotDir: dir, agent: 'new-agent' }), 'COMMAND_FAILED');
      expect(base.removed.sort()).toEqual(['av-new-agent-alpha', 'av-new-agent-beta']);
    });

    it('NEVER removes a volume that held data before (force)', async () => {
      const { dir } = await makeSnapshot();
      const runtime = new FakeRuntime({ existing: ['av-new-agent-data'], nonEmpty: ['av-new-agent-data'], restoreExit: 1 });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', force: true }), 'COMMAND_FAILED');
      expect(runtime.removed).toEqual([]);
    });

    it('removes the spool even on failure', async () => {
      const { dir } = await makeSnapshot({ passphrase: PASS });
      const tempDir = fresh('tmp');
      const runtime = new FakeRuntime({ existing: [], restoreExit: 1 });
      await expectError(restoreSnapshot({ runtime, snapshotDir: dir, agent: 'new-agent', passphrase: PASS, tempDir }), 'COMMAND_FAILED');
      expect(fs.readdirSync(tempDir)).toEqual([]);
    });
  });
});
