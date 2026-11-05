/**
 * The container commands (run, ps, logs, stop, rm, stats, inspect, exec) against
 * a recording fake runtime: no Docker, no terminal. Each test states a property
 * of the command line (what is refused, what is asked for, what is printed)
 * rather than re-testing src/container/lifecycle.ts, which has its own tests.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/container/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/container/lifecycle.js')>();
  return { ...actual, startAgent: vi.fn(actual.startAgent) };
});

import {
  containerCommand,
  containerExecCommand,
  containerInspectCommand,
  containerLogsCommand,
  containerStatsCommand,
  psCommand,
  redactInspectOutput,
  rmCommand,
  runCommand,
  stopCommand,
} from '../../../cli/commands/container.js';
import { IMAGE_RECORD_FILE } from '../../../cli/commands/container-package.js';
import { createPassphraseProvider, renderError, resolveDeps } from '../../../cli/commands/cli-support.js';
import type { ContainerCliDeps, PassphraseRequest } from '../../../cli/commands/cli-support.js';
import { packageCommand } from '../../../cli/commands/package.js';
import { secretsCommand } from '../../../cli/commands/secrets.js';
import { snapshotCommand } from '../../../cli/commands/snapshot.js';
import { createProgram } from '../../../cli/index.js';
import { serverEnvironment } from '../../../src/orchestration/mcp-client.js';
import { startAgent } from '../../../src/container/lifecycle.js';
import { containerManifestSchema, manifestToLabel } from '../../../src/container/manifest.js';
import type { ContainerManifest } from '../../../src/container/manifest.js';
import { SecretStore } from '../../../src/container/secrets-store.js';
import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_MANIFEST, LABEL_ROLE, LABEL_VOLUME_KEY } from '../../../src/container/types.js';
import type {
  BuildRequest,
  BuildResult,
  CommandResult,
  CommandRunner,
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ImageInfo,
  StartedAgent,
} from '../../../src/container/types.js';

const AGENT = 'alpha';
const IMAGE = 'agentvault/alpha:1';
const CANARY = 'CANARY-SECRET-5f4dcc3b5aa765d61d8327deb882cf99';
const PASS = 'correct horse battery staple';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function manifestFor(over: Partial<ContainerManifest> = {}): ContainerManifest {
  return containerManifestSchema.parse({
    schemaVersion: 1,
    name: AGENT,
    version: '1',
    runtime: 'node',
    entrypoint: ['node', 'index.js'],
    volumes: ['/data'],
    env: [],
    secrets: [],
    isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'node', contentHash: 'c'.repeat(64) },
    ...over,
  });
}

const SECRET_MANIFEST = (): ContainerManifest =>
  manifestFor({ secrets: ['anthropic'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });

function imageFor(manifest: ContainerManifest): ImageInfo {
  return { id: 'sha256:abc', repoTags: [IMAGE], repoDigests: [], labels: { [LABEL_MANIFEST]: manifestToLabel(manifest) }, user: '10001:10001', sizeBytes: 1 };
}

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false, ...over });

function started(over: Partial<StartedAgent> = {}): StartedAgent {
  return { agent: AGENT, containerName: `av-${AGENT}`, volumes: [`av-${AGENT}-data`], network: 'none', warnings: [], ...over };
}

// ---------------------------------------------------------------------------
// Recording fake runtime
// ---------------------------------------------------------------------------

const MUTATING = new Set([
  'ensureNetwork',
  'removeNetwork',
  'connectNetwork',
  'ensureVolume',
  'removeVolume',
  'start',
  'runForeground',
  'stop',
  'remove',
  'buildImage',
  'removeImage',
  'exec',
]);

class FakeRuntime implements ContainerRuntime {
  readonly runner: CommandRunner = () => Promise.resolve(ok());
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  containers: ContainerInfo[] = [];
  volumes: Array<{ name: string; key: string; agent: string }> = [];
  networks = new Set<string>();
  images = new Map<string, ImageInfo>([[IMAGE, imageFor(manifestFor())]]);
  logsResult: CommandResult = ok();
  statsResult: CommandResult = ok({ stdout: 'CONTAINER  CPU' });
  inspectResult: unknown = {};
  execResult: CommandResult = ok();
  /** Make this method throw. */
  failOn = new Map<string, Error>();

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const error = this.failOn.get(method);
    if (error !== undefined) throw error;
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  get mutations(): string[] {
    return this.calls.filter((c) => MUTATING.has(c.method)).map((c) => `${c.method}(${String(c.args[0] && typeof c.args[0] === 'object' ? (c.args[0] as { name?: string }).name : c.args[0])})`);
  }
  callsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }
  /** The specs docker was asked to start, in order. */
  started(): ContainerSpec[] {
    return this.callsOf('start').map((args) => args[0] as ContainerSpec);
  }

  /** An agent container as docker reports it. */
  seedAgent(agent: string, state = 'running', role: 'agent' | 'proxy' = 'agent'): void {
    this.containers.push({
      id: 'f'.repeat(64),
      name: role === 'agent' ? `av-${agent}` : `av-${agent}-proxy`,
      image: IMAGE,
      state,
      status: state === 'running' ? 'Up 3 minutes' : 'Exited (0) 1 minute ago',
      role,
      agent,
      createdAt: '2026-11-05 07:00:00 +0000 UTC',
      labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: agent, [LABEL_ROLE]: role },
    });
  }
  seedVolume(name: string, agent: string, key: string): void {
    this.volumes.push({ name, key, agent });
  }

  ensureAvailable(): Promise<{ serverVersion: string }> {
    this.record('ensureAvailable', []);
    return Promise.resolve({ serverVersion: 'fake' });
  }
  inspectImage(ref: string): Promise<ImageInfo | null> {
    this.record('inspectImage', [ref]);
    return Promise.resolve(this.images.get(ref) ?? null);
  }
  buildImage(request: BuildRequest): Promise<BuildResult> {
    this.record('buildImage', [request]);
    return Promise.resolve({ imageId: 'sha256:built', tag: request.tag });
  }
  removeImage(ref: string): Promise<void> {
    this.record('removeImage', [ref]);
    return Promise.resolve();
  }
  ensureNetwork(name: string, options: { internal: boolean }): Promise<void> {
    this.record('ensureNetwork', [name, options]);
    this.networks.add(name);
    return Promise.resolve();
  }
  removeNetwork(name: string): Promise<void> {
    this.record('removeNetwork', [name]);
    if (!this.networks.delete(name)) return Promise.reject(new ContainerError('NOT_FOUND', `network ${name} not found`));
    return Promise.resolve();
  }
  connectNetwork(container: string, network: string, aliases?: string[]): Promise<void> {
    this.record('connectNetwork', [container, network, aliases]);
    return Promise.resolve();
  }
  ensureVolume(name: string, labels?: Record<string, string>): Promise<void> {
    this.record('ensureVolume', [name, labels]);
    if (!this.volumes.some((v) => v.name === name)) {
      this.volumes.push({ name, key: labels?.[LABEL_VOLUME_KEY] ?? '', agent: labels?.[LABEL_AGENT] ?? '' });
    }
    return Promise.resolve();
  }
  /** Labels per volume name for volumes the test planted (unlabelled or someone else's); managed ones come from `volumes`. */
  foreignVolumes = new Map<string, Record<string, string>>();
  inspectVolume(name: string): Promise<{ name: string; labels: Record<string, string> } | null> {
    this.record('inspectVolume', [name]);
    const foreign = this.foreignVolumes.get(name);
    if (foreign !== undefined) return Promise.resolve({ name, labels: { ...foreign } });
    const managed = this.volumes.find((v) => v.name === name);
    if (managed === undefined) return Promise.resolve(null);
    return Promise.resolve({ name, labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: managed.agent, [LABEL_VOLUME_KEY]: managed.key } });
  }
  removeVolume(name: string): Promise<void> {
    this.record('removeVolume', [name]);
    this.volumes = this.volumes.filter((v) => v.name !== name);
    return Promise.resolve();
  }
  listVolumes(filter?: { agent?: string }): Promise<Array<{ name: string; key: string; agent: string }>> {
    this.record('listVolumes', [filter]);
    return Promise.resolve(this.volumes.filter((v) => filter?.agent === undefined || v.agent === filter.agent));
  }
  start(spec: ContainerSpec): Promise<{ id: string }> {
    this.record('start', [spec]);
    this.containers.push({
      id: 'a'.repeat(64),
      name: spec.name,
      image: spec.image,
      state: 'running',
      status: 'Up 1 second',
      role: spec.role,
      agent: spec.labels[LABEL_AGENT] ?? '',
      createdAt: '2026-11-05 07:00:00 +0000 UTC',
      labels: spec.labels,
    });
    return Promise.resolve({ id: 'a'.repeat(64) });
  }
  runForeground(spec: ContainerSpec): Promise<CommandResult> {
    this.record('runForeground', [spec]);
    return Promise.resolve(ok());
  }
  list(filter?: { agent?: string; all?: boolean }): Promise<ContainerInfo[]> {
    this.record('list', [filter]);
    return Promise.resolve(
      this.containers.filter((c) => (filter?.agent === undefined || c.agent === filter.agent) && (filter?.all === true || c.state === 'running'))
    );
  }
  logs(name: string, options?: { tail?: number; follow?: boolean }): Promise<CommandResult> {
    this.record('logs', [name, options]);
    return Promise.resolve(this.logsResult);
  }
  stop(name: string, timeoutSec?: number): Promise<void> {
    this.record('stop', [name, timeoutSec]);
    for (const c of this.containers) if (c.name === name) c.state = 'exited';
    return Promise.resolve();
  }
  remove(name: string, options?: { force?: boolean }): Promise<void> {
    this.record('remove', [name, options]);
    this.containers = this.containers.filter((c) => c.name !== name);
    return Promise.resolve();
  }
  inspect(name: string): Promise<unknown> {
    this.record('inspect', [name]);
    return Promise.resolve(this.inspectResult);
  }
  stats(name: string): Promise<CommandResult> {
    this.record('stats', [name]);
    return Promise.resolve(this.statsResult);
  }
  exec(name: string, command: string[], options?: { interactive?: boolean }): Promise<CommandResult> {
    this.record('exec', [name, command, options]);
    return Promise.resolve(this.execResult);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

interface Harness {
  deps: ContainerCliDeps;
  runtime: FakeRuntime;
  home: string;
  out: string[];
  err: string[];
  passphrases: PassphraseRequest[];
  stdout(): string;
  stderr(): string;
  all(): string;
}

let cleanup: string[] = [];

function mkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function harness(over: Partial<ContainerCliDeps> = {}, runtime = new FakeRuntime()): Harness {
  const home = mkdtemp('avt-k-home-');
  const out: string[] = [];
  const err: string[] = [];
  const passphrases: PassphraseRequest[] = [];
  const deps: ContainerCliDeps = {
    runtime,
    env: { AGENTVAULT_HOME: home },
    cwd: home,
    interactive: false,
    log: (line) => out.push(plain(line)),
    err: (line) => err.push(plain(line)),
    exit: (code) => {
      throw new ExitSignal(code);
    },
    getPassphrase: (request) => {
      passphrases.push(request);
      return Promise.resolve(PASS);
    },
    installSignalHandler: () => () => undefined,
    livenessGraceMs: 0, // the fake never crashes; waiting out the window would only slow every detached run
    ...over,
  };
  return {
    deps,
    runtime,
    home,
    out,
    err,
    passphrases,
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    all: () => [...out, ...err].join('\n'),
  };
}

/** Run a command line; returns the exit code the command asked for (0 when it did not exit). */
async function run(command: Command, args: string[]): Promise<number> {
  try {
    await command.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    throw error;
  }
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../src/container/lifecycle.js')>('../../../src/container/lifecycle.js');
  vi.mocked(startAgent).mockReset();
  vi.mocked(startAgent).mockImplementation(actual.startAgent);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('registers the group and the four shortcuts and leaves the canister verbs alone', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    for (const name of ['container', 'run', 'ps', 'stop', 'rm', 'snapshot', 'secrets']) expect(names).toContain(name);
    expect(names.filter((n) => n === 'logs')).toHaveLength(1);
    expect(names.filter((n) => n === 'stats')).toHaveLength(1);
    expect(names.filter((n) => n === 'exec')).toHaveLength(1);

    // Still the canister commands, not ours.
    for (const verb of ['logs', 'stats', 'exec']) {
      const command = program.commands.find((c) => c.name() === verb);
      expect(command?.registeredArguments[0]?.name()).toBe('canister-id');
    }
    // inspect/proxy-style verbs are reachable only under the group.
    expect(names).not.toContain('inspect');
    const group = program.commands.find((c) => c.name() === 'container');
    expect(group?.commands.map((c) => c.name())).toEqual(['run', 'ps', 'logs', 'stop', 'rm', 'stats', 'inspect', 'exec']);
  });

  it('builds a fresh command instance on every call (commander keeps option state on reused instances)', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--name', 'first'])).toBe(0);
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--name', 'second'])).toBe(0);
    const agents = vi.mocked(startAgent).mock.calls.map(([request]) => request.agent);
    expect(agents).toEqual(['first', 'second']);
  });
});

// ---------------------------------------------------------------------------
// Security property (a): no secret-bearing flag exists anywhere
// ---------------------------------------------------------------------------

function walkOptions(command: Command, trail = command.name()): Array<{ trail: string; long: string }> {
  const own = command.options.map((option) => ({ trail, long: (option.long ?? option.short ?? '').replace(/^--/, '') }));
  return [...own, ...command.commands.flatMap((child) => walkOptions(child, `${trail} ${child.name()}`))];
}

describe('no secret-bearing flags', () => {
  const FORBIDDEN = new Set(['value', 'key', 'passphrase', 'token', 'secret-value', 'password', 'mnemonic', 'private-key', 'api-key', 'secret-key']);

  it('no option on any container, snapshot, secrets or package command takes a secret value', () => {
    const commands = [containerCommand(), runCommand(), psCommand(), stopCommand(), rmCommand(), snapshotCommand(), secretsCommand(), packageCommand()];
    const options = commands.flatMap((command) => walkOptions(command));
    // Not vacuous: the walk really reached the interesting commands.
    const seen = options.map((o) => `${o.trail} --${o.long}`);
    expect(seen).toContain('secrets add --from-env');
    expect(seen).toContain('snapshot create --no-encrypt');
    expect(seen).toContain('run --secrets-from-env');
    expect(seen.length).toBeGreaterThan(40);

    const offenders = options.filter((o) => FORBIDDEN.has(o.long));
    expect(offenders).toEqual([]);
  });

  it('commander rejects a --passphrase flag instead of accepting it', async () => {
    const h = harness();
    const command = snapshotCommand(h.deps).exitOverride();
    for (const sub of command.commands) sub.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(command.parseAsync(['create', AGENT, '--passphrase', PASS], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });
});

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

describe('src/container barrel', () => {
  it('re-exports no name that another src barrel already exports', async () => {
    const container = await import('../../../src/container/index.js');
    const others = await Promise.all([
      import('../../../src/hypervault/index.js'),
      import('../../../src/pilot/index.js'),
      import('../../../src/packaging/index.js'),
      import('../../../src/wallet/index.js'),
      import('../../../src/vault/index.js'),
    ]);
    const mine = new Set(Object.keys(container));
    expect(mine.has('startAgent')).toBe(true);
    expect(mine.has('ProxyConfig')).toBe(false);
    const collisions = others.flatMap((module) => Object.keys(module).filter((name) => mine.has(name)));
    expect(collisions).toEqual([]);
  }, 60_000);
});

describe('MCP servers', () => {
  it('never inherit the passphrases that unlock the secret store or decrypt snapshots', () => {
    const env = serverEnvironment(
      { env: { AGENTVAULT_SNAPSHOT_PASSPHRASE: 'from config', KEEP_ME: 'yes' } },
      { AGENTVAULT_SECRETS_PASSPHRASE: PASS, AGENTVAULT_SNAPSHOT_PASSPHRASE: PASS, PATH: '/usr/bin' }
    );
    expect(env['AGENTVAULT_SECRETS_PASSPHRASE']).toBeUndefined();
    expect(env['AGENTVAULT_SNAPSHOT_PASSPHRASE']).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');
    expect(env['PATH']).toBe('/usr/bin');
  });
});

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

describe('ps', () => {
  it('lists running agents from the runtime and changes nothing', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT, 'running');
    h.runtime.seedAgent('beta', 'exited');
    expect(await run(psCommand(h.deps), [])).toBe(0);
    expect(h.runtime.callsOf('list')).toEqual([[{ all: false }]]);
    expect(h.runtime.mutations).toEqual([]);
    expect(h.stdout()).toMatch(/AGENT\s+STATE\s+IMAGE\s+PROXY\s+CREATED/);
    expect(h.stdout()).toMatch(/alpha\s+running\s+agentvault\/alpha:1\s+no/);
    expect(h.stdout()).not.toContain('beta');
  });

  it('--all includes stopped agents and --json is machine readable', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT, 'running');
    h.runtime.seedAgent('beta', 'exited');
    await run(psCommand(h.deps), ['--all', '--json']);
    expect(h.runtime.callsOf('list')).toEqual([[{ all: true }]]);
    const rows = JSON.parse(h.stdout()) as Array<{ agent: string; state: string }>;
    expect(rows.map((r) => [r.agent, r.state])).toEqual([
      ['alpha', 'running'],
      ['beta', 'exited'],
    ]);
  });

  it('says so when nothing runs', async () => {
    const h = harness();
    await run(psCommand(h.deps), []);
    expect(h.stdout()).toContain('No running agents');
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('run: plain image', () => {
  it('starts a detached agent through the lifecycle with the manifest defaults and prints a summary', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);

    expect(h.runtime.methods).toEqual([
      'inspectImage', // the CLI reads the manifest to choose the name and network
      'list', // ...and checks the name is not another image's agent
      'ensureAvailable', // lifecycle
      'inspectImage',
      'list',
      'inspectVolume',
      'ensureVolume',
      'start',
    ]);
    const spec = h.runtime.started()[0];
    expect(spec).toMatchObject({ name: `av-${AGENT}`, network: 'none', user: '10001:10001', readOnlyRootfs: true, detach: true });
    expect(h.stdout()).toContain(`Started agent ${AGENT}`);
    expect(h.stdout()).toContain(`av-${AGENT}-data`);
    expect(h.stdout()).toContain('agentvault stop alpha');
  });

  it('passes name, limits, restart, writable rootfs and the command after -- to the lifecycle', async () => {
    const h = harness();
    await run(runCommand(h.deps), [
      IMAGE, '-d', '--name', 'gamma', '--cpus', '1.5', '--memory', '512m', '--pids-limit', '100',
      '--writable-rootfs', '--restart', 'on-failure', '--', 'sh', '-c', 'echo hi',
    ]);
    const spec = h.runtime.started()[0];
    expect(spec).toMatchObject({
      name: 'av-gamma',
      command: ['sh', '-c', 'echo hi'],
      limits: { cpus: 1.5, memory: '512m', pidsLimit: 100 },
      readOnlyRootfs: false,
      restart: 'on-failure',
    });
  });

  it.each([
    [['--cpus', 'lots'], '--cpus'],
    [['--cpus', '0'], '--cpus'],
    [['--memory', '2 gigs'], '--memory'],
    [['--pids-limit', '-5'], '--pids-limit'],
    [['--restart', 'always'], '--restart'],
    [['--network', 'host'], '--network'],
    [['--name', '../evil'], 'agent name'],
  ])('refuses %j before anything is created', async (flags, mention) => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', ...flags])).toBe(1);
    expect(h.stderr()).toContain(mention);
    expect(h.runtime.mutations).toEqual([]);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('reports a missing image with the way to get one, and creates nothing', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), ['agentvault/nope:1', '-d'])).toBe(1);
    expect(h.stderr()).toContain('Error: Image agentvault/nope:1 was not found');
    expect(h.stderr()).toContain('docker pull');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('refuses an image that is not an AgentVault image', async () => {
    const h = harness();
    h.runtime.images.set('busybox:1.37', { ...imageFor(manifestFor()), labels: {} });
    expect(await run(runCommand(h.deps), ['busybox:1.37', '-d'])).toBe(1);
    expect(h.stderr()).toContain('is not an AgentVault image');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('shows no stack trace, only the message and a one-line hint, when docker is unusable', async () => {
    const h = harness();
    h.runtime.failOn.set('inspectImage', new ContainerError('DAEMON_UNREACHABLE', 'Docker is installed but its daemon is not reachable - start Docker'));
    expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(1);
    expect(h.err).toHaveLength(2);
    expect(h.err[0]).toMatch(/^Error: Docker is installed but its daemon is not reachable/);
    expect(h.err[1]).toContain('Start Docker');
    expect(h.stderr()).not.toMatch(/\bat \S+ \(|\.ts:\d+/);
  });
});

describe('run: directory target', () => {
  function packagedDir(h: Harness, options: { record?: string } = {}): string {
    const dir = path.join(h.home, 'my-agent');
    const out = path.join(dir, 'dist', 'container');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'agentvault.json'), JSON.stringify(manifestFor()));
    if (options.record !== undefined) {
      fs.writeFileSync(path.join(out, IMAGE_RECORD_FILE), JSON.stringify({ schemaVersion: 1, image: options.record }));
    }
    return dir;
  }

  it('derives agentvault/<name>:<version> from the manifest when no image was recorded', async () => {
    const h = harness();
    const dir = packagedDir(h);
    await run(runCommand(h.deps), [dir, '-d']);
    expect(h.runtime.callsOf('inspectImage')[0]).toEqual([IMAGE]);
    expect(h.runtime.started()[0]?.image).toBe(IMAGE);
  });

  it('uses the image recorded by "package --image" instead of guessing', async () => {
    const h = harness();
    h.runtime.images.set('custom/tag:9', imageFor(manifestFor()));
    const dir = packagedDir(h, { record: 'custom/tag:9' });
    await run(runCommand(h.deps), [dir, '-d']);
    expect(h.runtime.started()[0]?.image).toBe('custom/tag:9');
  });

  it('resolves a relative directory against the injected cwd', async () => {
    const h = harness();
    packagedDir(h);
    await run(runCommand(h.deps), ['./my-agent', '-d']);
    expect(h.runtime.started()[0]?.image).toBe(IMAGE);
  });

  it('says to package first when the directory was never packaged, and when it does not exist', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.home, 'plain'));
    expect(await run(runCommand(h.deps), ['./plain', '-d'])).toBe(1);
    expect(h.stderr()).toContain('has not been packaged');
    expect(h.stderr()).toContain('package ./plain --target container');

    const missing = harness();
    expect(await run(runCommand(missing.deps), ['./nowhere', '-d'])).toBe(1);
    expect(missing.stderr()).toContain('does not exist');
    expect(missing.runtime.calls).toEqual([]);
  });

  it('treats a top-level agentvault.json that is not a container manifest as "not packaged"', async () => {
    const h = harness();
    const dir = path.join(h.home, 'generic');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'agentvault.json'), JSON.stringify({ name: 'generic-agent-config' }));
    expect(await run(runCommand(h.deps), ['./generic', '-d'])).toBe(1);
    expect(h.stderr()).toContain('has not been packaged');
  });
});

describe('run: network and services', () => {
  it('--proxy needs a service to proxy', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--proxy'])).toBe(1);
    expect(h.stderr()).toContain('at least one service');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('--proxy conflicts with --network bridge', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--proxy', '--network', 'bridge'])).toBe(1);
    expect(h.stderr()).toContain('conflicts');
  });

  it('--service with --network none is refused (a service needs the proxy)', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--network', 'none', '--service', 'ollama'])).toBe(1);
    expect(h.stderr()).toContain('--service needs the credential proxy');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('an explicit --network bridge reaches the lifecycle, which warns about it', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--network', 'bridge'])).toBe(0);
    expect(h.runtime.started()[0]?.network).toBe('bridge');
    expect(h.stderr()).toContain('unrestricted network access');
  });

  it('a service that injects no credential (ollama) needs no passphrase and no secret', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--service', 'ollama'])).toBe(0);
    const request = vi.mocked(startAgent).mock.calls[0]?.[0];
    expect(request?.network).toBe('proxy');
    expect(request?.proxyPlan?.config.routes.map((r) => r.name)).toEqual(['ollama']);
    expect(request?.proxyPlan?.secrets).toEqual({});
    expect(h.passphrases).toEqual([]);
  });

  describe('Ctrl-C during a detached start', () => {
    // A detached start takes seconds (networks, the sidecar, waiting for it). The default signal action killed the CLI
    // half-way, leaving the sidecar (which holds the real key), its networks and its 0600 env file behind.
    function interruptible(h: Harness): { fire: () => void } {
      const box: { fire: () => void } = { fire: () => undefined };
      h.deps.installSignalHandler = (handler) => {
        box.fire = handler;
        return () => undefined;
      };
      return box;
    }

    it('asks the start to stop, which rolls itself back, and exits 130 with a clear message', async () => {
      const h = harness();
      const signal = interruptible(h);
      vi.mocked(startAgent).mockImplementationOnce(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new ContainerError('INTERRUPTED', 'Interrupted; everything created so far was removed again')));
            signal.fire();
          })
      );
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(130);
      expect(h.stderr()).toContain('Interrupted');
      expect(h.stdout()).not.toContain('Started agent');
    });

    it('a second Ctrl-C while it rolls back changes nothing (the handler stays installed until the start has settled)', async () => {
      const h = harness();
      const signal = interruptible(h);
      let aborts = 0;
      vi.mocked(startAgent).mockImplementationOnce(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => {
              aborts += 1;
              setTimeout(() => reject(new ContainerError('INTERRUPTED', 'Interrupted')), 10);
            });
            signal.fire();
            signal.fire();
            signal.fire();
          })
      );
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(130);
      expect(aborts).toBe(1);
    });

    it('whatever failure the interrupt causes in the step in flight is reported as the interrupt', async () => {
      // A terminal's Ctrl-C reaches the docker client children as well, so the step in flight usually fails first.
      const h = harness();
      const signal = interruptible(h);
      vi.mocked(startAgent).mockImplementationOnce(() => {
        signal.fire();
        return Promise.reject(new ContainerError('COMMAND_FAILED', 'docker failed (exit 1): Command "docker" terminated by SIGINT'));
      });
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(130);
      expect(h.stderr()).toContain('Interrupted');
      expect(h.stderr()).not.toContain('terminated by SIGINT');
    });

    it('...but a failure with no interrupt keeps its own message and exit code', async () => {
      const h = harness();
      interruptible(h);
      vi.mocked(startAgent).mockRejectedValueOnce(new ContainerError('COMMAND_FAILED', 'docker failed (exit 1): no such image'));
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(1);
      expect(h.stderr()).toContain('no such image');
      expect(h.stderr()).not.toContain('Interrupted');
    });

    it('takes away a named volume this run created, like any other failed detached start', async () => {
      const h = harness();
      const signal = interruptible(h);
      vi.mocked(startAgent).mockImplementationOnce(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new ContainerError('INTERRUPTED', 'Interrupted')));
            signal.fire();
          })
      );
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'fresh:/fresh'])).toBe(130);
      expect(h.runtime.callsOf('removeVolume')).toEqual([[`av-${AGENT}-fresh`]]);
    });

    it('the handler is removed once the start is over, and a foreground run is untouched (it has its own handling)', async () => {
      const h = harness();
      let installed = 0;
      let uninstalled = 0;
      h.deps.installSignalHandler = () => {
        installed += 1;
        return () => {
          uninstalled += 1;
        };
      };
      vi.mocked(startAgent).mockResolvedValueOnce(started());
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
      expect([installed, uninstalled]).toEqual([1, 1]);
      expect(vi.mocked(startAgent).mock.calls[0]?.[0].signal).toBeDefined();

      vi.mocked(startAgent).mockResolvedValueOnce(started({ exitCode: 0 }));
      await run(runCommand(h.deps), [IMAGE]);
      expect(vi.mocked(startAgent).mock.calls[1]?.[0].signal).toBeUndefined();
    });
  });

  describe('a detached agent that died at once', () => {
    it('is reported after the success summary, with the code, a hint and the way to read its output', async () => {
      const h = harness();
      vi.mocked(startAgent).mockResolvedValueOnce(started({ containerId: 'a'.repeat(64), earlyExit: { exitCode: 127, state: 'exited' } }));
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0); // like `docker run -d`, the exit status is the start's
      expect(h.stdout()).toContain(`Started agent ${AGENT}`);
      expect(h.stderr()).toMatch(/exited immediately with code 127 \(command not found/);
      expect(h.stderr()).toContain(`agentvault container logs ${AGENT}`);
    });

    it.each([
      [126, /not executable/],
      [137, /--memory/],
      [3, /exited immediately with code 3\.\s/],
    ])('code %i gets the matching hint', async (exitCode, expected) => {
      const h = harness();
      vi.mocked(startAgent).mockResolvedValueOnce(started({ earlyExit: { exitCode, state: 'exited' } }));
      await run(runCommand(h.deps), [IMAGE, '-d']);
      expect(h.stderr()).toMatch(expected);
    });

    it('says crash-looping for a restarting container', async () => {
      const h = harness();
      vi.mocked(startAgent).mockResolvedValueOnce(started({ earlyExit: { exitCode: 1, state: 'restarting' } }));
      await run(runCommand(h.deps), [IMAGE, '-d']);
      expect(h.stderr()).toMatch(/crash-looping with code 1/);
    });

    it('prints nothing extra for a healthy start', async () => {
      const h = harness();
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
      expect(h.stderr()).not.toMatch(/exited immediately|crash-looping/);
    });

    it('asks startAgent to watch for the window (detached only)', async () => {
      const h = harness({ livenessGraceMs: 321 });
      await run(runCommand(h.deps), [IMAGE, '-d']);
      expect(vi.mocked(startAgent).mock.calls[0]?.[0].livenessGraceMs).toBe(321);
    });

    it('does not for a foreground run, which already waits for the exit', async () => {
      const h = harness({ livenessGraceMs: 321 });
      await run(runCommand(h.deps), [IMAGE]);
      expect(vi.mocked(startAgent).mock.calls[0]?.[0].livenessGraceMs).toBeUndefined();
    });
  });

  it('an unknown service is refused with the list of known ones', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--service', 'nosuch'])).toBe(1);
    expect(h.stderr()).toContain('Unknown proxy service');
    expect(h.stderr()).toContain('anthropic');
    expect(startAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Security property (e): declared secrets that cannot be resolved fail closed
// ---------------------------------------------------------------------------

describe('run: credentials fail closed (property e)', () => {
  function withSecretImage(): FakeRuntime {
    const runtime = new FakeRuntime();
    runtime.images.set(IMAGE, imageFor(SECRET_MANIFEST()));
    return runtime;
  }

  it('names the missing secrets, starts nothing and creates nothing when none can be resolved', async () => {
    const h = harness({}, withSecretImage());
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(1);

    expect(h.stderr()).toContain('Error: The agent needs credentials that are not available: anthropic. Nothing was started.');
    expect(h.stderr()).toContain('agentvault secrets add');
    expect(startAgent).not.toHaveBeenCalled();
    // Only reads happened: no network, volume, container or image was touched.
    expect(h.runtime.mutations).toEqual([]);
    expect(h.runtime.methods).toEqual(['inspectImage', 'list']);
    // There is no store, so there is nothing a passphrase could unlock: do not ask for one.
    expect(h.passphrases).toEqual([]);
  });

  it('with an environment variable set but without --secrets-from-env it still refuses (the variable is not used silently)', async () => {
    const h = harness({}, withSecretImage());
    h.deps.env = { AGENTVAULT_HOME: h.home, ANTHROPIC_API_KEY: CANARY };
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(1);
    expect(startAgent).not.toHaveBeenCalled();
    expect(h.all()).not.toContain(CANARY);
  });

  it('--secrets-from-env resolves from the conventional variable, hands the value to the sidecar plan only, and prints no value', async () => {
    const h = harness({}, withSecretImage());
    h.deps.env = { AGENTVAULT_HOME: h.home, ANTHROPIC_API_KEY: CANARY };
    vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy', proxyContainerName: `av-${AGENT}-proxy` }));

    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--yes'])).toBe(0);

    const request = vi.mocked(startAgent).mock.calls[0]?.[0];
    expect(request?.network).toBe('proxy');
    expect(request?.proxyPlan?.secrets).toEqual({ anthropic: CANARY });
    // The agent side of the plan carries the placeholder, never the key.
    expect(JSON.stringify(request?.proxyPlan?.agentEnv)).not.toContain(CANARY);
    expect(request?.explicitEnv).toEqual({});
    expect(h.all()).not.toContain(CANARY);
    expect(h.passphrases).toEqual([]);
  });

  it('resolves from the encrypted store, asking for the passphrase exactly once and only then', async () => {
    const h = harness({}, withSecretImage());
    await new SecretStore({ home: h.home }).set('anthropic', CANARY, PASS);
    vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));

    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(0);

    expect(h.passphrases).toEqual([{ purpose: 'secrets', confirm: false, message: expect.any(String) as string }]);
    expect(vi.mocked(startAgent).mock.calls[0]?.[0].proxyPlan?.secrets).toEqual({ anthropic: CANARY });
    expect(h.all()).not.toContain(CANARY);
    expect(h.all()).not.toContain(PASS);
  });

  it('with --secrets-from-env the store is not unlocked at all when every secret came from the environment', async () => {
    const h = harness({}, withSecretImage());
    await new SecretStore({ home: h.home }).set('anthropic', 'STORE-VALUE-that-loses', PASS);
    h.deps.env = { AGENTVAULT_HOME: h.home, ANTHROPIC_API_KEY: CANARY };
    vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));

    await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--yes']);

    expect(h.passphrases).toEqual([]);
    expect(vi.mocked(startAgent).mock.calls[0]?.[0].proxyPlan?.secrets).toEqual({ anthropic: CANARY });
  });

  it('falls back to the store for a secret the environment lacks, and names a secret neither has', async () => {
    const runtime = new FakeRuntime();
    runtime.images.set(IMAGE, imageFor(manifestFor({ secrets: ['anthropic', 'openai'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } })));
    const h = harness({}, runtime);
    await new SecretStore({ home: h.home }).set('anthropic', CANARY, PASS);
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--yes'])).toBe(1);
    expect(h.stderr()).toContain('credentials that are not available: openai.');
    expect(h.stderr()).not.toContain('anthropic.');
    expect(startAgent).not.toHaveBeenCalled();
    expect(h.runtime.mutations).toEqual([]);
    expect(h.all()).not.toContain(CANARY);
  });

  it('a wrong store passphrase is an integrity error, not a silent "missing"', async () => {
    const h = harness({ getPassphrase: () => Promise.resolve('not the passphrase') }, withSecretImage());
    await new SecretStore({ home: h.home }).set('anthropic', CANARY, PASS);
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(1);
    expect(h.stderr()).toContain('wrong passphrase');
    expect(h.stderr()).not.toContain('not the passphrase');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('manifest secrets with --network none is left to the lifecycle, which refuses before creating anything', async () => {
    const h = harness({}, withSecretImage());
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--network', 'none'])).toBe(1);
    expect(h.stderr()).toContain('declares credentials (anthropic)');
    expect(h.runtime.mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --env
// ---------------------------------------------------------------------------

describe('run: --env', () => {
  it('passes KEY=VALUE through and warns that the value is in the shell history', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValueOnce(started());
    await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'GREETING=hello world', '--env', 'EMPTY=']);
    expect(vi.mocked(startAgent).mock.calls[0]?.[0].explicitEnv).toEqual({ GREETING: 'hello world', EMPTY: '' });
    expect(h.stderr()).toContain('land in your shell history');
  });

  it('--env KEY copies the value from the environment and needs no history warning', async () => {
    const h = harness();
    h.deps.env = { AGENTVAULT_HOME: h.home, REGION: 'eu-west' };
    vi.mocked(startAgent).mockResolvedValueOnce(started());
    await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'REGION']);
    expect(vi.mocked(startAgent).mock.calls[0]?.[0].explicitEnv).toEqual({ REGION: 'eu-west' });
    expect(h.stderr()).not.toContain('shell history');
  });

  it('--env KEY for a variable that is not set is an error', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'NOT_SET'])).toBe(1);
    expect(h.stderr()).toContain('NOT_SET is not set');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('never echoes a malformed entry: it may be a key pasted into the wrong place', async () => {
    const h = harness();
    const pasted = 'sk-ant-api03-this-is-a-real-looking-key';
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--env', pasted])).toBe(1);
    expect(h.all()).not.toContain(pasted);
    expect(h.stderr()).toContain('--env expects KEY=VALUE');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('warns when the name looks like a credential, because the agent would hold the value', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValueOnce(started());
    await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'MY_API_KEY=whatever']);
    expect(h.stderr()).toContain('MY_API_KEY looks like a credential');
  });

  it('a reserved name is refused by the policy, and its value is not printed', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'AGENTVAULT_PASSWORD=hunter2hunter2'])).toBe(1);
    expect(h.stderr()).toContain('AGENTVAULT_PASSWORD');
    expect(h.all()).not.toContain('hunter2hunter2');
    expect(h.runtime.mutations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --volume
// ---------------------------------------------------------------------------

describe('run: --volume', () => {
  it('NAME:/path is a labelled volume namespaced to the agent', async () => {
    const h = harness();
    await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'cache:/cache']);
    expect(h.runtime.callsOf('ensureVolume')).toContainEqual([
      `av-${AGENT}-cache`,
      { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_VOLUME_KEY]: 'cache' },
    ]);
    expect(h.runtime.started()[0]?.mounts).toContainEqual({ kind: 'volume', source: `av-${AGENT}-cache`, target: '/cache' });
  });

  describe('a volume of that name that is not this agent\'s', () => {
    it('unlabelled (somebody else\'s): refused, never used, never removed, nothing started', async () => {
      const h = harness();
      h.runtime.foreignVolumes.set(`av-${AGENT}-cache`, {});
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'cache:/cache'])).toBe(1);
      expect(h.stderr()).toContain(`av-${AGENT}-cache`);
      expect(h.stderr()).toMatch(/not created by AgentVault/);
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.callsOf('removeVolume')).toEqual([]);
      expect(h.runtime.callsOf('ensureVolume')).toEqual([]);
    });

    it('another agent\'s (the names combine into the same Docker name): refused, naming the owner', async () => {
      const h = harness();
      h.runtime.seedVolume(`av-${AGENT}-cache`, 'someone-else', 'other-key');
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'cache:/cache'])).toBe(1);
      expect(h.stderr()).toContain('"someone-else"');
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.callsOf('removeVolume')).toEqual([]);
    });

    it('when a later volume is refused, the one already created for this run is taken away again, and only that one', async () => {
      const h = harness();
      h.runtime.foreignVolumes.set(`av-${AGENT}-second`, {});
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'first:/first', '--volume', 'second:/second'])).toBe(1);
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.callsOf('removeVolume')).toEqual([[`av-${AGENT}-first`]]);
      expect(h.runtime.volumes.map((v) => v.name)).toEqual([]);
    });
  });

  it('a bind mount is validated, announced as weakening isolation, and passed read-only when asked', async () => {
    const h = harness();
    const dir = path.join(h.home, 'shared');
    fs.mkdirSync(dir);
    await run(runCommand(h.deps), [IMAGE, '-d', '--volume', `${dir}:/shared:ro`]);
    expect(h.runtime.started()[0]?.mounts).toContainEqual({ kind: 'bind', source: dir, target: '/shared', readOnly: true });
    expect(h.stderr()).toContain('weakens isolation');
    expect(h.stderr()).toContain(dir);
  });

  it('a relative bind source is resolved against the injected cwd', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.home, 'rel'));
    await run(runCommand(h.deps), [IMAGE, '-d', '--volume', './rel:/rel']);
    expect(h.runtime.started()[0]?.mounts).toContainEqual({ kind: 'bind', source: path.join(h.home, 'rel'), target: '/rel' });
  });

  it('never mounts the Docker socket', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', '/var/run/docker.sock:/var/run/docker.sock'])).toBe(1);
    expect(h.stderr()).toContain('control of the host');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('refuses the Docker socket on its own, before the lifecycle is even asked', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValue(started());
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', '/var/run/docker.sock:/var/run/docker.sock'])).toBe(1);
    expect(startAgent).not.toHaveBeenCalled();
    expect(h.runtime.mutations).toEqual([]);
  });

  it('a bind source that does not exist is an error, not an empty directory created by Docker', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', '/nonexistent-avt-k/dir:/x'])).toBe(1);
    expect(h.stderr()).toContain('does not exist');
    expect(h.runtime.mutations).toEqual([]);
  });

  it.each([['justonepart'], ['a:b:c:d'], ['name:relative/path'], ['name:/path:rwx'], ['Bad Name:/x'], [':/x']])('rejects the malformed spec %j', async (spec) => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', spec])).toBe(1);
    expect(h.runtime.mutations).toEqual([]);
  });

  it('refuses a name that is already the agent\'s own declared volume', async () => {
    const h = harness();
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'data:/elsewhere'])).toBe(1);
    expect(h.stderr()).toContain('already the agent\'s own volume');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('removes a named volume it created when a detached start fails, but never one that already existed', async () => {
    const h = harness();
    h.runtime.seedVolume(`av-${AGENT}-old`, AGENT, 'old');
    vi.mocked(startAgent).mockRejectedValueOnce(new ContainerError('POLICY_VIOLATION', 'refused'));
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--volume', 'fresh:/fresh', '--volume', 'old:/old'])).toBe(1);
    expect(h.runtime.callsOf('removeVolume')).toEqual([[`av-${AGENT}-fresh`]]);
    expect(h.runtime.volumes.map((v) => v.name)).toEqual([`av-${AGENT}-old`]);
  });
});

// ---------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------

describe('run: foreground', () => {
  it('returns the agent exit code as the command exit code', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValueOnce(started({ exitCode: 3 }));
    expect(await run(runCommand(h.deps), [IMAGE])).toBe(3);
    expect(vi.mocked(startAgent).mock.calls[0]?.[0].detach).toBe(false);
  });

  it('exits 0 when the agent exits 0 and prints no spinner chatter', async () => {
    const h = harness();
    vi.mocked(startAgent).mockResolvedValueOnce(started({ exitCode: 0 }));
    expect(await run(runCommand(h.deps), [IMAGE])).toBe(0);
    expect(h.stdout()).not.toContain('Started agent');
  });

  it('a signal during the run stops the agent, so the lifecycle can tear the sidecar down, and the handler is removed afterwards', async () => {
    const handlers: Array<() => void> = [];
    const uninstall = vi.fn();
    const h = harness({
      installSignalHandler: (handler) => {
        handlers.push(handler);
        return uninstall;
      },
    });
    h.runtime.seedAgent(AGENT, 'running');
    h.runtime.seedAgent(AGENT, 'running', 'proxy');
    // A stop that leaves the containers "running", so a second stop request would be visible as more calls.
    h.runtime.stop = (name, timeoutSec) => {
      h.runtime.calls.push({ method: 'stop', args: [name, timeoutSec] });
      return Promise.resolve();
    };
    let release: (value: StartedAgent) => void = () => undefined;
    vi.mocked(startAgent).mockImplementationOnce(
      () =>
        new Promise<StartedAgent>((resolve) => {
          release = resolve;
        })
    );

    const running = run(runCommand(h.deps), [IMAGE]);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    expect(uninstall).not.toHaveBeenCalled();

    handlers[0]?.();
    handlers[0]?.(); // a second Ctrl-C must not stop twice
    await vi.waitFor(() => expect(h.runtime.callsOf('stop')).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.runtime.callsOf('stop').map(([name]) => name)).toEqual([`av-${AGENT}`, `av-${AGENT}-proxy`]);

    release(started({ exitCode: 143 }));
    expect(await running).toBe(143);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('a detached run installs a handler only for the duration of the start, and removes it', async () => {
    // (It used to install none, so Ctrl-C killed the CLI half-way through a start and leaked the sidecar.)
    const uninstall = vi.fn();
    const install = vi.fn(() => uninstall);
    const h = harness({ installSignalHandler: install });
    await run(runCommand(h.deps), [IMAGE, '-d']);
    expect(install).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('prints the lifecycle warnings immediately in the foreground, and after the spinner when detached', async () => {
    const h = harness();
    vi.mocked(startAgent).mockImplementationOnce((request) => {
      request.onWarning?.('careful now');
      expect(h.stderr()).toContain('careful now');
      return Promise.resolve(started({ exitCode: 0 }));
    });
    await run(runCommand(h.deps), [IMAGE]);

    const detached = harness();
    vi.mocked(startAgent).mockImplementationOnce((request) => {
      request.onWarning?.('careful later');
      expect(detached.stderr()).not.toContain('careful later');
      return Promise.resolve(started());
    });
    await run(runCommand(detached.deps), [IMAGE, '-d']);
    expect(detached.stderr()).toContain('careful later');
  });
});

// ---------------------------------------------------------------------------
// logs / stats / inspect / exec
// ---------------------------------------------------------------------------

describe('logs, stats, inspect, exec', () => {
  it('logs prints stdout and stderr of the agent container and honours --tail', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.logsResult = ok({ stdout: 'line one\nline two', stderr: 'a warning' });
    expect(await run(containerLogsCommand(h.deps), [AGENT, '--tail', '5'])).toBe(0);
    expect(h.runtime.callsOf('logs')).toEqual([[`av-${AGENT}`, { tail: 5 }]]);
    expect(h.out).toEqual(['line one\nline two']);
    expect(h.err).toEqual(['a warning']);
  });

  it('logs --follow streams (the runtime writes to the terminal) and prints nothing itself', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    await run(containerLogsCommand(h.deps), [AGENT, '--follow']);
    expect(h.runtime.callsOf('logs')).toEqual([[`av-${AGENT}`, { follow: true }]]);
    expect(h.out).toEqual([]);
  });

  it('refuses a bad --tail and an agent that does not exist, with the NOT_FOUND hint', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    expect(await run(containerLogsCommand(h.deps), [AGENT, '--tail', 'many'])).toBe(1);
    expect(await run(containerLogsCommand(h.deps), ['ghost'])).toBe(1);
    expect(h.stderr()).toContain('No AgentVault agent named "ghost" exists');
    expect(h.stderr()).toContain('agentvault ps --all');
    expect(h.runtime.callsOf('logs')).toEqual([]);
  });

  it('does not touch a foreign container that merely has the name av-<agent>', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.containers = []; // docker would find av-alpha, but list() (labelled containers only) does not
    expect(await run(containerLogsCommand(h.deps), [AGENT])).toBe(1);
    expect(h.runtime.callsOf('logs')).toEqual([]);
  });

  it('stats prints the runtime table', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    await run(containerStatsCommand(h.deps), [AGENT]);
    expect(h.runtime.callsOf('stats')).toEqual([[`av-${AGENT}`]]);
    expect(h.stdout()).toBe('CONTAINER  CPU');
  });

  it('inspect prints environment VALUES as <redacted> even when the runtime returned them', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.inspectResult = {
      Id: 'abc',
      Config: { Env: [`SOME_KEY=${CANARY}`, 'PLAIN=visible-value-123', 'NOEQUALS'], Image: 'x' },
      State: { Running: true },
    };
    expect(await run(containerInspectCommand(h.deps), [AGENT])).toBe(0);
    const printed = h.stdout();
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('visible-value-123');
    const parsed = JSON.parse(printed) as { Config: { Env: string[]; Image: string }; State: { Running: boolean } };
    expect(parsed.Config.Env).toEqual(['SOME_KEY=<redacted>', 'PLAIN=<redacted>', 'NOEQUALS']);
    expect(parsed.Config.Image).toBe('x');
    expect(parsed.State.Running).toBe(true);
  });

  it('redactInspectOutput does not modify its input and survives odd shapes', () => {
    const input = { Config: { Env: ['A=secret'] } };
    const output = redactInspectOutput(input) as typeof input;
    expect(input.Config.Env).toEqual(['A=secret']);
    expect(output.Config.Env).toEqual(['A=<redacted>']);
    expect(redactInspectOutput(null)).toBeNull();
    expect(redactInspectOutput('text')).toBe('text');
    expect(redactInspectOutput({ Config: { Env: [42, null] } })).toEqual({ Config: { Env: ['<redacted>', '<redacted>'] } });
    expect(redactInspectOutput({ Config: null })).toEqual({ Config: null });
  });

  it('exec runs the command after -- in the agent container and prints its output', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.execResult = ok({ stdout: 'total 0', stderr: 'oops' });
    expect(await run(containerExecCommand(h.deps), [AGENT, '--', 'ls', '-la'])).toBe(0);
    expect(h.runtime.callsOf('exec')).toEqual([[`av-${AGENT}`, ['ls', '-la'], { interactive: false }]]);
    expect(h.stdout()).toBe('total 0');
    expect(h.stderr()).toBe('oops');
  });

  it('exec passes the command exit code on', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.execResult = ok({ exitCode: 2 });
    expect(await run(containerExecCommand(h.deps), [AGENT, '--', 'false'])).toBe(2);
  });

  it('exec -i does not print the output again (it already went to the terminal)', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.execResult = ok({ stdout: 'should not be printed twice' });
    await run(containerExecCommand(h.deps), [AGENT, '-i', '--', 'sh']);
    expect(h.runtime.callsOf('exec')).toEqual([[`av-${AGENT}`, ['sh'], { interactive: true }]]);
    expect(h.out).toEqual([]);
  });

  it('exec refuses an agent that is not running without calling exec', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT, 'exited');
    expect(await run(containerExecCommand(h.deps), [AGENT, '--', 'ls'])).toBe(1);
    expect(h.stderr()).toContain('is not running (state: exited)');
    expect(h.runtime.callsOf('exec')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stop / rm
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('stops the agent, then its sidecar, and says the data is kept', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    h.runtime.seedAgent(AGENT, 'running', 'proxy');
    expect(await run(stopCommand(h.deps), [AGENT])).toBe(0);
    expect(h.runtime.callsOf('stop')).toEqual([
      [`av-${AGENT}`, undefined],
      [`av-${AGENT}-proxy`, undefined],
    ]);
    expect(h.stdout()).toContain(`Stopped av-${AGENT}, av-${AGENT}-proxy`);
    expect(h.stdout()).toContain('data is kept');
    expect(h.runtime.callsOf('removeVolume')).toEqual([]);
  });

  it('-t is the stop timeout', async () => {
    const h = harness();
    h.runtime.seedAgent(AGENT);
    await run(stopCommand(h.deps), [AGENT, '-t', '30']);
    expect(h.runtime.callsOf('stop')).toEqual([[`av-${AGENT}`, 30]]);
  });

  it('is idempotent: nothing running is a message, not an error', async () => {
    const h = harness();
    expect(await run(stopCommand(h.deps), [AGENT])).toBe(0);
    expect(h.stdout()).toContain(`Agent "${AGENT}" is not running.`);
  });

  it('rejects an agent name that could escape into a docker argument', async () => {
    const h = harness();
    expect(await run(stopCommand(h.deps), ['--', '--all'])).toBe(1);
    expect(await run(stopCommand(h.deps), ['--', '-x'])).toBe(1);
    expect(h.stderr()).toContain('Invalid agent name');
    expect(h.runtime.callsOf('stop')).toEqual([]);
  });
});

describe('rm (property b: data loss is explicit)', () => {
  function seeded(): Harness {
    const h = harness();
    h.runtime.seedAgent(AGENT, 'exited');
    h.runtime.seedAgent(AGENT, 'exited', 'proxy');
    h.runtime.seedVolume(`av-${AGENT}-data`, AGENT, 'data');
    h.runtime.networks.add(`av-${AGENT}-net`);
    return h;
  }

  it('without --volumes removes the containers and networks and NEVER a volume', async () => {
    const h = seeded();
    expect(await run(rmCommand(h.deps), [AGENT])).toBe(0);
    expect(h.runtime.callsOf('removeVolume')).toEqual([]);
    expect(h.runtime.volumes.map((v) => v.name)).toEqual([`av-${AGENT}-data`]);
    expect(h.runtime.callsOf('remove')).toEqual([
      [`av-${AGENT}`, { force: true }],
      [`av-${AGENT}-proxy`, { force: true }],
    ]);
    expect(h.stdout()).toContain(`Removed av-${AGENT}, av-${AGENT}-proxy, av-${AGENT}-net`);
    expect(h.stdout()).toContain(`Kept volumes av-${AGENT}-data`);
    expect(h.stdout()).toContain('--volumes');
  });

  it('does not even ask a question without --volumes', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = harness({ confirm });
    h.runtime.seedAgent(AGENT, 'exited');
    await run(rmCommand(h.deps), [AGENT]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('--volumes without a terminal and without -y can never be answered: it fails (exit 1) instead of looking like success', async () => {
    // Piped stdin is not an answer. Exiting 0 here let a script believe the data had been deleted.
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = seeded();
    h.deps.confirm = confirm;
    expect(await run(rmCommand(h.deps), [AGENT, '--volumes'])).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.stderr()).toContain('-y');
    expect(h.runtime.mutations).toEqual([]);
  });

  it('--volumes asks first, naming the volumes, and removes nothing at all when the answer is no', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const h = seeded();
    h.deps.interactive = true;
    h.deps.confirm = confirm;
    expect(await run(rmCommand(h.deps), [AGENT, '--volumes'])).toBe(0); // the user said no, and knows it
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String((confirm.mock.calls as unknown[][])[0]?.[0])).toContain(`av-${AGENT}-data`);
    expect(h.runtime.mutations).toEqual([]);
    expect(h.stdout()).toContain('Aborted. Nothing was removed');
  });

  it('--volumes deletes the volumes after a yes', async () => {
    const h = seeded();
    h.deps.interactive = true;
    h.deps.confirm = () => Promise.resolve(true);
    expect(await run(rmCommand(h.deps), [AGENT, '--volumes'])).toBe(0);
    expect(h.runtime.callsOf('removeVolume')).toEqual([[`av-${AGENT}-data`]]);
    expect(h.stdout()).toContain(`Deleted volumes av-${AGENT}-data`);
  });

  it('--volumes -y skips the question', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const h = seeded();
    h.deps.confirm = confirm;
    expect(await run(rmCommand(h.deps), [AGENT, '--volumes', '-y'])).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.runtime.callsOf('removeVolume')).toEqual([[`av-${AGENT}-data`]]);
  });

  it('with no terminal and no -y nothing is deleted and the command FAILS, so a script cannot mistake it for success', async () => {
    const h = seeded();
    delete h.deps.confirm; // the real default: "no" without a TTY
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect(await run(rmCommand(h.deps), [AGENT, '--volumes'])).toBe(1);
    } finally {
      if (original) Object.defineProperty(process.stdin, 'isTTY', original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(h.runtime.mutations).toEqual([]);
    expect(h.runtime.volumes).toHaveLength(1);
  });

  it('--volumes with an agent that has no volumes asks nothing', async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const h = harness({ confirm });
    h.runtime.seedAgent(AGENT, 'exited');
    await run(rmCommand(h.deps), [AGENT, '--volumes']);
    expect(confirm).not.toHaveBeenCalled();
    expect(h.runtime.callsOf('remove')).toHaveLength(1);
  });

  it('is idempotent for an agent that is already gone', async () => {
    const h = harness();
    expect(await run(rmCommand(h.deps), [AGENT])).toBe(0);
    expect(h.stdout()).toContain('Nothing to remove');
  });
});

// ---------------------------------------------------------------------------
// cli-support: errors and passphrases
// ---------------------------------------------------------------------------

describe('renderError: credential-shaped text the user pasted by mistake', () => {
  // `secrets add sk-ant-...` (key in the name slot), `--service ghp_...` and similar are rejected with a message that
  // quotes the argument; the quote must not put a pasted key on the terminal or into a log.
  // Assembled at runtime on purpose: a complete token-shaped literal in the source trips secret scanning (and push
  // protection) even though these are made up.
  const join = (...parts: string[]): string => parts.join('');
  it.each([
    ['an Anthropic/OpenAI style key', join('sk', '-ant-api03-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
    ['a GitHub token', join('gh', 'p_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')],
    ['an AWS access key id', join('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['a Slack token', join('xo', 'xb-', '1234567890-abcdefghijklmnop')],
    ['a long bearer value', join('Bear', 'er ', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop')],
  ])('redacts %s', (_label, token) => {
    const rendered = renderError(new ContainerError('INVALID_INPUT', `Secret name "${token}" is not valid`));
    expect(rendered.message).not.toContain(token);
    expect(rendered.message).toContain('[redacted]');
    expect(rendered.message).toContain('is not valid');
  });

  it('leaves ordinary messages alone (names, paths, words that merely start like a token)', () => {
    const message = 'Agent "skeleton-key" not found at /tmp/ghost-1/sk-notes and ghp is not a token';
    expect(renderError(new Error(message)).message).toBe(`Error: ${message}`);
  });
});

describe('renderError', () => {
  it.each([
    ['NOT_INSTALLED', 'Install Docker'],
    ['DAEMON_UNREACHABLE', 'Start Docker'],
    ['PERMISSION_DENIED', 'docker" group'],
    ['MISSING_SECRET', 'secrets add'],
    ['NOT_FOUND', 'agentvault ps --all'],
    ['TIMEOUT', 'did not answer'],
    ['INTEGRITY', 'wrong passphrase'],
    ['POLICY_VIOLATION', 'security rule'],
    ['COMMAND_FAILED', 'Docker reported'],
  ] as const)('gives %s a one-line hint', (code, fragment) => {
    const rendered = renderError(new ContainerError(code, 'boom'));
    expect(rendered.message).toBe('Error: boom');
    expect(rendered.hint).toContain(fragment);
    expect(rendered.hint).not.toContain('\n');
  });

  it('gives INVALID_INPUT no hint and a plain Error none either', () => {
    expect(renderError(new ContainerError('INVALID_INPUT', 'bad')).hint).toBeUndefined();
    expect(renderError(new Error('plain')).hint).toBeUndefined();
    expect(renderError('a string').message).toBe('Error: Unknown error');
  });

  it('scrubs every sensitive value it was told about, whatever put it in the message', () => {
    const rendered = renderError(new ContainerError('COMMAND_FAILED', `docker said ${CANARY} and ${PASS}`), [CANARY, PASS]);
    expect(rendered.message).toBe('Error: docker said [redacted] and [redacted]');
  });

  it('a passphrase obtained during a command is scrubbed from the error that command prints', async () => {
    const h = harness({ getPassphrase: () => Promise.resolve(PASS) });
    h.runtime.images.set(IMAGE, imageFor(SECRET_MANIFEST()));
    await new SecretStore({ home: h.home }).set('anthropic', CANARY, PASS);
    vi.mocked(startAgent).mockRejectedValueOnce(new ContainerError('COMMAND_FAILED', `leaky: ${PASS} / ${CANARY}`));
    expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(1);
    expect(h.stderr()).toContain('leaky: [redacted] / [redacted]');
    expect(h.all()).not.toContain(PASS);
    expect(h.all()).not.toContain(CANARY);
  });
});

describe('the real Docker runtime, created on first use', () => {
  it('sweeps env-file directories left by a process that died, once, when it is created', () => {
    const tmp = mkdtemp('avt-k-sweep-');
    const original = process.env['TMPDIR'];
    process.env['TMPDIR'] = tmp;
    try {
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
      const stale = path.join(tmp, `avt-env-${dead}-abcdef`);
      fs.mkdirSync(stale, { mode: 0o700 });
      fs.writeFileSync(path.join(stale, 'env'), 'LEFT_BEHIND=1\n', { mode: 0o600 });

      const ctx = resolveDeps({ env: { AGENTVAULT_HOME: tmp } }); // no runtime injected: the real one
      expect(fs.existsSync(stale)).toBe(true); // nothing happens until a command asks for the runtime
      ctx.runtime();
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      if (original === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = original;
    }
  });

  it('an injected runtime sweeps nothing (tests and embedders keep control)', () => {
    const tmp = mkdtemp('avt-k-sweep2-');
    const original = process.env['TMPDIR'];
    process.env['TMPDIR'] = tmp;
    try {
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
      const stale = path.join(tmp, `avt-env-${dead}-abcdef`);
      fs.mkdirSync(stale, { mode: 0o700 });
      resolveDeps({ runtime: new FakeRuntime() }).runtime();
      expect(fs.existsSync(stale)).toBe(true);
    } finally {
      if (original === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = original;
    }
  });
});

describe('createPassphraseProvider', () => {
  const request: PassphraseRequest = { purpose: 'snapshot', confirm: true, message: 'Passphrase?' };

  it('uses the environment variable of the purpose', async () => {
    const provider = createPassphraseProvider({ AGENTVAULT_SNAPSHOT_PASSPHRASE: PASS, AGENTVAULT_SECRETS_PASSPHRASE: 'another one here' }, false);
    expect(await provider(request)).toBe(PASS);
    expect(await provider({ ...request, purpose: 'secrets' })).toBe('another one here');
  });

  it('fails closed without a variable and without a terminal, naming the variable', async () => {
    const provider = createPassphraseProvider({}, false);
    const error = await provider(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerError);
    expect((error as ContainerError).message).toContain('AGENTVAULT_SNAPSHOT_PASSPHRASE');
    expect((error as ContainerError).message).toContain('never accepted as command-line flags');
  });

  it('rejects a too-short variable by name without echoing it', async () => {
    const provider = createPassphraseProvider({ AGENTVAULT_SNAPSHOT_PASSPHRASE: 'short' }, false);
    const error = (await provider(request).catch((e: unknown) => e)) as ContainerError;
    expect(error.message).toBe('AGENTVAULT_SNAPSHOT_PASSPHRASE must be at least 8 characters');
  });

  it('treats an empty variable as unset', async () => {
    const provider = createPassphraseProvider({ AGENTVAULT_SNAPSHOT_PASSPHRASE: '' }, false);
    await expect(provider(request)).rejects.toThrow('A passphrase is required');
  });
});

// ---------------------------------------------------------------------------
// The image manifest is a REQUEST, never a grant. The agentvault.manifest label is written by whoever built
// the image. An adversarial review showed a hand-built label could, with a plain `run <image> -d`, forward
// the user's real GITHUB_TOKEN into the agent, pick the unrestricted bridge network (an end-to-end exfiltration
// of a canary key), attach every stored credential to the sidecar, and take over another agent's data by name.
// ---------------------------------------------------------------------------

describe('run: the image manifest is a request, never a grant', () => {
  const HOST_TOKEN = 'ghp_HOST-CANARY-0123456789';
  const HOST_AWS = 'aws-HOST-CANARY-abcdefghij';

  function withManifest(manifest: ContainerManifest, env: NodeJS.ProcessEnv = {}): Harness {
    const runtime = new FakeRuntime();
    runtime.images.set(IMAGE, imageFor(manifest));
    const h = harness({}, runtime);
    h.deps.env = { AGENTVAULT_HOME: h.home, ...env };
    return h;
  }

  describe('host environment', () => {
    const greedy = (): ContainerManifest => manifestFor({ env: ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'] });

    it('is NOT copied into the agent just because the image names it', async () => {
      const h = withManifest(greedy(), { GITHUB_TOKEN: HOST_TOKEN, AWS_SECRET_ACCESS_KEY: HOST_AWS });
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
      const env = h.runtime.started()[0]?.env ?? {};
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(JSON.stringify(h.runtime.started())).not.toContain(HOST_TOKEN);
      expect(JSON.stringify(h.runtime.started())).not.toContain(HOST_AWS);
    });

    it('is listed by NAME, with the way to provide it, and no value is ever printed', async () => {
      const h = withManifest(greedy(), { GITHUB_TOKEN: HOST_TOKEN, AWS_SECRET_ACCESS_KEY: HOST_AWS });
      await run(runCommand(h.deps), [IMAGE, '-d']);
      expect(h.stderr()).toMatch(/reads GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY/);
      expect(h.stderr()).toContain('--env GITHUB_TOKEN');
      expect(h.all()).not.toContain(HOST_TOKEN);
      expect(h.all()).not.toContain(HOST_AWS);
    });

    it('reaches the agent only for names the USER typed with --env', async () => {
      const h = withManifest(greedy(), { GITHUB_TOKEN: HOST_TOKEN, AWS_SECRET_ACCESS_KEY: HOST_AWS });
      await run(runCommand(h.deps), [IMAGE, '-d', '--env', 'GITHUB_TOKEN']);
      const env = h.runtime.started()[0]?.env ?? {};
      expect(env['GITHUB_TOKEN']).toBe(HOST_TOKEN);
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      // Names already provided are not nagged about.
      expect(h.stderr()).not.toMatch(/reads GITHUB_TOKEN/);
    });

    it('says nothing when the image declares no variables', async () => {
      const h = withManifest(manifestFor());
      await run(runCommand(h.deps), [IMAGE, '-d']);
      expect(h.stderr()).not.toMatch(/reads /);
    });
  });

  describe('network', () => {
    const bridgey = (): ContainerManifest => manifestFor({ isolation: { network: 'bridge', user: '10001:10001', readOnlyRootfs: true } });

    it('an image cannot choose the unrestricted bridge network: refused, nothing created, the way to opt in is named', async () => {
      const h = withManifest(bridgey());
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(1);
      expect(h.stderr()).toContain('--network bridge');
      expect(h.stderr()).toMatch(/unrestricted/i);
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.mutations).toEqual([]);
    });

    it('the user can still choose bridge explicitly (and is warned, as before)', async () => {
      const h = withManifest(bridgey());
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--network', 'bridge'])).toBe(0);
      expect(h.runtime.started()[0]?.network).toBe('bridge');
      expect(h.stderr()).toContain('unrestricted network access');
    });

    it('an image may still narrow: manifest none stays none', async () => {
      const h = withManifest(manifestFor());
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
      expect(h.runtime.started()[0]?.network).toBe('none');
    });
  });

  describe('stored credentials', () => {
    const asks = (...secrets: string[]): ContainerManifest =>
      manifestFor({ secrets, isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });
    const keys = { ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: `${CANARY}-openai` };

    it('credentials the image asks for are refused without approval, naming them and the flags, before anything is read or created', async () => {
      const h = withManifest(asks('anthropic', 'openai'), keys);
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env'])).toBe(1);
      expect(h.stderr()).toContain('anthropic, openai');
      expect(h.stderr()).toContain('--service anthropic');
      expect(h.stderr()).toContain('--yes');
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.mutations).toEqual([]);
      expect(h.passphrases).toEqual([]); // the store is not even unlocked
      expect(h.all()).not.toContain(CANARY);
    });

    it('--yes approves what the image asked for', async () => {
      const h = withManifest(asks('anthropic'), keys);
      vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' })); // the fake sidecar never reports ready
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--yes'])).toBe(0);
      expect(vi.mocked(startAgent).mock.calls[0]?.[0].proxyPlan?.config.routes.map((r) => r.name)).toEqual(['anthropic']);
    });

    it('--service <name> is the user naming it, so it needs no further approval', async () => {
      const h = withManifest(asks('anthropic'), keys);
      vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--service', 'anthropic'])).toBe(0);
    });

    it('approval covers only the services named: a second one the image asked for is still refused', async () => {
      const h = withManifest(asks('anthropic', 'openai'), keys);
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env', '--service', 'anthropic'])).toBe(1);
      expect(h.stderr()).toContain('openai');
      expect(h.stderr()).not.toMatch(/image asks .*anthropic/);
    });

    it('on a terminal the user is asked, with the services named; yes proceeds', async () => {
      const questions: string[] = [];
      const h = withManifest(asks('anthropic'), keys);
      h.deps.interactive = true;
      h.deps.confirm = (question) => {
        questions.push(question);
        return Promise.resolve(true);
      };
      vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env'])).toBe(0);
      expect(questions).toHaveLength(1);
      expect(questions[0]).toContain('anthropic');
    });

    it('on a terminal, no is no: exit 1, nothing created, nothing read', async () => {
      const h = withManifest(asks('anthropic'), keys);
      h.deps.interactive = true;
      h.deps.confirm = () => Promise.resolve(false);
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--secrets-from-env'])).toBe(1);
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.mutations).toEqual([]);
    });

    it('a service that opens a path to the HOST (ollama) is never enabled from a manifest, not even with --yes', async () => {
      const h = withManifest(asks('ollama'));
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--yes'])).toBe(1);
      expect(h.stderr()).toContain('--service ollama');
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.mutations).toEqual([]);
    });

    it('...but the user can enable it by naming it', async () => {
      const h = withManifest(asks('ollama'));
      vi.mocked(startAgent).mockResolvedValueOnce(started({ network: 'proxy' }));
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--service', 'ollama'])).toBe(0);
    });
  });

  describe('taking over an existing agent by name', () => {
    function withExisting(existingImage: string): Harness {
      const h = withManifest(manifestFor());
      h.runtime.seedAgent(AGENT, 'exited');
      h.runtime.inspectResult = { Config: { Image: existingImage } };
      return h;
    }

    it('an image from a DIFFERENT repository does not silently adopt the stopped agent and its data', async () => {
      const h = withExisting('agentvault/victim:1');
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(1);
      expect(h.stderr()).toContain('agentvault/victim:1');
      expect(h.stderr()).toContain(IMAGE);
      expect(h.stderr()).toContain(`--name ${AGENT}`);
      expect(startAgent).not.toHaveBeenCalled();
      expect(h.runtime.mutations).toEqual([]);
    });

    it('--name is the user taking responsibility, so it proceeds', async () => {
      const h = withExisting('agentvault/victim:1');
      expect(await run(runCommand(h.deps), [IMAGE, '-d', '--name', AGENT])).toBe(0);
    });

    it('a new version of the SAME repository (the normal rebuild-and-rerun loop) needs nothing', async () => {
      const h = withExisting('agentvault/alpha:0.9');
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
    });

    it('compares repositories, not tags, and not registry ports', async () => {
      const h = withExisting('localhost:5000/agentvault/alpha:0.9');
      h.runtime.images.set('localhost:5000/agentvault/alpha:1', imageFor(manifestFor()));
      expect(await run(runCommand(h.deps), ['localhost:5000/agentvault/alpha:1', '-d'])).toBe(0);
    });

    it('a name that is free needs nothing', async () => {
      const h = withManifest(manifestFor());
      expect(await run(runCommand(h.deps), [IMAGE, '-d'])).toBe(0);
    });
  });
});
