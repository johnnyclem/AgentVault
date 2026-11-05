/**
 * Lifecycle against a STATEFUL FAKE runtime: it remembers containers,
 * networks and volumes and refuses what Docker refuses (name in use, network
 * with endpoints, volume in use), so these tests prove the exact call ORDER,
 * what is refused before anything exists, and what a rollback leaves behind.
 * The real-daemon behaviour is covered by lifecycle.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  PROXY_READY_POLL_MS,
  PROXY_READY_TIMEOUT_MS,
  listAgents,
  redactSecrets,
  removeAgent,
  startAgent,
  stopAgent,
} from '../../src/container/lifecycle.js';
import type { StartAgentOptions } from '../../src/container/lifecycle.js';
import { containerManifestSchema, manifestToLabel } from '../../src/container/manifest.js';
import type { ContainerManifest } from '../../src/container/manifest.js';
import {
  ContainerError,
  LABEL_AGENT,
  LABEL_MANAGED,
  LABEL_MANIFEST,
  LABEL_ROLE,
  LABEL_VOLUME_KEY,
  PROXY_ALIAS,
  PROXY_PLACEHOLDER_KEY,
  PROXY_SECRET_ENV_PREFIX,
} from '../../src/container/types.js';
import type {
  BuildRequest,
  BuildResult,
  CommandResult,
  CommandRunner,
  ContainerErrorCode,
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ImageInfo,
  ProxyPlan,
} from '../../src/container/types.js';

const AGENT = 'alpha';
const IMAGE = 'agentvault/alpha:1';
const CANARY = 'CANARY-SECRET-5f4dcc3b5aa765d61d8327deb882cf99';
const LISTENING = '{"event":"listening","port":8080}';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function manifestFor(over: Partial<ContainerManifest> = {}): ContainerManifest {
  return containerManifestSchema.parse({
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
    ...over,
  });
}

function imageFor(manifest: ContainerManifest, user = '10001:10001'): ImageInfo {
  return { id: 'sha256:abc', repoTags: [IMAGE], repoDigests: [], labels: { [LABEL_MANIFEST]: manifestToLabel(manifest) }, user, sizeBytes: 1 };
}

function planFor(over: Partial<ProxyPlan> = {}): ProxyPlan {
  return {
    config: {
      version: 1,
      listenPort: 8080,
      routes: [
        { name: 'svc', pathPrefix: '/svc', upstream: 'https://api.example.com', inject: [{ header: 'x-api-key', secret: 'svc' }] },
      ],
      maxBodyBytes: 1_000_000,
      upstreamTimeoutMs: 10_000,
    },
    secrets: { svc: CANARY },
    agentEnv: { SVC_API_KEY: PROXY_PLACEHOLDER_KEY, SVC_BASE_URL: `http://${PROXY_ALIAS}:8080/svc` },
    scriptSource: `console.log('${LISTENING}');`,
    image: 'node:22-slim',
    ...over,
  };
}

const SECRET_MANIFEST = (): ContainerManifest =>
  manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });

// ---------------------------------------------------------------------------
// Stateful fake runtime
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
  mutating: boolean;
}

interface FakeContainer {
  spec: ContainerSpec;
  state: string;
  networks: Set<string>;
}

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
const CLEANUP = new Set(['remove', 'removeNetwork', 'removeVolume']);

const ok = (): CommandResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false });

class FakeRuntime implements ContainerRuntime {
  readonly runner: CommandRunner = () => Promise.resolve(ok());
  readonly calls: Call[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, { internal: boolean }>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly images = new Map<string, ImageInfo>();
  readonly foreground: Array<{ spec: ContainerSpec; io: unknown; containersDuring: string[]; networksDuring: string[] }> = [];
  readonly started: ContainerSpec[] = [];

  /** Fail the call with this index (counting every call, in order). */
  failAt: number | undefined;
  /** Called with the index of each Docker call as it begins. */
  onCall: ((index: number) => void) | undefined;
  private failed = false;
  /** After the injected failure, every cleanup call fails too. */
  failCleanup = false;
  /** Make the START of a container with this name fail the way docker reports a name clash. */
  nameClash: string | undefined;
  sidecarDies = false;
  /** When set, the agent container is already dead the moment it starts, with this status text. */
  agentDies: { state: string; status: string } | undefined;
  /** Make list() throw (a daemon hiccup during the liveness watch). */
  listThrows: Error | undefined;
  foregroundExit = 0;
  foregroundThrows: Error | undefined;
  proxyLogs: (poll: number) => string = () => `${LISTENING}\n`;
  private logPolls = 0;

  constructor(manifest: ContainerManifest = manifestFor(), user = '10001:10001') {
    this.images.set(IMAGE, imageFor(manifest, user));
  }

  private step(method: string, args: unknown[]): void {
    const index = this.calls.length;
    this.calls.push({ method, args, mutating: MUTATING.has(method) });
    this.onCall?.(index);
    if (this.failAt === index) {
      this.failed = true;
      throw new ContainerError('COMMAND_FAILED', `injected failure at call ${index} (${method})`);
    }
    if (this.failCleanup && this.failed && CLEANUP.has(method)) {
      throw new ContainerError('COMMAND_FAILED', `cleanup refused: ${method}`);
    }
  }

  // -- inspection helpers (not part of the contract) ------------------------

  get mutations(): string[] {
    return this.calls.filter((c) => c.mutating).map(fmt);
  }
  get trace(): string[] {
    return this.calls.map(fmt);
  }
  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
  seed(name: string, role: 'agent' | 'proxy' | 'helper', agent: string, state: string, labelsOverride?: Record<string, string>): void {
    const spec: ContainerSpec = {
      name,
      image: IMAGE,
      role,
      user: '10001:10001',
      network: 'none',
      mounts: [],
      tmpfs: [],
      env: {},
      labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: agent, [LABEL_ROLE]: role, ...(labelsOverride ?? {}) },
      limits: { cpus: 1, memory: '64m', pidsLimit: 10 },
      readOnlyRootfs: true,
      detach: true,
      init: true,
    };
    this.containers.set(name, { spec, state, networks: new Set() });
  }
  /** A running container with this name that AgentVault did not create (no labels). */
  seedForeign(name: string): void {
    this.seed(name, 'agent', 'x', 'running');
    const c = this.containers.get(name);
    if (c !== undefined) c.spec = { ...c.spec, labels: {} };
  }
  state(): { containers: Set<string>; networks: Set<string>; volumes: Set<string> } {
    return { containers: new Set(this.containers.keys()), networks: new Set(this.networks.keys()), volumes: new Set(this.volumes.keys()) };
  }

  // -- contract -------------------------------------------------------------

  ensureAvailable(): Promise<{ serverVersion: string }> {
    this.step('ensureAvailable', []);
    return Promise.resolve({ serverVersion: 'fake' });
  }

  inspectImage(ref: string): Promise<ImageInfo | null> {
    this.step('inspectImage', [ref]);
    return Promise.resolve(this.images.get(ref) ?? null);
  }

  buildImage(_request: BuildRequest): Promise<BuildResult> {
    this.step('buildImage', []);
    return Promise.reject(new Error('not used by lifecycle'));
  }

  removeImage(ref: string): Promise<void> {
    this.step('removeImage', [ref]);
    return Promise.reject(new Error('not used by lifecycle'));
  }

  ensureNetwork(name: string, options: { internal: boolean; labels?: Record<string, string> }): Promise<void> {
    this.step('ensureNetwork', [name, options]);
    const existing = this.networks.get(name);
    if (existing !== undefined && existing.internal !== options.internal) {
      return Promise.reject(new ContainerError('POLICY_VIOLATION', `network ${name} exists with a different internal flag`));
    }
    this.networks.set(name, { internal: options.internal });
    return Promise.resolve();
  }

  removeNetwork(name: string): Promise<void> {
    this.step('removeNetwork', [name]);
    if (!this.networks.has(name)) return Promise.reject(new ContainerError('NOT_FOUND', `network ${name} not found`));
    for (const container of this.containers.values()) {
      if (container.networks.has(name)) {
        return Promise.reject(new ContainerError('COMMAND_FAILED', `network ${name} has active endpoints`));
      }
    }
    this.networks.delete(name);
    return Promise.resolve();
  }

  connectNetwork(...args: [container: string, network: string, aliases?: string[]]): Promise<void> {
    this.step('connectNetwork', args);
    const [container, network] = args;
    const c = this.containers.get(container);
    if (c === undefined) return Promise.reject(new ContainerError('NOT_FOUND', `No such container: ${container}`));
    if (network !== 'bridge' && !this.networks.has(network)) {
      return Promise.reject(new ContainerError('NOT_FOUND', `network ${network} not found`));
    }
    c.networks.add(network);
    return Promise.resolve();
  }

  ensureVolume(name: string, labels?: Record<string, string>): Promise<void> {
    this.step('ensureVolume', [name, labels]);
    if (!this.volumes.has(name)) this.volumes.set(name, { ...(labels ?? {}), [LABEL_MANAGED]: 'true' });
    return Promise.resolve();
  }

  inspectVolume(name: string): Promise<{ name: string; labels: Record<string, string> } | null> {
    this.step('inspectVolume', [name]);
    const labels = this.volumes.get(name);
    return Promise.resolve(labels === undefined ? null : { name, labels: { ...labels } });
  }

  removeVolume(name: string): Promise<void> {
    this.step('removeVolume', [name]);
    if (!this.volumes.has(name)) return Promise.reject(new ContainerError('NOT_FOUND', `no such volume ${name}`));
    for (const container of this.containers.values()) {
      if (container.spec.mounts.some((m) => m.kind === 'volume' && m.source === name)) {
        return Promise.reject(new ContainerError('COMMAND_FAILED', `volume ${name} is in use`));
      }
    }
    this.volumes.delete(name);
    return Promise.resolve();
  }

  listVolumes(filter?: { agent?: string }): Promise<Array<{ name: string; key: string; agent: string }>> {
    this.step('listVolumes', [filter]);
    const rows: Array<{ name: string; key: string; agent: string }> = [];
    for (const [name, labels] of this.volumes) {
      if (labels[LABEL_MANAGED] !== 'true') continue;
      const agent = labels[LABEL_AGENT] ?? '';
      if (filter?.agent !== undefined && agent !== filter.agent) continue;
      rows.push({ name, key: labels[LABEL_VOLUME_KEY] ?? '', agent });
    }
    return Promise.resolve(rows);
  }

  private assertCanStart(spec: ContainerSpec): ContainerError | undefined {
    if (this.nameClash === spec.name || this.containers.has(spec.name)) {
      return new ContainerError('COMMAND_FAILED', `A container named "${spec.name}" already exists.`, { reason: 'name_in_use', name: spec.name });
    }
    if (spec.network !== 'none' && spec.network !== 'bridge' && !this.networks.has(spec.network)) {
      return new ContainerError('NOT_FOUND', `network ${spec.network} not found`);
    }
    for (const mount of spec.mounts) {
      if (mount.kind === 'volume' && !this.volumes.has(mount.source)) {
        throw new Error(`fake: volume ${mount.source} was mounted but never ensured`);
      }
    }
    return undefined;
  }

  start(spec: ContainerSpec): Promise<{ id: string }> {
    this.step('start', [spec]);
    const problem = this.assertCanStart(spec);
    if (problem) return Promise.reject(problem);
    this.started.push(spec);
    const state = spec.role === 'proxy' && this.sidecarDies ? 'exited' : spec.role === 'agent' && this.agentDies ? this.agentDies.state : 'running';
    this.containers.set(spec.name, { spec, state, networks: new Set(spec.network === 'none' || spec.network === 'bridge' ? [] : [spec.network]) });
    return Promise.resolve({ id: `${'0123456789abcdef'.repeat(4)}` });
  }

  runForeground(spec: ContainerSpec, io?: { inheritStdio?: boolean }): Promise<CommandResult> {
    this.step('runForeground', [spec, io]);
    const problem = this.assertCanStart(spec);
    if (problem) return Promise.reject(problem);
    this.started.push(spec);
    this.foreground.push({ spec, io, containersDuring: [...this.containers.keys()], networksDuring: [...this.networks.keys()] });
    if (this.foregroundThrows) return Promise.reject(this.foregroundThrows);
    return Promise.resolve({ ...ok(), exitCode: this.foregroundExit });
  }

  list(filter?: { agent?: string; all?: boolean }): Promise<ContainerInfo[]> {
    this.step('list', [filter]);
    if (this.listThrows && this.started.some((s) => s.role === 'agent')) return Promise.reject(this.listThrows);
    const rows: ContainerInfo[] = [];
    for (const [name, c] of this.containers) {
      const agent = c.spec.labels[LABEL_AGENT] ?? '';
      if (c.spec.labels[LABEL_MANAGED] !== 'true') continue;
      if (filter?.agent !== undefined && agent !== filter.agent) continue;
      if (filter?.all !== true && c.state !== 'running') continue;
      rows.push({
        id: `id-${name}`,
        name,
        image: c.spec.image,
        state: c.state,
        status:
          c.spec.role === 'agent' && this.agentDies && c.state === this.agentDies.state
            ? this.agentDies.status
            : c.state === 'running'
              ? 'Up 1 second'
              : `${c.state} (1) 1 second ago`,
        role: (c.spec.labels[LABEL_ROLE] as ContainerInfo['role'] | undefined) ?? 'unknown',
        agent,
        createdAt: '2026-11-05 05:15:00 +0000 UTC',
        labels: c.spec.labels,
      });
    }
    return Promise.resolve(rows);
  }

  logs(name: string): Promise<CommandResult> {
    this.step('logs', [name]);
    const c = this.containers.get(name);
    if (c === undefined) return Promise.reject(new ContainerError('NOT_FOUND', `No such container: ${name}`));
    const text = c.spec.role === 'proxy' ? this.proxyLogs(this.logPolls++) : '';
    return Promise.resolve({ ...ok(), stdout: text });
  }

  stop(...args: [name: string, timeoutSec?: number]): Promise<void> {
    this.step('stop', args);
    const c = this.containers.get(args[0]);
    if (c === undefined) return Promise.reject(new ContainerError('NOT_FOUND', `No such container: ${args[0]}`));
    c.state = 'exited';
    return Promise.resolve();
  }

  remove(name: string, options?: { force?: boolean }): Promise<void> {
    this.step('remove', [name, options]);
    const c = this.containers.get(name);
    if (c === undefined) return Promise.reject(new ContainerError('NOT_FOUND', `No such container: ${name}`));
    if (c.state === 'running' && options?.force !== true) {
      return Promise.reject(new ContainerError('COMMAND_FAILED', `cannot remove a running container ${name}`));
    }
    this.containers.delete(name);
    return Promise.resolve();
  }

  inspect(): Promise<unknown> {
    return Promise.reject(new Error('not used by lifecycle'));
  }
  stats(): Promise<CommandResult> {
    return Promise.reject(new Error('not used by lifecycle'));
  }
  exec(): Promise<CommandResult> {
    return Promise.reject(new Error('not used by lifecycle'));
  }
}

function fmt(call: Call): string {
  const [a, b] = call.args;
  switch (call.method) {
    case 'ensureNetwork':
      return `ensureNetwork ${String(a)} ${(b as { internal: boolean }).internal ? 'internal' : 'external'}`;
    case 'start':
    case 'runForeground':
      return `${call.method} ${(a as ContainerSpec).name}`;
    case 'remove':
      return `remove ${String(a)}${(b as { force?: boolean } | undefined)?.force === true ? ' --force' : ''}`;
    case 'connectNetwork':
      return `connectNetwork ${String(a)} ${String(b)}`;
    case 'stop':
      return `stop ${String(a)}`;
    case 'logs':
      return `logs ${String(a)}`;
    default:
      return [call.method, ...call.args.filter((x) => typeof x === 'string')].join(' ');
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function req(fake: FakeRuntime, over: Partial<StartAgentOptions> = {}): StartAgentOptions {
  return { runtime: fake, agent: AGENT, image: IMAGE, proxyReadyPollMs: 1, proxyReadyTimeoutMs: 1000, ...over };
}

async function rejection(promise: Promise<unknown>): Promise<ContainerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerError);
    return error as ContainerError;
  }
  throw new Error('expected the promise to reject');
}

async function expectRefusal(fake: FakeRuntime, request: StartAgentOptions, code: ContainerErrorCode): Promise<ContainerError> {
  const error = await rejection(startAgent(request));
  expect(error.code, error.message).toBe(code);
  expect(fake.mutations, 'a refused start must not touch Docker').toEqual([]);
  return error;
}

function specNamed(fake: FakeRuntime, name: string): ContainerSpec {
  const spec = fake.started.find((s) => s.name === name);
  if (spec === undefined) throw new Error(`no container ${name} was started`);
  return spec;
}

// ---------------------------------------------------------------------------
// Refusals (property a, f)
// ---------------------------------------------------------------------------

describe('startAgent refuses before creating anything', () => {
  interface Case {
    label: string;
    manifest: ContainerManifest;
    request: (fake: FakeRuntime) => Partial<StartAgentOptions>;
    code: ContainerErrorCode;
    includes?: string[];
    excludes?: string[];
  }
  const cases: Case[] = [
    {
      label: 'secrets declared, proxy mode, no plan',
      manifest: SECRET_MANIFEST(),
      request: () => ({}),
      code: 'MISSING_SECRET',
      includes: ['svc'],
    },
    {
      label: 'secrets declared, explicit proxy network, no plan',
      manifest: manifestFor({ secrets: ['svc'] }),
      request: () => ({ network: 'proxy' }),
      code: 'MISSING_SECRET',
      includes: ['svc'],
    },
    {
      label: 'secrets declared, manifest network none, no plan',
      manifest: manifestFor({ secrets: ['svc'] }),
      request: () => ({}),
      code: 'POLICY_VIOLATION',
      includes: ['svc'],
    },
    {
      label: 'secrets declared, explicit bridge',
      manifest: SECRET_MANIFEST(),
      request: () => ({ network: 'bridge' }),
      code: 'POLICY_VIOLATION',
      includes: ['svc'],
    },
    {
      label: 'secrets declared, explicit none, even with a complete plan',
      manifest: SECRET_MANIFEST(),
      request: () => ({ network: 'none', proxyPlan: planFor() }),
      code: 'POLICY_VIOLATION',
    },
    {
      label: 'plan has no route for one declared secret',
      manifest: manifestFor({ secrets: ['svc', 'other'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }),
      request: () => ({ proxyPlan: planFor() }),
      code: 'MISSING_SECRET',
      includes: ['other'],
      excludes: [CANARY],
    },
    {
      label: 'plan has no routes at all',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor({ config: { ...planFor().config, routes: [] } }) }),
      code: 'MISSING_SECRET',
      includes: ['svc'],
    },
    {
      label: 'a route injects a secret the plan carries no value for',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor({ secrets: {} }) }),
      code: 'MISSING_SECRET',
      includes: ['svc'],
    },
    {
      label: 'a route injects a secret whose value is empty',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor({ secrets: { svc: '' } }) }),
      code: 'MISSING_SECRET',
      includes: ['svc'],
    },
    {
      label: 'proxy network without a plan, no secrets declared',
      manifest: manifestFor(),
      request: () => ({ network: 'proxy' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'manifest default is proxy, no plan, no secrets',
      manifest: manifestFor({ isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }),
      request: () => ({}),
      code: 'INVALID_INPUT',
    },
    {
      label: 'a plan together with network none',
      manifest: manifestFor(),
      request: () => ({ network: 'none', proxyPlan: planFor() }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'a plan together with network bridge',
      manifest: manifestFor(),
      request: () => ({ network: 'bridge', proxyPlan: planFor() }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'an unknown network mode',
      manifest: manifestFor(),
      request: () => ({ network: 'host' as unknown as 'none' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'an egress network without proxy mode',
      manifest: manifestFor(),
      request: () => ({ proxyEgressNetwork: 'bridge' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'egress network "host"',
      manifest: manifestFor(),
      request: () => ({ proxyPlan: planFor(), proxyEgressNetwork: 'host' }),
      code: 'POLICY_VIOLATION',
    },
    {
      label: 'egress network "none"',
      manifest: manifestFor(),
      request: () => ({ proxyPlan: planFor(), proxyEgressNetwork: 'none' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'egress network equal to the internal network',
      manifest: manifestFor(),
      request: () => ({ proxyPlan: planFor(), proxyEgressNetwork: `av-${AGENT}-net` }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'egress network with an invalid name',
      manifest: manifestFor(),
      request: () => ({ proxyPlan: planFor(), proxyEgressNetwork: '--bad' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'a reserved variable passed explicitly',
      manifest: manifestFor(),
      request: () => ({ explicitEnv: { AGENTVAULT_PASSWORD: 'x' } }),
      code: 'POLICY_VIOLATION',
      includes: ['AGENTVAULT_PASSWORD'],
    },
    {
      label: 'an explicit env value that IS a proxy secret',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor(), explicitEnv: { SNEAKY: CANARY } }),
      code: 'POLICY_VIOLATION',
      includes: ['SNEAKY', 'svc'],
      excludes: [CANARY],
    },
    {
      label: 'a proxy secret embedded in a longer explicit env value',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor(), explicitEnv: { AUTH_LINE: `Bearer ${CANARY}` } }),
      code: 'POLICY_VIOLATION',
      includes: ['AUTH_LINE'],
      excludes: [CANARY],
    },
    {
      label: 'a host variable carrying a proxy secret under another name',
      manifest: manifestFor({ env: ['LEGACY_KEY'], secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }),
      request: () => ({ proxyPlan: planFor(), hostEnv: { LEGACY_KEY: CANARY } }),
      code: 'POLICY_VIOLATION',
      includes: ['LEGACY_KEY'],
      excludes: [CANARY],
    },
    {
      label: 'a multi-line secret the env file cannot carry',
      manifest: SECRET_MANIFEST(),
      request: () => ({ proxyPlan: planFor({ secrets: { svc: 'line-one\nCANARY-SECOND-LINE-0123456789' } }) }),
      code: 'INVALID_INPUT',
      excludes: ['line-one', 'CANARY-SECOND-LINE'],
    },
    {
      label: 'a foreground run with a restart policy',
      manifest: manifestFor(),
      request: () => ({ detach: false, restart: 'unless-stopped' }),
      code: 'INVALID_INPUT',
    },
    {
      label: 'two volume paths that map to one volume key',
      manifest: manifestFor({ volumes: ['/a/b', '/a-b'] }),
      request: () => ({}),
      code: 'INVALID_INPUT',
    },
  ];

  it.each(cases)('$label', async ({ manifest, request, code, includes, excludes }) => {
    const fake = new FakeRuntime(manifest);
    const error = await expectRefusal(fake, req(fake, request(fake)), code);
    for (const text of includes ?? []) expect(error.message).toContain(text);
    for (const text of excludes ?? []) expect(error.message).not.toContain(text);
  });

  it('names the missing secrets and never a value', async () => {
    const fake = new FakeRuntime(manifestFor({ secrets: ['svc', 'other'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));
    const error = await expectRefusal(fake, req(fake, { proxyPlan: planFor() }), 'MISSING_SECRET');
    expect(error.message).toContain('other');
    expect(error.message).not.toContain(CANARY);
    expect(JSON.stringify(error.details ?? {})).not.toContain(CANARY);
  });

  it('refuses an image that does not exist and says how to get one', async () => {
    const fake = new FakeRuntime();
    const error = await expectRefusal(fake, req(fake, { image: 'nope:1' }), 'NOT_FOUND');
    expect(error.message).toContain('nope:1');
    expect(error.message).toContain('agentvault package');
    expect(error.message).toContain('docker pull');
  });

  it('refuses an image that is not an AgentVault image', async () => {
    const fake = new FakeRuntime();
    fake.images.set('plain:1', { id: 'x', repoTags: [], repoDigests: [], labels: {}, user: '10001', sizeBytes: 1 });
    await expectRefusal(fake, req(fake, { image: 'plain:1' }), 'INVALID_INPUT');
  });

  it('refuses an image whose manifest label is garbage', async () => {
    const fake = new FakeRuntime();
    fake.images.set('bad:1', { id: 'x', repoTags: [], repoDigests: [], labels: { [LABEL_MANIFEST]: '{nope' }, user: '10001', sizeBytes: 1 });
    await expectRefusal(fake, req(fake, { image: 'bad:1' }), 'INVALID_INPUT');
  });

  it.each(['', '0', 'root', '0:0', 'root:root', '10001:0', '00'])('refuses an image whose USER is %j', async (user) => {
    const fake = new FakeRuntime(manifestFor(), user);
    await expectRefusal(fake, req(fake), 'POLICY_VIOLATION');
  });

  it.each(['10001', '10001:10001', 'agent', 'agent:agent'])('accepts an image whose USER is %j', async (user) => {
    const fake = new FakeRuntime(manifestFor(), user);
    await expect(startAgent(req(fake))).resolves.toBeDefined();
  });

  it('rejects an invalid agent name without any runtime call', async () => {
    const fake = new FakeRuntime();
    const error = await rejection(startAgent(req(fake, { agent: '../evil' })));
    expect(error.code).toBe('INVALID_INPUT');
    expect(fake.calls).toEqual([]);
  });

  it('stops at an unusable daemon', async () => {
    const fake = new FakeRuntime();
    fake.ensureAvailable = (): Promise<{ serverVersion: string }> => Promise.reject(new ContainerError('DAEMON_UNREACHABLE', 'down'));
    const error = await rejection(startAgent(req(fake)));
    expect(error.code).toBe('DAEMON_UNREACHABLE');
    expect(fake.calls).toEqual([]);
  });

  describe('(f) a running agent is not replaced', () => {
    it.each(['running', 'restarting', 'paused'])('refuses when the container is %s and touches nothing', async (state) => {
      const fake = new FakeRuntime();
      fake.seed(`av-${AGENT}`, 'agent', AGENT, state);
      fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
      const before = fake.state();
      const error = await expectRefusal(fake, req(fake), 'INVALID_INPUT');
      expect(error.message).toMatch(/already running/);
      expect(error.message).toContain('stop it first');
      expect(fake.state()).toEqual(before);
      expect(fake.containers.get(`av-${AGENT}`)?.state).toBe(state);
    });
  });
});

// ---------------------------------------------------------------------------
// Detached start without a proxy
// ---------------------------------------------------------------------------

describe('startAgent, detached, network none', () => {
  it('creates volumes then the agent, in that order, and nothing else', async () => {
    const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/var/cache'] }));
    const started = await startAgent(req(fake));
    expect(fake.trace).toEqual([
      'ensureAvailable',
      `inspectImage ${IMAGE}`,
      'list',
      `inspectVolume av-${AGENT}-data`,
      `ensureVolume av-${AGENT}-data`,
      `inspectVolume av-${AGENT}-var-cache`,
      `ensureVolume av-${AGENT}-var-cache`,
      `start av-${AGENT}`,
    ]);
    expect(started).toMatchObject({
      agent: AGENT,
      containerName: `av-${AGENT}`,
      volumes: [`av-${AGENT}-data`, `av-${AGENT}-var-cache`],
      network: 'none',
      warnings: [],
    });
    expect(started.containerId).toMatch(/^[0-9a-f]{64}$/);
    expect(started.proxyContainerName).toBeUndefined();
    expect(started.networkName).toBeUndefined();
    expect(started.exitCode).toBeUndefined();
  });

  it('labels the volumes so the snapshot code and removeAgent can find them', async () => {
    const fake = new FakeRuntime();
    await startAgent(req(fake));
    expect(fake.volumes.get(`av-${AGENT}-data`)).toEqual({
      [LABEL_MANAGED]: 'true',
      [LABEL_AGENT]: AGENT,
      [LABEL_VOLUME_KEY]: 'data',
    });
  });

  it('builds a locked-down agent spec from the manifest', async () => {
    const fake = new FakeRuntime();
    await startAgent(req(fake, { command: ['node', 'other.js'], limits: { memory: '512m' }, restart: 'on-failure' }));
    const spec = specNamed(fake, `av-${AGENT}`);
    expect(spec).toMatchObject({
      role: 'agent',
      image: IMAGE,
      user: '10001:10001',
      network: 'none',
      command: ['node', 'other.js'],
      readOnlyRootfs: true,
      detach: true,
      init: true,
      restart: 'on-failure',
      mounts: [{ kind: 'volume', source: `av-${AGENT}-data`, target: '/data' }],
    });
    expect(spec.limits.memory).toBe('512m');
    expect(spec.labels).toMatchObject({ [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_ROLE]: 'agent' });
    expect(spec.autoRemove).toBeUndefined();
  });

  it('forwards only the host variables the manifest declares, plus explicit ones', async () => {
    const fake = new FakeRuntime(manifestFor({ env: ['MODE'] }));
    await startAgent(req(fake, { hostEnv: { MODE: 'prod', HOME: '/root', AWS_SECRET_ACCESS_KEY: 'nope' }, explicitEnv: { EXTRA: '1' } }));
    expect(specNamed(fake, `av-${AGENT}`).env).toEqual({ MODE: 'prod', EXTRA: '1' });
  });

  it('passes writableRootfs and extra mounts through', async () => {
    const fake = new FakeRuntime();
    await startAgent(req(fake, { writableRootfs: true, extraMounts: [{ kind: 'bind', source: '/srv/in', target: '/in', readOnly: true }] }));
    const spec = specNamed(fake, `av-${AGENT}`);
    expect(spec.readOnlyRootfs).toBe(false);
    expect(spec.mounts).toContainEqual({ kind: 'bind', source: '/srv/in', target: '/in', readOnly: true });
  });

  it('restarts the same agent: a stopped container is replaced, its volumes are kept', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
    fake.volumes.set(`av-${AGENT}-data`, { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_VOLUME_KEY]: 'data' });
    const started = await startAgent(req(fake));
    // The kept volume is recognised as this agent's and reused as it is: nothing is created or re-labelled.
    expect(fake.mutations).toEqual([`remove av-${AGENT} --force`, `start av-${AGENT}`]);
    expect(fake.volumes.has(`av-${AGENT}-data`)).toBe(true);
    expect(fake.containers.get(`av-${AGENT}`)?.state).toBe('running');
    expect(started.containerId).toBeDefined();
  });

  it('removes a stale sidecar left by an earlier run, even a running one', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    await startAgent(req(fake));
    expect(fake.mutations[0]).toBe(`remove av-${AGENT}-proxy --force`);
    expect(fake.containers.has(`av-${AGENT}-proxy`)).toBe(false);
  });

  it('never touches another agent', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-beta', 'agent', 'beta', 'running');
    fake.seed('av-beta-proxy', 'proxy', 'beta', 'running');
    await startAgent(req(fake));
    expect(fake.containers.get('av-beta')?.state).toBe('running');
    expect(fake.containers.has('av-beta-proxy')).toBe(true);
  });

  it('does not remove a foreign container that merely has the same name (no AgentVault labels)', async () => {
    const fake = new FakeRuntime();
    fake.seedForeign(`av-${AGENT}`);
    const error = await rejection(startAgent(req(fake)));
    expect(error.details?.['reason']).toBe('name_in_use');
    // It was never ours: not removed, not stopped, and the volume this call created is cleaned up again.
    expect(fake.containers.get(`av-${AGENT}`)?.state).toBe('running');
    expect(fake.mutations.filter((m) => m.startsWith(`remove av-${AGENT}`) || m.startsWith(`stop av-${AGENT}`))).toEqual([]);
    expect(fake.volumes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bridge (property e)
// ---------------------------------------------------------------------------

describe('detached liveness watch', () => {
  const live = { livenessGraceMs: 200, livenessPollMs: 1 };

  it('is off by default: no extra daemon calls, no earlyExit', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'exited', status: 'Exited (127) 1 second ago' };
    const started = await startAgent(req(fake));
    expect(started.earlyExit).toBeUndefined();
    expect(fake.trace.filter((t) => t === 'list')).toHaveLength(1); // only the pre-start check
  });

  it('reports an agent that exited non-zero inside the window, and keeps the container', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'exited', status: 'Exited (127) 1 second ago' };
    const started = await startAgent(req(fake, live));
    expect(started.earlyExit).toEqual({ exitCode: 127, state: 'exited' });
    expect(started.containerId).toBeDefined();
    expect(fake.containers.has(`av-${AGENT}`)).toBe(true);
    expect(fake.mutations.filter((m) => m.startsWith('remove') || m.startsWith('stop'))).toEqual([]);
  });

  it('reports a crash-looping agent (restart policy) using the code in its status', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'restarting', status: 'Restarting (3) 2 seconds ago' };
    const started = await startAgent(req(fake, { ...live, restart: 'on-failure' }));
    expect(started.earlyExit).toEqual({ exitCode: 3, state: 'restarting' });
  });

  it('treats a quick clean exit (code 0) as a finished job, not a failure', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'exited', status: 'Exited (0) 1 second ago' };
    expect((await startAgent(req(fake, live))).earlyExit).toBeUndefined();
  });

  it('says nothing about an agent that is still running when the window closes', async () => {
    const fake = new FakeRuntime();
    const t0 = Date.now();
    const started = await startAgent(req(fake, live));
    expect(started.earlyExit).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150); // it really watched for the window
    expect(fake.trace.filter((t) => t === 'list').length).toBeGreaterThan(2);
  });

  it('returns as soon as the agent is seen dead instead of waiting out the window', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'exited', status: 'Exited (1) 1 second ago' };
    const t0 = Date.now();
    await startAgent(req(fake, { livenessGraceMs: 5_000, livenessPollMs: 1 }));
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a daemon error while watching never fails the start or tears the running agent down', async () => {
    const fake = new FakeRuntime();
    fake.listThrows = new Error('daemon hiccup');
    const started = await startAgent(req(fake, live));
    expect(started.earlyExit).toBeUndefined();
    expect(fake.containers.has(`av-${AGENT}`)).toBe(true);
    expect(fake.mutations.filter((m) => m.startsWith('remove') || m.startsWith('stop'))).toEqual([]);
  });

  it('ignores a status it cannot read a code from', async () => {
    const fake = new FakeRuntime();
    fake.agentDies = { state: 'exited', status: 'Exited' };
    expect((await startAgent(req(fake, live))).earlyExit).toBeUndefined();
  });
});

describe('--writable-rootfs', () => {
  it('is announced as weakening isolation, like bridge, and never otherwise', async () => {
    const heard: string[] = [];
    const weaker = await startAgent(req(new FakeRuntime(), { writableRootfs: true, onWarning: (m) => heard.push(m) }));
    expect(weaker.warnings).toHaveLength(1);
    expect(heard).toEqual(weaker.warnings);
    expect(weaker.warnings[0]).toMatch(/--writable-rootfs/);
    expect(weaker.warnings[0]).toMatch(/modify its own root filesystem/);

    expect((await startAgent(req(new FakeRuntime()))).warnings).toEqual([]);
    expect((await startAgent(req(new FakeRuntime(), { writableRootfs: false }))).warnings).toEqual([]);
  });
});

describe('(e) network bridge', () => {
  const bridgeManifest = (): ContainerManifest => manifestFor({ isolation: { network: 'bridge', user: '10001:10001', readOnlyRootfs: true } });

  it('is never chosen by the IMAGE: a manifest asking for bridge is refused before anything is created', async () => {
    // The manifest is written by whoever built the image. It may narrow isolation, never widen it.
    const fake = new FakeRuntime(bridgeManifest());
    const error = await expectRefusal(fake, req(fake), 'POLICY_VIOLATION');
    expect(error.message).toMatch(/unrestricted network access/);
    expect(error.message).toMatch(/explicitly/);
  });

  it('starts when the CALLER asks for bridge, and warns through onWarning and StartedAgent.warnings', async () => {
    const fake = new FakeRuntime(bridgeManifest());
    const heard: string[] = [];
    const started = await startAgent(req(fake, { network: 'bridge', onWarning: (m) => heard.push(m) }));
    expect(started.network).toBe('bridge');
    expect(started.warnings).toHaveLength(1);
    expect(heard).toEqual(started.warnings);
    expect(heard[0]).toMatch(/unrestricted/i);
    expect(heard[0]).toMatch(/no credential protection/i);
    expect(specNamed(fake, `av-${AGENT}`).network).toBe('bridge');
    expect(fake.mutations.filter((m) => m.includes('Network'))).toEqual([]);
  });

  it('a caller can still narrow a bridge manifest to none', async () => {
    const fake = new FakeRuntime(bridgeManifest());
    expect((await startAgent(req(fake, { network: 'none' }))).network).toBe('none');
  });

  it('warns for an explicit request too, and never for none', async () => {
    const a = new FakeRuntime();
    const heard: string[] = [];
    const bridged = await startAgent(req(a, { network: 'bridge', onWarning: (m) => heard.push(m) }));
    expect(bridged.warnings).toHaveLength(1);
    expect(heard).toHaveLength(1);

    const b = new FakeRuntime();
    const isolated = await startAgent(req(b, { network: 'none' }));
    expect(isolated.warnings).toEqual([]);
  });

  it('survives an onWarning callback that throws', async () => {
    const fake = new FakeRuntime();
    const started = await startAgent(
      req(fake, {
        network: 'bridge',
        onWarning: () => {
          throw new Error('callback bug');
        },
      })
    );
    expect(started.warnings).toHaveLength(1);
    expect(started.containerId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Proxy mode (properties b, i)
// ---------------------------------------------------------------------------

describe('startAgent in proxy mode', () => {
  const proxyFake = (over: Partial<ContainerManifest> = {}): FakeRuntime =>
    new FakeRuntime(manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true }, ...over }));

  it('(i) the default egress is the dedicated per-agent network: exact calls', async () => {
    const fake = proxyFake();
    const started = await startAgent(req(fake, { proxyPlan: planFor() }));
    expect(fake.trace).toEqual([
      'ensureAvailable',
      `inspectImage ${IMAGE}`,
      'list',
      `removeNetwork av-${AGENT}-net`,
      `removeNetwork av-${AGENT}-egress`,
      `inspectVolume av-${AGENT}-data`,
      `ensureVolume av-${AGENT}-data`,
      `ensureNetwork av-${AGENT}-net internal`,
      `start av-${AGENT}-proxy`,
      `ensureNetwork av-${AGENT}-egress external`,
      `connectNetwork av-${AGENT}-proxy av-${AGENT}-egress`,
      'list',
      `logs av-${AGENT}-proxy`,
      `start av-${AGENT}`,
    ]);
    expect(started).toMatchObject({
      network: 'proxy',
      proxyContainerName: `av-${AGENT}-proxy`,
      networkName: `av-${AGENT}-net`,
      warnings: [],
    });
    // The sidecar is attached to its egress network with NO aliases and is never put on the shared bridge.
    const connect = fake.callsOf('connectNetwork');
    expect(connect).toHaveLength(1);
    expect(connect[0]?.args).toEqual([`av-${AGENT}-proxy`, `av-${AGENT}-egress`]);
    expect(fake.calls.some((c) => c.args.includes('bridge'))).toBe(false);
    // Both networks carry the managed and agent labels; internal is internal, egress is not.
    expect(fake.networks.get(`av-${AGENT}-net`)).toEqual({ internal: true });
    expect(fake.networks.get(`av-${AGENT}-egress`)).toEqual({ internal: false });
    const ensured = fake.callsOf('ensureNetwork').map((c) => (c.args[1] as { labels?: Record<string, string> }).labels);
    for (const labels of ensured) expect(labels).toEqual({ [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT });
  });

  it('the sidecar sits on the internal network with the alias; the agent joins the same network', async () => {
    const fake = proxyFake();
    await startAgent(req(fake, { proxyPlan: planFor() }));
    const sidecar = specNamed(fake, `av-${AGENT}-proxy`);
    const agent = specNamed(fake, `av-${AGENT}`);
    expect(sidecar).toMatchObject({ role: 'proxy', network: `av-${AGENT}-net`, networkAliases: [PROXY_ALIAS], image: 'node:22-slim' });
    expect(agent).toMatchObject({ role: 'agent', network: `av-${AGENT}-net` });
    expect(agent.networkAliases).toBeUndefined();
  });

  it('(b) the real secret is in the sidecar environment and nowhere in the agent', async () => {
    const fake = proxyFake();
    await startAgent(req(fake, { proxyPlan: planFor() }));
    const sidecar = specNamed(fake, `av-${AGENT}-proxy`);
    const agent = specNamed(fake, `av-${AGENT}`);
    expect(sidecar.env[`${PROXY_SECRET_ENV_PREFIX}SVC`]).toBe(CANARY);
    expect(Object.values(agent.env).some((v) => v.includes(CANARY))).toBe(false);
    expect(JSON.stringify(agent)).not.toContain(CANARY);
    expect(agent.env['SVC_API_KEY']).toBe(PROXY_PLACEHOLDER_KEY);
    expect(agent.env['SVC_BASE_URL']).toBe(`http://${PROXY_ALIAS}:8080/svc`);
  });

  it('(b) a real key in the host environment under the placeholder name is replaced, not forwarded', async () => {
    const fake = proxyFake({ env: ['SVC_API_KEY'] });
    await startAgent(req(fake, { proxyPlan: planFor(), hostEnv: { SVC_API_KEY: 'a-different-real-key-0123456789' } }));
    expect(specNamed(fake, `av-${AGENT}`).env['SVC_API_KEY']).toBe(PROXY_PLACEHOLDER_KEY);
  });

  it('infers proxy mode from the plan and lets an unrelated manifest keep no secrets', async () => {
    const fake = new FakeRuntime(manifestFor());
    const started = await startAgent(req(fake, { proxyPlan: planFor() }));
    expect(started.network).toBe('proxy');
  });

  it('waits for the listening line before it starts the agent', async () => {
    const fake = proxyFake();
    fake.proxyLogs = (poll) => (poll < 3 ? 'booting\n' : `booting\n${LISTENING}\n`);
    await startAgent(req(fake, { proxyPlan: planFor() }));
    expect(fake.callsOf('logs')).toHaveLength(4);
    const order = fake.mutations;
    expect(order.indexOf(`start av-${AGENT}`)).toBeGreaterThan(order.indexOf(`connectNetwork av-${AGENT}-proxy av-${AGENT}-egress`));
  });

  it('accepts whitespace in the JSON and the line on stderr-style output', async () => {
    const fake = proxyFake();
    fake.proxyLogs = () => '{ "event" : "listening", "port": 8080 }\n';
    await expect(startAgent(req(fake, { proxyPlan: planFor() }))).resolves.toBeDefined();
  });

  it('removes stale sidecar and stale networks from an earlier run, then creates fresh ones', async () => {
    const fake = proxyFake();
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
    fake.networks.set(`av-${AGENT}-net`, { internal: true });
    fake.networks.set(`av-${AGENT}-egress`, { internal: false });
    await startAgent(req(fake, { proxyPlan: planFor() }));
    expect(fake.mutations.slice(0, 4)).toEqual([
      `remove av-${AGENT} --force`,
      `remove av-${AGENT}-proxy --force`,
      `removeNetwork av-${AGENT}-net`,
      `removeNetwork av-${AGENT}-egress`,
    ]);
    expect(fake.containers.get(`av-${AGENT}-proxy`)?.state).toBe('running');
  });

  it('(i) an explicit shared bridge is allowed but warned about, and never ensured or removed', async () => {
    const fake = proxyFake();
    const heard: string[] = [];
    const started = await startAgent(req(fake, { proxyPlan: planFor(), proxyEgressNetwork: 'bridge', onWarning: (m) => heard.push(m) }));
    expect(fake.callsOf('connectNetwork')[0]?.args).toEqual([`av-${AGENT}-proxy`, 'bridge']);
    expect(fake.callsOf('ensureNetwork').map((c) => c.args[0])).toEqual([`av-${AGENT}-net`]);
    expect(started.warnings).toHaveLength(1);
    expect(heard).toEqual(started.warnings);
    expect(heard[0]).toMatch(/bridge/);
    expect(heard[0]).toMatch(/every container on this host can reach the sidecar/);
    expect(heard[0]).toMatch(/spend the agent's credentials/);
  });

  it('(i) any other caller-named egress network is used as given and warned about too', async () => {
    const fake = proxyFake();
    fake.networks.set('shared-egress', { internal: false });
    const started = await startAgent(req(fake, { proxyPlan: planFor(), proxyEgressNetwork: 'shared-egress' }));
    expect(fake.callsOf('connectNetwork')[0]?.args).toEqual([`av-${AGENT}-proxy`, 'shared-egress']);
    expect(fake.networks.has(`av-${AGENT}-egress`)).toBe(false);
    expect(started.warnings).toHaveLength(1);
    expect(started.warnings[0]).toContain('shared-egress');
  });

  it('naming the dedicated egress network explicitly is the default, without a warning', async () => {
    const fake = proxyFake();
    const started = await startAgent(req(fake, { proxyPlan: planFor(), proxyEgressNetwork: `av-${AGENT}-egress` }));
    expect(started.warnings).toEqual([]);
    expect(fake.networks.get(`av-${AGENT}-egress`)).toEqual({ internal: false });
  });
});

// ---------------------------------------------------------------------------
// Sidecar readiness and the redaction of its logs (property g)
// ---------------------------------------------------------------------------

describe('(g) sidecar readiness and log redaction', () => {
  const secretFake = (): FakeRuntime =>
    new FakeRuntime(manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));

  it('times out, and the canary the sidecar logged never reaches the error', async () => {
    const fake = secretFake();
    fake.proxyLogs = () => `starting\ndebug env AV_SECRET_SVC=${CANARY}\nstill starting\n`;
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), proxyReadyTimeoutMs: 40, proxyReadyPollMs: 5 })));
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('did not report ready within 40 ms');
    expect(error.message).toContain('debug env AV_SECRET_SVC=[redacted]');
    expect(error.message).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
    expect(String(error.stack)).not.toContain(CANARY);
  });

  it('also scrubs the JSON-escaped form of a secret', async () => {
    const tricky = 'sk-with-"quotes"-and-\\backslash-0123456789';
    const fake = secretFake();
    fake.proxyLogs = () => `${JSON.stringify({ level: 'debug', header: tricky })}\n`;
    const error = await rejection(
      startAgent(req(fake, { proxyPlan: planFor({ secrets: { svc: tricky } }), proxyReadyTimeoutMs: 30, proxyReadyPollMs: 5 }))
    );
    expect(error.message).not.toContain('quotes');
    expect(error.message).not.toContain('backslash');
    expect(error.message).toContain('[redacted]');
  });

  it('does not leak a prefix when a secret straddles the line-length cut', async () => {
    const fake = secretFake();
    fake.proxyLogs = () => `${'x'.repeat(480)}${CANARY}${'y'.repeat(100)}\n`;
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), proxyReadyTimeoutMs: 30, proxyReadyPollMs: 5 })));
    expect(error.message).not.toContain(CANARY.slice(0, 12));
    expect(error.message).toContain('...');
  });

  it('shows only the last 10 lines', async () => {
    const fake = secretFake();
    fake.proxyLogs = () => `${Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n')}\n`;
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), proxyReadyTimeoutMs: 30, proxyReadyPollMs: 5 })));
    expect(error.message).toContain('line-30');
    expect(error.message).toContain('line-21');
    expect(error.message).not.toContain('line-20\n');
    expect(error.message).not.toContain('line-1\n');
  });

  it('fails fast, with the redacted tail, when the sidecar is no longer running', async () => {
    const fake = secretFake();
    fake.sidecarDies = true;
    fake.proxyLogs = () => `boom: bad key ${CANARY}\n`;
    const began = Date.now();
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), proxyReadyTimeoutMs: 60_000, proxyReadyPollMs: 1000 })));
    expect(Date.now() - began).toBeLessThan(2000);
    expect(error.code).toBe('COMMAND_FAILED');
    expect(error.message).toContain('stopped before it was ready');
    expect(error.message).toContain('boom: bad key [redacted]');
    expect(error.message).not.toContain(CANARY);
    // The agent was never started.
    expect(fake.started.map((s) => s.name)).toEqual([`av-${AGENT}-proxy`]);
  });

  it('fails fast when the sidecar container has vanished', async () => {
    const fake = secretFake();
    const realList = fake.list.bind(fake);
    fake.list = (filter): Promise<ContainerInfo[]> =>
      realList(filter).then((rows) => rows.filter((r) => r.name !== `av-${AGENT}-proxy`));
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor() })));
    expect(error.message).toContain('no longer exists');
  });

  it('scrubs a secret out of ANY error that leaves startAgent, keeping its code', async () => {
    const fake = secretFake();
    fake.connectNetwork = (): Promise<void> => Promise.reject(new ContainerError('COMMAND_FAILED', `docker said: bad ${CANARY}`, { exitCode: 1 }));
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor() })));
    expect(error.code).toBe('COMMAND_FAILED');
    expect(error.message).toBe('docker said: bad [redacted]');
    expect(error.details).toEqual({ exitCode: 1 });
  });

  it('leaves an error that holds no secret untouched (same object)', async () => {
    const fake = secretFake();
    const original = new ContainerError('COMMAND_FAILED', 'plain');
    fake.connectNetwork = (): Promise<void> => Promise.reject(original);
    await expect(startAgent(req(fake, { proxyPlan: planFor() }))).rejects.toBe(original);
  });

  it('exports the defaults the brief specifies', () => {
    expect(PROXY_READY_TIMEOUT_MS).toBe(20_000);
    expect(PROXY_READY_POLL_MS).toBe(250);
  });

  describe('redactSecrets', () => {
    it('skips empty values, replaces longer values first and every occurrence', () => {
      expect(redactSecrets('a abc abcdef b', ['', 'abc', 'abcdef'])).toBe('a [redacted] [redacted] b');
      expect(redactSecrets('x x x', ['x'])).toBe('[redacted] [redacted] [redacted]');
      expect(redactSecrets('nothing here', [''])).toBe('nothing here');
    });
  });
});

// ---------------------------------------------------------------------------
// Rollback (properties c, j)
// ---------------------------------------------------------------------------

describe('interrupting a start', () => {
  const makeProxy = (): { fake: FakeRuntime; request: StartAgentOptions } => {
    const fake = new FakeRuntime(manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));
    return { fake, request: req(fake, { proxyPlan: planFor() }) };
  };

  it('an already-aborted signal stops the start before anything is created', async () => {
    const { fake, request } = makeProxy();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(startAgent({ ...request, signal: controller.signal }));
    expect(error.code).toBe('INTERRUPTED');
    expect(fake.mutations).toEqual([]);
  });

  it('an abort at ANY point is rolled back completely: no sidecar, network or new volume survives', async () => {
    // Abort as the Nth Docker call happens, for every N a successful start makes, and compare with what existed before.
    const dry = makeProxy();
    await startAgent(dry.request);
    const total = dry.fake.calls.length;
    let aborted = 0;
    for (let n = 1; n < total; n += 1) {
      const { fake, request } = makeProxy();
      const before = fake.state();
      const controller = new AbortController();
      fake.onCall = (index) => {
        if (index === n) controller.abort();
      };
      let outcome: 'started' | 'interrupted';
      try {
        await startAgent({ ...request, signal: controller.signal });
        outcome = 'started';
      } catch (error) {
        expect((error as ContainerError).code, `abort at call ${n}`).toBe('INTERRUPTED');
        outcome = 'interrupted';
      }
      if (outcome === 'interrupted') {
        aborted += 1;
        const after = fake.state();
        for (const c of after.containers) expect(before.containers.has(c), `abort at call ${n}: container ${c} left behind`).toBe(true);
        for (const net of after.networks) expect(before.networks.has(net), `abort at call ${n}: network ${net} left behind`).toBe(true);
        for (const v of after.volumes) expect(before.volumes.has(v), `abort at call ${n}: volume ${v} left behind`).toBe(true);
      }
    }
    expect(aborted).toBeGreaterThan(5); // the loop really did interrupt starts in the middle
  });

  it('an abort while waiting for the sidecar does not wait out the readiness timeout', async () => {
    const { fake, request } = makeProxy();
    fake.proxyLogs = () => ''; // never reports ready
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const error = await rejection(startAgent({ ...request, signal: controller.signal, proxyReadyTimeoutMs: 20_000, proxyReadyPollMs: 5 }));
    expect(error.code).toBe('INTERRUPTED');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(fake.containers.size).toBe(0);
  });

  it('once the agent is running, an abort during the liveness window does not undo a successful start', async () => {
    const fake = new FakeRuntime();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = await startAgent(req(fake, { signal: controller.signal, livenessGraceMs: 2_000, livenessPollMs: 5 }));
    expect(started.containerId).toBeDefined();
    expect(fake.containers.get(`av-${AGENT}`)?.state).toBe('running');
    expect(fake.mutations.filter((m) => m.startsWith('remove') || m.startsWith('stop'))).toEqual([]);
  });

  it('the signal is optional: without one nothing changes', async () => {
    const fake = new FakeRuntime();
    expect((await startAgent(req(fake))).containerId).toBeDefined();
  });
});

describe('volume ownership', () => {
  const mine = { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_VOLUME_KEY]: 'data' };
  const PRECIOUS = `av-${AGENT}-data`;

  it('reuses this agent\'s own volume exactly as it is: nothing is created, re-labelled or removed', async () => {
    const fake = new FakeRuntime();
    fake.volumes.set(PRECIOUS, { ...mine });
    await startAgent(req(fake));
    expect(fake.mutations).toEqual([`start av-${AGENT}`]);
    expect(fake.volumes.get(PRECIOUS)).toEqual(mine);
  });

  it('refuses a volume of that name that carries no AgentVault labels (somebody else\'s), before creating anything', async () => {
    const fake = new FakeRuntime();
    fake.volumes.set(PRECIOUS, {}); // e.g. a volume the user made by hand with this name
    const error = await expectRefusal(fake, req(fake), 'POLICY_VIOLATION');
    expect(error.message).toContain(PRECIOUS);
    expect(error.message).toMatch(/not created by AgentVault/);
    expect(fake.volumes.has(PRECIOUS)).toBe(true);
  });

  it('refuses another AGENT\'s volume that happens to derive the same Docker name', async () => {
    // agent "alpha-agent" + key "data" and agent "alpha" + key "agent-data" are both "av-alpha-agent-data".
    const fake = new FakeRuntime(manifestFor({ volumes: ['/agent-data'] }));
    const owner = { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: `${AGENT}-agent`, [LABEL_VOLUME_KEY]: 'data' };
    fake.volumes.set(`av-${AGENT}-agent-data`, { ...owner });
    const error = await expectRefusal(fake, req(fake), 'POLICY_VIOLATION');
    expect(error.message).toContain(`"${AGENT}-agent"`);
    expect(error.message).toMatch(/combine/);
    expect(fake.volumes.get(`av-${AGENT}-agent-data`)).toEqual(owner);
  });

  it('refuses a volume of the right agent but a different key', async () => {
    const fake = new FakeRuntime();
    fake.volumes.set(PRECIOUS, { ...mine, [LABEL_VOLUME_KEY]: 'other' });
    await expectRefusal(fake, req(fake), 'POLICY_VIOLATION');
  });

  it('a failed start NEVER deletes a volume it did not create (the original data-loss path)', async () => {
    // Before: a volume of that name without our labels was not in the label-filtered "before" list, so the rollback
    // believed it had created it and deleted it after any later failure (even a typo'd --cpus). Now it is refused
    // outright, and a volume that is genuinely this agent's is reused and never counted as created.
    const dry = new FakeRuntime();
    dry.volumes.set(PRECIOUS, { ...mine });
    await startAgent(req(dry));
    const lastCall = dry.calls.length - 1; // the agent's own start

    const fake = new FakeRuntime();
    fake.volumes.set(PRECIOUS, { ...mine });
    fake.failAt = lastCall;
    const error = await rejection(startAgent(req(fake)));
    expect(error.message).toContain('injected failure');
    expect(fake.mutations.filter((m) => m.startsWith('removeVolume'))).toEqual([]);
    expect(fake.volumes.get(PRECIOUS)).toEqual(mine);

    const foreigners: Array<Record<string, string>> = [{}, { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: 'someone-else', [LABEL_VOLUME_KEY]: 'data' }];
    for (const foreign of foreigners) {
      const refused = new FakeRuntime();
      refused.volumes.set(PRECIOUS, { ...foreign });
      await expectRefusal(refused, req(refused), 'POLICY_VIOLATION'); // also asserts: not one mutating call
      expect(refused.volumes.get(PRECIOUS)).toEqual(foreign);
    }
  });

  it('a volume this call created IS removed when the start fails afterwards, and only that one', async () => {
    const make = (): FakeRuntime => {
      const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
      fake.volumes.set(PRECIOUS, { ...mine }); // pre-existing and genuinely this agent's: must survive
      return fake;
    };
    const dry = make();
    await startAgent(req(dry));
    const fake = make();
    fake.failAt = dry.calls.length - 1;
    await rejection(startAgent(req(fake)));
    expect(fake.volumes.has(PRECIOUS)).toBe(true);
    expect(fake.volumes.has(`av-${AGENT}-cache`)).toBe(false);
  });
});

describe('(c)(j) rollback', () => {
  interface Scenario {
    label: string;
    make: () => { fake: FakeRuntime; request: StartAgentOptions };
  }

  const dataVolume = { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: AGENT, [LABEL_VOLUME_KEY]: 'data' };

  const scenarios: Scenario[] = [
    {
      label: 'no network, one pre-existing and one new volume',
      make: () => {
        const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
        fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
        return { fake, request: req(fake) };
      },
    },
    {
      label: 'bridge',
      make: () => {
        const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
        fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
        return { fake, request: req(fake, { network: 'bridge' }) };
      },
    },
    {
      label: 'proxy mode, dedicated egress network',
      make: () => {
        const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'], secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));
        fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
        return { fake, request: req(fake, { proxyPlan: planFor() }) };
      },
    },
    {
      label: 'proxy mode, caller-named egress network',
      make: () => {
        const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
        fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
        fake.networks.set('shared-egress', { internal: false });
        return { fake, request: req(fake, { proxyPlan: planFor(), proxyEgressNetwork: 'shared-egress' }) };
      },
    },
    {
      label: 'proxy mode with stale leftovers of an earlier run',
      make: () => {
        const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
        fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
        fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
        fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'exited');
        fake.networks.set(`av-${AGENT}-net`, { internal: true });
        fake.networks.set(`av-${AGENT}-egress`, { internal: false });
        return { fake, request: req(fake, { proxyPlan: planFor() }) };
      },
    },
  ];

  describe.each(scenarios)('failure injected at every step: $label', ({ make }) => {
    /** Method name of every runtime call a SUCCESSFUL start makes, in order. */
    async function dryRun(): Promise<string[]> {
      const { fake, request } = make();
      await startAgent(request);
      return fake.calls.map((c) => c.method);
    }
    /** Stale-network removal before the first listVolumes is deliberately best effort. */
    const isTolerated = (methods: string[], i: number): boolean => methods[i] === 'removeNetwork' && i < methods.indexOf('inspectVolume');

    it('rejects with the ORIGINAL error and leaves nothing it created behind', async () => {
      const methods = await dryRun();
      expect(methods.length).toBeGreaterThan(5);
      let injected = 0;
      for (let i = 0; i < methods.length; i += 1) {
        if (isTolerated(methods, i)) continue;
        const { fake, request } = make();
        const before = fake.state();
        fake.failAt = i;
        const error = await rejection(startAgent(request));
        injected += 1;
        const where = `call ${i} (${methods[i] ?? '?'})`;
        expect(error.message, where).toContain(`injected failure at call ${i}`);
        const after = fake.state();
        for (const c of after.containers) expect(before.containers.has(c), `${where}: container ${c} was left behind`).toBe(true);
        for (const net of after.networks) expect(before.networks.has(net), `${where}: network ${net} was left behind`).toBe(true);
        for (const v of after.volumes) expect(before.volumes.has(v), `${where}: volume ${v} was left behind`).toBe(true);
        // Nothing that pre-existed was deleted by the rollback.
        expect(after.volumes.has(`av-${AGENT}-data`), `${where}: pre-existing volume deleted`).toBe(true);
        if (request.proxyEgressNetwork !== undefined) {
          expect(after.networks.has(request.proxyEgressNetwork), `${where}: caller's network deleted`).toBe(true);
        }
      }
      expect(injected).toBeGreaterThan(5);
    });

    it('the original error is not masked when every cleanup call fails as well', async () => {
      const methods = await dryRun();
      for (let i = 0; i < methods.length; i += 1) {
        if (isTolerated(methods, i)) continue;
        const { fake, request } = make();
        fake.failAt = i;
        fake.failCleanup = true;
        const error = await rejection(startAgent(request));
        expect(error.message, `call ${i} (${methods[i] ?? '?'})`).toContain(`injected failure at call ${i}`);
      }
    });
  });

  it('a stale network that cannot be removed does not stop the start', async () => {
    const fake = new FakeRuntime(manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));
    fake.networks.set(`av-${AGENT}-net`, { internal: true });
    fake.failAt = 3; // list is call 2; the first stale removeNetwork is call 3
    const started = await startAgent(req(fake, { proxyPlan: planFor() }));
    expect(fake.calls[3]?.method).toBe('removeNetwork');
    expect(started.containerId).toBeDefined();
  });

  it('(c) removes the volume this call created but keeps the one that existed, when the agent fails to start', async () => {
    const fake = new FakeRuntime(manifestFor({ volumes: ['/data', '/cache'] }));
    fake.volumes.set(`av-${AGENT}-data`, { ...dataVolume });
    fake.nameClash = `av-${AGENT}`;
    const error = await rejection(startAgent(req(fake)));
    expect(error.details?.['reason']).toBe('name_in_use');
    expect([...fake.volumes.keys()]).toEqual([`av-${AGENT}-data`]);
    expect(fake.mutations.filter((m) => m.startsWith('removeVolume'))).toEqual([`removeVolume av-${AGENT}-cache`]);
  });

  it('(c) a name clash with a container we did not create never gets it removed', async () => {
    const fake = new FakeRuntime();
    fake.nameClash = `av-${AGENT}`;
    await rejection(startAgent(req(fake)));
    expect(fake.mutations.some((m) => m.startsWith(`remove av-${AGENT} `))).toBe(false);
  });

  it('(j) rollback after a proxy failure removes sidecar, then egress, then internal network, then volumes', async () => {
    const fake = new FakeRuntime(manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } }));
    fake.nameClash = `av-${AGENT}`;
    await rejection(startAgent(req(fake, { proxyPlan: planFor() })));
    const afterFailure = fake.mutations.slice(fake.mutations.indexOf(`start av-${AGENT}`) + 1);
    expect(afterFailure).toEqual([
      `remove av-${AGENT}-proxy --force`,
      `removeNetwork av-${AGENT}-egress`,
      `removeNetwork av-${AGENT}-net`,
      `removeVolume av-${AGENT}-data`,
    ]);
    expect(fake.state()).toEqual({ containers: new Set(), networks: new Set(), volumes: new Set() });
  });

  it('a failure while the agent starts also force-removes a half-created agent container', async () => {
    const fake = new FakeRuntime();
    const realStart = fake.start.bind(fake);
    fake.start = (spec): Promise<{ id: string }> =>
      realStart(spec).then(() => Promise.reject(new ContainerError('COMMAND_FAILED', 'created but not started')));
    await rejection(startAgent(req(fake)));
    expect(fake.mutations).toContain(`remove av-${AGENT} --force`);
    expect(fake.containers.size).toBe(0);
  });

  it('reports what it could not clean up through onWarning, without masking the cause or leaking a secret', async () => {
    const manifest = manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });
    const dry = new FakeRuntime(manifest);
    await startAgent(req(dry, { proxyPlan: planFor() }));

    const fake = new FakeRuntime(manifest);
    fake.failAt = dry.calls.length - 1; // the start of the agent, the last call of a successful run
    fake.failCleanup = true;
    const realRemove = fake.remove.bind(fake);
    fake.remove = (name, options): Promise<void> =>
      fake.failAt !== undefined && fake.calls.length > fake.failAt
        ? Promise.reject(new ContainerError('COMMAND_FAILED', `refused ${CANARY}`))
        : realRemove(name, options);
    const heard: string[] = [];
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), onWarning: (m) => heard.push(m) })));
    expect(error.message).toContain('injected failure');
    expect(heard.some((m) => m.includes(`sidecar av-${AGENT}-proxy`))).toBe(true);
    expect(heard.every((m) => m.startsWith('Could not remove '))).toBe(true);
    expect(heard.join('\n')).not.toContain(CANARY);
    expect(heard.join('\n')).toContain('[redacted]');
  });
});

// ---------------------------------------------------------------------------
// Foreground (property h)
// ---------------------------------------------------------------------------

describe('(h) foreground run', () => {
  const proxyManifest = (): ContainerManifest =>
    manifestFor({ volumes: ['/data'], secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });

  it('runs with autoRemove and inherited stdio, returns the exit code, and tears down sidecar and networks but not the volume', async () => {
    const fake = new FakeRuntime(proxyManifest());
    fake.foregroundExit = 3;
    const started = await startAgent(req(fake, { proxyPlan: planFor(), detach: false }));
    expect(started.exitCode).toBe(3);
    expect(started.containerId).toBeUndefined();

    const run = fake.foreground[0];
    expect(run?.spec).toMatchObject({ name: `av-${AGENT}`, autoRemove: true, detach: false });
    expect(run?.io).toEqual({ inheritStdio: true });
    // While the agent ran, the sidecar and both networks existed...
    expect(run?.containersDuring).toContain(`av-${AGENT}-proxy`);
    expect(run?.networksDuring).toEqual(expect.arrayContaining([`av-${AGENT}-net`, `av-${AGENT}-egress`]));
    // ...afterwards they are gone, and the volume (created by this very call) is not.
    expect(fake.state()).toEqual({ containers: new Set(), networks: new Set(), volumes: new Set([`av-${AGENT}-data`]) });
    expect(fake.mutations).not.toContain(`removeVolume av-${AGENT}-data`);
    expect(fake.mutations.slice(-3)).toEqual([`remove av-${AGENT}-proxy --force`, `removeNetwork av-${AGENT}-egress`, `removeNetwork av-${AGENT}-net`]);
  });

  it('a non-zero exit code is returned, not thrown', async () => {
    const fake = new FakeRuntime();
    fake.foregroundExit = 137;
    const started = await startAgent(req(fake, { detach: false }));
    expect(started.exitCode).toBe(137);
  });

  it('a zero exit code is reported as 0', async () => {
    const fake = new FakeRuntime();
    const started = await startAgent(req(fake, { detach: false }));
    expect(started.exitCode).toBe(0);
  });

  it('without a proxy there is nothing to tear down', async () => {
    const fake = new FakeRuntime();
    await startAgent(req(fake, { detach: false }));
    expect(fake.mutations.some((m) => m.startsWith('removeNetwork') || m.startsWith('remove '))).toBe(false);
    expect(fake.mutations).toEqual([`ensureVolume av-${AGENT}-data`, `runForeground av-${AGENT}`]);
  });

  it('still tears down and propagates when the run itself throws, and keeps the volume', async () => {
    const fake = new FakeRuntime(proxyManifest());
    fake.foregroundThrows = new ContainerError('DAEMON_UNREACHABLE', 'docker went away');
    const error = await rejection(startAgent(req(fake, { proxyPlan: planFor(), detach: false })));
    expect(error.code).toBe('DAEMON_UNREACHABLE');
    expect(fake.state()).toEqual({ containers: new Set(), networks: new Set(), volumes: new Set([`av-${AGENT}-data`]) });
  });

  it('a failure BEFORE the run is a normal rollback, volumes created by this call included', async () => {
    const fake = new FakeRuntime(proxyManifest());
    fake.sidecarDies = true;
    await rejection(startAgent(req(fake, { proxyPlan: planFor(), detach: false })));
    expect(fake.foreground).toHaveLength(0);
    expect(fake.state()).toEqual({ containers: new Set(), networks: new Set(), volumes: new Set() });
  });

  it('warns when the sidecar cannot be removed afterwards (it holds credentials)', async () => {
    const fake = new FakeRuntime(proxyManifest());
    const realRemove = fake.remove.bind(fake);
    fake.remove = (name, options): Promise<void> =>
      name.endsWith('-proxy') && fake.foreground.length > 0 ? Promise.reject(new ContainerError('COMMAND_FAILED', 'stuck')) : realRemove(name, options);
    const heard: string[] = [];
    const started = await startAgent(req(fake, { proxyPlan: planFor(), detach: false, onWarning: (m) => heard.push(m) }));
    expect(started.exitCode).toBe(0);
    expect(started.warnings.some((w) => w.includes(`sidecar av-${AGENT}-proxy`))).toBe(true);
    expect(heard).toEqual(started.warnings);
  });

  it('passes interactive through for a foreground run, and ignores it for a detached one', async () => {
    const fg = new FakeRuntime();
    await startAgent(req(fg, { detach: false, interactive: true }));
    expect(fg.foreground[0]?.spec.interactive).toBe(true);
    const plain = new FakeRuntime();
    await startAgent(req(plain, { detach: false }));
    expect(plain.foreground[0]?.spec.interactive).toBeUndefined();
    const bg = new FakeRuntime();
    await startAgent(req(bg, { interactive: true }));
    expect(specNamed(bg, `av-${AGENT}`).interactive).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stopAgent
// ---------------------------------------------------------------------------

describe('stopAgent', () => {
  it('stops the agent first, then the sidecar, and reports both', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'running');
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    const result = await stopAgent(fake, AGENT);
    expect(result).toEqual({ stopped: [`av-${AGENT}`, `av-${AGENT}-proxy`] });
    expect(fake.mutations).toEqual([`stop av-${AGENT}`, `stop av-${AGENT}-proxy`]);
    expect(fake.callsOf('stop')[0]?.args).toEqual([`av-${AGENT}`]);
    expect(fake.containers.get(`av-${AGENT}`)?.state).toBe('exited');
  });

  it('forwards the timeout', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'running');
    await stopAgent(fake, AGENT, { timeoutSec: 3 });
    expect(fake.callsOf('stop')[0]?.args).toEqual([`av-${AGENT}`, 3]);
  });

  it('is idempotent: nothing running means nothing stopped and no error', async () => {
    const fake = new FakeRuntime();
    expect(await stopAgent(fake, AGENT)).toEqual({ stopped: [] });
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
    expect(await stopAgent(fake, AGENT)).toEqual({ stopped: [] });
    expect(fake.mutations).toEqual([]);
  });

  it('reports only what it actually stopped', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    expect(await stopAgent(fake, AGENT)).toEqual({ stopped: [`av-${AGENT}-proxy`] });
  });

  it('ignores a container that vanishes between list and stop', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'running');
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    const realStop = fake.stop.bind(fake);
    fake.stop = (...args): Promise<void> =>
      args[0] === `av-${AGENT}` ? Promise.reject(new ContainerError('NOT_FOUND', 'gone')) : realStop(...args);
    expect(await stopAgent(fake, AGENT)).toEqual({ stopped: [`av-${AGENT}-proxy`] });
  });

  it('does not stop the sidecar when the agent cannot be stopped, and throws', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'running');
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    fake.stop = (): Promise<void> => Promise.reject(new ContainerError('TIMEOUT', 'wedged'));
    await expect(stopAgent(fake, AGENT)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fake.containers.get(`av-${AGENT}-proxy`)?.state).toBe('running');
  });

  it('leaves other agents and unlabelled look-alikes alone', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-beta', 'agent', 'beta', 'running');
    fake.seed(`av-${AGENT}`, 'agent', 'someone-else', 'running');
    expect(await stopAgent(fake, AGENT)).toEqual({ stopped: [] });
  });

  it('rejects an invalid agent name', async () => {
    const fake = new FakeRuntime();
    await expect(stopAgent(fake, 'Bad Name')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fake.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// removeAgent (properties d, j)
// ---------------------------------------------------------------------------

describe('removeAgent', () => {
  const dataVolume = (agent: string, key = 'data'): Record<string, string> => ({
    [LABEL_MANAGED]: 'true',
    [LABEL_AGENT]: agent,
    [LABEL_VOLUME_KEY]: key,
  });

  function populated(): FakeRuntime {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'running');
    fake.seed(`av-${AGENT}-proxy`, 'proxy', AGENT, 'running');
    fake.networks.set(`av-${AGENT}-net`, { internal: true });
    fake.networks.set(`av-${AGENT}-egress`, { internal: false });
    fake.containers.get(`av-${AGENT}`)?.networks.add(`av-${AGENT}-net`);
    fake.containers.get(`av-${AGENT}-proxy`)?.networks.add(`av-${AGENT}-net`).add(`av-${AGENT}-egress`);
    const agentMounts = fake.containers.get(`av-${AGENT}`)?.spec.mounts;
    agentMounts?.push({ kind: 'volume', source: `av-${AGENT}-data`, target: '/data' });
    fake.volumes.set(`av-${AGENT}-data`, dataVolume(AGENT));
    fake.volumes.set(`av-${AGENT}-cache`, dataVolume(AGENT, 'cache'));
    fake.volumes.set('av-beta-data', dataVolume('beta'));
    return fake;
  }

  it('(d) stops gracefully, removes both containers and both networks, and KEEPS the volumes by default', async () => {
    const fake = populated();
    const result = await removeAgent(fake, AGENT);
    expect(result).toEqual({
      removed: [`av-${AGENT}`, `av-${AGENT}-proxy`, `av-${AGENT}-egress`, `av-${AGENT}-net`],
      keptVolumes: [`av-${AGENT}-data`, `av-${AGENT}-cache`],
      removedVolumes: [],
    });
    expect(fake.mutations).toEqual([
      `stop av-${AGENT}`,
      `remove av-${AGENT} --force`,
      `stop av-${AGENT}-proxy`,
      `remove av-${AGENT}-proxy --force`,
      `removeNetwork av-${AGENT}-egress`,
      `removeNetwork av-${AGENT}-net`,
    ]);
    expect(fake.state().volumes).toEqual(new Set([`av-${AGENT}-data`, `av-${AGENT}-cache`, 'av-beta-data']));
    expect(fake.mutations.some((m) => m.startsWith('removeVolume'))).toBe(false);
  });

  it.each([false, undefined, 1, 'true', 'yes'])('(d) removeVolumes=%j does not delete data', async (flag) => {
    const fake = populated();
    const result = await removeAgent(fake, AGENT, { removeVolumes: flag as unknown as boolean });
    expect(result.removedVolumes).toEqual([]);
    expect(result.keptVolumes).toHaveLength(2);
    expect(fake.mutations.some((m) => m.startsWith('removeVolume'))).toBe(false);
  });

  it('(d) removes this agent\'s volumes, and only its volumes, with removeVolumes: true', async () => {
    const fake = populated();
    const result = await removeAgent(fake, AGENT, { removeVolumes: true });
    expect(result.keptVolumes).toEqual([]);
    expect(result.removedVolumes).toEqual([`av-${AGENT}-data`, `av-${AGENT}-cache`]);
    expect(fake.state().volumes).toEqual(new Set(['av-beta-data']));
    // The containers that used the volume go first.
    const mutations = fake.mutations;
    expect(mutations.indexOf(`remove av-${AGENT} --force`)).toBeLessThan(mutations.indexOf(`removeVolume av-${AGENT}-data`));
  });

  it('(j) removes the egress network as well as the internal one', async () => {
    const fake = populated();
    await removeAgent(fake, AGENT);
    expect(fake.state().networks.size).toBe(0);
  });

  it('is idempotent on an agent that does not exist', async () => {
    const fake = new FakeRuntime();
    expect(await removeAgent(fake, AGENT)).toEqual({ removed: [], keptVolumes: [], removedVolumes: [] });
    expect(await removeAgent(fake, AGENT, { removeVolumes: true })).toEqual({ removed: [], keptVolumes: [], removedVolumes: [] });
  });

  it('is idempotent when called twice', async () => {
    const fake = populated();
    await removeAgent(fake, AGENT, { removeVolumes: true });
    expect(await removeAgent(fake, AGENT, { removeVolumes: true })).toEqual({ removed: [], keptVolumes: [], removedVolumes: [] });
  });

  it('removes an already-stopped container without stopping it again', async () => {
    const fake = new FakeRuntime();
    fake.seed(`av-${AGENT}`, 'agent', AGENT, 'exited');
    await removeAgent(fake, AGENT);
    expect(fake.mutations).toEqual([`remove av-${AGENT} --force`, `removeNetwork av-${AGENT}-egress`, `removeNetwork av-${AGENT}-net`]);
  });

  it('forwards the stop timeout', async () => {
    const fake = populated();
    await removeAgent(fake, AGENT, { timeoutSec: 2 });
    expect(fake.callsOf('stop')[0]?.args).toEqual([`av-${AGENT}`, 2]);
  });

  it('throws a real failure (network still in use) and attempts nothing after it, volumes included', async () => {
    const fake = populated();
    const realRemoveNetwork = fake.removeNetwork.bind(fake);
    fake.removeNetwork = (name): Promise<void> =>
      name.endsWith('-egress') ? Promise.reject(new ContainerError('COMMAND_FAILED', 'has active endpoints')) : realRemoveNetwork(name);
    await expect(removeAgent(fake, AGENT, { removeVolumes: true })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(fake.state().volumes.has(`av-${AGENT}-data`)).toBe(true);
  });

  it('does not delete a volume that is still in use (the fake refuses, and the error surfaces)', async () => {
    const fake = populated();
    fake.seed(`av-${AGENT}-extra`, 'helper', AGENT, 'running');
    fake.containers.get(`av-${AGENT}-extra`)?.spec.mounts.push({ kind: 'volume', source: `av-${AGENT}-data`, target: '/d' });
    await expect(removeAgent(fake, AGENT, { removeVolumes: true })).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(fake.state().volumes.has(`av-${AGENT}-data`)).toBe(true);
  });

  it('rejects an invalid agent name', async () => {
    await expect(removeAgent(new FakeRuntime(), '../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

// ---------------------------------------------------------------------------
// listAgents
// ---------------------------------------------------------------------------

describe('listAgents', () => {
  it('groups containers by agent label and reports the sidecar', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-zed', 'agent', 'zed', 'running');
    fake.seed('av-alpha', 'agent', 'alpha', 'running');
    fake.seed('av-alpha-proxy', 'proxy', 'alpha', 'running');
    const rows = await listAgents(fake);
    expect(rows).toEqual([
      { agent: 'alpha', state: 'running', image: IMAGE, hasProxy: true, containerName: 'av-alpha', createdAt: '2026-11-05 05:15:00 +0000 UTC' },
      { agent: 'zed', state: 'running', image: IMAGE, hasProxy: false, containerName: 'av-zed', createdAt: '2026-11-05 05:15:00 +0000 UTC' },
    ]);
  });

  it('lists only running containers by default and everything with all: true', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-alpha', 'agent', 'alpha', 'exited');
    fake.seed('av-beta', 'agent', 'beta', 'running');
    expect((await listAgents(fake)).map((r) => r.agent)).toEqual(['beta']);
    expect(fake.callsOf('list')[0]?.args).toEqual([{ all: false }]);
    const all = await listAgents(fake, { all: true });
    expect(all.map((r) => [r.agent, r.state])).toEqual([
      ['alpha', 'exited'],
      ['beta', 'running'],
    ]);
  });

  it('shows a sidecar whose agent container is gone as proxy-only', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-alpha-proxy', 'proxy', 'alpha', 'running');
    expect(await listAgents(fake)).toEqual([
      { agent: 'alpha', state: 'proxy-only', image: IMAGE, hasProxy: true, containerName: 'av-alpha-proxy', createdAt: '2026-11-05 05:15:00 +0000 UTC' },
    ]);
  });

  it('ignores helper containers, invalid agent labels and containers whose name does not match their agent', async () => {
    const fake = new FakeRuntime();
    fake.seed('av-alpha-snap', 'helper', 'alpha', 'running');
    fake.seed('av-evil', 'agent', '../etc', 'running');
    fake.seed('imposter', 'agent', 'alpha', 'running');
    expect(await listAgents(fake)).toEqual([]);
  });

  it('is empty when nothing exists', async () => {
    expect(await listAgents(new FakeRuntime())).toEqual([]);
  });
});
