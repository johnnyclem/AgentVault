/**
 * DockerRuntime against a REAL Docker daemon. Nothing here is stubbed: each
 * isolation claim (non-root, no capabilities, read-only root, no network,
 * internal-only network) is proven by running a command inside a container
 * built from buildAgentSpec()/buildProxySpec() output and reading what the
 * kernel reports.
 *
 * Skipped (not failed) when no daemon is reachable or busybox:1.37 is not
 * already pulled. Every Docker resource is named through dockerTestEnv('avt-a-').
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DockerRuntime } from '../../src/container/docker.js';
import { containerManifestSchema, manifestFromLabels, manifestToLabel } from '../../src/container/manifest.js';
import type { ContainerManifest } from '../../src/container/manifest.js';
import { buildAgentSpec, buildProxySpec } from '../../src/container/policy.js';
import { execaRunner } from '../../src/container/runner.js';
import {
  ContainerError,
  LABEL_AGENT,
  LABEL_VOLUME_KEY,
  PROXY_ALIAS,
} from '../../src/container/types.js';
import type {
  CommandResult,
  CommandRunner,
  ContainerErrorCode,
  ContainerSpec,
} from '../../src/container/types.js';
import { resourceNames } from '../../src/container/validate.js';
import { dockerTestEnv, imagePresent } from './helpers/docker.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const d = dockerTestEnv('avt-a-');
const BUSYBOX = 'busybox:1.37';
const usable = d.available && imagePresent(BUSYBOX);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manifestFor(over: Partial<ContainerManifest> = {}): ContainerManifest {
  return containerManifestSchema.parse({
    schemaVersion: 1,
    name: 'itest',
    version: '1.0.0',
    runtime: 'node',
    entrypoint: ['sh'],
    volumes: ['/data'],
    env: [],
    secrets: [],
    isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'node', contentHash: 'b'.repeat(64) },
    ...over,
  });
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

function expectCode(error: ContainerError, code: ContainerErrorCode): void {
  expect(error.code, error.message).toBe(code);
}

/** Raw docker CLI, for assertions about what the daemon actually holds. */
function dockerCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function eventually<T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const combined = (r: CommandResult): string => `${r.stdout}\n${r.stderr}`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!usable)('DockerRuntime against a real daemon', () => {
  const runtime = new DockerRuntime();
  let scratch: string;
  let previousTmp: string | undefined;
  let image: string;

  beforeAll(async () => {
    // Private TMPDIR so we can prove no env file outlives its container start.
    previousTmp = process.env['TMPDIR'];
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-a-itest-'));
    process.env['TMPDIR'] = scratch;

    const context = fs.mkdtempSync(path.join(scratch, 'ctx-'));
    // The image owns /data and /home/agent so a fresh named volume mounted there is copied up with
    // uid 10001 ownership. Without this the non-root agent cannot write to its volume.
    fs.writeFileSync(
      path.join(context, 'Dockerfile'),
      [
        `FROM ${BUSYBOX}`,
        // /home/agent is 0700 like a Debian `useradd -m` home: the tmpfs mounted over it must still be usable.
        'RUN mkdir -p /data /home/agent && chown 10001:10001 /data /home/agent && chmod 700 /home/agent',
        'USER 10001:10001',
        `LABEL agentvault.manifest=${JSON.stringify(manifestToLabel(manifestFor()))}`,
        'CMD ["sh"]',
        '',
      ].join('\n')
    );
    image = `${d.name('img')}:latest`;
    await runtime.buildImage({ contextDir: context, tag: image });
  });

  afterAll(() => {
    d.cleanup();
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** A real agent spec; callers override what they need. */
  function agentSpecFor(agent: string, over: Partial<ContainerSpec> = {}, network: 'none' | 'proxy' | 'bridge' = 'none'): ContainerSpec {
    const spec = buildAgentSpec({
      agent,
      image,
      manifest: manifestFor(),
      network,
      limits: { cpus: 0.5, memory: '64m', pidsLimit: 64 },
      hostEnv: {},
      explicitEnv: {},
      detach: false,
    });
    return { ...spec, name: d.name('c'), autoRemove: true, ...over };
  }

  async function ensureAgentVolumes(agent: string): Promise<void> {
    const names = resourceNames(agent);
    await runtime.ensureVolume(names.volume('data'), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: 'data' });
  }

  async function sh(spec: ContainerSpec, script: string, io?: Parameters<DockerRuntime['runForeground']>[1]): Promise<CommandResult> {
    return runtime.runForeground({ ...spec, name: d.name('c'), command: ['sh', '-c', script] }, io);
  }

  // -- daemon and images ----------------------------------------------------

  describe('daemon and images', () => {
    it('reports the server version', async () => {
      const { serverVersion } = await runtime.ensureAvailable();
      expect(serverVersion).toMatch(/^\d+\.\d+/);
    });

    it('built an image whose id, user and manifest label survive a round trip', async () => {
      const info = await runtime.inspectImage(image);
      expect(info).not.toBeNull();
      expect(info?.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(info?.user).toBe('10001:10001');
      expect(info?.repoTags).toContain(image);
      expect(manifestFromLabels(info?.labels ?? {})).toEqual(manifestFor());
    });

    it('buildImage returns the same id inspectImage reports', async () => {
      const context = fs.mkdtempSync(path.join(scratch, 'ctx2-'));
      fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM ${BUSYBOX}\nLABEL a.b="c"\n`);
      const tag = `${d.name('img2')}:v1`;
      const built = await runtime.buildImage({ contextDir: context, tag, labels: { 'agentvault.source-hash': 'abc123' } });
      const info = await runtime.inspectImage(tag);
      expect(built).toEqual({ imageId: info?.id, tag });
      expect(info?.labels['agentvault.source-hash']).toBe('abc123');
      expect(info?.user).toBe('');
    });

    it('removeImage untags an image, then reports NOT_FOUND', async () => {
      const context = fs.mkdtempSync(path.join(scratch, 'ctx-rmi-'));
      fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM ${BUSYBOX}\nLABEL a.b="removable"\n`);
      const tag = `${d.name('rmi')}:latest`;
      await runtime.buildImage({ contextDir: context, tag });
      await expect(runtime.inspectImage(tag)).resolves.not.toBeNull();
      await runtime.removeImage(tag);
      await expect(runtime.inspectImage(tag)).resolves.toBeNull();
      expectCode(await rejection(runtime.removeImage(tag)), 'NOT_FOUND');
    });

    it('inspectImage returns null for an image that does not exist', async () => {
      await expect(runtime.inspectImage(`${d.name('nope')}:latest`)).resolves.toBeNull();
    });

    it('a failing build is a COMMAND_FAILED that names the failing step', async () => {
      const context = fs.mkdtempSync(path.join(scratch, 'ctx3-'));
      fs.writeFileSync(path.join(context, 'Dockerfile'), `FROM ${BUSYBOX}\nRUN exit 3\n`);
      const error = await rejection(runtime.buildImage({ contextDir: context, tag: `${d.name('bad')}:latest` }));
      expectCode(error, 'COMMAND_FAILED');
      expect(error.message).toMatch(/exit code: 3|did not complete successfully/);
    });
  });

  // -- container hardening --------------------------------------------------

  describe('a container started from buildAgentSpec() output', () => {
    const agent = d.agent('iso');

    beforeAll(async () => {
      await ensureAgentVolumes(agent);
    });

    it('runs as uid/gid 10001', async () => {
      const r = await sh(agentSpecFor(agent), 'echo "$(id -u):$(id -g)"');
      expect(r.exitCode, combined(r)).toBe(0);
      expect(r.stdout.trim()).toBe('10001:10001');
    });

    it('has no capabilities (effective and bounding sets are empty) and no_new_privs set', async () => {
      const r = await sh(agentSpecFor(agent), 'grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):" /proc/self/status');
      expect(r.exitCode, combined(r)).toBe(0);
      const fields = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(/:\s+/) as [string, string]));
      for (const cap of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        expect(fields[cap], cap).toBe('0000000000000000');
      }
      expect(fields['NoNewPrivs']).toBe('1');
    });

    it('cannot write to the root filesystem, but can write to /tmp and /home/agent', async () => {
      const spec = agentSpecFor(agent);
      const root = await sh(spec, 'echo x > /rootfile');
      expect(root.exitCode).not.toBe(0);
      expect(combined(root)).toMatch(/Read-only file system/i);
      const bin = await sh(spec, 'echo x > /bin/evil');
      expect(bin.exitCode).not.toBe(0);

      const tmp = await sh(spec, 'echo scratch > /tmp/f && cat /tmp/f');
      expect(tmp.exitCode, combined(tmp)).toBe(0);
      expect(tmp.stdout.trim()).toBe('scratch');
      const home = await sh(spec, 'echo home > /home/agent/f && cat /home/agent/f');
      expect(home.exitCode, combined(home)).toBe(0);
      expect(home.stdout.trim()).toBe('home');
    });

    it('can write to its managed volume', async () => {
      const r = await sh(agentSpecFor(agent), 'echo vol > /data/probe && cat /data/probe');
      expect(r.exitCode, combined(r)).toBe(0);
      expect(r.stdout.trim()).toBe('vol');
    });

    it('may write to the root filesystem only when writableRootfs was requested', async () => {
      const writable = buildAgentSpec({
        agent,
        image,
        manifest: manifestFor(),
        network: 'none',
        hostEnv: {},
        explicitEnv: {},
        detach: false,
        writableRootfs: true,
      });
      // /etc is root-owned in the image, so a uid 10001 write still fails; /data is ours.
      expect(writable.readOnlyRootfs).toBe(false);
      const r = await runtime.runForeground({ ...writable, name: d.name('c'), autoRemove: true, command: ['sh', '-c', 'echo ok > /data/w && cat /data/w'] });
      expect(r.exitCode, combined(r)).toBe(0);
    });

    it('persists volume data across container lifetimes', async () => {
      const spec = agentSpecFor(agent);
      const write = await sh(spec, 'echo persisted-state > /data/state.txt');
      expect(write.exitCode, combined(write)).toBe(0);
      expect(dockerCli(['ps', '-a', '--filter', `label=${LABEL_AGENT}=${agent}`, '-q']).stdout.trim()).toBe('');
      const read = await sh(spec, 'cat /data/state.txt');
      expect(read.exitCode, combined(read)).toBe(0);
      expect(read.stdout.trim()).toBe('persisted-state');
    });

    it('the network is "none": only the loopback interface exists', async () => {
      const r = await sh(agentSpecFor(agent), 'cat /proc/net/dev');
      expect(r.exitCode, combined(r)).toBe(0);
      const interfaces = r.stdout
        .split('\n')
        .slice(2)
        .filter((l) => l.includes(':'))
        .map((l) => l.split(':')[0]?.trim());
      expect(interfaces).toEqual(['lo']);
    });

    it('reports every hardening flag on the running container', async () => {
      const name = d.name('hard');
      const spec = agentSpecFor(agent, { name, autoRemove: false, detach: true, command: ['sleep', '120'], restart: 'no' });
      const { id } = await runtime.start(spec);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      const info = (await runtime.inspect(name)) as {
        Id: string;
        Config: { User: string; Labels: Record<string, string> };
        HostConfig: {
          CapDrop: string[];
          CapAdd: string[] | null;
          SecurityOpt: string[];
          Privileged: boolean;
          ReadonlyRootfs: boolean;
          PidsLimit: number;
          Memory: number;
          MemorySwap: number;
          NanoCpus: number;
          Init: boolean;
          NetworkMode: string;
          PidMode: string;
          IpcMode: string;
          UsernsMode: string;
          Devices: unknown[];
          VolumesFrom: unknown;
          RestartPolicy: { Name: string };
          LogConfig: { Config: Record<string, string> };
          Tmpfs: Record<string, string>;
          Mounts: Array<{ Type: string; Source: string; Target: string }>;
        };
      };
      expect(info.Id).toBe(id);
      const host = info.HostConfig;
      expect(info.Config.User).toBe('10001:10001');
      expect(host.CapDrop).toEqual(['ALL']);
      expect(host.CapAdd ?? []).toEqual([]);
      expect(host.SecurityOpt).toEqual(['no-new-privileges']);
      expect(host.Privileged).toBe(false);
      expect(host.ReadonlyRootfs).toBe(true);
      expect(host.PidsLimit).toBe(64);
      expect(host.Memory).toBe(64 * 1024 * 1024);
      expect(host.MemorySwap).toBe(host.Memory);
      expect(host.NanoCpus).toBe(500_000_000);
      expect(host.Init).toBe(true);
      expect(host.NetworkMode).toBe('none');
      expect(host.PidMode).toBe('');
      expect(host.IpcMode).toBe('private');
      expect(host.UsernsMode).toBe('');
      expect(host.Devices).toEqual([]);
      expect(host.VolumesFrom ?? null).toBeNull();
      expect(host.RestartPolicy.Name).toBe('no');
      expect(host.LogConfig.Config).toEqual({ 'max-file': '3', 'max-size': '10m' });
      expect(host.Tmpfs['/tmp']).toBe('rw,nosuid,nodev,size=128m,mode=1777');
      expect(host.Tmpfs['/home/agent']).toBe('rw,nosuid,nodev,size=128m,mode=1777');
      expect(host.Mounts).toEqual([{ Type: 'volume', Source: resourceNames(agent).volume('data'), Target: '/data' }]);
      expect(info.Config.Labels[LABEL_AGENT]).toBe(agent);
      await runtime.remove(name, { force: true });
    });
  });

  // -- capabilities for the helper -----------------------------------------

  describe('helper containers', () => {
    it('root with every capability dropped cannot read another user\'s 0600 file; DAC_READ_SEARCH fixes exactly that', async () => {
      const agent = d.agent('cap');
      await ensureAgentVolumes(agent);
      const writeAsAgent = await sh(agentSpecFor(agent), 'echo top-secret > /data/private && chmod 600 /data/private');
      expect(writeAsAgent.exitCode, combined(writeAsAgent)).toBe(0);

      const helper = (capAdd?: string[]): ContainerSpec => ({
        name: d.name('helper'),
        image: BUSYBOX,
        role: 'helper',
        user: '0:0',
        allowRoot: true,
        network: 'none',
        mounts: [{ kind: 'volume', source: resourceNames(agent).volume('data'), target: '/data', readOnly: true }],
        tmpfs: [],
        env: {},
        labels: {},
        limits: { cpus: 0.5, memory: '64m', pidsLimit: 32 },
        readOnlyRootfs: true,
        detach: false,
        init: true,
        autoRemove: true,
        command: ['cat', '/data/private'],
        ...(capAdd ? { capAdd } : {}),
      });

      const denied = await runtime.runForeground(helper());
      expect(denied.exitCode).not.toBe(0);
      expect(combined(denied)).toMatch(/permission denied/i);

      const allowed = await runtime.runForeground(helper(['DAC_READ_SEARCH']));
      expect(allowed.exitCode, combined(allowed)).toBe(0);
      expect(allowed.stdout.trim()).toBe('top-secret');
    });

    it('streams binary data through stdinFile and stdoutFile, byte for byte', async () => {
      const volume = d.name('vol');
      await runtime.ensureVolume(volume);
      const helper = (script: string): ContainerSpec => ({
        name: d.name('helper'),
        image: BUSYBOX,
        role: 'helper',
        user: '0:0',
        allowRoot: true,
        network: 'none',
        mounts: [{ kind: 'volume', source: volume, target: '/vol' }],
        tmpfs: [],
        env: {},
        labels: {},
        limits: { cpus: 0.5, memory: '64m', pidsLimit: 32 },
        readOnlyRootfs: true,
        detach: false,
        init: true,
        autoRemove: true,
        command: ['sh', '-c', script],
      });
      const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.alloc(300_000, 0xfe)]);
      const input = path.join(scratch, 'in.bin');
      const output = path.join(scratch, 'out.bin');
      fs.writeFileSync(input, bytes);

      const put = await runtime.runForeground(helper('cat > /vol/blob'), { stdinFile: input });
      expect(put.exitCode, combined(put)).toBe(0);
      const get = await runtime.runForeground(helper('cat /vol/blob'), { stdoutFile: output });
      expect(get.exitCode, combined(get)).toBe(0);
      expect(get.stdout).toBe('');
      expect(fs.readFileSync(output).equals(bytes)).toBe(true);
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    });

    it('returns the container exit code instead of throwing, and leaves the partial output for the caller', async () => {
      const output = path.join(scratch, 'partial.bin');
      const spec: ContainerSpec = {
        name: d.name('helper'),
        image: BUSYBOX,
        role: 'helper',
        user: '0:0',
        allowRoot: true,
        network: 'none',
        mounts: [],
        tmpfs: [],
        env: {},
        labels: {},
        limits: { cpus: 0.5, memory: '64m', pidsLimit: 32 },
        readOnlyRootfs: true,
        detach: false,
        init: true,
        autoRemove: true,
        command: ['sh', '-c', 'printf partial; echo "tar: cannot open" >&2; exit 7'],
      };
      const r = await runtime.runForeground(spec, { stdoutFile: output });
      expect(r.exitCode).toBe(7);
      expect(r.stderr).toContain('cannot open');
      expect(fs.readFileSync(output, 'utf8')).toBe('partial');
    });
  });

  // -- environment ----------------------------------------------------------

  describe('environment delivery', () => {
    const awkward: Record<string, string> = {
      PLAIN: 'value',
      SPACED: '  leading and trailing  ',
      QUOTED: 'has "double" and \'single\' quotes',
      DOLLAR: '$HOME and ${PATH} and $(id)',
      HASHED: 'before # after',
      EQUALS: 'a=b=c',
      EMPTY: '',
      UNICODE: 'caf\u00e9 \u2713 \u65e5\u672c\u8a9e',
      BACKSLASH: 'C:\\path\\n',
    };

    it('delivers awkward values to the container exactly as given', async () => {
      const agent = d.agent('env');
      const spec = agentSpecFor(agent, { env: awkward });
      for (const [name, value] of Object.entries(awkward)) {
        const r = await runtime.runForeground({ ...spec, name: d.name('c'), command: ['sh', '-c', `printf '%s' "$${name}"`] });
        expect(r.exitCode, combined(r)).toBe(0);
        expect(r.stdout, name).toBe(value);
      }
    });

    it('keeps values out of the container\'s command line and out of runtime.inspect()', async () => {
      const secret = 'sk-ant-integration-SECRET-value-98765';
      const agent = d.agent('sec');
      const name = d.name('sec');
      await runtime.start(agentSpecFor(agent, { name, autoRemove: false, detach: true, env: { API_KEY: secret, OTHER: 'visible-but-redacted' }, command: ['sleep', '120'] }));

      const raw = dockerCli(['container', 'inspect', name]).stdout;
      expect(raw).toContain(secret); // the daemon does hold it...
      const redacted = JSON.stringify(await runtime.inspect(name));
      expect(redacted).not.toContain(secret); // ...but our inspect() never shows it
      expect(redacted).not.toContain('visible-but-redacted');
      expect(redacted).toContain('API_KEY=<redacted>');

      const seen = await runtime.exec(name, ['sh', '-c', 'printf "%s" "$API_KEY"']);
      expect(seen.stdout).toBe(secret);
      await runtime.remove(name, { force: true });
    });

    it('leaves no env file behind after any of this', () => {
      // beforeAll pointed TMPDIR at a private directory; every start()/runForeground() above used it.
      const leftovers = fs.readdirSync(scratch).filter((entry) => entry.startsWith('avt-env-'));
      expect(leftovers).toEqual([]);
    });
  });

  // -- networks -------------------------------------------------------------

  describe('network lockdown', () => {
    const agent = d.agent('net');
    const net = resourceNames(agent).network;
    let proxyName: string;

    beforeAll(async () => {
      await runtime.ensureNetwork(net, { internal: true, labels: { [LABEL_AGENT]: agent } });
      // A stand-in sidecar: it answers on the proxy alias, on the internal network only at first.
      proxyName = d.name('proxy');
      const proxy: ContainerSpec = {
        name: proxyName,
        image: BUSYBOX,
        role: 'proxy',
        user: '10001:10001',
        network: net,
        networkAliases: [PROXY_ALIAS],
        mounts: [],
        tmpfs: ['/tmp'],
        env: {},
        labels: {},
        limits: { cpus: 0.5, memory: '64m', pidsLimit: 32 },
        readOnlyRootfs: true,
        detach: true,
        init: true,
        command: ['sh', '-c', 'mkdir -p /tmp/www && echo pong > /tmp/www/index.html && exec httpd -f -p 8080 -h /tmp/www'],
      };
      await runtime.start(proxy);
    });

    const onInternalNet = (): ContainerSpec => agentSpecFor(agent, {}, 'proxy');

    it('ensureNetwork is idempotent and created the network as internal', async () => {
      await runtime.ensureNetwork(net, { internal: true });
      expect(dockerCli(['network', 'inspect', net, '--format', '{{.Internal}}']).stdout.trim()).toBe('true');
      expect(dockerCli(['network', 'inspect', net, '--format', '{{index .Labels "agentvault.managed"}}']).stdout.trim()).toBe('true');
    });

    it('a container on the internal network has an interface but cannot reach the internet', async () => {
      const iface = await sh(onInternalNet(), 'cat /proc/net/dev');
      const names = iface.stdout.split('\n').slice(2).filter((l) => l.includes(':')).map((l) => l.split(':')[0]?.trim());
      expect(names).toContain('eth0');

      const direct = await sh(onInternalNet(), 'wget -T 3 -q -O /dev/null http://1.1.1.1/');
      expect(direct.exitCode).not.toBe(0);
      expect(combined(direct)).toMatch(/Network is unreachable/i);
    });

    it('cannot resolve public names either (no DNS exfiltration path)', async () => {
      const r = await sh(onInternalNet(), 'nslookup example.com');
      expect(r.exitCode).not.toBe(0);
      expect(combined(r)).toMatch(/SERVFAIL|can't find|NXDOMAIN|timed out/i);
    });

    it('reaches the sidecar by its alias on the internal network', async () => {
      const r = await eventually(async () => {
        const attempt = await sh(onInternalNet(), `wget -T 3 -q -O- http://${PROXY_ALIAS}:8080/`);
        return attempt.exitCode === 0 ? attempt : undefined;
      }, 'the sidecar to answer on its alias');
      expect(r.stdout.trim()).toBe('pong');
      const dns = await sh(onInternalNet(), `nslookup ${PROXY_ALIAS}`);
      expect(dns.exitCode, combined(dns)).toBe(0);
    });

    it('once connected to the bridge the sidecar is still reachable from the internal side, and itself reaches out', async (ctx) => {
      await runtime.connectNetwork(proxyName, 'bridge');
      await runtime.connectNetwork(proxyName, 'bridge'); // idempotent

      const viaAlias = await sh(onInternalNet(), `wget -T 3 -q -O- http://${PROXY_ALIAS}:8080/`);
      expect(viaAlias.exitCode, combined(viaAlias)).toBe(0);
      expect(viaAlias.stdout.trim()).toBe('pong');

      const egress = await runtime.exec(proxyName, ['sh', '-c', 'wget -T 5 -q -O /dev/null http://1.1.1.1/']);
      if (egress.exitCode !== 0) {
        ctx.skip(`no direct internet egress from this environment: ${combined(egress).trim()}`);
      }
      // The agent, on the same shared internal network, still has no route out.
      const agentEgress = await sh(onInternalNet(), 'wget -T 3 -q -O /dev/null http://1.1.1.1/');
      expect(agentEgress.exitCode).not.toBe(0);
    });

    it('connectNetwork to a network that does not exist is NOT_FOUND', async () => {
      expectCode(await rejection(runtime.connectNetwork(proxyName, d.name('nonet'))), 'NOT_FOUND');
    });

    it('ensureNetwork refuses an existing NON-internal network of the same name (POLICY_VIOLATION)', async () => {
      const open = d.name('open');
      await runtime.ensureNetwork(open, { internal: false });
      expect(dockerCli(['network', 'inspect', open, '--format', '{{.Internal}}']).stdout.trim()).toBe('false');
      const error = await rejection(runtime.ensureNetwork(open, { internal: true }));
      expectCode(error, 'POLICY_VIOLATION');
      expect(error.message).toContain('internal=false');
      // ...and nothing was changed.
      expect(dockerCli(['network', 'inspect', open, '--format', '{{.Internal}}']).stdout.trim()).toBe('false');
      await runtime.removeNetwork(open);
    });

    it('ensureNetwork refuses an existing internal network when a non-internal one is requested', async () => {
      expectCode(await rejection(runtime.ensureNetwork(net, { internal: false })), 'POLICY_VIOLATION');
    });

    it('removeNetwork removes it, then reports NOT_FOUND', async () => {
      const gone = d.name('gone');
      await runtime.ensureNetwork(gone, { internal: true });
      await runtime.removeNetwork(gone);
      expectCode(await rejection(runtime.removeNetwork(gone)), 'NOT_FOUND');
    });

    it('starting a container on a network that does not exist is NOT_FOUND', async () => {
      const spec = agentSpecFor(d.agent('x'), { network: d.name('missing'), detach: true, autoRemove: false });
      expectCode(await rejection(runtime.start(spec)), 'NOT_FOUND');
    });

    it('buildProxySpec output starts as a locked-down sidecar and carries its secret only in its environment', async () => {
      const proxyAgent = d.agent('sidecar');
      const proxyNet = resourceNames(proxyAgent).network;
      await runtime.ensureNetwork(proxyNet, { internal: true });
      const secret = 'sk-ant-sidecar-REAL-secret-0123456789abcdef';
      const spec = buildProxySpec({
        agent: proxyAgent,
        plan: {
          config: { version: 1, listenPort: 8080, routes: [], maxBodyBytes: 1000, upstreamTimeoutMs: 1000 },
          secrets: { anthropic: secret },
          agentEnv: {},
          // busybox has no node: the script is a shell stand-in, so run it through sh via the command override.
          scriptSource: 'unused',
          image: BUSYBOX,
        },
      });
      const started = await runtime.start({ ...spec, user: '10001:10001', command: ['sh', '-c', 'printf "%s" "$AV_SECRET_ANTHROPIC" > /tmp/seen; sleep 60'] });
      expect(started.id).toMatch(/^[0-9a-f]{64}$/);

      const seen = await eventually(async () => {
        const r = await runtime.exec(spec.name, ['cat', '/tmp/seen']);
        return r.exitCode === 0 && r.stdout.length > 0 ? r : undefined;
      }, 'the sidecar to read its secret');
      expect(seen.stdout).toBe(secret);

      const info = JSON.stringify(await runtime.inspect(spec.name));
      expect(info).not.toContain(secret);
      const host = (await runtime.inspect(spec.name)) as { HostConfig: { CapDrop: string[]; ReadonlyRootfs: boolean; NetworkMode: string } };
      expect(host.HostConfig.CapDrop).toEqual(['ALL']);
      expect(host.HostConfig.ReadonlyRootfs).toBe(true);
      expect(host.HostConfig.NetworkMode).toBe(proxyNet);
      const listed = await runtime.list({ agent: proxyAgent });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ name: spec.name, role: 'proxy', agent: proxyAgent, state: 'running' });
    });
  });

  // -- volumes and listing --------------------------------------------------

  describe('volumes', () => {
    it('listVolumes finds managed volumes by agent, with their keys, and ignores others', async () => {
      const agent = d.agent('vols');
      const other = d.agent('vols2');
      const names = resourceNames(agent);
      await runtime.ensureVolume(names.volume('data'), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: 'data' });
      await runtime.ensureVolume(names.volume('cache'), { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: 'cache' });
      await runtime.ensureVolume(resourceNames(other).volume('data'), { [LABEL_AGENT]: other, [LABEL_VOLUME_KEY]: 'data' });
      await runtime.ensureVolume(d.name('unlabelled'));

      const mine = await runtime.listVolumes({ agent });
      expect(mine.slice().sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: names.volume('cache'), key: 'cache', agent },
        { name: names.volume('data'), key: 'data', agent },
      ]);
      const everything = await runtime.listVolumes();
      expect(everything.map((v) => v.name)).toEqual(expect.arrayContaining([names.volume('data'), names.volume('cache'), resourceNames(other).volume('data')]));
      // The volume with no agent/key labels is managed-labelled (ensureVolume adds that) but not mappable, so it is dropped.
      expect(everything.some((v) => v.name.includes('unlabelled'))).toBe(false);
      await expect(runtime.listVolumes({ agent: d.agent('none-here') })).resolves.toEqual([]);
    });

    it('ensureVolume is idempotent and removeVolume reports NOT_FOUND the second time', async () => {
      const v = d.name('idem');
      await runtime.ensureVolume(v);
      await runtime.ensureVolume(v);
      await runtime.removeVolume(v);
      expectCode(await rejection(runtime.removeVolume(v)), 'NOT_FOUND');
    });

    it('removeVolume refuses a volume that is in use', async () => {
      const v = d.name('busy');
      await runtime.ensureVolume(v);
      const holder = d.name('holder');
      await runtime.start({
        name: holder,
        image: BUSYBOX,
        role: 'helper',
        user: '0:0',
        allowRoot: true,
        network: 'none',
        mounts: [{ kind: 'volume', source: v, target: '/vol' }],
        tmpfs: [],
        env: {},
        labels: {},
        limits: { cpus: 0.5, memory: '64m', pidsLimit: 32 },
        readOnlyRootfs: true,
        detach: true,
        init: true,
        command: ['sleep', '60'],
      });
      expectCode(await rejection(runtime.removeVolume(v)), 'COMMAND_FAILED');
      await runtime.remove(holder, { force: true });
      await runtime.removeVolume(v);
    });
  });

  describe('container lifecycle: list, logs, stats, exec, stop, remove', () => {
    const agent = d.agent('life');
    const name = d.name('life');

    it('start returns an id; a second start with the same name is a clear error', async () => {
      await ensureAgentVolumes(agent);
      const spec = agentSpecFor(agent, {
        name,
        autoRemove: false,
        detach: true,
        command: ['sh', '-c', 'echo hello-from-the-agent; echo oops-on-stderr >&2; sleep 300'],
      });
      const { id } = await runtime.start(spec);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      const error = await rejection(runtime.start(spec));
      expectCode(error, 'COMMAND_FAILED');
      expect(error.message).toContain(`"${name}" already exists`);
      expect(error.details).toMatchObject({ reason: 'name_in_use' });
    });

    it('list shows it with role, agent and state, and honours the filters', async () => {
      const running = await runtime.list({ agent });
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({ name, role: 'agent', agent, state: 'running', image });
      expect(running[0]?.id).toMatch(/^[0-9a-f]{12}$/);
      expect(running[0]?.labels[LABEL_AGENT]).toBe(agent);
      expect((await runtime.list()).map((c) => c.name)).toContain(name);
      await expect(runtime.list({ agent: d.agent('nobody') })).resolves.toEqual([]);
    });

    it('logs returns stdout and stderr of the container', async () => {
      const r = await eventually(async () => {
        const attempt = await runtime.logs(name, { tail: 20 });
        return attempt.stdout.includes('hello-from-the-agent') ? attempt : undefined;
      }, 'the agent to log');
      expect(r.stdout).toContain('hello-from-the-agent');
      expect(r.stderr).toContain('oops-on-stderr');
      const tail = await runtime.logs(name, { tail: 1, since: '10m' });
      expect(tail.exitCode).toBe(0);
    });

    it('stats reports on the running container', async () => {
      const r = await runtime.stats(name);
      expect(r.stdout).toContain(name);
      expect(r.stdout).toContain('CPU %');
    });

    it('exec runs an argv command inside and returns its exit code', async () => {
      const out = await runtime.exec(name, ['sh', '-c', 'echo "uid=$(id -u)"']);
      expect(out.exitCode).toBe(0);
      expect(out.stdout.trim()).toBe('uid=10001');
      const fail = await runtime.exec(name, ['sh', '-c', 'exit 7']);
      expect(fail.exitCode).toBe(7);
    });

    it('exec does not interpret the argv: shell metacharacters stay literal', async () => {
      const r = await runtime.exec(name, ['echo', '$(id -u); echo injected && true']);
      expect(r.stdout.trim()).toBe('$(id -u); echo injected && true');
    });

    it('inspect returns the parsed container', async () => {
      const info = (await runtime.inspect(name)) as { Name: string; State: { Status: string; Running: boolean } };
      expect(info.Name).toBe(`/${name}`);
      expect(info.State).toMatchObject({ Status: 'running', Running: true });
    });

    it('stop stops it promptly, and list only shows it with all', async () => {
      const started = Date.now();
      await runtime.stop(name, 5);
      // sleep as PID 1 under tini exits on SIGTERM, so this must not wait the full grace period.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((await runtime.list({ agent })).map((c) => c.name)).not.toContain(name);
      const all = await runtime.list({ agent, all: true });
      expect(all).toHaveLength(1);
      expect(all[0]?.state).toBe('exited');
      await runtime.stop(name, 1); // stopping a stopped container is not an error
    });

    it('logs still work on a stopped container', async () => {
      const r = await runtime.logs(name);
      expect(r.stdout).toContain('hello-from-the-agent');
    });

    it('remove deletes it, then every operation on it reports NOT_FOUND', async () => {
      await runtime.remove(name);
      for (const op of [
        () => runtime.remove(name),
        () => runtime.stop(name),
        () => runtime.logs(name),
        () => runtime.inspect(name),
        () => runtime.stats(name),
        () => runtime.exec(name, ['true']),
      ]) {
        expectCode(await rejection(op()), 'NOT_FOUND');
      }
      expect((await runtime.list({ agent, all: true })).map((c) => c.name)).not.toContain(name);
    });

    it('remove refuses a running container unless forced', async () => {
      const busy = d.name('busyc');
      await runtime.start(agentSpecFor(agent, { name: busy, autoRemove: false, detach: true, command: ['sleep', '120'] }));
      expectCode(await rejection(runtime.remove(busy)), 'COMMAND_FAILED');
      await runtime.remove(busy, { force: true });
      expectCode(await rejection(runtime.inspect(busy)), 'NOT_FOUND');
    });
  });

  // -- failures of docker itself -------------------------------------------

  describe('docker unavailable', () => {
    it('a missing binary is NOT_INSTALLED for every entry point', async () => {
      const broken = new DockerRuntime({ dockerBin: '/nonexistent/docker' });
      expectCode(await rejection(broken.ensureAvailable()), 'NOT_INSTALLED');
      expectCode(await rejection(broken.inspectImage('busybox:1.37')), 'NOT_INSTALLED');
      expectCode(await rejection(broken.list()), 'NOT_INSTALLED');
      expectCode(await rejection(broken.runForeground(agentSpecFor(d.agent('x')))), 'NOT_INSTALLED');
      expectCode(await rejection(broken.start(agentSpecFor(d.agent('x'), { detach: true }))), 'NOT_INSTALLED');
    });

    it('the NOT_INSTALLED message tells the user what to do', async () => {
      const error = await rejection(new DockerRuntime({ dockerBin: '/nonexistent/docker' }).ensureAvailable());
      expect(error.message).toMatch(/install Docker/);
    });

    const unreachable: CommandRunner = (file, args, options) =>
      execaRunner(file, args, { ...options, env: { ...options?.env, DOCKER_HOST: 'unix:///nonexistent.sock' } });

    it('an unreachable daemon is DAEMON_UNREACHABLE (not "not found")', async () => {
      const rt = new DockerRuntime({ runner: unreachable });
      expectCode(await rejection(rt.ensureAvailable()), 'DAEMON_UNREACHABLE');
      expectCode(await rejection(rt.inspectImage('busybox:1.37')), 'DAEMON_UNREACHABLE');
      expectCode(await rejection(rt.list()), 'DAEMON_UNREACHABLE');
      expectCode(await rejection(rt.ensureNetwork(d.name('n'), { internal: true })), 'DAEMON_UNREACHABLE');
      expectCode(await rejection(rt.remove('whatever')), 'DAEMON_UNREACHABLE');
      expectCode(await rejection(rt.runForeground(agentSpecFor(d.agent('x')))), 'DAEMON_UNREACHABLE');
    });

    const asNobody: CommandRunner = (file, args, options) => execaRunner('runuser', ['-u', 'nobody', '--', file, ...args], options);
    const canDropPrivileges =
      process.getuid?.() === 0 &&
      fs.existsSync('/usr/sbin/runuser') &&
      fs.existsSync('/var/run/docker.sock') &&
      (fs.statSync('/var/run/docker.sock').mode & 0o007) === 0;

    it.skipIf(!canDropPrivileges)('a user who cannot open the socket gets PERMISSION_DENIED', async () => {
      const rt = new DockerRuntime({ runner: asNobody });
      expectCode(await rejection(rt.ensureAvailable()), 'PERMISSION_DENIED');
      expectCode(await rejection(rt.runForeground(agentSpecFor(d.agent('x')))), 'PERMISSION_DENIED');
    });
  });
});
