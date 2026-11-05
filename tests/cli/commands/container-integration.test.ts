/**
 * The container commands against a REAL Docker daemon, driven the way a user
 * drives them: through createProgram() and command lines. Nothing about the
 * runtime is faked; only the terminal is (the passphrase source, the output
 * sinks, exit).
 *
 * Flow 1 (state): package a tiny node agent -> run -d -> ps -> exec/logs ->
 * inspect (env redacted) -> stop -> snapshot (encrypted) -> verify -> restore
 * into a second agent -> run that agent and read the first agent's data back ->
 * rm (volumes kept) -> rm --volumes.
 * Flow 2 (credentials): package an agent that declares the anthropic service ->
 * secrets add -> run -d with the REAL credential-proxy sidecar -> the agent has
 * the placeholder and never the key, the sidecar has the key -> stop -> rm.
 *
 * Skipped (not failed) when no daemon is reachable or busybox:1.37 / node:22-slim
 * are not already pulled. Every Docker resource is named through
 * dockerTestEnv('avt-k-').
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createProgram } from '../../../cli/index.js';
import type { ContainerCliDeps } from '../../../cli/commands/cli-support.js';
import { DockerRuntime } from '../../../src/container/docker.js';
import { containerManifestSchema, manifestToLabel } from '../../../src/container/manifest.js';
import { dockerTestEnv, imagePresent } from '../../container/helpers/docker.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const d = dockerTestEnv('avt-k-');
const usable = d.available && imagePresent('busybox:1.37') && imagePresent('node:22-slim');

const PASS = 'integration passphrase 0123';
const WRONG_PASS = 'another passphrase 4567';
const CANARY = 'sk-ant-CANARY-avtk-7c6a180b36896a0a8c02787eeafb0e4c';
const PLACEHOLDER = 'agentvault-proxy-placeholder';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

function docker(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, ...(input !== undefined ? { input } : {}) });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const dockerNames = (args: string[]): string[] => docker(args).stdout.split('\n').map((l) => l.trim()).filter(Boolean);

async function eventually<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const AGENT_SOURCE = [
  "const fs = require('fs');",
  "const file = '/data/state.txt';",
  "const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';",
  "fs.writeFileSync(file, previous + 'run:' + (process.env.GREETING || '-') + '\\n');",
  "console.log('agent-ready lines=' + (previous === '' ? 0 : previous.trim().split('\\n').length));",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

describe.skipIf(!usable)('container commands against a real daemon', () => {
  let scratch: string;
  let home: string;
  let passphrase = PASS;
  let stdout: string[] = [];
  let stderr: string[] = [];
  let consoleOut: string[] = [];

  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeAll(() => {
    logSpy = vi.spyOn(console, 'log');
    errorSpy = vi.spyOn(console, 'error');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-k-it-'));
    home = path.join(scratch, 'home');
    fs.mkdirSync(home);
  });

  beforeEach(() => {
    passphrase = PASS;
    stdout = [];
    stderr = [];
    consoleOut = [];
    logSpy.mockImplementation((...args: unknown[]) => {
      consoleOut.push(plain(args.map(String).join(' ')));
    });
    errorSpy.mockImplementation((...args: unknown[]) => {
      consoleOut.push(plain(args.map(String).join(' ')));
    });
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    d.cleanup();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** One command line, a fresh program, the real DockerRuntime. */
  async function cli(args: string[], extra: Partial<ContainerCliDeps> & { env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
    stdout = [];
    stderr = [];
    const { env, ...rest } = extra;
    const deps: ContainerCliDeps = {
      runtime: new DockerRuntime(),
      env: { AGENTVAULT_HOME: home, ...env },
      cwd: scratch,
      interactive: false,
      log: (line) => stdout.push(plain(line)),
      err: (line) => stderr.push(plain(line)),
      exit: (code) => {
        throw new ExitSignal(code);
      },
      getPassphrase: () => Promise.resolve(passphrase),
      installSignalHandler: () => () => undefined,
      ...rest,
    };
    let code = 0;
    try {
      await createProgram(deps).parseAsync(args, { from: 'user' });
    } catch (error) {
      if (error instanceof ExitSignal) code = error.code;
      else throw error;
    }
    return { code, out: stdout.join('\n'), err: stderr.join('\n') };
  }

  function agentDirectory(label: string, extraFiles: Record<string, string> = {}): { dir: string; name: string; tag: string } {
    const name = d.agent(label);
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), AGENT_SOURCE);
    for (const [file, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, file), content);
    return { dir, name, tag: `agentvault/${name}:0.0.1` };
  }

  // -------------------------------------------------------------------------
  // Flow 1: state
  // -------------------------------------------------------------------------

  describe('package, run, observe, stop, snapshot, restore, remove', () => {
    let first: { dir: string; name: string; tag: string };
    let second: string;
    let snapshotDir: string;

    beforeAll(() => {
      first = agentDirectory('one');
      second = d.agent('two');
    });

    it('package <dir> --target container builds an image and leaves the WASM machinery alone', async () => {
      await createProgram().parseAsync(['package', first.dir, '--target', 'container'], { from: 'user' });
      const printed = consoleOut.join('\n');
      expect(printed).toContain(`Packaged agent ${first.name} as container image ${first.tag}`);
      expect(printed).not.toContain('icp.yaml');
      expect(printed).not.toContain('WASM');

      const image = docker(['image', 'inspect', '--format', '{{.Config.User}}', first.tag]);
      expect(image.status).toBe(0);
      expect(image.stdout.trim()).toBe('10001:10001');
      expect(fs.existsSync(path.join(first.dir, 'dist', 'container', 'agentvault-image.json'))).toBe(true);
      expect(fs.existsSync(path.join(first.dir, 'icp.yaml'))).toBe(false);
    });

    it('run <dir> -d starts a locked-down container and ps lists it', async () => {
      const result = await cli(['run', first.dir, '-d', '--env', 'GREETING=hi']);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain(`Started agent ${first.name}`);

      const container = docker([
        'inspect',
        '--format',
        '{{.HostConfig.NetworkMode}}|{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.CapDrop}}|{{.State.Running}}',
        `av-${first.name}`,
      ]);
      expect(container.stdout.trim()).toBe('none|10001:10001|true|[ALL]|true');

      const ps = await cli(['ps']);
      expect(ps.out).toMatch(new RegExp(`${first.name}\\s+running\\s+${first.tag.replace(/[/.]/g, '\\$&')}\\s+no`));
      const json = await cli(['ps', '--json']);
      expect((JSON.parse(json.out) as Array<{ agent: string }>).map((r) => r.agent)).toContain(first.name);
    });

    it('exec and logs reach the running agent; inspect never shows an environment value', async () => {
      const written = await eventually('the agent to write its state', async () => {
        const r = await cli(['container', 'exec', first.name, '--', 'cat', '/data/state.txt']);
        return r.code === 0 && r.out.includes('run:hi') ? r.out : undefined;
      });
      expect(written).toBe('run:hi');

      const logs = await cli(['container', 'logs', first.name]);
      expect(logs.out).toContain('agent-ready lines=0');

      const inspect = await cli(['container', 'inspect', first.name]);
      expect(inspect.code).toBe(0);
      expect(inspect.out).toContain('"GREETING=<redacted>"');
      expect(inspect.out).not.toContain('GREETING=hi');

      const stats = await cli(['container', 'stats', first.name]);
      expect(stats.out).toContain(`av-${first.name}`);
    });

    it('a second run of a running agent is refused and changes nothing', async () => {
      const before = docker(['inspect', '--format', '{{.Id}}', `av-${first.name}`]).stdout.trim();
      const again = await cli(['run', first.dir, '-d']);
      expect(again.code).toBe(1);
      expect(again.err).toContain('already running');
      expect(docker(['inspect', '--format', '{{.Id}}', `av-${first.name}`]).stdout.trim()).toBe(before);
    });

    it('stop keeps the data and moves the agent to the --all listing', async () => {
      const stopped = await cli(['stop', first.name]);
      expect(stopped.code, stopped.err).toBe(0);
      expect(stopped.out).toContain(`Stopped av-${first.name}`);
      expect((await cli(['ps'])).out).not.toContain(first.name);
      expect((await cli(['ps', '--all'])).out).toMatch(new RegExp(`${first.name}\\s+exited`));
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}'])).toContain(`av-${first.name}-data`);
    });

    it('snapshot create without any way to get a passphrase fails and writes no snapshot', async () => {
      // No injected provider, no AGENTVAULT_SNAPSHOT_PASSPHRASE, no terminal: the real default provider.
      const refused = await cli(['snapshot', 'create', first.name], { getPassphrase: undefined });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('AGENTVAULT_SNAPSHOT_PASSPHRASE');
      expect(fs.existsSync(path.join(home, 'snapshots'))).toBe(false);
    });

    it('snapshot create encrypts the volume: the ciphertext does not contain the data', async () => {
      const created = await cli(['snapshot', 'create', first.name]);
      expect(created.code, created.err).toBe(0);
      expect(created.out).toContain('Encrypted: yes');
      expect(created.out).not.toContain(PASS);

      const listed = JSON.parse((await cli(['snapshot', 'list', '--json'])).out) as Array<{ dir: string; encrypted: boolean; agent: string }>;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ encrypted: true, agent: first.name });
      snapshotDir = listed[0]?.dir ?? '';

      const files = fs.readdirSync(snapshotDir).sort();
      expect(files).toEqual(['data.tar.enc', 'manifest.json']);
      expect(fs.readFileSync(path.join(snapshotDir, 'data.tar.enc')).includes('run:hi')).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'manifest.json'), 'utf8')) as { image: { ref: string } | null; volumes: Array<{ containerPath?: string }> };
      expect(manifest.image?.ref).toBe(first.tag);
      expect(manifest.volumes[0]?.containerPath).toBe('/data');
    });

    it('snapshot verify accepts it, and rejects it under the wrong passphrase', async () => {
      const ok = await cli(['snapshot', 'verify', snapshotDir]);
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out).toContain('is intact');
      // The decrypted spool is private and not left behind.
      expect(fs.statSync(path.join(home, 'tmp')).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.join(home, 'tmp'))).toEqual([]);

      passphrase = WRONG_PASS;
      const wrong = await cli(['snapshot', 'verify', snapshotDir]);
      expect(wrong.code).toBe(1);
      expect(wrong.err).toContain('wrong passphrase');
      expect(wrong.err).not.toContain(WRONG_PASS);
      expect(fs.readdirSync(path.join(home, 'tmp'))).toEqual([]);
    });

    it('snapshot restore under the wrong passphrase writes nothing', async () => {
      passphrase = WRONG_PASS;
      const wrong = await cli(['snapshot', 'restore', snapshotDir, '--to', second]);
      expect(wrong.code).toBe(1);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}'])).not.toContain(`av-${second}-data`);
    });

    it('snapshot restore --to <agent> recreates the volume, and the second agent reads the first one\'s data', async () => {
      const restored = await cli(['snapshot', 'restore', snapshotDir, '--to', second]);
      expect(restored.code, restored.err).toBe(0);
      expect(restored.out).toContain(`of ${second}`);
      expect(restored.out).toContain(`agentvault run ${first.tag} --name ${second} -d`);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}'])).toContain(`av-${second}-data`);

      const run = await cli(['run', first.tag, '-d', '--name', second]);
      expect(run.code, run.err).toBe(0);
      const content = await eventually('the second agent to append to the restored state', async () => {
        const r = await cli(['container', 'exec', second, '--', 'cat', '/data/state.txt']);
        return r.code === 0 && r.out.split('\n').length >= 2 ? r.out : undefined;
      });
      // First line: written by the first agent and carried over by the snapshot. Second: this agent's own start.
      expect(content.split('\n')).toEqual(['run:hi', 'run:-']);
      expect((await cli(['container', 'logs', second])).out).toContain('agent-ready lines=1');
    });

    it('restoring into a volume that holds data is refused with a message that names --force', async () => {
      const refused = await cli(['snapshot', 'restore', snapshotDir, '--to', second]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('--force');
      expect(refused.err).toContain(`av-${second}-data`);
    });

    it('snapshot --no-encrypt is explicit, warned about, and really is plaintext', async () => {
      const plainSnapshot = await cli(['snapshot', 'create', second, '--no-encrypt', '--output', path.join(scratch, 'plain-snapshots')]);
      expect(plainSnapshot.code, plainSnapshot.err).toBe(0);
      expect(plainSnapshot.err).toContain('will NOT be encrypted');
      const [entry] = fs.readdirSync(path.join(scratch, 'plain-snapshots'));
      const tar = fs.readFileSync(path.join(scratch, 'plain-snapshots', entry ?? '', 'data.tar'));
      expect(tar.includes('run:hi')).toBe(true);
    });

    it('rm without --volumes removes the containers and keeps the data; rm --volumes -y deletes it', async () => {
      const removed = await cli(['rm', first.name]);
      expect(removed.code, removed.err).toBe(0);
      expect(removed.out).toContain(`Removed av-${first.name}`);
      expect(removed.out).toContain('Kept volumes');
      expect(dockerNames(['ps', '-a', '--format', '{{.Names}}'])).not.toContain(`av-${first.name}`);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}'])).toContain(`av-${first.name}-data`);

      const wiped = await cli(['rm', first.name, '--volumes', '-y']);
      expect(wiped.code, wiped.err).toBe(0);
      expect(wiped.out).toContain(`Deleted volumes av-${first.name}-data`);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}'])).not.toContain(`av-${first.name}-data`);

      // The second agent is still running: rm stops it gracefully, then removes it and its data on request.
      const gone = await cli(['rm', second, '--volumes', '-y']);
      expect(gone.code, gone.err).toBe(0);
      expect(dockerNames(['ps', '-a', '--format', '{{.Names}}']).filter((n) => n.startsWith('av-avt-k-'))).toEqual([]);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}']).filter((n) => n.startsWith('av-avt-k-'))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Flow 2: credentials through the real sidecar
  // -------------------------------------------------------------------------

  describe('a declared credential travels only through the credential proxy', () => {
    let agent: { dir: string; name: string; tag: string };

    beforeAll(() => {
      agent = agentDirectory('cred');
    });

    it('package --secret anthropic declares the service in the image manifest', async () => {
      await createProgram().parseAsync(['package', agent.dir, '--target', 'container', '--secret', 'anthropic'], { from: 'user' });
      expect(consoleOut.join('\n')).toContain('anthropic (delivered by the credential proxy)');
      const label = docker(['image', 'inspect', '--format', '{{index .Config.Labels "agentvault.manifest"}}', agent.tag]).stdout;
      expect(JSON.parse(label)).toMatchObject({ secrets: ['anthropic'], isolation: { network: 'proxy' } });
    });

    it('run without the credential fails closed, naming it, before creating anything', async () => {
      const refused = await cli(['run', agent.dir, '-d', '--yes']);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('credentials that are not available: anthropic');
      expect(dockerNames(['ps', '-a', '--format', '{{.Names}}']).filter((n) => n.includes(agent.name))).toEqual([]);
      expect(dockerNames(['network', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
    });

    it('secrets add stores the key encrypted; secrets list shows the name and never the value', async () => {
      const added = await cli(['secrets', 'add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'], { env: { AGENTVAULT_HOME: home, ANTHROPIC_API_KEY: CANARY } });
      expect(added.code, added.err).toBe(0);
      expect(added.out + added.err).not.toContain(CANARY);
      const listed = await cli(['secrets', 'list']);
      expect(listed.out).toBe('anthropic');
      const raw = fs.readFileSync(path.join(home, 'secrets', 'store.avsec'));
      expect(raw.includes(CANARY)).toBe(false);
    });

    it('run -d starts the real sidecar; the agent holds the placeholder, the sidecar holds the key', async () => {
      const started = await cli(['run', agent.dir, '-d', '--yes']);
      expect(started.code, started.err).toBe(0);
      expect(started.out).toContain(`credential proxy: av-${agent.name}-proxy`);
      expect(started.out + started.err).not.toContain(CANARY);

      const agentEnv = await eventually('the agent environment', async () => {
        const r = await cli(['container', 'exec', agent.name, '--', 'env']);
        return r.code === 0 ? r.out : undefined;
      });
      expect(agentEnv).toContain(`ANTHROPIC_API_KEY=${PLACEHOLDER}`);
      expect(agentEnv).toContain('ANTHROPIC_BASE_URL=http://agentvault-proxy:8080/anthropic');
      expect(agentEnv).not.toContain(CANARY);
      expect(agentEnv).not.toContain('AV_SECRET');

      // Everything docker will show about the agent container, raw, is free of the key too.
      expect(docker(['inspect', `av-${agent.name}`]).stdout).not.toContain(CANARY);
      // `inspect` through the CLI is redacted on top of that.
      expect((await cli(['container', 'inspect', agent.name])).out).not.toContain(CANARY);

      // The sidecar is where the key lives (and nowhere on argv).
      const sidecarEnv = docker(['exec', `av-${agent.name}-proxy`, 'env']).stdout;
      expect(sidecarEnv).toContain(`AV_SECRET_ANTHROPIC=${CANARY}`);
      expect(docker(['inspect', '--format', '{{json .Config.Cmd}}', `av-${agent.name}-proxy`]).stdout).not.toContain(CANARY);

      // Two networks, both ours: the internal one for the agent, a dedicated one for the sidecar's way out.
      const networks = dockerNames(['network', 'ls', '--format', '{{.Name}}']);
      expect(networks).toContain(`av-${agent.name}-net`);
      expect(networks).toContain(`av-${agent.name}-egress`);
      expect(docker(['network', 'inspect', '--format', '{{.Internal}}', `av-${agent.name}-net`]).stdout.trim()).toBe('true');
    });

    it('ps shows the sidecar, stop stops both, rm removes both containers and both networks', async () => {
      expect((await cli(['ps'])).out).toMatch(new RegExp(`${agent.name}\\s+running\\s+\\S+\\s+yes`));

      const stopped = await cli(['stop', agent.name]);
      expect(stopped.out).toContain(`av-${agent.name}, av-${agent.name}-proxy`);

      const removed = await cli(['rm', agent.name, '--volumes', '-y']);
      expect(removed.code, removed.err).toBe(0);
      const names = dockerNames(['ps', '-a', '--format', '{{.Names}}']);
      expect(names.filter((n) => n.includes(agent.name))).toEqual([]);
      expect(dockerNames(['network', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Flow 3: `docker run -d` succeeds even when the entrypoint cannot start
  // -------------------------------------------------------------------------

  describe('a detached agent that dies at once is reported, not celebrated', () => {
    let node: { dir: string; name: string; tag: string };
    let python: { dir: string; name: string };

    beforeAll(async () => {
      node = agentDirectory('dies');
      await createProgram().parseAsync(['package', node.dir, '--target', 'container'], { from: 'user' });
      // A base image with no entrypoint wrapper: the node image's docker-entrypoint.sh turns an
      // unknown command into `node <command>` (exit 1), so only this one yields a true 127.
      const name = d.agent('py');
      const dir = path.join(scratch, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'main.py'), 'print("hello")\n');
      fs.writeFileSync(path.join(dir, 'requirements.txt'), '# no dependencies\n');
      python = { dir, name };
      await createProgram().parseAsync(['package', dir, '--target', 'container'], { from: 'user' });
    });

    it('a missing binary (exit 127) is called out, with a hint and where to read the output', async () => {
      const result = await cli(['run', python.dir, '-d', '--', 'definitely-not-a-binary']);
      expect(result.code, result.err).toBe(0); // like `docker run -d`, the exit status is the start's
      expect(result.out).toContain(`Started agent ${python.name}`);
      expect(result.err).toMatch(/exited immediately with code 127 \(command not found/);
      expect(result.err).toContain(`agentvault container logs ${python.name}`);
      // The container is kept so the advice is actionable.
      expect(dockerNames(['ps', '-a', '--format', '{{.Names}}'])).toContain(`av-${python.name}`);
      await cli(['rm', python.name, '--volumes', '-y']);
    });

    it('any other non-zero exit is reported with its code', async () => {
      const result = await cli(['run', node.dir, '-d', '--', 'node', '-e', 'process.exit(3)']);
      expect(result.code, result.err).toBe(0);
      expect(result.err).toMatch(/exited immediately with code 3\./);
      await cli(['rm', node.name, '--volumes', '-y']);
    });

    it('an agent that finishes successfully straight away is not a failure', async () => {
      const result = await cli(['run', node.dir, '-d', '--', 'node', '-e', '0']);
      expect(result.code, result.err).toBe(0);
      expect(result.err).not.toMatch(/exited immediately|crash-looping/);
    });

    it('a healthy long-running agent is not flagged', async () => {
      await cli(['rm', node.name, '--volumes', '-y']);
      const result = await cli(['run', node.dir, '-d', '--', 'node', '-e', 'setInterval(() => {}, 1000)']);
      expect(result.code, result.err).toBe(0);
      expect(result.err).not.toMatch(/exited immediately|crash-looping/);
      expect(docker(['inspect', '--format', '{{.State.Running}}', `av-${node.name}`]).stdout.trim()).toBe('true');
    });
  });

  // -------------------------------------------------------------------------
  // Flow 4: an image is a request, never a grant. The agentvault.manifest label is whatever its builder wrote.
  // These are the hand-built images an adversarial review used (verbatim in spirit) against the real CLI and daemon.
  // -------------------------------------------------------------------------

  describe('a hand-built image cannot grant itself anything', () => {
    const HOST_CANARY = 'ghp_HOST-CANARY-avtk-0f9c2b7e1a';

    function forgedImage(label: string, manifest: Record<string, unknown>): { name: string; tag: string } {
      const name = d.agent(label);
      const tag = `agentvault/${name}:evil`;
      const parsed = containerManifestSchema.parse({
        schemaVersion: 1,
        name,
        version: '1',
        runtime: 'node',
        entrypoint: ['node', '-e', 'setInterval(() => {}, 1000)'],
        volumes: ['/data'],
        env: [],
        secrets: [],
        isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
        source: { type: 'node', contentHash: 'a'.repeat(64) },
        ...manifest,
      });
      const dockerfile = `FROM node:22-slim\nRUN mkdir -p /data /home/agent && chown 10001:10001 /data /home/agent\nUSER 10001:10001\nCMD ["node","-e","setInterval(() => {}, 1000)"]\n`;
      const built = docker(['build', '-q', '-t', tag, '--label', `agentvault.manifest=${manifestToLabel(parsed)}`, '-'], dockerfile);
      expect(built.status, built.stderr).toBe(0);
      return { name, tag };
    }

    const containersOf = (name: string): string[] => dockerNames(['ps', '-a', '--format', '{{.Names}}']).filter((n) => n.startsWith(`av-${name}`));

    it('choosing the unrestricted bridge network is refused, and nothing is created', async () => {
      const evil = forgedImage('bridge', { env: ['GITHUB_TOKEN'], isolation: { network: 'bridge', user: '10001:10001', readOnlyRootfs: true } });
      const result = await cli(['run', evil.tag, '-d'], { env: { GITHUB_TOKEN: HOST_CANARY } });
      expect(result.code).toBe(1);
      expect(result.err).toContain('--network bridge');
      expect(containersOf(evil.name)).toEqual([]);
      expect(result.out + result.err).not.toContain(HOST_CANARY);
    });

    it('a variable the image names is NOT copied from the shell: the agent does not have it', async () => {
      const evil = forgedImage('env', { env: ['GITHUB_TOKEN'] });
      const result = await cli(['run', evil.tag, '-d'], { env: { GITHUB_TOKEN: HOST_CANARY } });
      expect(result.code, result.err).toBe(0);
      expect(result.err).toContain('This image reads GITHUB_TOKEN');
      expect(result.out + result.err).not.toContain(HOST_CANARY);
      const configured = docker(['inspect', '--format', '{{json .Config.Env}}', `av-${evil.name}`]).stdout;
      expect(configured).not.toContain(HOST_CANARY);
      expect(docker(['exec', `av-${evil.name}`, 'printenv', 'GITHUB_TOKEN']).status).not.toBe(0);
    });

    it('...but the user typing --env for it does hand it over', async () => {
      const evil = forgedImage('envyes', { env: ['GITHUB_TOKEN'] });
      const result = await cli(['run', evil.tag, '-d', '--env', 'GITHUB_TOKEN'], { env: { GITHUB_TOKEN: HOST_CANARY } });
      expect(result.code, result.err).toBe(0);
      expect(docker(['exec', `av-${evil.name}`, 'printenv', 'GITHUB_TOKEN']).stdout.trim()).toBe(HOST_CANARY);
    });

    it('asking for stored credentials is refused without approval: no sidecar, no network, the key never read', async () => {
      const evil = forgedImage('creds', { secrets: ['anthropic'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });
      const result = await cli(['run', evil.tag, '-d', '--secrets-from-env'], { env: { ANTHROPIC_API_KEY: CANARY } });
      expect(result.code).toBe(1);
      expect(result.err).toContain('anthropic');
      expect(result.err).toContain('--yes');
      expect(containersOf(evil.name)).toEqual([]);
      expect(dockerNames(['network', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(evil.name))).toEqual([]);
      expect(result.out + result.err).not.toContain(CANARY);
    });

    it('two (agent, volume) pairs that derive the same Docker volume cannot reach each other\'s data', async () => {
      // "avt-k" + key "own-xxxxxx-data" and "avt-k-own-xxxxxx" + key "data" are both av-avt-k-own-xxxxxx-data.
      const owner = forgedImage('own', {});
      expect((await cli(['run', owner.tag, '-d'])).code).toBe(0);
      expect(docker(['exec', `av-${owner.name}`, 'sh', '-c', 'echo PRECIOUS-DATA > /data/memory.db']).status).toBe(0);
      expect((await cli(['rm', owner.name])).code).toBe(0); // documented: rm keeps the data
      const volume = `av-${owner.name}-data`;

      const parts = owner.name.split('-');
      const collider = forgedImage('collide', { name: parts.slice(0, 2).join('-'), volumes: [`/${parts.slice(2).join('-')}-data`] });
      const result = await cli(['run', collider.tag, '-d']);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`"${owner.name}"`);
      expect(result.err).toMatch(/combine into the same Docker name/);

      // The owner's data is intact and still its own.
      const labels = docker(['volume', 'inspect', '--format', '{{json .Labels}}', volume]).stdout;
      expect(labels).toContain(`"agentvault.agent":"${owner.name}"`);
      const content = docker(['run', '--rm', '-v', `${volume}:/v:ro`, 'busybox:1.37', 'cat', '/v/memory.db']);
      expect(content.stdout.trim()).toBe('PRECIOUS-DATA');
    });

    it('a volume of that name made by hand (no AgentVault labels) is refused, and survives a failed start', async () => {
      const agent = forgedImage('handmade', {});
      const volume = `av-${agent.name}-data`;
      expect(docker(['volume', 'create', volume]).status).toBe(0);
      docker(['run', '--rm', '-v', `${volume}:/v`, 'busybox:1.37', 'sh', '-c', 'echo MINE > /v/keep.txt']);

      // Before the fix a later failure (here an out-of-range --cpus) made the rollback delete this volume.
      for (const extra of [[], ['--cpus', '1024']]) {
        const result = await cli(['run', agent.tag, '-d', ...extra]);
        expect(result.code).toBe(1);
        expect(result.err).toMatch(/not created by AgentVault/);
        expect(containersOf(agent.name)).toEqual([]);
      }
      expect(docker(['run', '--rm', '-v', `${volume}:/v:ro`, 'busybox:1.37', 'cat', '/v/keep.txt']).stdout.trim()).toBe('MINE');
    });

    it('a network that merely has our name is neither adopted by `run` nor deleted by `rm`', async () => {
      const agent = forgedImage('foreignnet', { secrets: ['anthropic'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });
      const network = `av-${agent.name}-net`;
      expect(docker(['network', 'create', '--internal', network]).status).toBe(0); // somebody else's: no AgentVault labels

      const refused = await cli(['run', agent.tag, '-d', '--yes', '--secrets-from-env'], { env: { ANTHROPIC_API_KEY: CANARY } });
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/not created by AgentVault/);
      expect(refused.out + refused.err).not.toContain(CANARY);
      expect(containersOf(agent.name)).toEqual([]); // no sidecar was left holding the key

      // `rm` derives the same name; it must leave a network it did not create alone.
      await cli(['rm', agent.name, '-y']);
      expect(docker(['network', 'inspect', '--format', '{{.Name}}', network]).stdout.trim()).toBe(network);
      docker(['network', 'rm', network]);
    });

    it('Ctrl-C during a detached proxy start rolls everything back: no sidecar, network, new volume or key file survives', async () => {
      // The real CLI in a child process, interrupted the way a terminal does (SIGINT to the whole process group).
      // The default signal action used to kill it mid-start and leave the sidecar holding the real key behind.
      const agent = forgedImage('intr', { secrets: ['anthropic'], isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true } });
      const tmp = fs.mkdtempSync(path.join(scratch, 'tmp-intr-'));
      const child = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['cli/index.ts', 'run', agent.tag, '-d', '--yes', '--secrets-from-env'], {
        cwd: process.cwd(),
        env: { ...process.env, AGENTVAULT_HOME: home, ANTHROPIC_API_KEY: CANARY, TMPDIR: tmp },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

      // The first resource of a proxy start is its internal network: interrupt as soon as it exists.
      await eventually('the start to begin', () => (dockerNames(['network', 'ls', '--format', '{{.Name}}']).includes(`av-${agent.name}-net`) ? true : undefined), 90_000);
      process.kill(-(child.pid as number), 'SIGINT');

      const code = await exited;
      expect(code, output).toBe(130);
      expect(output).toContain('Interrupted');
      expect(containersOf(agent.name)).toEqual([]);
      expect(dockerNames(['network', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
      expect(dockerNames(['volume', 'ls', '--format', '{{.Name}}']).filter((n) => n.includes(agent.name))).toEqual([]);
      expect(fs.readdirSync(tmp).filter((n) => n.startsWith('avt-env-'))).toEqual([]);
      expect(output).not.toContain(CANARY);
    });

    it('claiming another agent\'s name does not take over its stopped container and data', async () => {
      const victim = forgedImage('victim', {});
      expect((await cli(['run', victim.tag, '-d'])).code).toBe(0);
      expect(docker(['exec', `av-${victim.name}`, 'sh', '-c', 'echo VICTIM-DATA > /data/memory.db']).status).toBe(0);
      expect((await cli(['stop', victim.name])).code).toBe(0);

      // A different image (different repository) whose label claims the victim's name.
      const thief = forgedImage('thief', { name: victim.name });
      const result = await cli(['run', thief.tag, '-d']);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`--name ${victim.name}`);
      // Still the victim's container, still stopped, data untouched.
      expect(docker(['inspect', '--format', '{{.Config.Image}}', `av-${victim.name}`]).stdout.trim()).toBe(victim.tag);
      expect(docker(['inspect', '--format', '{{.State.Running}}', `av-${victim.name}`]).stdout.trim()).toBe('false');
    });
  });
});
