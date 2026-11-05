import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerRuntime } from '../../src/container/docker.js';
import { containerManifestSchema, manifestToLabel, parseManifest, MANIFEST_FILE } from '../../src/container/manifest.js';
import {
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILES,
  OUTPUT_LOCK,
  OUTPUT_MARKER,
  acquireOutputLock,
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
  /** What inspecting a freshly built image reports, given the label the packager wrote next to the Dockerfile. */
  info?: (labelFromFile: string) => ImageInfo | null;
  buildError?: Error;
  /** Make removeImage (the best-effort untag after a failed verification) throw. */
  removeError?: Error;
  /** Images that exist before packaging starts, by tag. */
  existing?: Record<string, ImageInfo>;
  /** Runs inside buildImage, before it returns or fails. */
  duringBuild?: (request: BuildRequest) => Promise<void> | void;
}

const BUILT_ID = 'sha256:' + 'e'.repeat(64);

function image(id: string, tags: string[], labels: Record<string, string> = {}): ImageInfo {
  return { id, repoTags: tags, repoDigests: [], labels, user: '10001:10001', sizeBytes: 1 };
}

/** A runtime double that models tags: build adds one, tagImage copies one, removeImage drops one. */
function fakeRuntime(options: FakeOptions = {}) {
  const builds: BuildRequest[] = [];
  const images = new Map<string, ImageInfo>(Object.entries(options.existing ?? {}));
  const builtTags = new Set<string>();
  const calls: string[] = [];
  const runner = vi.fn(async (_file: string, _args: readonly string[]) => ok());
  const runtime: PackagingRuntime = {
    runner,
    removeImage: vi.fn(async (ref: string) => {
      calls.push(`rm ${ref}`);
      if (options.removeError) throw options.removeError;
      images.delete(ref);
    }),
    tagImage: vi.fn(async (source: string, target: string) => {
      calls.push(`tag ${source} ${target}`);
      const info = images.get(source);
      if (info === undefined) throw new ContainerError('NOT_FOUND', `no such image ${source}`);
      images.set(target, info);
    }),
    buildImage: vi.fn(async (request: BuildRequest) => {
      calls.push(`build ${request.tag}`);
      builds.push(request);
      await options.duringBuild?.(request);
      if (options.buildError) throw options.buildError;
      const manifestFile = path.join(path.dirname(request.dockerfile ?? ''), MANIFEST_FILE);
      const label = manifestToLabel(parseManifest(fs.readFileSync(manifestFile, 'utf8')));
      images.set(request.tag, image(BUILT_ID, [request.tag], { [LABEL_MANIFEST]: label }));
      builtTags.add(request.tag);
      return { imageId: BUILT_ID, tag: request.tag };
    }),
    inspectImage: vi.fn(async (ref: string) => {
      calls.push(`inspect ${ref}`);
      const found = images.get(ref) ?? null;
      if (found !== null && builtTags.has(ref) && options.info !== undefined) {
        const custom = options.info(found.labels[LABEL_MANIFEST] as string);
        if (custom !== undefined) return custom;
      }
      return found;
    }),
  };
  return { runtime, runner, builds, images, calls, builtTag: (): string => builds[0]?.tag ?? '' };
}

/** The label a real AgentVault image of agent `name` carries. */
function agentvaultLabel(name: string): string {
  return manifestToLabel(
    parseManifest({
      schemaVersion: 1,
      name,
      version: '0.9.0',
      runtime: 'node',
      entrypoint: ['node', 'index.js'],
      volumes: ['/data'],
      env: [],
      secrets: [],
      isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
      source: { type: 'generic', contentHash: 'a'.repeat(64) },
    })
  );
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

  describe('dist/ (compiled TypeScript output)', () => {
    it('stages compiled code under dist/ and runs it', async () => {
      nodeProject({ main: 'dist/index.js' });
      write('dist/index.js', 'console.log("compiled")\n');
      write('dist/lib/util.js', 'module.exports = 1\n');
      const r = await packageContainer(pkgOptions());
      expect(listTree(r.contextDir)).toEqual(['dist/index.js', 'dist/lib/util.js', 'index.js', 'package-lock.json', 'package.json']);
      expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('"dist/index.js"');
      expect(r.skipped.map((s) => s.path)).not.toContain('dist/');
    });

    it('does not nest AgentVault output inside the context on a re-run (default dist/container)', async () => {
      nodeProject({ main: 'dist/index.js' });
      write('dist/index.js');
      const first = await packageContainer(pkgOptions());
      const second = await packageContainer(pkgOptions());
      expect(listTree(second.contextDir)).toEqual(listTree(first.contextDir));
      expect(listTree(second.contextDir).some((p) => p.includes('container/') || p.includes('Dockerfile'))).toBe(false);
      expect(second.skipped).toContainEqual({ path: 'dist/container/', reason: 'output directory' });
    });

    it('skips a previous default output even when this run writes elsewhere', async () => {
      nodeProject({ main: 'dist/index.js' });
      write('dist/index.js');
      await packageContainer(pkgOptions()); // leaves <src>/dist/container behind
      const elsewhere = path.join(outside, 'out');
      const r = await packageContainer(pkgOptions({ outputDir: elsewhere }));
      expect(listTree(r.contextDir)).toEqual(['dist/index.js', 'index.js', 'package-lock.json', 'package.json']);
      expect(r.skipped).toContainEqual({ path: 'dist/container/', reason: 'AgentVault packaging output' });
    });
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
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('RUN pip install --no-cache-dir --no-input -r requirements.txt');
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

  it('keeps an executable entrypoint path-like in the manifest and in CMD', async () => {
    nodeProject();
    write('run.sh', '#!/bin/sh\necho hi\n', 0o755);
    const r = await packageContainer(pkgOptions({ entrypoint: ['./run.sh', '--x'] }));
    expect(r.manifest.entrypoint).toEqual(['./run.sh', '--x']);
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).toContain('\nCMD ["./run.sh","--x"]\n');
    expect(fs.statSync(path.join(r.contextDir, 'run.sh')).mode & 0o111).not.toBe(0);
  });

  it('passes the pip warnings of the detected project on to the caller', async () => {
    write('main.py');
    write('requirements.txt', 'requests==2.31.0\n--extra-index-url http://x\n');
    const seen: string[] = [];
    const r = await packageContainer(pkgOptions({ onWarning: (m) => seen.push(m) }));
    expect(r.warnings.join('\n')).toMatch(/requirements\.txt line 2 \(--extra-index-url\)/);
    expect(seen).toEqual(r.warnings);
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
      '.venv/bin/python', 'venv/pyvenv.cfg', '__pycache__/x.pyc', 'pkg/__pycache__/y.pyc',
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
    for (const expected of ['.env', '.env.local', 'server.pem', 'tls/', 'node_modules/', '.git/', '.agentvault/', '.venv/', '__pycache__/', 'pkg/__pycache__/']) {
      if (expected === 'tls/') continue; // tls/ itself is kept; only private.key inside is skipped
      expect(skippedPaths, expected).toContain(expected);
    }
    expect(skippedPaths).toContain('tls/private.key');
    expect(r.warnings.join('\n')).toMatch(/\.env.*not copied into the image/);
  });

  it('stages none of the env-file variants, backups or credential files the original list missed, and lists them as skipped', async () => {
    nodeProject();
    const planted = [
      '.env~', '.env-prod', '.env_local', '.envs', 'prod.env', '.env_dir/inner.txt', 'server.key.bak', 'server.pem~', 'tls.key.old',
      'my_id_rsa', 'credentials.json', 'secrets.json', 'service-account.json', 'terraform.tfstate', 'prod.tfvars', '.htpasswd',
      '.vault-token', 'kubeconfig', '.boto', '.s3cfg', '.dockercfg', 'key.p8', 'key.ppk', 'db.kdbx', 'secret.gpg', '.bash_history',
    ];
    for (const rel of planted) write(rel, `TOKEN=${CANARY}\n`);
    // Ordinary source that merely looks similar must still ship.
    for (const rel of ['env', 'env.py', 'env.js', 'environment.js']) write(rel, 'module.exports = {}\n');
    const r = await packageContainer(pkgOptions());
    expect(listTree(r.contextDir)).toEqual(['env', 'env.js', 'env.py', 'environment.js', 'index.js', 'package-lock.json', 'package.json']);
    for (const bytes of allBytes(r.contextDir)) expect(bytes.includes(CANARY)).toBe(false);
    const skipped = r.skipped.map((s) => s.path);
    for (const rel of planted) expect(skipped, rel).toContain(rel.startsWith('.env_dir/') ? '.env_dir/' : rel);
    expect(r.warnings.join('\n')).toMatch(/\.env~.*not copied into the image/);
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

describe('files that change between the scan and the copy', () => {
  // stageBuildContext lstat()s everything first and opens the files afterwards.
  // `afterScan` runs exactly between the two phases: the window another process
  // on the machine would use. No timing is involved, so these tests are exact.
  let ctx: string;

  beforeEach(() => {
    ctx = path.join(root, 'ctx');
    fs.mkdirSync(ctx);
  });

  const fifoSupported = ((): boolean => {
    const probe = path.join(os.tmpdir(), `avt-fifo-probe-${process.pid}`);
    try {
      execFileSync('mkfifo', [probe]);
      fs.rmSync(probe);
      return true;
    } catch {
      return false; // mkfifo unavailable on this platform
    }
  })();

  it('does not read through a directory swapped for a symlink after the scan', () => {
    write('index.js', 'ok');
    write('keep/a.js', 'a');
    write('sub/passwd', 'placeholder');
    fs.writeFileSync(path.join(outside, 'passwd'), CANARY);
    const result = stageBuildContext(src, ctx, {
      afterScan: () => {
        fs.renameSync(path.join(src, 'sub'), path.join(src, 'sub.real'));
        fs.symlinkSync(outside, path.join(src, 'sub'));
      },
    });
    expect(listTree(ctx)).toEqual(['index.js', 'keep/a.js']);
    expect(result.skipped).toContainEqual({ path: 'sub/passwd', reason: 'changed while packaging' });
    for (const bytes of allBytes(ctx)) expect(bytes.includes(CANARY)).toBe(false);
  });

  // Without O_NONBLOCK, opening a FIFO that has no writer blocks the whole process for ever. A blocked
  // synchronous open cannot be interrupted by a test timeout, so this runs in a child process that is
  // killed after a while: a regression fails the test instead of hanging the suite.
  it.skipIf(!fifoSupported)('does not block on a regular file replaced by a FIFO after the scan', () => {
    write('index.js', 'ok');
    write('zz-last.js', 'x');
    const moduleUrl = new URL('../../src/container/package-image.ts', import.meta.url).href;
    const script = `
      import * as fs from 'node:fs';
      import * as path from 'node:path';
      import { execFileSync } from 'node:child_process';
      import { stageBuildContext } from ${JSON.stringify(moduleUrl)};
      const [src, ctx] = [process.env.AVT_SRC, process.env.AVT_CTX];
      const result = stageBuildContext(src, ctx, {
        afterScan: () => {
          fs.rmSync(path.join(src, 'zz-last.js'));
          execFileSync('mkfifo', [path.join(src, 'zz-last.js')]);
        },
      });
      process.stdout.write(JSON.stringify(result.skipped));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      env: { ...process.env, AVT_SRC: src, AVT_CTX: ctx },
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    expect(child.error, 'the child timed out: staging blocked on the FIFO').toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toContainEqual({ path: 'zz-last.js', reason: expect.stringMatching(/not a regular file/) });
    expect(listTree(ctx)).toEqual(['index.js']);
  });

  it('skips a file replaced by a different file after the scan', () => {
    write('index.js', 'ok');
    write('a.js', 'original');
    const result = stageBuildContext(src, ctx, {
      afterScan: () => {
        // Create the replacement before the original goes away so the two cannot share an inode number.
        write('a.js.new', 'replacement');
        fs.renameSync(path.join(src, 'a.js.new'), path.join(src, 'a.js'));
      },
    });
    expect(listTree(ctx)).toEqual(['index.js']);
    expect(result.skipped).toContainEqual({ path: 'a.js', reason: 'changed while packaging' });
  });

  it('skips a file replaced by a symlink after the scan', () => {
    write('index.js', 'ok');
    write('a.js', 'original');
    fs.writeFileSync(path.join(outside, 'host.js'), CANARY);
    const result = stageBuildContext(src, ctx, {
      afterScan: () => {
        fs.rmSync(path.join(src, 'a.js'));
        fs.symlinkSync(path.join(outside, 'host.js'), path.join(src, 'a.js'));
      },
    });
    expect(listTree(ctx)).toEqual(['index.js']);
    expect(result.skipped).toContainEqual({ path: 'a.js', reason: expect.stringMatching(/symbolic link/) });
  });

  it('still copies files that did not change', () => {
    write('index.js', 'ok');
    write('sub/b.js', 'b');
    const result = stageBuildContext(src, ctx, { afterScan: () => undefined });
    expect(listTree(ctx)).toEqual(['index.js', 'sub/b.js']);
    expect(result.files).toBe(2);
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

  it('builds under a private tag, verifies that, and only then gives the image its real tag', async () => {
    const fake = fakeRuntime();
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, platform: 'linux/arm64', noCache: true });
    const temp = fake.builtTag();
    expect(temp).toMatch(/^agentvault\/my-agent:build-[0-9a-f]{16}$/);
    expect(fake.builds).toEqual([{ contextDir: r.contextDir, dockerfile: r.dockerfilePath, tag: temp, platform: 'linux/arm64', noCache: true }]);
    expect(fake.calls).toEqual([
      'inspect agentvault/my-agent:1.0.0', // refuse before building when the tag is someone else's
      `build ${temp}`,
      `inspect ${temp}`, // verify the image under its private tag
      'inspect agentvault/my-agent:1.0.0', // the tag may have been claimed while it built
      `tag ${temp} agentvault/my-agent:1.0.0`,
      `rm ${temp}`, // drop the private tag again
    ]);
    expect(r.imageId).toBe(BUILT_ID);
    expect(r.imageTag).toBe('agentvault/my-agent:1.0.0');
    expect([...fake.images.keys()]).toEqual(['agentvault/my-agent:1.0.0']);
    expect(fake.runner).not.toHaveBeenCalled();
  });

  it('omits platform and noCache when not requested', async () => {
    const fake = fakeRuntime();
    await packageContainer({ sourceDir: src, runtime: fake.runtime });
    expect(Object.keys(fake.builds[0] ?? {}).sort()).toEqual(['contextDir', 'dockerfile', 'tag']);
  });

  it('uses a custom image tag', async () => {
    const fake = fakeRuntime();
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, image: 'team/agent:dev' });
    expect(fake.calls).toContain(`tag ${fake.builtTag()} team/agent:dev`);
    expect([...fake.images.keys()]).toEqual(['team/agent:dev']);
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
  it.each(failing)('rejects the image when %s, untags only its private tag, and never gives it the real tag', async (_name, options, code, message) => {
    const fake = fakeRuntime(options);
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe(code);
    expect(err.message).toMatch(message);
    expect(fake.runtime.removeImage).toHaveBeenCalledTimes(1);
    expect(fake.runtime.removeImage).toHaveBeenCalledWith(fake.builtTag());
    expect(fake.runtime.tagImage).not.toHaveBeenCalled();
    expect(fake.images.size).toBe(0);
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
    expect(fake.runtime.removeImage).toHaveBeenCalledWith(fake.builtTag());
    expect(fake.runtime.tagImage).not.toHaveBeenCalled();
  });

  it('propagates a build failure and keeps the generated files for debugging', async () => {
    const fake = fakeRuntime({ buildError: new ContainerError('COMMAND_FAILED', 'docker build failed: boom') });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('COMMAND_FAILED');
    expect(fs.existsSync(path.join(src, 'dist', 'container', 'Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.join(src, 'dist', 'container', 'context', 'index.js'))).toBe(true);
    expect(fake.calls).toEqual(['inspect agentvault/my-agent:1.0.0', `build ${fake.builtTag()}`]);
  });

  it('warns, and still succeeds, when the private tag cannot be removed afterwards', async () => {
    const fake = fakeRuntime({ removeError: new ContainerError('COMMAND_FAILED', 'docker image rm failed: boom') });
    const warnings: string[] = [];
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, onWarning: (m) => warnings.push(m) });
    expect(fake.runtime.removeImage).toHaveBeenCalledTimes(1);
    expect(r.imageTag).toBe('agentvault/my-agent:1.0.0');
    expect(fake.images.has('agentvault/my-agent:1.0.0')).toBe(true);
    const message = warnings.join('\n');
    expect(message).toContain(fake.builtTag());
    expect(message).toMatch(/docker image rm/);
  });

  it('refuses a runtime that cannot tag images, before it stages or builds anything', async () => {
    const fake = fakeRuntime();
    const withoutTagging: PackagingRuntime = { ...fake.runtime, tagImage: undefined };
    const err = await failure({ sourceDir: src, runtime: withoutTagging });
    expect(err.code).toBe('COMMAND_FAILED');
    expect(err.message).toMatch(/cannot tag/);
    expect(fake.builds).toEqual([]);
    expect(fs.existsSync(path.join(src, 'dist'))).toBe(false);
  });
});

describe('image tags that already exist', () => {
  const TAG = 'agentvault/my-agent:1.0.0';
  beforeEach(() => nodeProject());

  it('refuses a tag that names an image AgentVault did not build, and writes nothing', async () => {
    const base = image('sha256:' + 'b'.repeat(64), ['node:22-slim']);
    const fake = fakeRuntime({ existing: { 'node:22-slim': base } });
    const err = await failure({ sourceDir: src, runtime: fake.runtime, image: 'node:22-slim' });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('node:22-slim');
    expect(err.message).toContain('sha256:bbbbbbbbbbbb');
    expect(err.message).toMatch(/did not build/);
    expect(err.message).toMatch(/--image/);
    expect(fake.builds).toEqual([]);
    expect(fake.runtime.tagImage).not.toHaveBeenCalled();
    expect(fake.runtime.removeImage).not.toHaveBeenCalled();
    expect(fake.images.get('node:22-slim')).toBe(base);
    expect(fs.existsSync(path.join(src, 'dist'))).toBe(false);
  });

  it('refuses a tag held by the AgentVault image of a different agent', async () => {
    const other = image('sha256:' + 'c'.repeat(64), [TAG], { [LABEL_MANIFEST]: agentvaultLabel('other-agent') });
    const fake = fakeRuntime({ existing: { [TAG]: other } });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('"other-agent"');
    expect(err.message).toMatch(/--image/);
    expect(fake.builds).toEqual([]);
    expect(fake.images.get(TAG)).toBe(other);
  });

  it('treats an image whose manifest label cannot be parsed as not ours', async () => {
    const odd = image('sha256:' + 'd'.repeat(64), [TAG], { [LABEL_MANIFEST]: '{nope' });
    const fake = fakeRuntime({ existing: { [TAG]: odd } });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('INVALID_INPUT');
    expect(fake.images.get(TAG)).toBe(odd);
  });

  it('replaces the previous image of the same agent', async () => {
    const previous = image('sha256:' + 'a'.repeat(64), [TAG], { [LABEL_MANIFEST]: agentvaultLabel('my-agent') });
    const fake = fakeRuntime({ existing: { [TAG]: previous } });
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime });
    expect(r.imageTag).toBe(TAG);
    expect(fake.images.get(TAG)?.id).toBe(BUILT_ID);
  });

  it('leaves the image that held the tag alone when verification fails', async () => {
    const previous = image('sha256:' + 'a'.repeat(64), [TAG], { [LABEL_MANIFEST]: agentvaultLabel('my-agent') });
    const fake = fakeRuntime({ existing: { [TAG]: previous }, info: () => image('x', [], {}) });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('INTEGRITY');
    expect(fake.images.get(TAG)).toBe(previous);
    expect(fake.runtime.removeImage).not.toHaveBeenCalledWith(TAG);
    expect(fake.runtime.removeImage).toHaveBeenCalledWith(fake.builtTag());
  });

  it('leaves the image that held the tag alone when the build fails', async () => {
    const previous = image('sha256:' + 'a'.repeat(64), [TAG], { [LABEL_MANIFEST]: agentvaultLabel('my-agent') });
    const fake = fakeRuntime({ existing: { [TAG]: previous }, buildError: new ContainerError('COMMAND_FAILED', 'docker build failed: boom') });
    await failure({ sourceDir: src, runtime: fake.runtime });
    expect(fake.images.get(TAG)).toBe(previous);
    expect(fake.runtime.removeImage).not.toHaveBeenCalled();
    expect(fake.runtime.tagImage).not.toHaveBeenCalled();
  });

  it('refuses at the last moment when someone else claims the tag while the image builds', async () => {
    const intruder = image('sha256:' + '9'.repeat(64), [TAG]);
    const fake: ReturnType<typeof fakeRuntime> = fakeRuntime({ duringBuild: () => void fake.images.set(TAG, intruder) });
    const err = await failure({ sourceDir: src, runtime: fake.runtime });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain(TAG);
    expect(fake.runtime.tagImage).not.toHaveBeenCalled();
    expect(fake.images.get(TAG)).toBe(intruder);
    expect(fake.runtime.removeImage).toHaveBeenCalledTimes(1);
    expect(fake.runtime.removeImage).toHaveBeenCalledWith(fake.builtTag());
  });

  it('does not look at the tag when it only generates files', async () => {
    const base = image('sha256:' + 'b'.repeat(64), ['node:22-slim']);
    const fake = fakeRuntime({ existing: { 'node:22-slim': base } });
    const r = await packageContainer({ sourceDir: src, runtime: fake.runtime, image: 'node:22-slim', build: false });
    expect(r.imageTag).toBe('node:22-slim');
    expect(fake.calls).toEqual([]);
  });
});

describe('DockerRuntime.tagImage', () => {
  function runtimeWithRunner(exitCode = 0, stderr = '') {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner = vi.fn(async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { exitCode, stdout: '', stderr, timedOut: false, spawnFailed: false };
    });
    return { runtime: new DockerRuntime({ runner }), calls };
  }

  it('runs `docker image tag --` so a ref can never be parsed as a flag', async () => {
    const { runtime, calls } = runtimeWithRunner();
    await runtime.tagImage('agentvault/a:build-1', 'agentvault/a:1.0.0');
    expect(calls).toEqual([{ file: 'docker', args: ['image', 'tag', '--', 'agentvault/a:build-1', 'agentvault/a:1.0.0'] }]);
  });

  it('validates both refs before running anything', async () => {
    const { runtime, calls } = runtimeWithRunner();
    await expect(runtime.tagImage('-bad', 'agentvault/a:1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.tagImage('agentvault/a:1', 'bad ref')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toEqual([]);
  });

  it('surfaces a docker failure as a ContainerError', async () => {
    const { runtime } = runtimeWithRunner(1, 'Error response from daemon: No such image: agentvault/a:build-1');
    await expect(runtime.tagImage('agentvault/a:build-1', 'agentvault/a:1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('concurrent packaging into one output directory', () => {
  beforeEach(() => nodeProject());
  const outDir = (): string => path.join(root, 'shared-out');
  const lockPath = (): string => path.join(outDir(), OUTPUT_LOCK);

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** The pid of a process that has already exited. */
  function deadPid(): number {
    const pid = spawnSync(process.execPath, ['-e', '0']).pid;
    expect(pid).toBeGreaterThan(0);
    return pid;
  }

  /** An output directory that this packager owns, so a lock file can be planted in it. */
  async function claimedOutputDir(): Promise<void> {
    await packageContainer(pkgOptions({ outputDir: outDir() }));
    expect(fs.existsSync(lockPath())).toBe(false);
  }

  it('fails the second run fast, leaves the first run its context, and frees the lock afterwards', async () => {
    const building = deferred();
    const release = deferred();
    const first = fakeRuntime({
      duringBuild: async () => {
        building.resolve();
        await release.promise;
      },
    });
    const running = packageContainer({ sourceDir: src, outputDir: outDir(), runtime: first.runtime });
    await building.promise; // the first run is inside `docker build`, reading the context
    // A second run would delete and re-create the context, which loses this file.
    const sentinel = path.join(outDir(), 'context', 'sentinel.txt');
    fs.writeFileSync(sentinel, 'the first run still owns this tree');

    const err = await failure(pkgOptions({ outputDir: outDir() }));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/another packaging run/i);
    expect(err.message).toContain(`process ${process.pid}`);
    expect(err.message).toContain(lockPath());
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.existsSync(path.join(outDir(), 'Dockerfile'))).toBe(true);
    expect(fs.readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid));

    release.resolve();
    const result = await running;
    expect(result.imageTag).toBe('agentvault/my-agent:1.0.0');
    expect(fs.existsSync(lockPath())).toBe(false);
    await expect(packageContainer(pkgOptions({ outputDir: outDir() }))).resolves.toBeDefined();
  });

  it('releases the lock when staging fails', async () => {
    const fd = fs.openSync(path.join(src, 'huge.bin'), 'w');
    fs.ftruncateSync(fd, MAX_CONTEXT_BYTES + 10);
    fs.closeSync(fd);
    await failure(pkgOptions({ outputDir: outDir() }));
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when the build fails', async () => {
    const fake = fakeRuntime({ buildError: new ContainerError('COMMAND_FAILED', 'docker build failed: boom') });
    await failure({ sourceDir: src, outputDir: outDir(), runtime: fake.runtime });
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('takes over a lock whose owner is no longer running, and says so', async () => {
    await claimedOutputDir();
    const stale = deadPid();
    fs.writeFileSync(lockPath(), `${stale}\n`);
    const r = await packageContainer(pkgOptions({ outputDir: outDir() }));
    expect(r.warnings.join('\n')).toMatch(new RegExp(`stale.*process ${stale}`, 'i'));
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it.each([
    ['this very process', (): string => String(process.pid)],
    ['init (a process another user may own)', (): string => '1'],
  ])('refuses a lock owned by a running process: %s', async (_name, content) => {
    await claimedOutputDir();
    const sentinel = path.join(outDir(), 'context', 'sentinel.txt');
    fs.writeFileSync(sentinel, 'untouched');
    fs.writeFileSync(lockPath(), `${content()}\n`);
    const err = await failure(pkgOptions({ outputDir: outDir() }));
    expect(err.message).toMatch(/another packaging run/i);
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe(`${content()}\n`);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  // kill(pid, 0) fails with EPERM for a live process owned by another user. Only ESRCH proves a pid is gone.
  // Forced here because as root (and for pid 1) the real call never reports EPERM.
  it('treats a process it is not allowed to signal as running, and keeps its lock', async () => {
    await claimedOutputDir();
    fs.writeFileSync(lockPath(), '424242\n');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      const err = await failure(pkgOptions({ outputDir: outDir() }));
      expect(err.message).toContain('process 424242');
      expect(kill).toHaveBeenCalledWith(424242, 0);
    } finally {
      kill.mockRestore();
    }
    expect(fs.readFileSync(lockPath(), 'utf8')).toBe('424242\n');
  });

  it.each([['empty', ''], ['not a pid', 'hello\n'], ['zero', '0\n'], ['a negative pid', '-5\n'], ['a process group', '0 1\n']])(
    'never deletes a lock it cannot attribute to a dead process (%s)',
    async (_name, content) => {
      await claimedOutputDir();
      fs.writeFileSync(lockPath(), content);
      const err = await failure(pkgOptions({ outputDir: outDir() }));
      expect(err.message).toContain(`delete ${lockPath()}`);
      expect(err.message).toMatch(/unknown process/);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(content);
    }
  );

  describe('acquireOutputLock', () => {
    let dir: string;
    beforeEach(() => {
      dir = path.join(root, 'lock-dir');
      fs.mkdirSync(dir);
    });

    it('writes the owning pid with an exclusive create and refuses a second holder', () => {
      const lock = acquireOutputLock(dir);
      expect(fs.readFileSync(path.join(dir, OUTPUT_LOCK), 'utf8')).toBe(`${process.pid}\n`);
      expect(() => acquireOutputLock(dir)).toThrow(/another packaging run/i);
      lock.release();
      expect(fs.existsSync(path.join(dir, OUTPUT_LOCK))).toBe(false);
      acquireOutputLock(dir).release();
    });

    it('removes its lock if the process exits without finishing, and leaves no listener behind after release', () => {
      const before = process.listeners('exit');
      const lock = acquireOutputLock(dir);
      const added = process.listeners('exit').filter((listener) => !before.includes(listener));
      expect(added).toHaveLength(1);
      (added[0] as () => void)(); // what Node does on process.exit()
      expect(fs.existsSync(path.join(dir, OUTPUT_LOCK))).toBe(false);
      lock.release();
      expect(process.listeners('exit')).toEqual(before);
    });

    it('never deletes a lock that another process has since taken', () => {
      const lock = acquireOutputLock(dir);
      fs.writeFileSync(path.join(dir, OUTPUT_LOCK), '1\n');
      lock.release();
      expect(fs.readFileSync(path.join(dir, OUTPUT_LOCK), 'utf8')).toBe('1\n');
    });

    it('reports which stale owner it replaced', () => {
      const stale = deadPid();
      fs.writeFileSync(path.join(dir, OUTPUT_LOCK), `${stale}\n`);
      const lock = acquireOutputLock(dir);
      expect(lock.replacedStaleOwner).toBe(stale);
      lock.release();
    });
  });
});

describe('symbolic links in the output location', () => {
  beforeEach(() => nodeProject());

  it('refuses a symlinked dist/ and writes nothing through it', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(src, 'dist'));
    const err = await failure(pkgOptions());
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/symbolic link/);
    expect(err.message).toContain(path.join(src, 'dist'));
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a dangling dist/ symlink with the same clear message, not a raw ENOENT', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(src, 'dist'));
    const err = await failure(pkgOptions());
    expect(err.message).toMatch(/symbolic link/);
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false);
  });

  it('refuses a symlinked dist/container and leaves the other project it points at untouched', async () => {
    const other = path.join(root, 'other-project-output');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'Dockerfile'), 'FROM scratch\n');
    fs.mkdirSync(path.join(src, 'dist'));
    fs.symlinkSync(other, path.join(src, 'dist', 'container'));
    const err = await failure(pkgOptions());
    expect(err.message).toMatch(/symbolic link/);
    expect(fs.readdirSync(other)).toEqual(['Dockerfile']);
  });

  it('refuses an --output that is itself a symlink, to a directory or to nothing', async () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    const toDir = path.join(root, 'link-to-dir');
    fs.symlinkSync(target, toDir);
    expect((await failure(pkgOptions({ outputDir: toDir }))).message).toMatch(/symbolic link/);
    const dangling = path.join(root, 'link-to-nothing');
    fs.symlinkSync(path.join(root, 'nothing'), dangling);
    expect((await failure(pkgOptions({ outputDir: dangling }))).message).toMatch(/symbolic link/);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'nothing'))).toBe(false);
  });

  it('reports the real path when --output goes through a symlinked parent directory', async () => {
    const real = path.join(root, 'real-parent');
    fs.mkdirSync(real);
    const link = path.join(root, 'linked-parent');
    fs.symlinkSync(real, link);
    const r = await packageContainer(pkgOptions({ outputDir: path.join(link, 'out') }));
    expect(r.outputDir).toBe(path.join(real, 'out'));
    expect(r.contextDir).toBe(path.join(real, 'out', 'context'));
    expect(fs.existsSync(path.join(real, 'out', 'Dockerfile'))).toBe(true);
  });
});
