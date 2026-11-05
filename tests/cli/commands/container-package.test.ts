/**
 * `package --target container`: the flag mapping, the refusals, the image
 * record that lets `run <dir>` find the image, and (property f) the proof that
 * the WASM path is untouched: the container target never reaches the WASM
 * packager, and the default target never reaches the container module.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/packaging/index.js', () => ({
  packageAgent: vi.fn(),
  getPackageSummary: vi.fn(),
}));
vi.mock('../../../src/deployment/index.js', () => ({ ensureIcpManifest: vi.fn() }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));
vi.mock('../../../src/container/package-image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/container/package-image.js')>();
  return { ...actual, packageContainer: vi.fn(actual.packageContainer) };
});
vi.mock('../../../cli/commands/container-package.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cli/commands/container-package.js')>();
  return { ...actual, runContainerPackage: vi.fn(actual.runContainerPackage) };
});

import { IMAGE_RECORD_FILE, executeContainerPackage, readImageRecord, runContainerPackage } from '../../../cli/commands/container-package.js';
import type { ContainerPackageCliOptions } from '../../../cli/commands/container-package.js';
import { resolveDeps } from '../../../cli/commands/cli-support.js';
import type { ContainerCliDeps } from '../../../cli/commands/cli-support.js';
import { packageCommand } from '../../../cli/commands/package.js';
import { parseManifest, manifestToLabel } from '../../../src/container/manifest.js';
import { packageContainer } from '../../../src/container/package-image.js';
import type { ContainerPackageResult, PackagingRuntime } from '../../../src/container/package-image.js';
import { ensureIcpManifest } from '../../../src/deployment/index.js';
import { packageAgent } from '../../../src/packaging/index.js';
import { ContainerError, LABEL_MANIFEST } from '../../../src/container/types.js';
import type { BuildRequest, BuildResult, ImageInfo } from '../../../src/container/types.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

let cleanup: string[] = [];
function mkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

beforeEach(async () => {
  const real = await vi.importActual<typeof import('../../../src/container/package-image.js')>('../../../src/container/package-image.js');
  vi.mocked(packageContainer).mockReset();
  vi.mocked(packageContainer).mockImplementation(real.packageContainer);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

/** A runtime that fails the test on any docker call. */
const noDocker: PackagingRuntime = new Proxy({} as PackagingRuntime, {
  get: (_t, property) => () => {
    throw new Error(`unexpected docker call: ${String(property)}`);
  },
});

/** Builds "images" by reading the manifest the packager wrote next to the Dockerfile. */
function fakeBuildRuntime(): PackagingRuntime & { builds: BuildRequest[] } {
  const builds: BuildRequest[] = [];
  const images = new Map<string, ImageInfo>();
  return {
    builds,
    runner: () => Promise.reject(new Error('no runner')),
    buildImage: (request: BuildRequest): Promise<BuildResult> => {
      builds.push(request);
      const manifestFile = path.join(path.dirname(request.dockerfile ?? ''), 'agentvault.json');
      const manifest = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
      images.set(request.tag, { id: 'sha256:' + 'e'.repeat(64), repoTags: [request.tag], repoDigests: [], labels: { [LABEL_MANIFEST]: manifestToLabel(manifest) }, user: '10001:10001', sizeBytes: 1 });
      return Promise.resolve({ imageId: 'sha256:' + 'e'.repeat(64), tag: request.tag });
    },
    inspectImage: (ref: string) => Promise.resolve(images.get(ref) ?? null),
    removeImage: () => Promise.resolve(),
  };
}

function agentDir(name = 'avt-k-pkg-agent'): string {
  const parent = mkdtemp('avt-k-pkg-');
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), "console.log('hello');\n");
  return dir;
}

interface Harness {
  deps: ContainerCliDeps;
  out: string[];
  err: string[];
  cwd: string;
  all(): string;
}

function harness(over: Partial<ContainerCliDeps> = {}): Harness {
  const cwd = mkdtemp('avt-k-pkg-cwd-');
  const out: string[] = [];
  const err: string[] = [];
  const deps: ContainerCliDeps = {
    cwd,
    env: {},
    interactive: false,
    log: (line) => out.push(plain(line)),
    err: (line) => err.push(plain(line)),
    exit: (code) => {
      throw new ExitSignal(code);
    },
    ...over,
  };
  return { deps, out, err, cwd, all: () => [...out, ...err].join('\n') };
}

function fakeResult(outputDir: string, over: Partial<ContainerPackageResult> = {}): ContainerPackageResult {
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    imageTag: 'agentvault/demo:1.0.0',
    manifest: parseManifest({
      schemaVersion: 1,
      name: 'demo',
      version: '1.0.0',
      runtime: 'node',
      entrypoint: ['node', 'index.js'],
      volumes: ['/data'],
      env: [],
      secrets: [],
      isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
      source: { type: 'node', contentHash: 'c'.repeat(64) },
    }),
    outputDir,
    contextDir: path.join(outputDir, 'context'),
    dockerfilePath: path.join(outputDir, 'Dockerfile'),
    manifestPath: path.join(outputDir, 'agentvault.json'),
    warnings: [],
    skipped: [],
    stats: { files: 2, bytes: 100 },
    ...over,
  };
}

async function exec(h: Harness, source: string, options: ContainerPackageCliOptions, runtime: PackagingRuntime = noDocker): Promise<number> {
  try {
    await executeContainerPackage(source, options, resolveDeps(h.deps), runtime);
    return 0;
  } catch (error) {
    if (error instanceof ContainerError) {
      h.err.push(error.message);
      return 1;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Flag mapping
// ---------------------------------------------------------------------------

describe('executeContainerPackage: flags reach the engine', () => {
  it('maps every container flag, resolving paths against the injected cwd', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockResolvedValueOnce(fakeResult(path.join(h.cwd, 'out')));
    const code = await exec(h, 'agents/demo', {
      output: 'out',
      image: 'registry.example/demo:9',
      base: 'node:22-slim',
      entrypoint: '["node","server.js"]',
      volume: ['/data', '/cache'],
      envName: ['REGION', 'LOG_LEVEL'],
      secret: ['anthropic', 'openai'],
      healthUrl: 'http://localhost:3000/health',
    });
    expect(code).toBe(0);
    const options = vi.mocked(packageContainer).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      sourceDir: path.join(h.cwd, 'agents', 'demo'),
      outputDir: path.join(h.cwd, 'out'),
      image: 'registry.example/demo:9',
      base: 'node:22-slim',
      entrypoint: ['node', 'server.js'],
      volumes: ['/data', '/cache'],
      env: ['REGION', 'LOG_LEVEL'],
      secrets: ['anthropic', 'openai'],
      healthUrl: 'http://localhost:3000/health',
      build: true,
    });
  });

  it('with no flags passes only the source, the runtime and build: true (the engine owns the defaults)', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockResolvedValueOnce(fakeResult(path.join(h.cwd, 'out')));
    await exec(h, '.', { volume: [], envName: [], secret: [], build: true });
    const options = vi.mocked(packageContainer).mock.calls[0]?.[0];
    expect(Object.keys(options ?? {}).sort()).toEqual(['build', 'onWarning', 'runtime', 'sourceDir']);
    expect(options?.sourceDir).toBe(h.cwd);
  });

  it('--no-build generates the files only and says how to build', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockResolvedValueOnce(fakeResult(path.join(h.cwd, 'out')));
    await exec(h, '.', { build: false });
    expect(vi.mocked(packageContainer).mock.calls[0]?.[0].build).toBe(false);
    expect(h.all()).toContain('was NOT built');
    expect(h.all()).toContain('docker build -f');
  });

  it('forwards engine warnings to stderr', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockImplementationOnce((options) => {
      options.onWarning?.('No package-lock.json: the build is not reproducible');
      return Promise.resolve(fakeResult(path.join(h.cwd, 'out')));
    });
    await exec(h, '.', {});
    expect(h.err.join('\n')).toContain('Warning: No package-lock.json');
  });
});

describe('executeContainerPackage: refusals', () => {
  it('--dry-run is refused, because the engine would still write files and build an image', async () => {
    const h = harness();
    expect(await exec(h, '.', { dryRun: true })).toBe(1);
    expect(h.err.join('\n')).toContain('--dry-run is not supported with --target container');
    expect(h.err.join('\n')).toContain('--no-build');
    expect(packageContainer).not.toHaveBeenCalled();
  });

  it.each([['not json'], ['{"a":1}'], ['[]'], ['[1,2]'], ['["node",""]'], ['"node index.js"']])('--entrypoint %j is refused without echoing it', async (raw) => {
    const h = harness();
    expect(await exec(h, '.', { entrypoint: raw })).toBe(1);
    expect(h.err.join('\n')).toContain('--entrypoint must be a JSON array of strings');
    expect(packageContainer).not.toHaveBeenCalled();
  });

  it('warns about a service no preset provides, but not about one that exists', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockResolvedValue(fakeResult(path.join(h.cwd, 'out')));
    await exec(h, '.', { secret: ['anthropic'] });
    expect(h.err.join('\n')).not.toContain('no credential-proxy preset');
    await exec(h, '.', { secret: ['frobnicator'] });
    expect(h.err.join('\n')).toContain('no credential-proxy preset named frobnicator');
    expect(h.err.join('\n')).toContain('anthropic');
  });

  it('says which WASM-only flags it ignored instead of ignoring them silently', async () => {
    const h = harness();
    vi.mocked(packageContainer).mockResolvedValueOnce(fakeResult(path.join(h.cwd, 'out')));
    await exec(h, '.', { debug: true, icWasmShrink: true, validate: 'x.did', skipValidation: true });
    expect(h.err.join('\n')).toContain('--skip-validation, --debug, --ic-wasm-shrink, --validate only apply to the WASM target');
  });
});

// ---------------------------------------------------------------------------
// The image record
// ---------------------------------------------------------------------------

describe('image record', () => {
  it('is written next to the manifest, so "run <dir>" does not have to guess the tag', async () => {
    const h = harness();
    const out = path.join(h.cwd, 'out');
    vi.mocked(packageContainer).mockResolvedValueOnce(fakeResult(out, { imageTag: 'custom/tag:7', imageId: 'sha256:' + '1'.repeat(64) }));
    await exec(h, '.', { image: 'custom/tag:7' });
    expect(readImageRecord(out)).toEqual({ schemaVersion: 1, image: 'custom/tag:7', imageId: 'sha256:' + '1'.repeat(64) });
    expect(fs.statSync(path.join(out, IMAGE_RECORD_FILE)).isFile()).toBe(true);
  });

  it('readImageRecord ignores a missing, malformed or hostile record', () => {
    const dir = mkdtemp('avt-k-record-');
    expect(readImageRecord(dir)).toBeNull();
    for (const content of ['not json', '[]', '{"image":42}', '{"image":"--privileged"}', '{"image":"a b"}', 'null']) {
      fs.writeFileSync(path.join(dir, IMAGE_RECORD_FILE), content);
      expect(readImageRecord(dir)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The real engine, without a daemon
// ---------------------------------------------------------------------------

describe('executeContainerPackage: real staging', () => {
  it('--no-build writes the Dockerfile, manifest and image record and calls no docker command at all', async () => {
    const h = harness();
    const source = agentDir();
    expect(await exec(h, source, { build: false, volume: ['/data'], envName: ['REGION'], secret: ['anthropic'] })).toBe(0);

    const out = path.join(source, 'dist', 'container');
    const manifest = parseManifest(fs.readFileSync(path.join(out, 'agentvault.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'avt-k-pkg-agent', version: '1.2.3', env: ['REGION'], secrets: ['anthropic'] });
    expect(manifest.isolation).toMatchObject({ network: 'proxy', user: '10001:10001' });
    expect(fs.existsSync(path.join(out, 'Dockerfile'))).toBe(true);
    expect(readImageRecord(out)?.image).toBe('agentvault/avt-k-pkg-agent:1.2.3');
    expect(h.out.join('\n')).toContain('Generated the build context');
    expect(h.out.join('\n')).toContain('anthropic (delivered by the credential proxy)');
  });

  it('a build through a runtime records the image id and points at "agentvault run"', async () => {
    const h = harness();
    const source = agentDir();
    const runtime = fakeBuildRuntime();
    expect(await exec(h, source, { image: 'avt-k-custom:1' }, runtime)).toBe(0);
    expect(runtime.builds.map((b) => b.tag)).toEqual(['avt-k-custom:1']);
    const record = readImageRecord(path.join(source, 'dist', 'container'));
    expect(record).toEqual({ schemaVersion: 1, image: 'avt-k-custom:1', imageId: 'sha256:' + 'e'.repeat(64) });
    expect(h.out.join('\n')).toContain('Packaged agent avt-k-pkg-agent as container image avt-k-custom:1');
    expect(h.out.join('\n')).toContain('agentvault run avt-k-custom:1 -d');
  });

  it('a second run over the same output directory is accepted (it is ours)', async () => {
    const h = harness();
    const source = agentDir();
    expect(await exec(h, source, { build: false })).toBe(0);
    expect(await exec(h, source, { build: false })).toBe(0);
  });
});

describe('runContainerPackage', () => {
  it('prints an engine failure as one message plus a hint, with no stack trace, and exits 1', async () => {
    const h = harness();
    const exits: number[] = [];
    h.deps.exit = (code) => {
      exits.push(code);
      throw new ExitSignal(code);
    };
    await expect(runContainerPackage('does-not-exist', { build: false }, h.deps)).rejects.toBeInstanceOf(ExitSignal);
    expect(exits).toEqual([1]);
    const text = h.err.join('\n');
    expect(text).toMatch(/^Error: /m);
    expect(text).toContain('Check the name or path');
    expect(text).not.toMatch(/\bat \S+ \(|\.ts:\d+/);
  });
});

// ---------------------------------------------------------------------------
// Property (f): the WASM path is untouched
// ---------------------------------------------------------------------------

describe('package.ts routes by target (property f)', () => {
  const wasmResult = {
    config: { name: 'wasm-agent', type: 'generic', sourcePath: '/x' },
    wasmPath: '/x/a.wasm',
    watPath: '/x/a.wat',
    statePath: '/x/a.state.json',
    wasmSize: 10,
    target: 'wasmedge',
    duration: 5,
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(packageAgent).mockReset();
    vi.mocked(packageAgent).mockResolvedValue(wasmResult as never);
    vi.mocked(ensureIcpManifest).mockReset();
    vi.mocked(ensureIcpManifest).mockReturnValue({ action: 'kept', path: '/x/icp.yaml' } as never);
    vi.mocked(runContainerPackage).mockReset();
    vi.mocked(runContainerPackage).mockResolvedValue(undefined);
  });

  it('--target container goes to the container packager and never to the WASM packager, icp.yaml or the WASM banner', async () => {
    await packageCommand().parseAsync(['agents/demo', '--target', 'container', '--image', 'a/b:1', '--secret', 'anthropic', '--secret', 'openai', '--volume', '/data', '--no-build'], { from: 'user' });

    expect(runContainerPackage).toHaveBeenCalledTimes(1);
    const [source, options] = vi.mocked(runContainerPackage).mock.calls[0] ?? [];
    expect(source).toBe('agents/demo');
    expect(options).toMatchObject({ target: 'container', image: 'a/b:1', secret: ['anthropic', 'openai'], volume: ['/data'], build: false });

    expect(packageAgent).not.toHaveBeenCalled();
    expect(ensureIcpManifest).not.toHaveBeenCalled();
    const printed = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).not.toContain('AgentVault Package');
    expect(printed).not.toContain('deploy');
  });

  it('the default target still runs the WASM pipeline, byte for byte as before, and never loads the container packager', async () => {
    const source = mkdtemp('avt-k-wasm-src-');
    await packageCommand().parseAsync([source], { from: 'user' });

    expect(runContainerPackage).not.toHaveBeenCalled();
    expect(packageAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(packageAgent).mock.calls[0]?.[0]).toMatchObject({ sourcePath: source, target: 'wasmedge' });
    expect(ensureIcpManifest).toHaveBeenCalledTimes(1);
    const printed = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('AgentVault Package');
    expect(printed).toContain('Next steps');
  });

  it.each(['wasmedge', 'motoko', 'pure-wasm'])('--target %s still goes to the WASM packager', async (target) => {
    await packageCommand().parseAsync(['agents/demo', '--target', target], { from: 'user' });
    expect(runContainerPackage).not.toHaveBeenCalled();
    expect(vi.mocked(packageAgent).mock.calls[0]?.[0]).toMatchObject({ target });
  });

  it('keeps the pinned shape of the command: description words, one positional, the WASM default and its options', () => {
    const command = packageCommand();
    expect(command.description()).toContain('Compile');
    expect(command.description()).toContain('WASM');
    expect(command.registeredArguments).toHaveLength(1);
    expect(command.registeredArguments[0]?.name()).toBe('source');
    const target = command.options.find((o) => o.long === '--target');
    expect(target?.defaultValue).toBe('wasmedge');
    expect(target?.description).toContain('container');
    for (const flag of ['--output', '--force', '--skip-validation', '--dry-run', '--debug', '--optimize', '--ic-wasm-optimize', '--ic-wasm-shrink', '--validate', '--memory-limit', '--compute-quota']) {
      expect(command.options.some((o) => o.long === flag)).toBe(true);
    }
  });

  it('declares the container flags, repeatable ones collecting values', () => {
    const command = packageCommand();
    for (const flag of ['--image', '--base', '--entrypoint', '--volume', '--env-name', '--secret', '--health-url', '--no-build']) {
      expect(command.options.some((o) => o.long === flag)).toBe(true);
    }
    command.parse(['x', '--secret', 'a', '--secret', 'b', '--env-name', 'ONE', '--env-name', 'TWO', '--volume', '/a', '--volume', '/b', '--target', 'container'], { from: 'user' });
    expect(command.opts()).toMatchObject({ secret: ['a', 'b'], envName: ['ONE', 'TWO'], volume: ['/a', '/b'], build: true });
  });
});
