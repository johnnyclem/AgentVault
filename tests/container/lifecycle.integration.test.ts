/**
 * Lifecycle against a REAL Docker daemon. Nothing about isolation is taken on
 * trust: each claim is proven by running a command inside a real container and
 * reading what the kernel says, or by asking the daemon what exists afterwards.
 *
 * The credential-proxy sidecar here is a hand-made 15-line node server (NOT the
 * real src/container/proxy bundle): the lifecycle only cares that the sidecar
 * prints {"event":"listening"} and answers on port 8080.
 *
 * Skipped (not failed) when no daemon is reachable or busybox:1.37 / node:22-slim
 * are not already pulled. Every Docker resource is named through dockerTestEnv('avt-l-').
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DockerRuntime } from '../../src/container/docker.js';
import { listAgents, removeAgent, startAgent, stopAgent } from '../../src/container/lifecycle.js';
import { containerManifestSchema, manifestToLabel } from '../../src/container/manifest.js';
import type { ContainerManifest } from '../../src/container/manifest.js';
import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_VOLUME_KEY, PROXY_ALIAS, PROXY_PLACEHOLDER_KEY } from '../../src/container/types.js';
import type { CommandResult, ContainerErrorCode, ContainerRuntime, ProxyPlan } from '../../src/container/types.js';
import { resourceNames } from '../../src/container/validate.js';
import { dockerTestEnv, imagePresent } from './helpers/docker.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const d = dockerTestEnv('avt-l-');
const BUSYBOX = 'busybox:1.37';
const NODE = 'node:22-slim';
const usable = d.available && imagePresent(BUSYBOX) && imagePresent(NODE);

// A token no placeholder, script or config may contain. It must only ever be in the sidecar environment.
const CANARY = 'CANARY-LIFECYCLE-7c6a180b36896a0a8c02787eeafb0e4c';

/** A sidecar that behaves: listens on 8080, says so in one JSON line, answers every request with its headers. */
const GOOD_SIDECAR = [
  "import http from 'node:http';",
  'const server = http.createServer((req, res) => {',
  "  res.setHeader('content-type', 'application/json');",
  '  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));',
  '});',
  "server.listen(8080, '0.0.0.0', () => {",
  "  console.log(JSON.stringify({ event: 'listening', port: 8080 }));",
  '});',
].join('\n');

/** A sidecar that logs its secret (as a careless one would) and never reports ready. */
const NEVER_READY_SIDECAR = [
  "console.log('booting, upstream key is ' + process.env.AV_SECRET_SVC);",
  'setInterval(() => {}, 1000);',
].join('\n');

/** A sidecar that dies at once. */
const CRASHING_SIDECAR = [
  "console.error('fatal: bad configuration, key ' + process.env.AV_SECRET_SVC);",
  'process.exit(1);',
].join('\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dockerCli(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, ...(input !== undefined ? { input } : {}) });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Every container, network and volume Docker holds for this agent. */
function resourcesOf(agent: string): { containers: string[]; networks: string[]; volumes: string[] } {
  const mine = (name: string): boolean => name === `av-${agent}` || name.startsWith(`av-${agent}-`);
  return {
    containers: lines(dockerCli(['ps', '-a', '--format', '{{.Names}}']).stdout).filter(mine),
    networks: lines(dockerCli(['network', 'ls', '--format', '{{.Name}}']).stdout).filter(mine),
    volumes: lines(dockerCli(['volume', 'ls', '--format', '{{.Name}}']).stdout).filter(mine),
  };
}

function containerState(name: string): string | undefined {
  const r = dockerCli(['inspect', '--format', '{{.State.Status}}', name]);
  return r.status === 0 ? r.stdout.trim() : undefined;
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

async function expectRefusal(promise: Promise<unknown>, code: ContainerErrorCode): Promise<ContainerError> {
  const error = await rejection(promise);
  expect(error.code, error.message).toBe(code);
  return error;
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

/** The real runtime, recording which methods were called. */
function recording(inner: DockerRuntime): { runtime: ContainerRuntime; calls: string[] } {
  const calls: string[] = [];
  const runtime = new Proxy(inner, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && typeof prop === 'string' && prop !== 'runner') {
        return (...args: unknown[]): unknown => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { runtime, calls };
}

function manifestFor(over: Partial<ContainerManifest> = {}): ContainerManifest {
  return containerManifestSchema.parse({
    schemaVersion: 1,
    name: 'itest',
    version: '1.0.0',
    runtime: 'node',
    entrypoint: ['sleep', '3600'],
    volumes: ['/data'],
    env: [],
    secrets: [],
    isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'node', contentHash: 'd'.repeat(64) },
    ...over,
  });
}

function planFor(script: string, over: Partial<ProxyPlan> = {}): ProxyPlan {
  return {
    config: {
      version: 1,
      listenPort: 8080,
      routes: [{ name: 'svc', pathPrefix: '/svc', upstream: 'http://upstream.invalid', inject: [{ header: 'x-api-key', secret: 'svc' }] }],
      maxBodyBytes: 1_048_576,
      upstreamTimeoutMs: 5000,
    },
    secrets: { svc: CANARY },
    agentEnv: { SVC_API_KEY: PROXY_PLACEHOLDER_KEY, SVC_BASE_URL: `http://${PROXY_ALIAS}:8080/svc` },
    scriptSource: script,
    image: NODE,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!usable)('lifecycle against a real daemon', () => {
  const runtime = new DockerRuntime();
  let scratch: string;
  let plainImage: string;
  let secretImage: string;

  async function buildImage(label: string, manifest: ContainerManifest): Promise<string> {
    const context = fs.mkdtempSync(path.join(scratch, 'ctx-'));
    // The image owns /data so a fresh named volume mounted there is copied up with uid 10001 ownership.
    fs.writeFileSync(
      path.join(context, 'Dockerfile'),
      [
        `FROM ${BUSYBOX}`,
        'RUN mkdir -p /data /home/agent && chown 10001:10001 /data /home/agent && chmod 700 /home/agent',
        'USER 10001:10001',
        `LABEL agentvault.manifest=${JSON.stringify(manifestToLabel(manifest))}`,
        'CMD ["sleep", "3600"]',
        '',
      ].join('\n')
    );
    const tag = `${d.name(label)}:latest`;
    await runtime.buildImage({ contextDir: context, tag });
    return tag;
  }

  const sh = (container: string, script: string): Promise<CommandResult> => runtime.exec(container, ['sh', '-c', script]);

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-l-itest-'));
    plainImage = await buildImage('plain', manifestFor());
    secretImage = await buildImage(
      'secret',
      manifestFor({ secrets: ['svc'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } })
    );
  });

  afterAll(() => {
    d.cleanup();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  // -- (1) and (6): lifecycle and data ---------------------------------------

  it('(1) detached start, stop and remove; data survives stop + remove + start', async () => {
    const agent = d.agent('life');
    const names = resourceNames(agent);
    const started = await startAgent({ runtime, agent, image: plainImage });
    expect(started).toMatchObject({ agent, containerName: names.container, network: 'none', volumes: [names.volume('data')], warnings: [] });
    expect(started.containerId).toMatch(/^[0-9a-f]{64}$/);
    expect(containerState(names.container)).toBe('running');
    expect(dockerCli(['volume', 'inspect', '--format', '{{json .Labels}}', names.volume('data')]).stdout).toContain(`"${LABEL_AGENT}":"${agent}"`);

    // listAgents reflects it.
    const row = (await listAgents(runtime)).find((r) => r.agent === agent);
    expect(row).toMatchObject({ state: 'running', hasProxy: false, containerName: names.container, image: plainImage });

    // (f) a running agent is not replaced.
    const clash = await expectRefusal(startAgent({ runtime, agent, image: plainImage }), 'INVALID_INPUT');
    expect(clash.message).toMatch(/already running/);
    expect(containerState(names.container)).toBe('running');

    // The container really is locked down and writes to its volume as uid 10001.
    const write = await sh(names.container, 'printf survive > /data/proof && id -u');
    expect(write.exitCode, write.stderr).toBe(0);
    expect(write.stdout.trim()).toBe('10001');

    // Stop: graceful, idempotent.
    expect(await stopAgent(runtime, agent, { timeoutSec: 1 })).toEqual({ stopped: [names.container] });
    expect(containerState(names.container)).toBe('exited');
    expect((await listAgents(runtime)).some((r) => r.agent === agent)).toBe(false);
    expect((await listAgents(runtime, { all: true })).find((r) => r.agent === agent)).toMatchObject({ state: 'exited' });
    expect(await stopAgent(runtime, agent)).toEqual({ stopped: [] });

    // Remove keeps the volume by default; idempotent.
    expect(await removeAgent(runtime, agent)).toEqual({ removed: [names.container], keptVolumes: [names.volume('data')], removedVolumes: [] });
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [names.volume('data')] });
    expect(await removeAgent(runtime, agent)).toEqual({ removed: [], keptVolumes: [names.volume('data')], removedVolumes: [] });

    // Start again: the same data.
    const again = await startAgent({ runtime, agent, image: plainImage });
    const read = await sh(again.containerName, 'cat /data/proof');
    expect(read.stdout).toBe('survive');
    expect(again.containerId).not.toBe(started.containerId);

    // Restart in place: a stopped container is replaced, the data stays.
    await stopAgent(runtime, agent, { timeoutSec: 1 });
    const third = await startAgent({ runtime, agent, image: plainImage });
    expect((await sh(third.containerName, 'cat /data/proof')).stdout).toBe('survive');
    expect(resourcesOf(agent).containers).toEqual([names.container]);

    // Final cleanup is opt-in: the volume goes only with removeVolumes: true.
    const gone = await removeAgent(runtime, agent, { removeVolumes: true, timeoutSec: 1 });
    expect(gone).toEqual({ removed: [names.container], keptVolumes: [], removedVolumes: [names.volume('data')] });
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
  });

  it('(6) removeAgent without removeVolumes keeps the data of THAT agent only; with it, deletes that agent\'s volumes and no one else\'s', async () => {
    const keeper = d.agent('keep');
    const goner = d.agent('gone');
    for (const agent of [keeper, goner]) {
      const s = await startAgent({ runtime, agent, image: plainImage });
      expect((await sh(s.containerName, `printf ${agent} > /data/id`)).exitCode).toBe(0);
    }
    const kept = await removeAgent(runtime, keeper, { timeoutSec: 1 });
    expect(kept.removedVolumes).toEqual([]);
    expect(kept.keptVolumes).toEqual([`av-${keeper}-data`]);
    const wiped = await removeAgent(runtime, goner, { removeVolumes: true, timeoutSec: 1 });
    expect(wiped.removedVolumes).toEqual([`av-${goner}-data`]);

    expect(resourcesOf(keeper).volumes).toEqual([`av-${keeper}-data`]);
    expect(resourcesOf(goner).volumes).toEqual([]);
    const content = dockerCli(['run', '--rm', '--network=none', `--name=${d.name('rd')}`, '-v', `av-${keeper}-data:/v:ro`, BUSYBOX, 'cat', '/v/id']);
    expect(content.stdout).toBe(keeper);
  });

  // -- (2) network none ---------------------------------------------------------

  it('(2) network none: the container has only loopback and cannot reach anything', async () => {
    const agent = d.agent('none');
    const started = await startAgent({ runtime, agent, image: plainImage });
    expect(started.network).toBe('none');
    const nics = await sh(started.containerName, 'ls /sys/class/net');
    expect(nics.stdout.trim()).toBe('lo');
    const wget = await sh(started.containerName, 'wget -T 3 -q -O- http://1.1.1.1/');
    expect(wget.exitCode).not.toBe(0);
    await removeAgent(runtime, agent, { removeVolumes: true, timeoutSec: 1 });
  });

  // -- refusals touch nothing -----------------------------------------------------

  it('(a) secrets without a proxy plan are refused and the real runtime is never asked to create anything', async () => {
    const agent = d.agent('refuse');
    const rec = recording(runtime);
    const noPlan = await expectRefusal(startAgent({ runtime: rec.runtime, agent, image: secretImage }), 'MISSING_SECRET');
    expect(noPlan.message).toContain('svc');
    await expectRefusal(startAgent({ runtime: rec.runtime, agent, image: secretImage, network: 'none' }), 'POLICY_VIOLATION');
    await expectRefusal(startAgent({ runtime: rec.runtime, agent, image: secretImage, network: 'bridge' }), 'POLICY_VIOLATION');
    const insufficient = await expectRefusal(
      startAgent({
        runtime: rec.runtime,
        agent,
        image: secretImage,
        proxyPlan: planFor(GOOD_SIDECAR, { config: { ...planFor(GOOD_SIDECAR).config, routes: [] } }),
      }),
      'MISSING_SECRET'
    );
    expect(insufficient.message).not.toContain(CANARY);
    expect(rec.calls.filter((c) => MUTATING.has(c))).toEqual([]);
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
  });

  it('refuses an image that does not exist', async () => {
    const agent = d.agent('noimg');
    const error = await expectRefusal(startAgent({ runtime, agent, image: `${d.name('missing')}:latest` }), 'NOT_FOUND');
    expect(error.message).toContain('agentvault package');
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
  });

  it('refuses an image that is not an AgentVault image', async () => {
    const agent = d.agent('plainimg');
    await expectRefusal(startAgent({ runtime, agent, image: BUSYBOX }), 'INVALID_INPUT');
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
  });

  // -- (3) proxy mode ---------------------------------------------------------------

  describe('(3) proxy mode with a hand-made plan', () => {
    let agent: string;
    let agentContainer: string;
    let sidecar: string;
    let internalNet: string;
    let egressNet: string;
    let neighbour: string;
    let control: string;
    let controlIp: string;

    beforeAll(async () => {
      agent = d.agent('prx');
      const names = resourceNames(agent);
      agentContainer = names.container;
      sidecar = names.proxy;
      internalNet = names.network;
      egressNet = names.egress;
      const warnings: string[] = [];
      const started = await startAgent({
        runtime,
        agent,
        image: secretImage,
        proxyPlan: planFor(GOOD_SIDECAR),
        command: ['sleep', '3600'],
        proxyReadyTimeoutMs: 60_000,
        onWarning: (m) => warnings.push(m),
      });
      expect(started).toMatchObject({ network: 'proxy', proxyContainerName: sidecar, networkName: internalNet, warnings: [] });
      expect(warnings).toEqual([]);

      // An unrelated container on the default bridge, and a control server beside it (see (3b)).
      neighbour = d.name('nb');
      control = d.name('ctl');
      expect(dockerCli(['run', '-d', `--name=${neighbour}`, BUSYBOX, 'sleep', '3600']).status).toBe(0);
      expect(
        dockerCli(['run', '-d', `--name=${control}`, BUSYBOX, 'sh', '-c', 'mkdir /www && echo control-ok > /www/index.html && exec httpd -f -p 8080 -h /www']).status
      ).toBe(0);
      controlIp = dockerCli(['inspect', '--format', '{{(index .NetworkSettings.Networks "bridge").IPAddress}}', control]).stdout.trim();
      expect(controlIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    it('the agent reaches the sidecar by its alias and the sidecar sees the request', async () => {
      const r = await runtime.exec(agentContainer, ['wget', '-q', '-O-', `http://${PROXY_ALIAS}:8080/svc/hello`]);
      expect(r.exitCode, r.stderr).toBe(0);
      const echoed = JSON.parse(r.stdout) as { method: string; url: string; headers: Record<string, string> };
      expect(echoed.method).toBe('GET');
      expect(echoed.url).toBe('/svc/hello');
      expect(echoed.headers['host']).toBe(`${PROXY_ALIAS}:8080`);
    });

    it('the agent cannot reach the internet or resolve public DNS', async () => {
      const direct = await sh(agentContainer, 'wget -T 3 -q -O- http://1.1.1.1/ 2>&1');
      expect(direct.exitCode).not.toBe(0);
      expect(direct.stdout).toMatch(/unreachable/i);
      const byName = await sh(agentContainer, 'wget -T 3 -q -O- http://example.com/ 2>&1');
      expect(byName.exitCode).not.toBe(0);
      expect(byName.stdout).toMatch(/bad address|can't resolve|unreachable/i);
      const lookup = await sh(agentContainer, 'timeout 8 nslookup example.com 2>&1');
      expect(lookup.exitCode).not.toBe(0);
    });

    it('(b) the agent environment holds the placeholder and NOT the secret; the sidecar environment holds it', async () => {
      const inside = await runtime.exec(agentContainer, ['env']);
      expect(inside.stdout).toContain(`SVC_API_KEY=${PROXY_PLACEHOLDER_KEY}`);
      expect(inside.stdout).toContain(`SVC_BASE_URL=http://${PROXY_ALIAS}:8080/svc`);
      expect(inside.stdout).not.toContain(CANARY);

      const rawAgent = dockerCli(['inspect', '--format', '{{json .Config.Env}}', agentContainer]).stdout;
      const rawSidecar = dockerCli(['inspect', '--format', '{{json .Config.Env}}', sidecar]).stdout;
      expect(rawAgent).not.toContain(CANARY);
      expect(rawSidecar).toContain(`AV_SECRET_SVC=${CANARY}`);

      // runtime.inspect redacts values: the canary is in neither.
      const agentInspect = JSON.stringify(await runtime.inspect(agentContainer));
      const sidecarInspect = JSON.stringify(await runtime.inspect(sidecar));
      expect(agentInspect).not.toContain(CANARY);
      expect(sidecarInspect).not.toContain(CANARY);
      expect(sidecarInspect).toContain('AV_SECRET_SVC=<redacted>');

      // The secret is also not in the sidecar's argv: it travelled only through the env file.
      const sidecarCmd = dockerCli(['inspect', '--format', '{{json .Config.Cmd}}{{json .Args}}', sidecar]).stdout;
      expect(sidecarCmd).not.toContain(CANARY);
      const sidecarEnv = await runtime.exec(sidecar, ['printenv', 'AV_SECRET_SVC']);
      expect(sidecarEnv.stdout).toBe(CANARY);
    });

    it('the sidecar has an alias on the internal network only; its egress network holds nothing else', async () => {
      const info = (await runtime.inspect(sidecar)) as { NetworkSettings: { Networks: Record<string, { IPAddress: string; Aliases?: string[] | null }> } };
      const nets = info.NetworkSettings.Networks;
      expect(Object.keys(nets).sort()).toEqual([egressNet, internalNet].sort());
      expect(nets['bridge']).toBeUndefined();
      expect(nets[internalNet]?.Aliases ?? []).toContain(PROXY_ALIAS);
      expect(nets[egressNet]?.Aliases ?? []).not.toContain(PROXY_ALIAS);

      const egressMembers = JSON.parse(dockerCli(['network', 'inspect', '--format', '{{json .Containers}}', egressNet]).stdout) as Record<string, { Name: string }>;
      expect(Object.values(egressMembers).map((c) => c.Name)).toEqual([sidecar]);
      expect(dockerCli(['network', 'inspect', '--format', '{{.Internal}}', egressNet]).stdout.trim()).toBe('false');
      expect(dockerCli(['network', 'inspect', '--format', '{{.Internal}}', internalNet]).stdout.trim()).toBe('true');
      const internalMembers = JSON.parse(dockerCli(['network', 'inspect', '--format', '{{json .Containers}}', internalNet]).stdout) as Record<string, { Name: string }>;
      expect(Object.values(internalMembers).map((c) => c.Name).sort()).toEqual([agentContainer, sidecar].sort());
    });

    it('(3b) THE CROSS-CONTAINER ATTACK: an unrelated container on the default bridge cannot reach the sidecar', async () => {
      const info = (await runtime.inspect(sidecar)) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
      const ips = Object.values(info.NetworkSettings.Networks)
        .map((n) => n.IPAddress)
        .filter((ip) => ip !== '');
      expect(ips).toHaveLength(2);

      // Positive control: the very same probes DO reach a server that is on the default bridge.
      const viaWget = await runtime.exec(neighbour, ['wget', '-T', '3', '-q', '-O-', `http://${controlIp}:8080/`]);
      expect(viaWget.exitCode, viaWget.stderr).toBe(0);
      expect(viaWget.stdout).toBe('control-ok');
      const viaNc = await runtime.exec(neighbour, ['nc', '-z', '-w', '3', controlIp, '8080']);
      expect(viaNc.exitCode, viaNc.stderr).toBe(0);

      // The attack: every address the sidecar has, port 8080.
      for (const ip of ips) {
        const wget = await runtime.exec(neighbour, ['wget', '-T', '3', '-q', '-O-', `http://${ip}:8080/svc/spend`]);
        expect(wget.exitCode, `wget to ${ip} unexpectedly succeeded: ${wget.stdout}`).not.toBe(0);
        expect(wget.stdout).toBe('');
        const nc = await runtime.exec(neighbour, ['nc', '-z', '-w', '3', ip, '8080']);
        expect(nc.exitCode, `nc to ${ip} unexpectedly connected`).not.toBe(0);
      }

      // The agent itself is on the internal network only: it cannot use the sidecar's egress address either.
      const egressIp = (info.NetworkSettings.Networks[egressNet] as { IPAddress: string }).IPAddress;
      const fromAgent = await runtime.exec(agentContainer, ['nc', '-z', '-w', '3', egressIp, '8080']);
      expect(fromAgent.exitCode).not.toBe(0);
    });

    it('(3b) the sidecar itself still reaches the internet through its egress network', async () => {
      const probe = dockerCli(['run', '--rm', `--name=${d.name('inet')}`, BUSYBOX, 'wget', '-T', '5', '-q', '-O', '/dev/null', 'http://1.1.1.1/']);
      const script = "fetch('http://1.1.1.1/', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).then((r) => console.log('status ' + r.status), (e) => { console.log('error ' + String(e.cause?.code ?? e.message)); process.exit(3); });";
      const result = await runtime.exec(sidecar, ['node', '-e', script]);
      if (probe.status === 0) {
        expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(/^status \d{3}$/);
      } else {
        // The sandbox has no outbound access at all: assert on the attachment instead (done in the previous tests).
        console.warn('[lifecycle itest] no outbound internet from containers here; egress asserted by network attachment only');
        expect(result.exitCode).not.toBe(0);
      }
    });

    it('listAgents shows the sidecar; stop stops agent then sidecar; remove removes both networks', async () => {
      const row = (await listAgents(runtime)).find((r) => r.agent === agent);
      expect(row).toMatchObject({ state: 'running', hasProxy: true, containerName: agentContainer });

      expect(await stopAgent(runtime, agent, { timeoutSec: 1 })).toEqual({ stopped: [agentContainer, sidecar] });
      expect(containerState(agentContainer)).toBe('exited');
      expect(containerState(sidecar)).toBe('exited');

      const removed = await removeAgent(runtime, agent, { removeVolumes: true, timeoutSec: 1 });
      expect(removed.removed).toEqual([agentContainer, sidecar, egressNet, internalNet]);
      expect(removed.removedVolumes).toEqual([`av-${agent}-data`]);
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
    });
  });

  it('an explicit shared bridge for the sidecar is allowed, warned about, and never removed', async () => {
    const agent = d.agent('brg');
    const names = resourceNames(agent);
    const heard: string[] = [];
    const started = await startAgent({
      runtime,
      agent,
      image: secretImage,
      proxyPlan: planFor(GOOD_SIDECAR),
      proxyEgressNetwork: 'bridge',
      proxyReadyTimeoutMs: 60_000,
      onWarning: (m) => heard.push(m),
    });
    expect(started.warnings).toHaveLength(1);
    expect(heard).toEqual(started.warnings);
    expect(heard[0]).toMatch(/every container on this host can reach the sidecar/);
    const info = (await runtime.inspect(names.proxy)) as { NetworkSettings: { Networks: Record<string, unknown> } };
    expect(Object.keys(info.NetworkSettings.Networks).sort()).toEqual(['bridge', names.network].sort());
    expect(resourcesOf(agent).networks).toEqual([names.network]);
    await removeAgent(runtime, agent, { removeVolumes: true, timeoutSec: 1 });
    expect(dockerCli(['network', 'inspect', 'bridge']).status).toBe(0);
    expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
  });

  it('(e) bridge mode runs, warns, and has a network interface', async () => {
    const agent = d.agent('bridge');
    const heard: string[] = [];
    const started = await startAgent({ runtime, agent, image: plainImage, network: 'bridge', onWarning: (m) => heard.push(m) });
    expect(started.network).toBe('bridge');
    expect(started.warnings).toHaveLength(1);
    expect(heard).toEqual(started.warnings);
    const nics = await sh(started.containerName, 'ls /sys/class/net');
    expect(nics.stdout.split('\n').sort()).toEqual(['eth0', 'lo']);
    await removeAgent(runtime, agent, { removeVolumes: true, timeoutSec: 1 });
  });

  // -- (4) failure injection for real -----------------------------------------------

  describe('(4) failure injection', () => {
    it('a sidecar that never becomes ready: start rejects after the timeout, redacts the log, and leaves nothing behind', async () => {
      const agent = d.agent('nrdy');
      const began = Date.now();
      const error = await rejection(
        startAgent({ runtime, agent, image: secretImage, proxyPlan: planFor(NEVER_READY_SIDECAR), proxyReadyTimeoutMs: 3000, proxyReadyPollMs: 100 })
      );
      expect(Date.now() - began).toBeGreaterThanOrEqual(3000);
      expect(error.code).toBe('TIMEOUT');
      expect(error.message).toContain('did not report ready');
      // The sidecar really did log the secret; the error does not carry it.
      expect(error.message).toContain('booting, upstream key is [redacted]');
      expect(error.message).not.toContain(CANARY);
      expect(String(error.stack)).not.toContain(CANARY);
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
    });

    it('a sidecar that crashes: fails fast with the redacted tail, nothing left behind', async () => {
      const agent = d.agent('crash');
      const began = Date.now();
      const error = await rejection(
        startAgent({ runtime, agent, image: secretImage, proxyPlan: planFor(CRASHING_SIDECAR), proxyReadyTimeoutMs: 60_000, proxyReadyPollMs: 100 })
      );
      expect(Date.now() - began).toBeLessThan(30_000);
      expect(error.code).toBe('COMMAND_FAILED');
      expect(error.message).toContain('stopped before it was ready');
      expect(error.message).toContain('fatal: bad configuration, key [redacted]');
      expect(error.message).not.toContain(CANARY);
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
    });

    it('(c) a rollback keeps a volume that already held data and removes only what it created', async () => {
      const agent = d.agent('keepvol');
      const names = resourceNames(agent);
      // The agent's data volume exists from an earlier life, with a file in it.
      await runtime.ensureVolume(names.volume('data'), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: 'data' });
      const seed = dockerCli(['run', '--rm', '--network=none', `--name=${d.name('seed')}`, '-v', `${names.volume('data')}:/v`, BUSYBOX, 'sh', '-c', 'echo precious > /v/keep']);
      expect(seed.status, seed.stderr).toBe(0);

      await rejection(
        startAgent({ runtime, agent, image: secretImage, proxyPlan: planFor(NEVER_READY_SIDECAR), proxyReadyTimeoutMs: 1500, proxyReadyPollMs: 100 })
      );
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [names.volume('data')] });
      const content = dockerCli(['run', '--rm', '--network=none', `--name=${d.name('chk')}`, '-v', `${names.volume('data')}:/v:ro`, BUSYBOX, 'cat', '/v/keep']);
      expect(content.stdout.trim()).toBe('precious');
      expect(dockerCli(['volume', 'inspect', '--format', `{{index .Labels "${LABEL_MANAGED}"}}`, names.volume('data')]).stdout.trim()).toBe('true');
    });

    it('a failure at the very last step (the agent cannot be created) removes sidecar, both networks and the new volume', async () => {
      const agent = d.agent('lastfail');
      const names = resourceNames(agent);
      // Something that is not ours already owns the agent's container name, so docker refuses the LAST step.
      expect(dockerCli(['run', '-d', `--name=${names.container}`, BUSYBOX, 'sleep', '3600']).status).toBe(0);
      const heard: string[] = [];
      const error = await rejection(
        startAgent({ runtime, agent, image: secretImage, proxyPlan: planFor(GOOD_SIDECAR), proxyReadyTimeoutMs: 60_000, onWarning: (m) => heard.push(m) })
      );
      expect(error.details?.['reason']).toBe('name_in_use');
      expect(heard).toEqual([]);
      // The sidecar had been up and ready; now it, both networks and the volume this call created are gone.
      expect(resourcesOf(agent)).toEqual({ containers: [names.container], networks: [], volumes: [] });
      expect(containerState(names.container)).toBe('running');
      dockerCli(['rm', '-f', names.container]);
    });

    it('(c) a foreign container that already owns the agent\'s name is neither removed nor stopped', async () => {
      const agent = d.agent('foreign');
      const names = resourceNames(agent);
      expect(dockerCli(['run', '-d', `--name=${names.container}`, BUSYBOX, 'sleep', '3600']).status).toBe(0);
      const error = await rejection(startAgent({ runtime, agent, image: plainImage }));
      expect(error.details?.['reason']).toBe('name_in_use');
      expect(containerState(names.container)).toBe('running');
      // The volume this call created is gone again; the foreign container is untouched.
      expect(resourcesOf(agent)).toEqual({ containers: [names.container], networks: [], volumes: [] });
      dockerCli(['rm', '-f', names.container]);
    });
  });

  // -- (5) foreground ---------------------------------------------------------------

  describe('(5) foreground', () => {
    it('returns the exit code and leaves the volume with the data it wrote', async () => {
      const agent = d.agent('fg');
      const names = resourceNames(agent);
      const started = await startAgent({ runtime, agent, image: plainImage, detach: false, command: ['sh', '-c', 'printf wrote > /data/fg; exit 7'] });
      expect(started.exitCode).toBe(7);
      expect(started.containerId).toBeUndefined();
      // --rm: no stopped container left to block the next start.
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [names.volume('data')] });
      const read = dockerCli(['run', '--rm', '--network=none', `--name=${d.name('fgr')}`, '-v', `${names.volume('data')}:/v:ro`, BUSYBOX, 'cat', '/v/fg']);
      expect(read.stdout).toBe('wrote');

      // And it can be started again straight away.
      const second = await startAgent({ runtime, agent, image: plainImage, detach: false, command: ['sh', '-c', 'exit 0'] });
      expect(second.exitCode).toBe(0);
      await removeAgent(runtime, agent, { removeVolumes: true });
    });

    it('in proxy mode the agent reaches the sidecar while it runs, and afterwards sidecar and networks are gone but the volume stays', async () => {
      const agent = d.agent('fgp');
      const names = resourceNames(agent);
      const started = await startAgent({
        runtime,
        agent,
        image: secretImage,
        proxyPlan: planFor(GOOD_SIDECAR),
        detach: false,
        command: ['sh', '-c', `wget -q -T 5 -O /data/echo http://${PROXY_ALIAS}:8080/svc/fg && exit 0; exit 9`],
        proxyReadyTimeoutMs: 60_000,
      });
      expect(started.exitCode).toBe(0);
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [names.volume('data')] });
      const echoed = dockerCli(['run', '--rm', '--network=none', `--name=${d.name('fgx')}`, '-v', `${names.volume('data')}:/v:ro`, BUSYBOX, 'cat', '/v/echo']);
      expect((JSON.parse(echoed.stdout) as { url: string }).url).toBe('/svc/fg');
      await removeAgent(runtime, agent, { removeVolumes: true });
      expect(resourcesOf(agent)).toEqual({ containers: [], networks: [], volumes: [] });
    });
  });
});
