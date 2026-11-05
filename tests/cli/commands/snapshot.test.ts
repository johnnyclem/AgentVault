/**
 * `snapshot create|restore|verify|list` with the archiving library replaced by
 * spies: what these tests pin is the command line's decisions (is a passphrase
 * asked for, may a snapshot be written unencrypted, where does scratch data go,
 * what does a refusal tell the user), not tar and AES, which have their own
 * tests and run against a real daemon in container-integration.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/container/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/container/snapshot.js')>();
  return { ...actual, createSnapshot: vi.fn(), restoreSnapshot: vi.fn(), verifySnapshot: vi.fn() };
});

import { ensurePrivateDir, resolveDeps } from '../../../cli/commands/cli-support.js';
import type { ContainerCliDeps, PassphraseRequest } from '../../../cli/commands/cli-support.js';
import { executeSnapshotCreate, snapshotCommand } from '../../../cli/commands/snapshot.js';
import { containerManifestSchema, manifestToLabel } from '../../../src/container/manifest.js';
import { createSnapshot, restoreSnapshot, verifySnapshot } from '../../../src/container/snapshot.js';
import type { SnapshotManifest } from '../../../src/container/snapshot.js';
import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_MANIFEST, LABEL_ROLE } from '../../../src/container/types.js';
import type { ContainerInfo, ContainerRuntime, ImageInfo } from '../../../src/container/types.js';

const AGENT = 'alpha';
const IMAGE = 'agentvault/alpha:1';
const PASS = 'correct horse battery staple';
const OTHER_PASS = 'a different passphrase';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

let cleanup: string[] = [];
afterEach(() => {
  vi.mocked(createSnapshot).mockReset();
  vi.mocked(restoreSnapshot).mockReset();
  vi.mocked(verifySnapshot).mockReset();
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

function mkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// A runtime that only knows what snapshot create looks at
// ---------------------------------------------------------------------------

function manifestLabel(): string {
  return manifestToLabel(
    containerManifestSchema.parse({
      schemaVersion: 1,
      name: AGENT,
      version: '1',
      runtime: 'node',
      entrypoint: ['node', 'index.js'],
      volumes: ['/data', '/work/cache'],
      env: [],
      secrets: [],
      isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
      source: { type: 'node', contentHash: 'c'.repeat(64) },
    })
  );
}

function stubRuntime(options: { withAgent?: boolean } = {}): ContainerRuntime {
  const container: ContainerInfo = {
    id: 'f'.repeat(64),
    name: `av-${AGENT}`,
    image: IMAGE,
    state: 'exited',
    status: 'Exited (0)',
    role: 'agent',
    agent: AGENT,
    createdAt: '2026-11-05 07:00:00 +0000 UTC',
    labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_ROLE]: 'agent' },
  };
  const image: ImageInfo = {
    id: 'sha256:abc123',
    repoTags: [IMAGE],
    repoDigests: [`agentvault/alpha@sha256:${'d'.repeat(64)}`],
    labels: { [LABEL_MANIFEST]: manifestLabel() },
    user: '10001:10001',
    sizeBytes: 1,
  };
  const known: Record<string, unknown> = {
    list: () => Promise.resolve(options.withAgent === false ? [] : [container]),
    inspectImage: () => Promise.resolve(image),
  };
  return new Proxy({} as ContainerRuntime, {
    get: (_target, property) => {
      const handler = known[String(property)];
      if (handler !== undefined) return handler;
      return () => {
        throw new Error(`unexpected runtime call: ${String(property)}`);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: ContainerCliDeps;
  home: string;
  cwd: string;
  out: string[];
  err: string[];
  passphrases: PassphraseRequest[];
  all(): string;
  stderr(): string;
  stdout(): string;
}

function harness(over: Partial<ContainerCliDeps> = {}, options: { withAgent?: boolean } = {}): Harness {
  const home = mkdtemp('avt-k-snap-home-');
  const cwd = mkdtemp('avt-k-snap-cwd-');
  const out: string[] = [];
  const err: string[] = [];
  const passphrases: PassphraseRequest[] = [];
  const deps: ContainerCliDeps = {
    runtime: stubRuntime(options),
    env: { AGENTVAULT_HOME: home },
    cwd,
    interactive: false,
    now: () => new Date('2026-11-05T07:30:00.000Z'),
    log: (line) => out.push(plain(line)),
    err: (line) => err.push(plain(line)),
    exit: (code) => {
      throw new ExitSignal(code);
    },
    getPassphrase: (request) => {
      passphrases.push(request);
      return Promise.resolve(PASS);
    },
    ...over,
  };
  return { deps, home, cwd, out, err, passphrases, all: () => [...out, ...err].join('\n'), stderr: () => err.join('\n'), stdout: () => out.join('\n') };
}

async function run(command: Command, args: string[]): Promise<number> {
  try {
    await command.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    throw error;
  }
}

function snapshotManifest(over: Partial<SnapshotManifest> & { encrypted?: boolean } = {}): SnapshotManifest {
  const { encrypted = true, ...rest } = over;
  return {
    format: 'agentvault-container-snapshot',
    version: 1,
    createdAt: '2026-11-05T07:00:00.000Z',
    agent: AGENT,
    image: { ref: IMAGE },
    volumes: [
      {
        key: 'data',
        file: encrypted ? 'data.tar.enc' : 'data.tar',
        encrypted,
        plaintextSha256: 'a'.repeat(64),
        plaintextBytes: 2048,
        ...(encrypted ? { ciphertextSha256: 'b'.repeat(64), ciphertextBytes: 2100 } : {}),
        entries: 3,
      },
    ],
    encryption: encrypted ? { alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: 210_000 } : null,
    ...rest,
  };
}

function writeSnapshotDir(parent: string, name: string, manifest: SnapshotManifest): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('snapshot create', () => {
  function created(dir: string, manifest = snapshotManifest(), warnings: string[] = []): ReturnType<typeof createSnapshot> {
    return Promise.resolve({ dir, manifest, warnings });
  }

  it('encrypts by default: asks for the passphrase twice-confirmed and hands it to the library', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 'snapshots', 'alpha-20261105T073000Z')));

    expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(0);

    expect(h.passphrases).toEqual([{ purpose: 'snapshot', confirm: true, message: expect.any(String) as string }]);
    const request = vi.mocked(createSnapshot).mock.calls[0]?.[0];
    expect(request?.passphrase).toBe(PASS);
    expect(request?.agent).toBe(AGENT);
    expect(request?.outputDir).toBe(path.join(h.home, 'snapshots'));
    expect(request?.now?.().toISOString()).toBe('2026-11-05T07:30:00.000Z');
    expect(h.stdout()).toContain('alpha-20261105T073000Z');
    expect(h.stdout()).toContain('Encrypted: yes');
    expect(h.stdout()).toContain('snapshot restore');
  });

  it('records the image and the volume paths in the snapshot when the agent container exists', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's')));
    await run(snapshotCommand(h.deps), ['create', AGENT]);
    const request = vi.mocked(createSnapshot).mock.calls[0]?.[0];
    expect(request?.image).toEqual({ ref: IMAGE, id: 'sha256:abc123', digest: `agentvault/alpha@sha256:${'d'.repeat(64)}` });
    expect(request?.containerPaths).toEqual({ data: '/data', 'work-cache': '/work/cache' });
  });

  it('still snapshots the volumes of an agent whose container was removed', async () => {
    const h = harness({}, { withAgent: false });
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's')));
    expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(0);
    const request = vi.mocked(createSnapshot).mock.calls[0]?.[0];
    expect(request).not.toHaveProperty('image');
    expect(request).not.toHaveProperty('containerPaths');
  });

  it('--output is resolved against the injected cwd', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.cwd, 'backups', 's')));
    await run(snapshotCommand(h.deps), ['create', AGENT, '--output', 'backups']);
    expect(vi.mocked(createSnapshot).mock.calls[0]?.[0].outputDir).toBe(path.join(h.cwd, 'backups'));
  });

  it('takes the passphrase from AGENTVAULT_SNAPSHOT_PASSPHRASE when no provider is injected, and never prints it', async () => {
    const h = harness();
    delete h.deps.getPassphrase;
    h.deps.env = { AGENTVAULT_HOME: h.home, AGENTVAULT_SNAPSHOT_PASSPHRASE: OTHER_PASS };
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's')));
    expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(0);
    expect(vi.mocked(createSnapshot).mock.calls[0]?.[0].passphrase).toBe(OTHER_PASS);
    expect(h.all()).not.toContain(OTHER_PASS);
  });

  describe('property (c): never unencrypted without --no-encrypt', () => {
    it('with no variable and no terminal it FAILS, names the variable, and writes nothing', async () => {
      const h = harness();
      delete h.deps.getPassphrase; // the real provider, with an empty environment
      expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(1);
      expect(h.stderr()).toContain('AGENTVAULT_SNAPSHOT_PASSPHRASE');
      expect(createSnapshot).not.toHaveBeenCalled();
    });

    it('when the passphrase source fails for any reason it fails, it does not degrade to plaintext', async () => {
      const h = harness({ getPassphrase: () => Promise.reject(new Error('prompt closed')) });
      expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(1);
      expect(createSnapshot).not.toHaveBeenCalled();
    });

    it('--no-encrypt is the one way to an unencrypted snapshot: no passphrase asked, a warning printed', async () => {
      const h = harness();
      vi.mocked(createSnapshot).mockReturnValueOnce(
        created(path.join(h.home, 's'), snapshotManifest({ encrypted: false }), [
          "This snapshot is NOT encrypted: anyone who can read it can read the agent's data. Provide a passphrase to encrypt it.",
        ])
      );
      expect(await run(snapshotCommand(h.deps), ['create', AGENT, '--no-encrypt'])).toBe(0);

      expect(h.passphrases).toEqual([]);
      const request = vi.mocked(createSnapshot).mock.calls[0]?.[0];
      expect(request).not.toHaveProperty('passphrase');
      expect(h.stderr()).toContain('will NOT be encrypted');
      // The library's own warning says the same thing; the user sees it once.
      expect(h.stderr().match(/NOT (be )?encrypted/gi)).toHaveLength(1);
      expect(h.stdout()).toContain('Encrypted: NO');
    });

    it('--no-encrypt wins over a passphrase variable in the environment', async () => {
      const h = harness();
      delete h.deps.getPassphrase;
      h.deps.env = { AGENTVAULT_HOME: h.home, AGENTVAULT_SNAPSHOT_PASSPHRASE: PASS };
      vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's'), snapshotManifest({ encrypted: false })));
      await run(snapshotCommand(h.deps), ['create', AGENT, '--no-encrypt']);
      expect(vi.mocked(createSnapshot).mock.calls[0]?.[0]).not.toHaveProperty('passphrase');
    });
  });

  it('encrypts when called without any option at all: unencrypted is something a caller must ask for', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's')));
    await executeSnapshotCreate(AGENT, {}, resolveDeps(h.deps));
    expect(h.passphrases).toHaveLength(1);
    expect(vi.mocked(createSnapshot).mock.calls[0]?.[0].passphrase).toBe(PASS);

    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's2'), snapshotManifest({ encrypted: false })));
    await executeSnapshotCreate(AGENT, { encrypt: false }, resolveDeps(h.deps));
    expect(vi.mocked(createSnapshot).mock.calls[1]?.[0]).not.toHaveProperty('passphrase');
  });

  it('rejects a bad agent name before asking for anything', async () => {
    const h = harness();
    expect(await run(snapshotCommand(h.deps), ['create', '../etc'])).toBe(1);
    expect(h.stderr()).toContain('Invalid agent name');
    expect(h.passphrases).toEqual([]);
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it('prints the library warnings (a running agent is not quiesced)', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockReturnValueOnce(created(path.join(h.home, 's'), snapshotManifest(), ['Agent alpha is running: files may change while they are archived.']));
    await run(snapshotCommand(h.deps), ['create', AGENT]);
    expect(h.stderr()).toContain('Agent alpha is running');
  });

  it('a library failure that mentions the passphrase is printed with the passphrase scrubbed', async () => {
    const h = harness();
    vi.mocked(createSnapshot).mockRejectedValueOnce(new ContainerError('COMMAND_FAILED', `helper failed near ${PASS}`));
    expect(await run(snapshotCommand(h.deps), ['create', AGENT])).toBe(1);
    expect(h.stderr()).toContain('helper failed near [redacted]');
    expect(h.all()).not.toContain(PASS);
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('snapshot restore', () => {
  const restored = { volumes: [{ key: 'data', volume: `av-${AGENT}-data`, entries: 3, bytes: 2048 }], entries: 3, warnings: [] as string[] };

  it('asks for the passphrase of an encrypted snapshot (once, no confirmation) and spools in a private directory under the AgentVault home', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);

    expect(await run(snapshotCommand(h.deps), ['restore', dir])).toBe(0);

    expect(h.passphrases).toEqual([{ purpose: 'snapshot', confirm: false, message: expect.any(String) as string }]);
    const request = vi.mocked(restoreSnapshot).mock.calls[0]?.[0];
    expect(request?.snapshotDir).toBe(dir);
    expect(request?.agent).toBe(AGENT);
    expect(request?.passphrase).toBe(PASS);
    expect(request).not.toHaveProperty('force');

    // Disk-backed, under the AgentVault home, private to the owner: never os.tmpdir() by default.
    const scratch = path.join(h.home, 'tmp');
    expect(request?.tempDir).toBe(scratch);
    expect(fs.statSync(scratch).mode & 0o777).toBe(0o700);

    expect(h.stdout()).toContain('Restored 3 entries into 1 volume(s) of alpha');
    expect(h.stdout()).toContain(`agentvault run ${IMAGE} --name ${AGENT} -d`);
    expect(h.all()).not.toContain(PASS);
  });

  it('does not ask for a passphrase for an unencrypted snapshot', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest({ encrypted: false }));
    vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);
    await run(snapshotCommand(h.deps), ['restore', dir]);
    expect(h.passphrases).toEqual([]);
    expect(vi.mocked(restoreSnapshot).mock.calls[0]?.[0]).not.toHaveProperty('passphrase');
  });

  it('--to restores into another agent', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);
    await run(snapshotCommand(h.deps), ['restore', dir, '--to', 'beta']);
    expect(vi.mocked(restoreSnapshot).mock.calls[0]?.[0].agent).toBe('beta');
    expect(h.stdout()).toContain('--name beta');
  });

  it('a snapshot directory is resolved against the injected cwd', async () => {
    const h = harness();
    writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);
    await run(snapshotCommand(h.deps), ['restore', 'snap']);
    expect(vi.mocked(restoreSnapshot).mock.calls[0]?.[0].snapshotDir).toBe(path.join(h.cwd, 'snap'));
  });

  it('turns the library\'s "non-empty volume" refusal into a message that names --force and the volume', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockRejectedValueOnce(
      new ContainerError('POLICY_VIOLATION', 'Refusing to restore into non-empty volume(s) "av-alpha-data": ... pass force to restore anyway.', { volumes: ['data'] })
    );
    expect(await run(snapshotCommand(h.deps), ['restore', dir])).toBe(1);
    expect(h.stderr()).toContain('Refusing to restore into non-empty volume(s) av-alpha-data');
    expect(h.stderr()).toContain('--force');
    expect(h.stderr()).toContain('agentvault rm alpha --volumes');
    expect(h.stderr()).not.toContain('pass force');
  });

  it('leaves every other policy refusal as the library worded it', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockRejectedValueOnce(new ContainerError('POLICY_VIOLATION', 'Refusing something else'));
    expect(await run(snapshotCommand(h.deps), ['restore', dir])).toBe(1);
    expect(h.stderr()).toContain('Error: Refusing something else');
    expect(h.stderr()).not.toContain('--force');
  });

  it('--force is passed on and announced', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);
    await run(snapshotCommand(h.deps), ['restore', dir, '--force']);
    expect(vi.mocked(restoreSnapshot).mock.calls[0]?.[0].force).toBe(true);
    expect(h.stderr()).toContain('--force: existing files');
  });

  it('a missing or incomplete snapshot is reported before any passphrase is asked for', async () => {
    const h = harness();
    expect(await run(snapshotCommand(h.deps), ['restore', path.join(h.cwd, 'nothing-here')])).toBe(1);
    expect(h.stderr()).toContain('manifest.json');
    expect(h.passphrases).toEqual([]);
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a bad --to name before asking for a passphrase', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    expect(await run(snapshotCommand(h.deps), ['restore', dir, '--to', 'a/b'])).toBe(1);
    expect(h.passphrases).toEqual([]);
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });

  it('a wrong passphrase surfaces as an integrity error with its hint, without the passphrase', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(restoreSnapshot).mockRejectedValueOnce(new ContainerError('INTEGRITY', 'wrong passphrase or the file was modified'));
    expect(await run(snapshotCommand(h.deps), ['restore', dir])).toBe(1);
    expect(h.stderr()).toContain('wrong passphrase or the file was modified');
    expect(h.stderr()).toContain('damaged or modified');
    expect(h.all()).not.toContain(PASS);
  });

  describe('the scratch directory for decrypted data', () => {
    it('refuses a symlink in its place: decrypted data must not be steered somewhere else', async () => {
      const h = harness();
      const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
      const elsewhere = mkdtemp('avt-k-elsewhere-');
      fs.mkdirSync(h.home, { recursive: true });
      fs.symlinkSync(elsewhere, path.join(h.home, 'tmp'));
      expect(await run(snapshotCommand(h.deps), ['restore', dir])).toBe(1);
      expect(h.stderr()).toContain('must be a real directory');
      expect(restoreSnapshot).not.toHaveBeenCalled();
    });

    it('tightens a pre-existing directory that other users could read', async () => {
      const h = harness();
      const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
      fs.mkdirSync(path.join(h.home, 'tmp'), { recursive: true, mode: 0o755 });
      fs.chmodSync(path.join(h.home, 'tmp'), 0o755);
      vi.mocked(restoreSnapshot).mockResolvedValueOnce(restored);
      await run(snapshotCommand(h.deps), ['restore', dir]);
      expect(fs.statSync(path.join(h.home, 'tmp')).mode & 0o777).toBe(0o700);
    });

    it.each([0o000, 0o022, 0o277])('ensurePrivateDir leaves every directory it created at 0700 under umask %o', (mask) => {
      const base = mkdtemp('avt-k-umask-');
      const old = process.umask(mask);
      try {
        ensurePrivateDir(path.join(base, 'a', 'b'));
        // Under 0o277 a plain recursive mkdir would leave these at 0500, which blocks the next level for any non-root user.
        for (const level of ['a', 'a/b']) expect(fs.statSync(path.join(base, level)).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(old);
      }
    });

    it('ensurePrivateDir creates missing parents private and refuses a plain file', () => {
      const base = mkdtemp('avt-k-private-');
      const deep = path.join(base, 'a', 'b', 'c');
      expect(ensurePrivateDir(deep)).toBe(deep);
      for (const level of ['a', 'a/b', 'a/b/c']) expect(fs.statSync(path.join(base, level)).mode & 0o777).toBe(0o700);

      const file = path.join(base, 'file');
      fs.writeFileSync(file, 'x');
      expect(() => ensurePrivateDir(file)).toThrow('must be a real directory');
    });
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe('snapshot verify', () => {
  const verified = (fully: boolean) => ({
    manifest: snapshotManifest(),
    volumes: [{ key: 'data', entries: 3, plaintextBytes: 2048, encrypted: true, plaintextVerified: fully }],
    fullyVerified: fully,
    warnings: fully ? [] : ['No passphrase was given: only the ciphertext hashes were checked.'],
  });

  it('asks for the passphrase of an encrypted snapshot and verifies with scratch space under the home', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(verifySnapshot).mockResolvedValueOnce(verified(true));
    expect(await run(snapshotCommand(h.deps), ['verify', dir])).toBe(0);
    const request = vi.mocked(verifySnapshot).mock.calls[0]?.[0];
    expect(request?.passphrase).toBe(PASS);
    expect(request?.tempDir).toBe(path.join(h.home, 'tmp'));
    expect(h.stdout()).toContain('is intact');
    expect(h.stdout()).toContain('decrypted and checked');
  });

  it('--ciphertext-only asks for no passphrase and says what was and was not checked', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(verifySnapshot).mockResolvedValueOnce(verified(false));
    expect(await run(snapshotCommand(h.deps), ['verify', dir, '--ciphertext-only'])).toBe(0);
    expect(h.passphrases).toEqual([]);
    expect(vi.mocked(verifySnapshot).mock.calls[0]?.[0]).not.toHaveProperty('passphrase');
    expect(h.stdout()).toContain('consistent (ciphertext only)');
    expect(h.stderr()).toContain('only the ciphertext hashes were checked');
  });

  it('an unencrypted snapshot needs no passphrase', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest({ encrypted: false }));
    vi.mocked(verifySnapshot).mockResolvedValueOnce({ ...verified(true), volumes: [{ key: 'data', entries: 3, plaintextBytes: 2048, encrypted: false, plaintextVerified: true }] });
    await run(snapshotCommand(h.deps), ['verify', dir]);
    expect(h.passphrases).toEqual([]);
  });

  it('a snapshot that fails verification exits 1', async () => {
    const h = harness();
    const dir = writeSnapshotDir(h.cwd, 'snap', snapshotManifest());
    vi.mocked(verifySnapshot).mockRejectedValueOnce(new ContainerError('INTEGRITY', 'data.tar.enc does not match its sha256 in the manifest'));
    expect(await run(snapshotCommand(h.deps), ['verify', dir])).toBe(1);
    expect(h.stderr()).toContain('does not match its sha256');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('snapshot list', () => {
  it('lists the snapshots of the default directory, newest first, flagging unencrypted ones', async () => {
    const h = harness();
    const dir = path.join(h.home, 'snapshots');
    writeSnapshotDir(dir, 'alpha-old', snapshotManifest({ createdAt: '2026-11-01T00:00:00.000Z' }));
    writeSnapshotDir(dir, 'alpha-new', snapshotManifest({ createdAt: '2026-11-04T00:00:00.000Z', encrypted: false }));
    fs.mkdirSync(path.join(dir, 'half-written')); // no manifest.json: not a complete snapshot

    expect(await run(snapshotCommand(h.deps), ['list'])).toBe(0);
    const lines = h.out.filter((l) => l.startsWith('alpha-') || l.startsWith('NAME'));
    expect(lines[0]).toMatch(/NAME\s+AGENT\s+CREATED\s+ENCRYPTED\s+VOLUMES\s+SIZE/);
    expect(lines[1]).toMatch(/^alpha-new\s+alpha\s+\S+\s+NO\s+1\s+2\.0 KB/);
    expect(lines[2]).toMatch(/^alpha-old\s+alpha\s+\S+\s+yes\s+1/);
    expect(h.stdout()).not.toContain('half-written');
  });

  it('takes a directory argument and can print JSON', async () => {
    const h = harness();
    writeSnapshotDir(path.join(h.cwd, 'mine'), 's1', snapshotManifest());
    await run(snapshotCommand(h.deps), ['list', 'mine', '--json']);
    const rows = JSON.parse(h.stdout()) as Array<{ name: string; encrypted: boolean }>;
    expect(rows.map((r) => [r.name, r.encrypted])).toEqual([['s1', true]]);
  });

  it('says so when there are none', async () => {
    const h = harness();
    await run(snapshotCommand(h.deps), ['list']);
    expect(h.stdout()).toContain('No snapshots in');
  });
});
