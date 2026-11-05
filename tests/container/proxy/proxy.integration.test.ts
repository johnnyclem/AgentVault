/**
 * Credential proxy against a REAL Docker daemon.
 *
 * The sidecar is started exactly as the lifecycle will start it: the bundled
 * script in a bare node:22-slim container, read-only rootfs, all capabilities
 * dropped, non-root, config and secrets through a 0600 --env-file, on user-defined
 * networks next to a fake upstream and a client container.
 *
 * The fake upstream never returns a credential. It returns the SHA-256 of what it
 * received, so a test can prove the real key was injected (and the forged one
 * replaced) without the secret ever being in a client-visible response.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProxyScript } from '../../../src/container/proxy/bundle.js';
import { PROXY_ALIAS, PROXY_CONFIG_ENV, PROXY_PORT } from '../../../src/container/types.js';
import type { CredentialProxyConfig, ProxyRoute } from '../../../src/container/types.js';
import { dockerTestEnv, imagePresent } from '../helpers/docker.js';

const d = dockerTestEnv('avt-d-');
const NODE_IMAGE = 'node:22-slim';
const BUSYBOX_IMAGE = 'busybox:1.37';
const ready = d.available && imagePresent(NODE_IMAGE) && imagePresent(BUSYBOX_IMAGE);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Docker {
  status: number;
  stdout: string;
  stderr: string;
}
function docker(args: string[], timeoutMs = 60_000): Docker {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function mustDocker(args: string[], timeoutMs?: number): Docker {
  const r = docker(args, timeoutMs);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr.slice(0, 500)}`);
  return r;
}
async function waitForLog(container: string, needle: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  let logs = '';
  while (Date.now() < deadline) {
    const r = docker(['logs', container], 10_000);
    logs = r.stdout + r.stderr;
    if (logs.includes(needle)) return logs;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)} in logs of ${container}; last logs: ${logs.slice(-500)}`);
}
const allLogs = (container: string): string => {
  const r = docker(['logs', container], 10_000);
  return r.stdout + r.stderr;
};

/** Echoes SHA-256 hashes of credential headers, never the values. */
const FAKE_UPSTREAM = `
const http=require('http'),c=require('crypto');
const h=v=>v===undefined?null:c.createHash('sha256').update(String(v)).digest('hex');
http.createServer((q,r)=>{let n=0;q.on('data',b=>n+=b.length);q.on('end',()=>{
r.writeHead(200,{'content-type':'application/json'});
r.end(JSON.stringify({method:q.method,url:q.url,host:q.headers.host,names:Object.keys(q.headers).sort(),
sha:{'x-api-key':h(q.headers['x-api-key']),authorization:h(q.headers.authorization),cookie:h(q.headers.cookie),'x-forwarded-for':h(q.headers['x-forwarded-for'])},bytes:n}));});
}).listen(9000,()=>console.log('up-ready'));`;

/** Runs a list of HTTP requests against the proxy alias, or a list of raw TCP connects. */
const CLIENT = `
const http=require('http'),net=require('net');
if(process.env.MODE==='http'){
const reqs=JSON.parse(process.env.REQS);
const run=r=>new Promise(res=>{const body=r.body;
const q=http.request({host:'${PROXY_ALIAS}',port:${PROXY_PORT},method:r.method||'GET',path:r.path,agent:false,
headers:Object.assign({},r.headers,body!==undefined?{'content-length':Buffer.byteLength(body)}:{})},p=>{const b=[];p.on('data',x=>b.push(x));
p.on('end',()=>res({status:p.statusCode,headers:p.headers,body:Buffer.concat(b).toString()}));});
q.setTimeout(8000,()=>q.destroy());q.on('error',e=>res({error:e.code||String(e)}));q.end(body);});
(async()=>{const out=[];for(const r of reqs)out.push(await run(r));console.log(JSON.stringify({results:out,env:process.env}));})();
}else{
const targets=JSON.parse(process.env.TARGETS);
const one=t=>new Promise(res=>{const s=net.connect({host:t.host,port:t.port});s.setTimeout(3000);
s.on('connect',()=>{s.destroy();res('connected');});s.on('timeout',()=>{s.destroy();res('timeout');});s.on('error',e=>res(e.code||String(e)));});
(async()=>{const out={};for(const t of targets)out[t.host+':'+t.port]=await one(t);console.log(JSON.stringify(out));})();
}`;

interface ClientResult {
  status?: number;
  error?: string;
  headers?: Record<string, string>;
  body?: string;
}

describe.skipIf(!ready)('credential proxy in real containers', () => {
  let script: string;
  let scratch: string;

  beforeAll(async () => {
    script = await loadProxyScript();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-d-int-'));
  }, 60_000);

  afterAll(() => {
    d.cleanup();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** A fake upstream container on `network`; returns its name. */
  function startUpstream(network: string): string {
    const name = d.name('up');
    mustDocker([
      'run', '-d', '--name', name, '--network', network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      NODE_IMAGE, 'node', '-e', FAKE_UPSTREAM,
    ]);
    return name;
  }

  /** Start the sidecar as the lifecycle does: --env-file (0600, removed after create), no secret on argv. */
  function startSidecar(network: string, routes: ProxyRoute[], secrets: Record<string, string>, extra: string[] = []): string {
    const name = d.name('sc');
    const config: CredentialProxyConfig = { version: 1, listenPort: PROXY_PORT, routes, maxBodyBytes: 1024 * 1024, upstreamTimeoutMs: 10_000 };
    const lines = [`${PROXY_CONFIG_ENV}=${JSON.stringify(config)}`];
    for (const [secret, value] of Object.entries(secrets)) lines.push(`AV_SECRET_${secret.toUpperCase().replace(/-/g, '_')}=${value}`);
    const envFile = path.join(scratch, `${name}.env`);
    fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    try {
      mustDocker([
        'run', '-d', '--name', name, '--network', network, '--network-alias', PROXY_ALIAS,
        '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', '1000:1000', '--pids-limit', '256', '--memory', '256m',
        '--env-file', envFile, ...extra,
        NODE_IMAGE, 'node', '--input-type=module', '-e', script,
      ]);
    } finally {
      fs.rmSync(envFile, { force: true });
    }
    return name;
  }

  function httpFromClient(network: string, requests: Array<{ method?: string; path: string; headers?: Record<string, string>; body?: string }>): { results: ClientResult[]; env: Record<string, string> } {
    const r = mustDocker([
      'run', '--rm', '--name', d.name('cl'), '--network', network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      '-e', 'MODE=http', '-e', `REQS=${JSON.stringify(requests)}`,
      NODE_IMAGE, 'node', '-e', CLIENT,
    ]);
    return JSON.parse(r.stdout.trim().split('\n').pop()!) as { results: ClientResult[]; env: Record<string, string> };
  }

  function connectsFromClient(network: string, targets: Array<{ host: string; port: number }>): Record<string, string> {
    const r = mustDocker([
      'run', '--rm', '--name', d.name('cl'), '--network', network,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      '-e', 'MODE=tcp', '-e', `TARGETS=${JSON.stringify(targets)}`,
      NODE_IMAGE, 'node', '-e', CLIENT,
    ]);
    return JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, string>;
  }

  const upstreamBody = (result: ClientResult): { url: string; host: string; names: string[]; sha: Record<string, string | null>; bytes: number } =>
    JSON.parse(result.body ?? '{}') as { url: string; host: string; names: string[]; sha: Record<string, string | null>; bytes: number };

  it('injects the real key, replaces forged credentials, and never exposes the secret (logs, responses, client env)', async () => {
    const REAL_A = `sk-real-a-${randomBytes(12).toString('hex')}`;
    const REAL_B = `sk-real-b-${randomBytes(12).toString('hex')}`;
    const CANARY = `CANARY-${randomBytes(8).toString('hex')}`;
    const net = d.name('net');
    mustDocker(['network', 'create', net]);
    const up = startUpstream(net);
    await waitForLog(up, 'up-ready');
    const sidecar = startSidecar(
      net,
      [
        { name: 'up', pathPrefix: '/up', upstream: `http://${up}:9000`, inject: [{ header: 'x-api-key', secret: 'up-key' }], allowInsecureUpstream: true },
        { name: 'bearer', pathPrefix: '/bearer', upstream: `http://${up}:9000/base`, inject: [{ header: 'authorization', secret: 'bearer-key', scheme: 'Bearer' }], allowInsecureUpstream: true },
      ],
      { 'up-key': REAL_A, 'bearer-key': REAL_B }
    );

    // 1. The lifecycle waits for this exact line.
    const first = await waitForLog(sidecar, '"event":"listening"');
    expect(first.trim().split('\n')[0]).toBe(`{"event":"listening","port":${PROXY_PORT}}`);

    const forged = { 'x-api-key': 'forged-key-111', authorization: 'Bearer forged-token-222', cookie: 'session=forged-333', 'x-forwarded-for': '6.6.6.6' };
    const { results, env } = httpFromClient(net, [
      { path: '/_agentvault/health' },
      { method: 'POST', path: `/up/v1/messages?beta=true&probe=${CANARY}`, headers: forged, body: `body-${CANARY}` },
      { path: '/bearer/v1/models', headers: forged },
      { path: '/unknown/x' },
      { path: '/up/../etc/passwd' },
      { path: '/up/%2e%2e/etc/passwd' },
      { path: 'http://evil.example/steal' },
    ]);
    const [health, injected, bearer, unknown, dotdot, encoded, absolute] = results as [ClientResult, ClientResult, ClientResult, ClientResult, ClientResult, ClientResult, ClientResult];

    expect(health.status).toBe(200);
    expect(health.body).toBe('{"ok":true}');

    // 2. Injection happened and the forged inbound credentials are gone.
    expect(injected.status).toBe(200);
    const sawUp = upstreamBody(injected);
    expect(sawUp.sha['x-api-key']).toBe(sha256(REAL_A));
    expect(sawUp.sha['x-api-key']).not.toBe(sha256('forged-key-111'));
    expect(sawUp.sha['authorization']).toBeNull();
    expect(sawUp.sha['cookie']).toBeNull();
    expect(sawUp.sha['x-forwarded-for']).toBeNull();
    expect(sawUp.url).toBe(`/v1/messages?beta=true&probe=${CANARY}`);
    expect(sawUp.host).toBe(`${up}:9000`);
    expect(sawUp.bytes).toBe(`body-${CANARY}`.length);

    // 3. A second route, a different secret, a scheme, and an upstream base path.
    expect(bearer.status).toBe(200);
    const sawBearer = upstreamBody(bearer);
    expect(sawBearer.url).toBe('/base/v1/models');
    expect(sawBearer.sha['authorization']).toBe(sha256(`Bearer ${REAL_B}`));
    expect(sawBearer.sha['x-api-key']).toBeNull();

    // 4. Not an open relay.
    expect(unknown.status).toBe(404);
    expect(dotdot.status).toBe(400);
    expect(encoded.status).toBe(400);
    expect(absolute.status).toBe(400);

    // 5. The secret is nowhere a client or an operator would look.
    const logs = allLogs(sidecar);
    expect(logs).toContain('"route":"up"');
    expect(logs).toContain('"path":"/up/v1/messages"');
    expect(logs).toContain('"route":"bearer"');
    for (const needle of [REAL_A, REAL_B, CANARY, 'forged-key-111', 'forged-token-222', 'forged-333']) {
      expect(logs, `sidecar logs leaked ${needle}`).not.toContain(needle);
    }
    const clientVisible = JSON.stringify(results);
    for (const needle of [REAL_A, REAL_B]) {
      expect(clientVisible).not.toContain(needle);
      expect(JSON.stringify(env)).not.toContain(needle);
    }

    // 6. Hardening flags really applied, and the process is non-root.
    const inspected = JSON.parse(mustDocker(['inspect', sidecar]).stdout) as Array<{ HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[] }; Config: { User: string; Cmd: string[] } }>;
    expect(inspected[0]!.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspected[0]!.HostConfig.CapDrop).toEqual(['ALL']);
    expect(inspected[0]!.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspected[0]!.Config.User).toBe('1000:1000');
    expect(inspected[0]!.Config.Cmd.join(' ')).not.toContain(REAL_A);

    // 7. `docker stop` (SIGTERM to PID 1) shuts down cleanly, quickly, with exit code 0.
    const started = Date.now();
    mustDocker(['stop', '-t', '10', sidecar]);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(mustDocker(['inspect', '-f', '{{.State.ExitCode}}', sidecar]).stdout.trim()).toBe('0');
  }, 180_000);

  it('fails closed inside a container when a secret is missing: exit 1, names only', async () => {
    const OTHER = `OTHER-CANARY-${randomBytes(8).toString('hex')}`;
    const net = d.name('net');
    mustDocker(['network', 'create', net]);
    const sidecar = startSidecar(
      net,
      [{ name: 'up', pathPrefix: '/up', upstream: 'http://upstream.invalid:9000', inject: [{ header: 'x-api-key', secret: 'up-key' }], allowInsecureUpstream: true }],
      { 'unrelated-key': OTHER }
    );
    const exit = mustDocker(['wait', sidecar], 30_000).stdout.trim();
    expect(exit).toBe('1');
    const logs = allLogs(sidecar);
    expect(logs).toContain('missing secret(s): up-key');
    expect(logs).not.toContain('"event":"listening"');
    expect(logs).not.toContain(OTHER);
  }, 90_000);

  it('topology: a client on an --internal network reaches only the sidecar, never the upstream or the internet', async () => {
    const REAL = `sk-real-${randomBytes(12).toString('hex')}`;
    const internal = d.name('int');
    const egress = d.name('egr');
    mustDocker(['network', 'create', '--internal', internal]);
    mustDocker(['network', 'create', egress]);
    const up = startUpstream(egress);
    await waitForLog(up, 'up-ready');
    // Sidecar starts on the egress side (where the upstream lives) and is then also attached to the agent's internal network.
    const sidecar = startSidecar(
      egress,
      [{ name: 'up', pathPrefix: '/up', upstream: `http://${up}:9000`, inject: [{ header: 'x-api-key', secret: 'up-key' }], allowInsecureUpstream: true }],
      { 'up-key': REAL }
    );
    mustDocker(['network', 'connect', '--alias', PROXY_ALIAS, internal, sidecar]);
    await waitForLog(sidecar, '"event":"listening"');
    const upstreamIp = mustDocker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${egress}").IPAddress}}`, up]).stdout.trim();
    expect(upstreamIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    // The client can use the proxy...
    const { results } = httpFromClient(internal, [{ path: '/up/v1/ping', headers: { 'x-api-key': 'forged' } }]);
    expect(results[0]!.status).toBe(200);
    expect(upstreamBody(results[0]!).sha['x-api-key']).toBe(sha256(REAL));

    // ...but has no other way out.
    const reach = connectsFromClient(internal, [
      { host: PROXY_ALIAS, port: PROXY_PORT },
      { host: up, port: 9000 },
      { host: upstreamIp, port: 9000 },
      { host: '1.1.1.1', port: 80 },
      { host: 'example.com', port: 80 },
    ]);
    expect(reach[`${PROXY_ALIAS}:${PROXY_PORT}`]).toBe('connected');
    expect(reach[`${up}:9000`], 'upstream resolvable or reachable by name from the internal network').not.toBe('connected');
    expect(reach[`${upstreamIp}:9000`], 'upstream reachable by IP from the internal network').not.toBe('connected');
    expect(reach['1.1.1.1:80'], 'internet reachable from the internal network').not.toBe('connected');
    expect(reach['example.com:80'], 'public DNS/internet usable from the internal network').not.toBe('connected');

    // Control: a client on the egress network CAN reach the upstream directly, so the results above are the topology's doing.
    const control = connectsFromClient(egress, [{ host: up, port: 9000 }]);
    expect(control[`${up}:9000`]).toBe('connected');

    expect(allLogs(sidecar)).not.toContain(REAL);
  }, 180_000);
});
