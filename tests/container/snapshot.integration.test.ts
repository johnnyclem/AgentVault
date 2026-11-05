/**
 * Snapshots against a REAL Docker daemon. Nothing here is stubbed: the helper
 * containers run busybox with the verified capability sets, the volumes hold
 * files owned by uid 10001 with modes 0640/0700, and the restored data is read
 * back by a container running as 10001:10001.
 *
 * Skipped (not failed) when no daemon is reachable or busybox:1.37 is not
 * already pulled. Every Docker resource is named through dockerTestEnv('avt-c-').
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptFile } from '../../src/container/crypto.js';
import { DockerRuntime } from '../../src/container/docker.js';
import { createSnapshot, restoreSnapshot, verifySnapshot } from '../../src/container/snapshot.js';
import type { SnapshotManifest } from '../../src/container/snapshot.js';
import { validateTarArchive } from '../../src/container/tar-validate.js';
import { ContainerError, LABEL_AGENT, LABEL_VOLUME_KEY } from '../../src/container/types.js';
import type { ContainerRuntime, ContainerSpec } from '../../src/container/types.js';
import { resourceNames } from '../../src/container/validate.js';
import { dockerTestEnv, imagePresent } from './helpers/docker.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const d = dockerTestEnv('avt-c-');
const BUSYBOX = 'busybox:1.37';
const usable = d.available && imagePresent(BUSYBOX);
const PASS = 'integration passphrase 0451';
const CANARY = 'CANARY-INTEGRATION-5d41402abc4b2a76b9719d911017c592';

let work: string;
const runtime = new DockerRuntime();

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], input?: string): Run {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, ...(input !== undefined ? { input } : {}) });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function volumeExists(name: string): boolean {
  return docker(['volume', 'inspect', name]).status === 0;
}

/** Run a shell script in busybox with the volume mounted at /v (root, default capabilities: a test-side observer). */
function inVolume(volume: string, script: string, options: { readOnly?: boolean; user?: string; hardened?: boolean } = {}): Run {
  const args = ['run', '--rm', '--network=none', `--name=${d.name('probe')}`];
  if (options.user !== undefined) args.push(`--user=${options.user}`);
  if (options.hardened === true) args.push('--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only');
  args.push(`-v=${volume}:/v${options.readOnly === true ? ':ro' : ''}`, BUSYBOX, 'sh', '-c', script);
  return docker(args);
}

/** Names, owner, mode, type, size and link count of everything, plus a sha256 of every regular file. */
const LISTING_SCRIPT = [
  'cd /v',
  'find . | sort | while IFS= read -r f; do stat -c "%n %u:%g %a %F %s %h" "$f"; done',
  'echo ---',
  'find . -type f -exec sha256sum {} \\; | sort -k2',
  'echo ---',
  'find . -type l | sort | while IFS= read -r f; do echo "$f -> $(readlink "$f")"; done',
].join(' && ');

function listing(volume: string): string {
  const r = inVolume(volume, LISTING_SCRIPT, { readOnly: true });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/**
 * BusyBox `tar -x` calls chown(), which follows symlinks, so it never sets the
 * owner of a symlink itself: restored links are root-owned (verified on
 * busybox:1.37). Link ownership does not affect following a link, so the
 * comparison ignores it; every other owner, mode, size and count must match.
 */
function ignoreSymlinkOwner(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.includes(' symbolic link ') ? line.replace(/ \d+:\d+ /, ' *:* ') : line))
    .join('\n');
}

function seed(volume: string): void {
  const script = [
    'cd /v',
    'mkdir -p nested/deep/er',
    `printf '%s' '${CANARY}' > readable.txt`,
    'printf data > nested/deep/er/file.txt',
    'ln nested/deep/er/file.txt hardlink-of-file',
    'mkdir secret.dir',
    'printf inner > secret.dir/inner.txt',
    'ln -s readable.txt link-to-readable',
    'ln -s nested/deep link-to-dir',
    "printf unicode > 'unicodé-日本.txt'",
    ': > empty-file',
    'chown -R 10001:10001 .',
    'chmod 0640 readable.txt',
    'chmod 0700 secret.dir',
    'chmod 0600 secret.dir/inner.txt',
    'chmod 0750 nested',
  ].join(' && ');
  const r = inVolume(volume, script);
  expect(r.status, r.stderr).toBe(0);
}

async function newAgentWithData(label: string, extraKeys: string[] = []): Promise<string> {
  const agent = d.agent(label);
  const names = resourceNames(agent);
  await runtime.ensureVolume(names.volume('data'), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: 'data' });
  seed(names.volume('data'));
  for (const key of extraKeys) {
    await runtime.ensureVolume(names.volume(key), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: key });
    const r = inVolume(names.volume(key), `printf 'cache-content' > /v/${key}.dat && chown -R 10001:10001 /v`);
    expect(r.status, r.stderr).toBe(0);
  }
  return agent;
}

function leftoverHelpers(agent: string): string[] {
  return docker(['ps', '-a', '--format', '{{.Names}}'])
    .stdout.split('\n')
    .filter((n) => n.startsWith(`av-${agent}-`));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ContainerError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'expected a rejection').toBeInstanceOf(ContainerError);
  expect((err as ContainerError).code).toBe(code);
  return err as ContainerError;
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-c-snap-'));
});

afterAll(() => {
  d.cleanup();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!usable)('snapshot create / verify / restore on a real daemon', () => {
  let source: string;

  beforeAll(async () => {
    source = await newAgentWithData('src', ['cache']);
  });

  it('a tar produced by busybox inside the daemon passes validateTarArchive', async () => {
    const r = spawnSync(
      'docker',
      [
        'run', '--rm', '--network=none', '--cap-drop=ALL', '--cap-add=DAC_READ_SEARCH', '--security-opt=no-new-privileges', '--read-only',
        `--name=${d.name('bbtar')}`, `-v=${resourceNames(source).volume('data')}:/v:ro`, BUSYBOX, 'tar', '-cf', '-', '-C', '/v', '.',
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    expect(r.status).toBe(0);
    const file = path.join(work, 'busybox.tar');
    fs.writeFileSync(file, r.stdout);
    const summary = await validateTarArchive(file);

    const gnuList = spawnSync('tar', ['-tf', file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(summary.entries).toBe(gnuList.length);
    expect(summary.symlinks).toBe(2);
    expect(summary.hardlinks).toBe(1);
    expect(summary.directories).toBe(5); // . nested nested/deep nested/deep/er secret.dir
    expect(summary.files).toBe(5); // readable file hardlink-target inner unicode empty
    expect(summary.totalBytes).toBe(CANARY.length + 4 + 5 + 7 + 0);
  });

  it('encrypted round trip: create, verify, restore into a NEW agent, read back as 10001:10001', async () => {
    const outputDir = path.join(work, 'enc-out');
    const created = await createSnapshot({
      runtime,
      agent: source,
      outputDir,
      passphrase: PASS,
      image: { ref: 'my-agent:1.0' },
      containerPaths: { data: '/data', cache: '/cache' },
    });
    expect(created.warnings.join(' ')).not.toMatch(/NOT encrypted/);
    expect(created.manifest.volumes.map((v) => v.key)).toEqual(['cache', 'data']);
    expect(fs.readdirSync(created.dir).sort()).toEqual(['cache.tar.enc', 'data.tar.enc', 'manifest.json']);

    // nothing readable leaks into the snapshot directory
    for (const f of ['cache.tar.enc', 'data.tar.enc', 'manifest.json']) {
      const bytes = fs.readFileSync(path.join(created.dir, f));
      expect(bytes.includes(Buffer.from(CANARY)), f).toBe(false);
      expect(bytes.includes(Buffer.from(PASS)), f).toBe(false);
      expect(bytes.includes(Buffer.from('cache-content')), f).toBe(false);
    }

    const verified = await verifySnapshot({ snapshotDir: created.dir, passphrase: PASS });
    expect(verified.fullyVerified).toBe(true);

    const target = d.agent('dst');
    const restored = await restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target, passphrase: PASS });
    expect(restored.volumes.map((v) => v.volume)).toEqual([resourceNames(target).volume('cache'), resourceNames(target).volume('data')]);
    expect(restored.entries).toBe(created.manifest.volumes.reduce((n, v) => n + v.entries, 0));

    // The restored volumes are managed + labelled, so listVolumes finds them again.
    const listed = await runtime.listVolumes({ agent: target });
    expect(listed.map((v) => v.key).sort()).toEqual(['cache', 'data']);

    // Byte-for-byte: names, owners, modes, types, sizes, link counts, contents, link targets.
    const from = resourceNames(source);
    const to = resourceNames(target);
    expect(ignoreSymlinkOwner(listing(to.volume('data')))).toBe(ignoreSymlinkOwner(listing(from.volume('data'))));
    expect(ignoreSymlinkOwner(listing(to.volume('cache')))).toBe(ignoreSymlinkOwner(listing(from.volume('cache'))));

    // ...and the facts the listing encodes, spelled out.
    const dataListing = listing(to.volume('data'));
    expect(dataListing).toContain('./readable.txt 10001:10001 640 regular file');
    expect(dataListing).toContain('./secret.dir 10001:10001 700 directory');
    expect(dataListing).toContain('./secret.dir/inner.txt 10001:10001 600 regular file');
    expect(dataListing).toContain('./link-to-readable -> readable.txt');
    expect(dataListing).toContain('./link-to-dir -> nested/deep');
    expect(dataListing).toMatch(/\.\/hardlink-of-file 10001:10001 644 regular file 4 2/);

    // A restored agent running as 10001 can read AND write it, without any capability.
    const asAgent = inVolume(
      to.volume('data'),
      [
        'cat /v/readable.txt',
        'echo',
        'cat /v/secret.dir/inner.txt',
        'echo',
        'cat /v/link-to-readable',
        'echo',
        'cat /v/unicodé-日本.txt',
        'echo',
        'readlink /v/link-to-dir',
        'touch /v/newfile',
        'echo appended >> /v/readable.txt',
        'id -u',
        'echo RESTORE-OK',
      ].join(' && '),
      { user: '10001:10001', hardened: true }
    );
    expect(asAgent.status, asAgent.stderr).toBe(0);
    expect(asAgent.stdout).toContain(`${CANARY}\ninner\n${CANARY}\nunicode\nnested/deep\n10001\nRESTORE-OK`);

    expect(leftoverHelpers(source)).toEqual([]);
    expect(leftoverHelpers(target)).toEqual([]);
  });

  it('unencrypted round trip works the same and warns', async () => {
    const created = await createSnapshot({ runtime, agent: source, outputDir: path.join(work, 'plain-out'), volumeKeys: ['data'] });
    expect(created.warnings.join(' ')).toMatch(/NOT encrypted/);
    expect(fs.readdirSync(created.dir).sort()).toEqual(['data.tar', 'manifest.json']);
    expect((await verifySnapshot({ snapshotDir: created.dir })).fullyVerified).toBe(true);

    const target = d.agent('plain');
    await restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target });
    expect(ignoreSymlinkOwner(listing(resourceNames(target).volume('data')))).toBe(
      ignoreSymlinkOwner(listing(resourceNames(source).volume('data')))
    );
    expect(volumeExists(resourceNames(target).volume('cache'))).toBe(false);
  });

  it('a helper that cannot read 0640/0700 files exits non-zero while still emitting a VALID-LOOKING tar, and createSnapshot refuses it', async () => {
    // Proof of the hazard: run the snapshot recipe WITHOUT DAC_READ_SEARCH by hand.
    const hazard: ContainerSpec = {
      name: d.name('nocap'),
      image: BUSYBOX,
      role: 'helper',
      command: ['tar', '-cf', '-', '-C', '/v', '.'],
      user: '0:0',
      allowRoot: true,
      network: 'none',
      mounts: [{ kind: 'volume', source: resourceNames(source).volume('data'), target: '/v', readOnly: true }],
      tmpfs: [],
      env: {},
      labels: { 'agentvault.managed': 'true', 'agentvault.role': 'helper' },
      limits: { cpus: 1, memory: '256m', pidsLimit: 64 },
      readOnlyRootfs: true,
      capAdd: [],
      detach: false,
      autoRemove: true,
      init: false,
    };
    const partial = path.join(work, 'partial.tar');
    const result = await runtime.runForeground(hazard, { stdoutFile: partial });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Permission denied|can't open/);
    const summary = await validateTarArchive(partial); // it looks perfectly fine...
    expect(summary.entries).toBeGreaterThan(0);
    const names = spawnSync('tar', ['-tf', partial], { encoding: 'utf8' }).stdout;
    expect(names).not.toContain('readable.txt'); // ...but the 0640 file is silently missing

    // The same recipe with the capability dropped by a wrapper: createSnapshot must throw and keep nothing.
    const stripped = new Proxy(runtime, {
      get(target, prop) {
        if (prop === 'runForeground') {
          return (spec: ContainerSpec, io?: { stdinFile?: string; stdoutFile?: string }) => target.runForeground({ ...spec, capAdd: [] }, io);
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as ContainerRuntime;

    for (const passphrase of [undefined, PASS]) {
      const outputDir = path.join(work, `nocap-out-${passphrase === undefined ? 'plain' : 'enc'}`);
      const err = await expectCode(
        createSnapshot({ runtime: stripped, agent: source, outputDir, volumeKeys: ['data'], ...(passphrase !== undefined ? { passphrase } : {}) }),
        'COMMAND_FAILED'
      );
      expect(err.message).toMatch(/exit code 1/);
      expect(fs.readdirSync(outputDir)).toEqual([]);
    }
    expect(leftoverHelpers(source)).toEqual([]);
  });

  it('a wrong passphrase on restore throws INTEGRITY and writes NOTHING (target volume still does not exist)', async () => {
    const created = await createSnapshot({ runtime, agent: source, outputDir: path.join(work, 'wrongpass-out'), passphrase: PASS, volumeKeys: ['data'] });
    const target = d.agent('wrongpass');
    const targetVolume = resourceNames(target).volume('data');

    const err = await expectCode(restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target, passphrase: 'not the right passphrase' }), 'INTEGRITY');
    expect(err.message).toBe('wrong passphrase or the file was modified');
    expect(volumeExists(targetVolume)).toBe(false);

    // Same when the target volume already exists and is empty: it stays empty.
    await runtime.ensureVolume(targetVolume, { [LABEL_AGENT]: target, [LABEL_VOLUME_KEY]: 'data' });
    await expectCode(restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target, passphrase: 'still not the right one' }), 'INTEGRITY');
    const empty = inVolume(targetVolume, 'ls -A /v | wc -l', { readOnly: true });
    expect(empty.stdout.trim()).toBe('0');

    // And a single flipped ciphertext byte is refused the same way.
    const file = path.join(created.dir, 'data.tar.enc');
    const bytes = fs.readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 1;
    fs.writeFileSync(file, bytes);
    await expectCode(restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target, passphrase: PASS }), 'INTEGRITY');
    expect(inVolume(targetVolume, 'ls -A /v | wc -l', { readOnly: true }).stdout.trim()).toBe('0');
  });

  it('refuses to restore into a non-empty volume without force, and leaves its data alone', async () => {
    const created = await createSnapshot({ runtime, agent: source, outputDir: path.join(work, 'force-out'), volumeKeys: ['data'] });
    const target = d.agent('busy');
    const targetVolume = resourceNames(target).volume('data');
    await runtime.ensureVolume(targetVolume, { [LABEL_AGENT]: target, [LABEL_VOLUME_KEY]: 'data' });
    expect(inVolume(targetVolume, 'printf precious > /v/precious.txt').status).toBe(0);

    await expectCode(restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target }), 'POLICY_VIOLATION');
    expect(inVolume(targetVolume, 'ls -A /v', { readOnly: true }).stdout.trim()).toBe('precious.txt');

    await restoreSnapshot({ runtime, snapshotDir: created.dir, agent: target, force: true });
    const after = inVolume(targetVolume, 'ls -A /v | sort', { readOnly: true }).stdout;
    expect(after).toContain('precious.txt');
    expect(after).toContain('readable.txt');
  });

  it('a snapshot with a hostile tar (valid hashes, valid tag) is refused before any volume exists', async () => {
    // Hand-forge: write-through-symlink archive, encrypted with the real format, manifest with correct hashes.
    const gnu = path.join(work, 'forge');
    fs.mkdirSync(path.join(gnu, 'stage', 'real'), { recursive: true });
    fs.symlinkSync('real', path.join(gnu, 'stage', 'link'));
    fs.writeFileSync(path.join(gnu, 'stage', 'payload'), 'pwned');
    const tarFile = path.join(gnu, 'evil.tar');
    expect(spawnSync('tar', ['-cf', tarFile, '-C', path.join(gnu, 'stage'), 'real', 'link'], { encoding: 'utf8' }).status).toBe(0);
    expect(
      spawnSync('tar', ['-rf', tarFile, '-C', path.join(gnu, 'stage'), '--transform', 's,^payload$,link/evil,', 'payload'], { encoding: 'utf8' }).status
    ).toBe(0);

    const dir = path.join(gnu, 'snapshot');
    fs.mkdirSync(dir);
    const enc = await encryptFile(tarFile, path.join(dir, 'data.tar.enc'), PASS);
    const manifest: SnapshotManifest = {
      format: 'agentvault-container-snapshot',
      version: 1,
      createdAt: new Date().toISOString(),
      agent: 'forger',
      image: null,
      volumes: [
        {
          key: 'data',
          file: 'data.tar.enc',
          encrypted: true,
          plaintextSha256: enc.plaintextSha256,
          plaintextBytes: enc.plaintextBytes,
          ciphertextSha256: enc.ciphertextSha256,
          ciphertextBytes: enc.ciphertextBytes,
          entries: 4,
        },
      ],
      encryption: { alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: 210000 },
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const target = d.agent('evil');
    const err = await expectCode(restoreSnapshot({ runtime, snapshotDir: dir, agent: target, passphrase: PASS }), 'INTEGRITY');
    expect(err.message).toMatch(/passes through the earlier symlink/);
    expect(volumeExists(resourceNames(target).volume('data'))).toBe(false);
  });

  it('a missing helper image is NOT_FOUND with the pull command, and nothing is started', async () => {
    const image = 'busybox:0.0-avt-c-does-not-exist';
    const err = await expectCode(
      createSnapshot({ runtime, agent: source, outputDir: path.join(work, 'noimage-out'), helperImage: image }),
      'NOT_FOUND'
    );
    expect(err.message).toContain(`docker pull ${image}`);
    expect(fs.existsSync(path.join(work, 'noimage-out'))).toBe(false);
  });

  it('refuses an agent with no managed volumes', async () => {
    const empty = d.agent('novols');
    const outputDir = path.join(work, 'novols-out');
    await expectCode(createSnapshot({ runtime, agent: empty, outputDir }), 'NOT_FOUND');
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('describes the volume hashes the manifest records', async () => {
    const created = await createSnapshot({ runtime, agent: source, outputDir: path.join(work, 'hash-out'), volumeKeys: ['cache'] });
    const tar = fs.readFileSync(path.join(created.dir, 'cache.tar'));
    expect(created.manifest.volumes[0]?.plaintextSha256).toBe(createHash('sha256').update(tar).digest('hex'));
    expect(created.manifest.volumes[0]?.entries).toBe(2); // ./ and ./cache.dat
  });
});
