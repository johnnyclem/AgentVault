/**
 * Real-daemon tests for image packaging: build tiny agents, then inspect and
 * run the images. Skipped (not failed) when no Docker daemon is reachable.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerRuntime } from '../../src/container/docker.js';
import { MANIFEST_FILE, manifestToLabel, parseManifest } from '../../src/container/manifest.js';
import { packageContainer, type ContainerPackageResult } from '../../src/container/package-image.js';
import { ContainerError, LABEL_MANIFEST, LABEL_SOURCE_HASH } from '../../src/container/types.js';
import { dockerTestEnv } from './helpers/docker.js';

const d = dockerTestEnv('avt-b-');
const CANARY = 'sk-live-CANARY-integration-7f3a9c';

function docker(args: string[], timeoutMs = 120_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function dockerJson(args: string[]): unknown {
  const r = docker(args);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as unknown;
}

describe.skipIf(!d.available)('packageContainer against a real Docker daemon', () => {
  const runtime = new DockerRuntime();
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-b-int-'));
  });

  afterAll(() => {
    d.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function plantHazards(src: string): void {
    const put = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), content);
    };
    put('.env', `API_KEY=${CANARY}\n`);
    put('.env.local', `API_KEY=${CANARY}\n`);
    put('secret.pem', `-----BEGIN PRIVATE KEY-----\n${CANARY}\n`);
    put('id_rsa', CANARY);
    put('.npmrc', `//registry.npmjs.org/:_authToken=${CANARY}\n`);
    put('node_modules/planted/index.js', `module.exports = "${CANARY}"`);
    put('.git/config', CANARY);
    put('dist/bundle.js', CANARY);
    put('.agentvault/state.json', CANARY);
    fs.symlinkSync('/etc/passwd', path.join(src, 'link.txt'));
    fs.symlinkSync('/etc/hostname', path.join(src, 'escape.js'));
    fs.symlinkSync('/etc', path.join(src, 'etc-link'));
  }

  function makeNodeAgent(agent: string, lockfile: boolean): string {
    const src = path.join(root, agent);
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'ignored-by-agentvault', version: '1.2.3' }));
    if (lockfile) {
      fs.writeFileSync(
        path.join(src, 'package-lock.json'),
        JSON.stringify({
          name: 'ignored-by-agentvault',
          version: '1.2.3',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'ignored-by-agentvault', version: '1.2.3' } },
        })
      );
    }
    fs.writeFileSync(
      path.join(src, 'index.js'),
      'console.log(`hello from avt-b node uid=${process.getuid()} args=${JSON.stringify(process.argv.slice(2))}`);\n'
    );
    plantHazards(src);
    return src;
  }

  function expectHardenedImage(r: ContainerPackageResult): void {
    // 1. The label inside the image is exactly the manifest written to disk.
    const labels = dockerJson(['image', 'inspect', '--format={{json .Config.Labels}}', r.imageTag]) as Record<string, string>;
    const onDisk = fs.readFileSync(r.manifestPath, 'utf8');
    expect(JSON.parse(labels[LABEL_MANIFEST] as string)).toEqual(JSON.parse(onDisk));
    expect(labels[LABEL_MANIFEST]).toBe(manifestToLabel(parseManifest(onDisk)));
    expect(labels[LABEL_SOURCE_HASH]).toBe(r.manifest.source.contentHash);
    expect(labels['agentvault.base']).toBe(r.manifest.runtime === 'node' ? 'node:22-slim' : 'python:3.12-slim');

    // 2. The image's resolved user is the non-root 10001:10001.
    expect(docker(['image', 'inspect', '--format={{.Config.User}}', r.imageTag]).stdout.trim()).toBe('10001:10001');

    // 3. /app has no secrets, no VCS data and no symlinks.
    const listing = docker(['run', '--rm', '--entrypoint', 'ls', r.imageTag, '-la', '/app']);
    expect(listing.status, listing.stderr).toBe(0);
    const lines = listing.stdout.split('\n').filter(Boolean);
    expect(lines.some((l) => /(^|\s)\.env(\.\w+)?$/.test(l))).toBe(false);
    expect(listing.stdout).not.toMatch(/secret\.pem|id_rsa|\.npmrc|\.git\b|link\.txt|escape\.js|etc-link|bundle\.js/);
    expect(lines.filter((l) => l.startsWith('l'))).toEqual([]);

    // 4. The canary is nowhere in the filesystem the agent can see...
    const grep = docker(['run', '--rm', '--entrypoint', 'grep', r.imageTag, '-rl', 'sk-live-CANARY', '/app', '/home/agent']);
    expect(grep.status).toBe(1);
    expect(grep.stdout).toBe('');

    // ...nor in the image history.
    const history = docker(['history', '--no-trunc', r.imageTag]);
    expect(history.status).toBe(0);
    expect(history.stdout).not.toContain('sk-live');
    expect(history.stdout).not.toContain('CANARY');
    expect(fs.readFileSync(r.dockerfilePath, 'utf8')).not.toContain('CANARY');
    expect(fs.readFileSync(r.manifestPath, 'utf8')).not.toContain('CANARY');
  }

  it(
    'packages a dependency-free node agent (npm ci), runs it, and the image is locked down',
    async () => {
      const agent = d.agent('node');
      const src = makeNodeAgent(agent, true);
      const awkward = '--greeting=$HOME ${X} $(id) `x` "q" \\z é';
      const warnings: string[] = [];
      const r = await packageContainer({
        sourceDir: src,
        runtime,
        entrypoint: ['node', 'index.js', awkward],
        volumes: ['/data', '/memory'],
        env: ['MODEL'],
        secrets: ['anthropic'],
        healthUrl: 'http://localhost:8080/health',
        onWarning: (m) => warnings.push(m),
      });

      expect(r.imageTag).toBe(`agentvault/${agent}:1.2.3`);
      expect(r.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(r.manifest).toMatchObject({
        name: agent,
        version: '1.2.3',
        runtime: 'node',
        entrypoint: ['node', 'index.js', awkward],
        volumes: ['/data', '/memory'],
        env: ['MODEL'],
        secrets: ['anthropic'],
        isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true },
      });
      expect(fs.existsSync(path.join(r.outputDir, MANIFEST_FILE))).toBe(true);
      expect(warnings.join('\n')).toMatch(/symbolic link/);

      const info = await runtime.inspectImage(r.imageTag);
      expect(info?.user).toBe('10001:10001');
      expect(info?.labels[LABEL_MANIFEST]).toBeDefined();

      expectHardenedImage(r);

      // Exec form: the awkward argument reaches the program untouched (no shell, no expansion).
      const run = docker(['run', '--rm', r.imageTag]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe(`hello from avt-b node uid=10001 args=${JSON.stringify([awkward])}`);

      // It also runs under the full lockdown the lifecycle applies.
      const locked = docker(['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--tmpfs=/tmp', r.imageTag]);
      expect(locked.status, locked.stderr).toBe(0);
      expect(locked.stdout).toContain('uid=10001');

      // Volume paths and home exist and belong to the agent user.
      const owners = docker(['run', '--rm', '--entrypoint', 'stat', r.imageTag, '-c', '%u:%g %n', '/data', '/memory', '/home/agent']);
      expect(owners.stdout.trim().split('\n')).toEqual(['10001:10001 /data', '10001:10001 /memory', '10001:10001 /home/agent']);

      // /app is not writable by the agent (code is root-owned).
      const writable = docker(['run', '--rm', '--entrypoint', 'sh', r.imageTag, '-c', 'touch /app/pwned 2>&1; echo rc=$?']);
      expect(writable.stdout).toMatch(/rc=1/);

      // HEALTHCHECK came from the manifest.
      const health = dockerJson(['image', 'inspect', '--format={{json .Config.Healthcheck}}', r.imageTag]) as { Test: string[]; Interval: number };
      expect(health.Test.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
      expect(health.Test.join(' ')).toContain('http://localhost:8080/health');
      expect(health.Interval).toBe(30_000_000_000);
    },
    300_000
  );

  it(
    'packages a node agent without a lockfile (npm install) and runs it with defaults',
    async () => {
      const agent = d.agent('nolock');
      const src = makeNodeAgent(agent, false);
      const r = await packageContainer({ sourceDir: src, runtime });
      expect(r.warnings.join('\n')).toMatch(/not reproducible/);
      expect(r.manifest.isolation.network).toBe('none');
      expectHardenedImage(r);
      const run = docker(['run', '--rm', r.imageTag]);
      expect(run.stdout.trim()).toBe('hello from avt-b node uid=10001 args=[]');
    },
    300_000
  );

  it(
    'packages a python agent (pip -r), runs it, and the image is locked down',
    async () => {
      const agent = d.agent('py');
      const src = path.join(root, agent);
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'requirements.txt'), '# no dependencies\n');
      fs.writeFileSync(path.join(src, 'main.py'), 'import os, sys\nprint(f"hello from avt-b python uid={os.getuid()} argv={sys.argv[1:]}")\n');
      fs.writeFileSync(path.join(src, 'agent.json'), JSON.stringify({ name: agent, version: '0.3.0' }));
      plantHazards(src);

      const r = await packageContainer({ sourceDir: src, runtime, healthUrl: 'http://127.0.0.1:9000/' });
      expect(r.manifest).toMatchObject({ runtime: 'python', entrypoint: ['python', 'main.py'], version: '0.3.0' });
      expect(r.imageTag).toBe(`agentvault/${agent}:0.3.0`);
      expectHardenedImage(r);

      const run = docker(['run', '--rm', r.imageTag]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('hello from avt-b python uid=10001 argv=[]');

      const locked = docker(['run', '--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', r.imageTag]);
      expect(locked.status, locked.stderr).toBe(0);

      // The curl-free python healthcheck really executes (and fails: nothing listens on 9000).
      const check = dockerJson(['image', 'inspect', '--format={{json .Config.Healthcheck.Test}}', r.imageTag]) as string[];
      expect(check.slice(0, 3)).toEqual(['CMD', 'python', '-c']);
      const exec = docker(['run', '--rm', '--entrypoint', check[2] as string, r.imageTag, ...check.slice(3)]);
      expect(exec.status).not.toBe(0);
    },
    300_000
  );

  it(
    'a healthcheck against a live server passes with the generated no-curl check',
    async () => {
      const agent = d.agent('hc');
      const src = path.join(root, agent);
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      fs.writeFileSync(
        path.join(src, 'index.js'),
        "require('node:http').createServer((q, s) => { s.statusCode = q.url === '/health' ? 200 : 404; s.end('ok'); }).listen(8080, '127.0.0.1');\n"
      );
      const r = await packageContainer({ sourceDir: src, runtime, healthUrl: 'http://127.0.0.1:8080/health' });
      const name = d.name('hc');
      const started = docker(['run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--network=none', r.imageTag]);
      expect(started.status, started.stderr).toBe(0);
      try {
        const test = dockerJson(['image', 'inspect', '--format={{json .Config.Healthcheck.Test}}', r.imageTag]) as string[];
        let status = 1;
        for (let i = 0; i < 20 && status !== 0; i++) {
          status = docker(['exec', name, ...test.slice(1)]).status;
          if (status !== 0) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(status).toBe(0);
        // The same check against a path that 404s must fail.
        const bad = docker(['exec', name, 'node', '-e', (test[3] as string).replace('/health', '/missing')]);
        expect(bad.status).not.toBe(0);
      } finally {
        docker(['rm', '-f', name]);
      }
    },
    300_000
  );

  it(
    'a failing build rejects with a ContainerError, leaves the generated files and tags nothing',
    async () => {
      const agent = d.agent('fail');
      const src = makeNodeAgent(agent, true);
      let caught: unknown;
      try {
        await packageContainer({ sourceDir: src, runtime, base: 'avt-b-no-such-base-image:0' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ContainerError);
      expect(docker(['image', 'inspect', `agentvault/${agent}:1.2.3`]).status).not.toBe(0);
      expect(fs.existsSync(path.join(src, 'dist', 'container', 'Dockerfile'))).toBe(true);
    },
    300_000
  );

  it(
    'rebuilding the same source gives the same content hash and Dockerfile',
    async () => {
      const agent = d.agent('same');
      const src = makeNodeAgent(agent, true);
      const a = await packageContainer({ sourceDir: src, runtime, build: false, outputDir: path.join(root, 'same-a') });
      const b = await packageContainer({ sourceDir: src, runtime, build: false, outputDir: path.join(root, 'same-b') });
      expect(a.manifest.source.contentHash).toBe(b.manifest.source.contentHash);
      expect(fs.readFileSync(a.dockerfilePath, 'utf8')).toBe(fs.readFileSync(b.dockerfilePath, 'utf8'));
    },
    60_000
  );
});
