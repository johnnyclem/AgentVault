import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { containerManifestSchema, manifestToLabel, parseManifest, MANIFEST_FILE } from '../../src/container/manifest.js';
import {
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILES,
  OUTPUT_MARKER,
  packageContainer,
  stageBuildContext,
  type ContainerPackageOptions,
  type PackagingRuntime,
} from '../../src/container/package-image.js';
import {
  ContainerError,
  LABEL_MANIFEST,
  type BuildRequest,
  type CommandResult,
  type ImageInfo,
} from '../../src/container/types.js';

const CANARY = 'sk-live-CANARY-0123456789abcdef';

let root: string;
let src: string;
let outside: string;

function write(rel: string, content: string | Buffer = '', mode?: number): string {
  const abs = path.join(src, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mode !== undefined) fs.chmodSync(abs, mode);
  return abs;
}

function nodeProject(extra: Record<string, unknown> = {}): void {
  write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0', ...extra }));
  write('package-lock.json', '{}');
  write('index.js', 'console.log("hello")\n');
}

function listTree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) out.push(...listTree(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

function allBytes(dir: string): Buffer[] {
  return listTree(dir).map((rel) => fs.readFileSync(path.join(dir, ...rel.split('/'))));
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, spawnFailed: false };
}

interface FakeOptions {
  info?: (labelFromFile: string) => ImageInfo | null;
  buildError?: Error;
  /** Make removeImage (the best-effort untag after a failed verification) throw. */
  removeError?: Error;
}

function fakeRuntime(options: FakeOptions = {}) {
  const builds: BuildRequest[] = [];
  const runner = vi.fn(async (_file: string, _args: readonly string[]) => ok());
  const runtime: PackagingRuntime = {
    runner,
    removeImage: vi.fn(async (_ref: string) => {
      if (options.removeError) throw options.removeError;
    }),
    buildImage: vi.fn(async (request: BuildRequest) => {
      builds.push(request);
      if (options.buildError) throw options.buildError;
      return { imageId: 'sha256:' + 'e'.repeat(64), tag: request.tag };
    }),
    inspectImage: vi.fn(async (ref: string) => {
      const request = builds[builds.length - 1];
      const manifestFile = path.join(path.dirname(request?.dockerfile ?? ''), MANIFEST_FILE);
      const label = manifestToLabel(parseManifest(fs.readFileSync(manifestFile, 'utf8')));
      const custom = options.info?.(label);
      if (custom !== undefined) return custom;
      return {
        id: 'sha256:' + 'e'.repeat(64),
        repoTags: [ref],
        repoDigests: [],
        labels: { [LABEL_MANIFEST]: label },
        user: '10001:10001',
        sizeBytes: 1,
      };
    }),
  };
  return { runtime, runner, builds };
}

function pkgOptions(extra: Partial<ContainerPackageOptions> = {}): ContainerPackageOptions {
  return { sourceDir: src, runtime: fakeRuntime().runtime, build: false, ...extra };
}

async function failure(options: ContainerPackageOptions): Promise<ContainerError> {
  try {
    await packageContainer(options);
  } catch (err) {
    expect(err).toBeInstanceOf(ContainerError);
    return err as ContainerError;
  }
  throw new Error('expected packageContainer to reject');
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'avt-b-pkg-')));
  src = path.join(root, 'my-agent');
  outside = path.join(root, 'outside');
  fs.mkdirSync(src);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('packageContainer (generate only)', () => {
  it('writes Dockerfile, agentvault.json and a staged context to dist/container', async () => {
    nodeProject();
    const r = await packageContainer(pkgOptions());
    expect(r.outputDir).toBe(path.join(src, 'dist', 'container'));
    expect(r.contextDir).toBe(path.join(r.outputDir, 'context'));
    expect(r.dockerfilePath).toBe(path.join(r.outputDir, 'Dockerfile'));
    expect(r.manifestPath).toBe(path.join(r.outputDir, 'agentvault.json'));
    expect(r.imageTag).toBe('agentvault/my-agent:1.0.0');
    expect(r.imageId).toBeUndefined();
    expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('RUN npm ci --omit=dev --ignore-scripts');
    expect(r.stats.files).toBe(3);
  });

  it('does not call the runtime when build is false', async () => {
    nodeProject();
    const fake = fakeRuntime();
    await packageContainer({ sourceDir: src, runtime: fake.runtime, build: false });
    expect(fake.runtime.buildImage).not.toHaveBeenCalled();
    expect(fake.runtime.inspectImage).not.toHaveBeenCalled();
    expect(fake.runner).not.toHaveBeenCalled();
  });

  it('writes a manifest that validates, matches the result, and records names only', async () => {
    nodeProject();
    process.env['AVT_B_TEST_API_KEY'] = CANARY;
    try {
      const r = await packageContainer(
        pkgOptions({ env: ['AVT_B_TEST_API_KEY', 'MODEL'], secrets: ['anthropic', 'openai'], volumes: ['/data', '/memory'] })
      );
      const onDisk = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as unknown;
      expect(containerManifestSchema.parse(onDisk)).toEqual(r.manifest);
      expect(r.manifest).toMatchObject({
        schemaVersion: 1,
        name: 'my-agent',
        version: '1.0.0',
        runtime: 'node',
        entrypoint: ['node', 'index.js'],
        volumes: ['/data', '/memory'],
        env: ['AVT_B_TEST_API_KEY', 'MODEL'],
        secrets: ['anthropic', 'openai'],
        isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true },
        source: { type: 'generic' },
      });
      expect(r.manifest.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
      for (const bytes of [fs.readFileSync(r.manifestPath), fs.readFileSync(r.dockerfilePath), ...allBytes(r.contextDir)]) {
        expect(bytes.includes(CANARY)).toBe(false);
      }
      expect(r.warnings.join('\n')).toMatch(/AVT_B_TEST_API_KEY looks like a credential/);
    } finally {
      delete process.env['AVT_B_TEST_API_KEY'];
    }
  });

  it('defaults: volumes /data, network none; network proxy when secrets are declared', async () => {
    nodeProject();
    const plain = await packageContainer(pkgOptions());
    expect(plain.manifest.volumes).toEqual(['/data']);
    expect(plain.manifest.isolation.network).toBe('none');
    const withSecrets = await packageContainer(pkgOptions({ secrets: ['anthropic'] }));
    expect(withSecrets.manifest.isolation.network).toBe('proxy');
  });

  it('refuses secrets on network none, and warns on bridge', async () => {
    nodeProject();
    expect((await failure(pkgOptions({ secrets: ['anthropic'], network: 'none' }))).message).toMatch(/proxy/);
    const warnings: string[] = [];
    const r = await packageContainer(pkgOptions({ network: 'bridge', onWarning: (m) => warnings.push(m) }));
    expect(r.manifest.isolation.network).toBe('bridge');
    expect(warnings.join('\n')).toMatch(/unrestricted/);
    expect(r.warnings).toEqual(warnings);
  });

  it('renders a healthcheck from healthUrl', async () => {
    nodeProject();
    const r = await packageContainer(pkgOptions({ healthUrl: 'http://localhost:8080/health' }));
    expect(r.manifest.healthcheck?.test.slice(0, 2)).toEqual(['node', '-e']);
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toMatch(/^HEALTHCHECK --interval=30s /m);
  });

  it('packages a python agent', async () => {
    write('requirements.txt', '# none\n');
    write('main.py', 'print("hi")\n');
    const r = await packageContainer(pkgOptions());
    expect(r.manifest).toMatchObject({ runtime: 'python', entrypoint: ['python', 'main.py'] });
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('FROM python:3.12-slim');
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('RUN pip install --no-cache-dir -r requirements.txt');
  });

  it('honours entrypoint, base, name, image and runtimeKind options', async () => {
    nodeProject();
    write('server.js');
    write('main.py');
    write('requirements.txt');
    const r = await packageContainer(
      pkgOptions({ entrypoint: ['node', 'server.js', '--x'], base: 'node:20-slim', name: 'Custom Name', image: 'registry.local:5000/team/custom:v1', runtimeKind: 'node' })
    );
    expect(r.manifest.entrypoint).toEqual(['node', 'server.js', '--x']);
    expect(r.manifest.name).toBe('custom-name');
    expect(r.imageTag).toBe('registry.local:5000/team/custom:v1');
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('FROM node:20-slim');
  });

  it('reports missing and non-directory sources', async () => {
    expect((await failure({ sourceDir: path.join(root, 'nope'), runtime: fakeRuntime().runtime, build: false })).code).toBe('NOT_FOUND');
    write('file.txt');
    expect((await failure({ sourceDir: path.join(src, 'file.txt'), runtime: fakeRuntime().runtime, build: false })).code).toBe('INVALID_INPUT');
  });

  it('surfaces detection errors (ambiguity, TypeScript) without writing anything', async () => {
    write('package.json', '{}');
    write('requirements.txt');
    write('index.js');
    expect((await failure(pkgOptions())).message).toMatch(/Cannot tell/);
    fs.rmSync(path.join(src, 'requirements.txt'));
    fs.rmSync(path.join(src, 'index.js'));
    write('index.ts');
    expect((await failure(pkgOptions())).message).toMatch(/TypeScript/);
    expect(fs.existsSync(path.join(src, 'dist'))).toBe(false);
  });
});

describe('option validation', () => {
  beforeEach(() => nodeProject());

  it.each([
    ['volumes', { volumes: ['data'] }],
    ['volumes', { volumes: ['/a/../b'] }],
    ['volumes', { volumes: ['/'] }],
    ['volumes', { volumes: ['/a/b', '/a-b'] }],
    ['volumes', { volumes: ['/data;rm'] }],
    ['env', { env: ['1BAD'] }],
    ['env', { env: ['A=B'] }],
    ['env', { env: ['$(id)'] }],
    ['secrets', { secrets: ['Upper'] }],
    ['secrets', { secrets: ['a_b'] }],
    ['secrets', { secrets: ['a\nb'] }],
    ['network', { network: 'host' as never }],
    ['image', { image: 'Upper/Case:1' }],
    ['image', { image: '-evil' }],
    ['image', { image: 'name with space' }],
    ['image', { image: 'name@sha256:' + 'a'.repeat(64) }],
    ['image', { image: 'name:bad tag' }],
    ['image', { image: 'name:' + 'a'.repeat(129) }],
    ['platform', { platform: 'linux/amd64 --privileged' }],
    ['platform', { platform: 'x' }],
    ['healthUrl', { healthUrl: 'http://example.com/' }],
    ['base', { base: 'node:22\nRUN id' }],
    ['entrypoint', { entrypoint: ['node', '../x.js'] }],
    ['entrypoint', { entrypoint: ['node', 'index.js\nRUN id'] }],
  ] satisfies Array<[string, Partial<ContainerPackageOptions>]>)('rejects bad %s %#', async (_what, extra) => {
    const outputDir = path.join(root, 'out-' + Math.random().toString(16).slice(2));
    const err = await failure(pkgOptions({ ...extra, outputDir }));
    expect(['INVALID_INPUT', 'NOT_FOUND']).toContain(err.code);
    // Validation happens before anything touches the disk.
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('refuses a manifest whose label would be enormous', async () => {
    const outputDir = path.join(root, 'huge-out');
    const err = await failure(pkgOptions({ outputDir, entrypoint: ['node', 'index.js', ...Array.from({ length: 20 }, () => 'x'.repeat(4000))] }));
    expect(err.message).toMatch(/Manifest label exceeds/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('deduplicates env, secrets and volumes', async () => {
    const r = await packageContainer(pkgOptions({ env: ['A', 'A', 'B'], secrets: ['x', 'x'], volumes: ['/d', '/d'] }));
    expect(r.manifest.env).toEqual(['A', 'B']);
    expect(r.manifest.secrets).toEqual(['x']);
    expect(r.manifest.volumes).toEqual(['/d']);
  });

  it('does not warn about ordinary env names', async () => {
    const r = await packageContainer(pkgOptions({ env: ['MODEL', 'WORKSPACE'] }));
    expect(r.warnings).toEqual([]);
  });
});

describe('build context staging', () => {
  it('never copies symlinks (index.js -> /etc/passwd) and reports them', async () => {
    write('package.json', JSON.stringify({ name: 'demo', main: 'main.js' }));
    write('main.js', 'console.log(1)');
    fs.symlinkSync('/etc/passwd', path.join(src, 'index.js'));
    fs.symlinkSync(outside, path.join(src, 'linked-dir'));
    fs.symlinkSync('main.js', path.join(src, 'alias.js'));
    fs.writeFileSync(path.join(outside, 'host-secret.txt'), CANARY);
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['main.js', 'package.json']);
    expect(fs.existsSync(path.join(r.contextDir, 'index.js'))).toBe(false);
    for (const p of ['alias.js', 'index.js', 'linked-dir']) {
      expect(r.skipped).toContainEqual({ path: p, reason: expect.stringMatching(/symbolic link/) });
    }
    expect(r.warnings.join('\n')).toMatch(/3 symbolic link\(s\) were not copied/);
    for (const bytes of allBytes(r.contextDir)) expect(bytes.includes(CANARY)).toBe(false);
  });

  it('never stages secrets or build output, and the canary appears nowhere', async () => {
    nodeProject();
    const planted = [
      '.env', '.env.local', '.env.production', 'config/.env', 'server.pem', 'tls/private.key', 'cert.p12', 'cert.pfx',
      'id_rsa', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.DS_Store', 'debug.log', 'logs/app.log',
      '.git/config', '.git/objects/ab/cdef', 'node_modules/dep/index.js', '.agentvault/hypervault.json',
      'dist/bundle.js', '.venv/bin/python', 'venv/pyvenv.cfg', '__pycache__/x.pyc', 'pkg/__pycache__/y.pyc',
      '.ssh/id_rsa', '.aws/credentials', '.dockerignore', '.git-credentials',
    ];
    for (const rel of planted) write(rel, `TOKEN=${CANARY}\n`);
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
    for (const file of [r.dockerfilePath, r.manifestPath]) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain(CANARY);
    }
    for (const bytes of allBytes(r.contextDir)) expect(bytes.includes(CANARY)).toBe(false);
    const skippedPaths = r.skipped.map((s) => s.path);
    for (const expected of ['.env', '.env.local', 'server.pem', 'tls/', 'node_modules/', '.git/', 'dist/', '.agentvault/', '.venv/', '__pycache__/', 'pkg/__pycache__/']) {
      if (expected === 'tls/') continue; // tls/ itself is kept; only private.key inside is skipped
      expect(skippedPaths, expected).toContain(expected);
    }
    expect(skippedPaths).toContain('tls/private.key');
    expect(r.warnings.join('\n')).toMatch(/\.env.*not copied into the image/);
  });

  it('matches the denylist case-insensitively', async () => {
    nodeProject();
    write('.ENV', CANARY);
    write('SERVER.PEM', CANARY);
    write('Node_Modules/x.js', CANARY);
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
  });

  it('skips sockets and FIFOs and reports them', async () => {
    nodeProject();
    let fifo = false;
    try {
      execFileSync('mkfifo', [path.join(src, 'pipe')]);
      fifo = true;
    } catch {
      // mkfifo unavailable on this platform
    }
    const server = net.createServer();
    const sock = path.join(src, 's.sock');
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const r = await packageContainer(pkgOptions());
      expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
      expect(r.skipped).toContainEqual({ path: 's.sock', reason: expect.stringMatching(/not a regular file/) });
      if (fifo) expect(r.skipped).toContainEqual({ path: 'pipe', reason: expect.stringMatching(/not a regular file/) });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('skips file names containing control characters', async () => {
    nodeProject();
    write('bad\nname.txt', 'x');
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
    expect(r.skipped).toContainEqual({ path: 'bad?name.txt', reason: expect.stringMatching(/control character/) });
  });

  it('copies bytes exactly (binary safe) and normalizes modes', async () => {
    nodeProject();
    const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    write('data/blob.bin', binary, 0o600);
    write('bin/run.sh', '#!/bin/sh\n', 0o700);
    write('lib/ro.js', 'x', 0o444);
    const r = await packageContainer(pkgOptions());
    expect(fs.readFileSync(path.join(r.contextDir, 'data', 'blob.bin')).equals(binary)).toBe(true);
    const mode = (rel: string): number => fs.statSync(path.join(r.contextDir, rel)).mode & 0o777;
    expect(mode('data/blob.bin')).toBe(0o644);
    expect(mode('lib/ro.js')).toBe(0o644);
    expect(mode('bin/run.sh')).toBe(0o755);
    expect(mode('data')).toBe(0o755);
    expect(mode('.')).toBe(0o755);
  });

  it('ignores a symlinked requirements.txt (it would not be copied) and warns', async () => {
    write('main.py');
    fs.writeFileSync(path.join(outside, 'requirements.txt'), 'evil==1\n');
    fs.symlinkSync(path.join(outside, 'requirements.txt'), path.join(src, 'requirements.txt'));
    const r = await packageContainer(pkgOptions());
    expect(r.warnings.join('\n')).toMatch(/requirements\.txt is a symbolic link/);
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).not.toContain('requirements.txt');
    expect(fs.existsSync(path.join(r.contextDir, 'requirements.txt'))).toBe(false);
  });

  it('excludes a custom output directory inside the source, and re-running does not recurse into it', async () => {
    nodeProject();
    const outputDir = path.join(src, 'build-out');
    const first = await packageContainer(pkgOptions({ outputDir }));
    const second = await packageContainer(pkgOptions({ outputDir }));
    expect(listTree(second.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
    expect(second.skipped).toContainEqual({ path: 'build-out/', reason: 'output directory' });
    expect(second.manifest.source.contentHash).toBe(first.manifest.source.contentHash);
  });

  it('does not stage the output of an earlier packaging run that lives elsewhere in the source', async () => {
    nodeProject();
    await packageContainer(pkgOptions({ outputDir: path.join(src, 'out-one') }));
    const second = await packageContainer(pkgOptions({ outputDir: path.join(src, 'out-two') }));
    expect(listTree(second.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
    expect(second.skipped).toContainEqual({ path: 'out-one/', reason: 'AgentVault packaging output' });
  });

  it('stages a nested tree', async () => {
    nodeProject();
    write('src/a/b/c.js', 'c');
    write('src/a/z.js', 'z');
    write('src/a.js', 'a');
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json', 'src/a.js', 'src/a/b/c.js', 'src/a/z.js']);
  });
});

describe('caps', () => {
  it('names the byte limit when a single sparse file exceeds 200 MB, and cleans up', async () => {
    nodeProject();
    const big = path.join(src, 'big.bin');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, MAX_CONTEXT_BYTES + 1);
    fs.closeSync(fd);
    const outputDir = path.join(root, 'out');
    const err = await failure(pkgOptions({ outputDir }));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/200 MB limit/);
    expect(fs.existsSync(path.join(outputDir, 'context'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'Dockerfile'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, MANIFEST_FILE))).toBe(false);
  });

  it('names the file limit when there are more than 20,000 files, and cleans up', async () => {
    nodeProject();
    fs.mkdirSync(path.join(src, 'many'));
    for (let i = 0; i < MAX_CONTEXT_FILES - 2; i++) fs.writeFileSync(path.join(src, 'many', `f${i}`), '');
    // 3 project files + 19,998 = 20,001 > limit
    const outputDir = path.join(root, 'out');
    const err = await failure(pkgOptions({ outputDir }));
    expect(err.message).toMatch(/20000-file limit/);
    expect(fs.existsSync(path.join(outputDir, 'context'))).toBe(false);
  }, 60_000);

  it('accepts exactly the file limit', () => {
    fs.mkdirSync(path.join(src, 'many'));
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(src, 'many', `f${i}`), 'x');
    const ctx = path.join(root, 'ctx');
    fs.mkdirSync(ctx);
    expect(stageBuildContext(src, ctx, { maxFiles: 25 }).files).toBe(25);
    fs.rmSync(ctx, { recursive: true });
    fs.mkdirSync(ctx);
    expect(() => stageBuildContext(src, ctx, { maxFiles: 24 })).toThrow(/24-file limit/);
    expect(listTree(ctx)).toEqual([]);
  });

  it('enforces maxBytes on planned and on actual sizes', () => {
    write('a', 'x'.repeat(600));
    write('b', 'x'.repeat(600));
    const ctx = path.join(root, 'ctx');
    fs.mkdirSync(ctx);
    expect(() => stageBuildContext(src, ctx, { maxBytes: 1000 })).toThrow(ContainerError);
    // The planned-size check fails fast: nothing was written before the error.
    expect(listTree(ctx)).toEqual([]);
    fs.rmSync(ctx, { recursive: true });
    fs.mkdirSync(ctx);
    expect(stageBuildContext(src, ctx, { maxBytes: 1200 }).bytes).toBe(1200);
  });

  it('exports the documented limits', () => {
    expect(MAX_CONTEXT_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_CONTEXT_FILES).toBe(20_000);
  });

  it('does not count excluded trees against the caps', async () => {
    nodeProject();
    fs.mkdirSync(path.join(src, 'node_modules'));
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(src, 'node_modules', `f${i}`), 'x');
    const ctx = path.join(root, 'ctx');
    fs.mkdirSync(ctx);
    expect(stageBuildContext(src, ctx, { maxFiles: 3 }).files).toBe(3);
  });
});

describe('determinism', () => {
  function project(): void {
    nodeProject();
    write('src/lib.js', 'lib');
    write('src/deep/x.js', 'x');
    write('bin/run', '#!/bin/sh\n', 0o755);
  }

  it('gives an identical contentHash, Dockerfile and manifest for the same source', async () => {
    project();
    const a = await packageContainer(pkgOptions({ outputDir: path.join(root, 'out-a') }));
    const b = await packageContainer(pkgOptions({ outputDir: path.join(root, 'out-b') }));
    expect(a.manifest.source.contentHash).toBe(b.manifest.source.contentHash);
    expect(fs.readFileSync(a.dockerfilePath, 'utf8')).toBe(fs.readFileSync(b.dockerfilePath, 'utf8'));
    expect(fs.readFileSync(a.manifestPath, 'utf8')).toBe(fs.readFileSync(b.manifestPath, 'utf8'));
  });

  it('is independent of mtimes and creation order', async () => {
    project();
    const a = await packageContainer(pkgOptions({ outputDir: path.join(root, 'out-a') }));
    const old = new Date('2001-01-01T00:00:00Z');
    for (const rel of listTree(src)) fs.utimesSync(path.join(src, rel), old, old);
    const b = await packageContainer(pkgOptions({ outputDir: path.join(root, 'out-b') }));
    expect(b.manifest.source.contentHash).toBe(a.manifest.source.contentHash);

    const other = path.join(root, 'my-agent');
    const copy = path.join(root, 'copy', 'my-agent');
    fs.mkdirSync(copy, { recursive: true });
    for (const rel of listTree(other).filter((r) => !r.startsWith('dist/')).reverse()) {
      fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
      fs.copyFileSync(path.join(other, rel), path.join(copy, rel));
      fs.chmodSync(path.join(copy, rel), fs.statSync(path.join(other, rel)).mode);
    }
    const c = await packageContainer({ ...pkgOptions({ outputDir: path.join(root, 'out-c') }), sourceDir: copy });
    expect(c.manifest.source.contentHash).toBe(a.manifest.source.contentHash);
  });

  it('changes when content, the executable bit, or a path changes', async () => {
    project();
    const base = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o1') }))).manifest.source.contentHash;

    write('src/lib.js', 'lib2');
    const content = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o2') }))).manifest.source.contentHash;
    expect(content).not.toBe(base);
    write('src/lib.js', 'lib');

    fs.chmodSync(path.join(src, 'bin', 'run'), 0o644);
    const exec = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o3') }))).manifest.source.contentHash;
    expect(exec).not.toBe(base);
    fs.chmodSync(path.join(src, 'bin', 'run'), 0o755);

    fs.renameSync(path.join(src, 'src', 'lib.js'), path.join(src, 'src', 'lib2.js'));
    const renamed = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o4') }))).manifest.source.contentHash;
    expect(renamed).not.toBe(base);
    fs.renameSync(path.join(src, 'src', 'lib2.js'), path.join(src, 'src', 'lib.js'));

    const again = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o5') }))).manifest.source.contentHash;
    expect(again).toBe(base);
  });

  it('cannot be confused by a file whose content looks like a framed entry', async () => {
    write('package.json', '{}');
    write('index.js', '');
    write('a', 'xb\0-\x001\0y');
    const one = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o1') }))).manifest.source.contentHash;
    fs.rmSync(path.join(src, 'a'));
    write('a', 'x');
    write('b', 'y');
    const two = (await packageContainer(pkgOptions({ outputDir: path.join(root, 'o2') }))).manifest.source.contentHash;
    expect(one).not.toBe(two);
  });
});

describe('output directory safety and cleanup', () => {
  beforeEach(() => nodeProject());

  it('refuses the source directory and any ancestor of it', async () => {
    expect((await failure(pkgOptions({ outputDir: src }))).message).toMatch(/must not be the source directory/);
    expect((await failure(pkgOptions({ outputDir: root }))).message).toMatch(/must not be the source directory/);
    expect((await failure(pkgOptions({ outputDir: path.join(src, '..') }))).code).toBe('INVALID_INPUT');
    expect(fs.existsSync(path.join(src, 'Dockerfile'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'context'))).toBe(false);
  });

  it('refuses a non-empty directory it did not create, and leaves it untouched', async () => {
    const mine = path.join(root, 'precious');
    fs.mkdirSync(path.join(mine, 'context'), { recursive: true });
    fs.writeFileSync(path.join(mine, 'context', 'thesis.docx'), 'irreplaceable');
    fs.writeFileSync(path.join(mine, 'Dockerfile'), 'FROM scratch\n');
    const err = await failure(pkgOptions({ outputDir: mine }));
    expect(err.message).toMatch(/not empty and was not created by AgentVault/);
    expect(fs.readFileSync(path.join(mine, 'context', 'thesis.docx'), 'utf8')).toBe('irreplaceable');
    expect(fs.readFileSync(path.join(mine, 'Dockerfile'), 'utf8')).toBe('FROM scratch\n');
  });

  it('refuses an output path that is a file', async () => {
    const file = path.join(root, 'afile');
    fs.writeFileSync(file, 'x');
    expect((await failure(pkgOptions({ outputDir: file }))).message).toMatch(/not a directory/);
  });

  it('accepts an existing empty directory and replaces stale output on re-run', async () => {
    const out = path.join(root, 'empty');
    fs.mkdirSync(out);
    const first = await packageContainer(pkgOptions({ outputDir: out }));
    expect(fs.existsSync(path.join(out, OUTPUT_MARKER))).toBe(true);
    write('extra.js', 'x');
    fs.rmSync(path.join(src, 'extra.js'));
    fs.writeFileSync(path.join(first.contextDir, 'stale.txt'), 'stale');
    const second = await packageContainer(pkgOptions({ outputDir: out }));
    expect(listTree(second.contextDir)).toEqual(['index.js', 'package-lock.json', 'package.json']);
  });

  it('removes the half-written context and files when staging fails, keeping only the marker', async () => {
    write('big.bin', 'x'.repeat(2000));
    const out = path.join(root, 'out');
    const ctx = path.join(root, 'ctx-direct');
    fs.mkdirSync(ctx);
    expect(() => stageBuildContext(src, ctx, { maxBytes: 1500 })).toThrow(/limit/);

    const fd = fs.openSync(path.join(src, 'huge.bin'), 'w');
    fs.ftruncateSync(fd, MAX_CONTEXT_BYTES + 10);
    fs.closeSync(fd);
    await failure(pkgOptions({ outputDir: out }));
    expect(fs.readdirSync(out)).toEqual([OUTPUT_MARKER]);
  });

  it('cleans up a previous successful run when a later run fails', async () => {
    const out = path.join(root, 'out');
    await packageContainer(pkgOptions({ outputDir: out }));
    const fd = fs.openSync(path.join(src, 'huge.bin'), 'w');
    fs.ftruncateSync(fd, MAX_CONTEXT_BYTES + 10);
    fs.closeSync(fd);
    await failure(pkgOptions({ outputDir: out }));
    expect(fs.readdirSync(out)).toEqual([OUTPUT_MARKER]);
  });

  it('does not follow a symlinked context directory when cleaning', async () => {
    const out = path.join(root, 'out');
    await packageContainer(pkgOptions({ outputDir: out }));
    fs.rmSync(path.join(out, 'context'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(out, 'context'));
    await packageContainer(pkgOptions({ outputDir: out }));
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.lstatSync(path.join(out, 'context')).isSymbolicLink()).toBe(false);
  });
});

describe('build + verification', () => {
  beforeEach(() => nodeProject());

  it('builds with the generated Dockerfile and context, then verifies label and user', async () => {
    const fake = fakeRuntime();
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, platform: 'linux/arm64', noCache: true });
    expect(fake.builds).toEqual([
      { contextDir: r.contextDir, dockerfile: r.dockerfilePath, tag: 'agentvault/my-agent:1.0.0', platform: 'linux/arm64', noCache: true },
    ]);
    expect(r.imageId).toBe('sha256:' + 'e'.repeat(64));
    expect(r.imageTag).toBe('agentvault/my-agent:1.0.0');
    expect(fake.runtime.inspectImage).toHaveBeenCalledWith('agentvault/my-agent:1.0.0');
    expect(fake.runner).not.toHaveBeenCalled();
    expect(fake.runtime.removeImage).not.toHaveBeenCalled();
  });

  it('omits platform and noCache when not requested', async () => {
    const fake = fakeRuntime();
    await packageContainer({ sourceDir: src, runtime: fake.runtime });
    expect(Object.keys(fake.builds[0] ?? {}).sort()).toEqual(['contextDir', 'dockerfile', 'tag']);
  });

  it('uses a custom image tag', async () => {
    const fake = fakeRuntime();
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, image: 'team/agent:dev' });
    expect(fake.builds[0]?.tag).toBe('team/agent:dev');
    expect(r.imageTag).toBe('team/agent:dev');
  });

  const failing: Array<[string, FakeOptions, string, RegExp]> = [
    ['the manifest label is missing', { info: () => ({ id: 'x', repoTags: [], repoDigests: [], labels: {}, user: '10001:10001', sizeBytes: 1 }) }, 'INTEGRITY', /no agentvault\.manifest label/],
    ['the manifest label is not JSON', { info: () => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: '{nope' }, user: '10001:10001', sizeBytes: 1 }) }, 'INTEGRITY', /invalid manifest label/],
    ['the user is empty (root)', { info: (label) => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: label }, user: '', sizeBytes: 1 }) }, 'POLICY_VIOLATION', /root/],
    ['the user is root', { info: (label) => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: label }, user: 'root', sizeBytes: 1 }) }, 'POLICY_VIOLATION', /root/],
    ['the user is 0:0', { info: (label) => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: label }, user: '0:0', sizeBytes: 1 }) }, 'POLICY_VIOLATION', /root/],
    ['the user is a different uid', { info: (label) => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: label }, user: '1000:1000', sizeBytes: 1 }) }, 'INTEGRITY', /expected 10001:10001/],
    [
      'the label differs from the written manifest',
      {
        info: (label) => {
          const changed = JSON.parse(label) as { entrypoint: string[] };
          changed.entrypoint = ['node', 'evil.js'];
          return { id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: JSON.stringify(changed) }, user: '10001:10001', sizeBytes: 1 };
        },
      },
      'INTEGRITY',
      /does not match/,
    ],
  ];
  it.each(failing)('rejects the image when %s, and untags it', async (_name, options, code, message) => {
    const fake = fakeRuntime(options);
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
    expect(fake.runtime.removeImage).toHaveBeenCalledWith('agentvault/my-agent:1.0.0');
  });

  it('reports the verification error even when untagging the image also fails', async () => {
    const fake = fakeRuntime({
      removeError: new ContainerError('COMMAND_FAILED', 'docker image rm failed: boom'),
      info: (label) => ({ id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: label }, user: '1000:1000', sizeBytes: 1 }),
    });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(fake.runtime.removeImage).toHaveBeenCalledTimes(1);
    expect(err.code).toBe('INTEGRITY');
    expect(err.message).toMatch(/expected 10001:10001/);
    expect(err.message).not.toMatch(/image rm failed/);
  });

  it('rejects and untags an image that cannot be found after the build', async () => {
    const fake = fakeRuntime();
    (fake.runtime.inspectImage as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('INTEGRITY');
    expect(err.message).toMatch(/not found after the build/);
    expect(fake.runtime.removeImage).toHaveBeenCalledWith('agentvault/my-agent:1.0.0');
  });

  it('propagates a build failure and keeps the generated files for debugging', async () => {
    const fake = fakeRuntime({ buildError: new ContainerError('COMMAND_FAILED', 'docker build failed: boom') });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('COMMAND_FAILED');
    expect(fs.existsSync(path.join(src, 'dist', 'container', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(src, 'dist', 'container', 'context', 'index.js'))).toBe(true);
    expect(fake.runtime.inspectImage).not.toHaveBeenCalled();
  });
});
