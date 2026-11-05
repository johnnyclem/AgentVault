/**
 * The bundled script as a real process: exit codes, the single `listening` line,
 * the stdout contract, signals, and TLS verification of the upstream. Each child
 * runs with a scrubbed environment (see spawnSidecar).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadProxyScript } from '../../../src/container/proxy/bundle.js';
import { PROXY_CONFIG_ENV } from '../../../src/container/types.js';
import type { ProxyRoute } from '../../../src/container/types.js';
import { deferred, send, sleep, spawnSidecar, startUpstream, waitUntil, within } from './harness.js';
import type { FakeUpstream, SidecarProcess } from './harness.js';

// Timing-based tests have generous budgets so a loaded CI machine does not flake them.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

const REAL = 'sk-proc-REAL-0123456789';
let script: string;
beforeAll(async () => {
  script = await loadProxyScript();
});

const children: SidecarProcess[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const close of closers.splice(0)) await close();
});

function configEnv(routes: ProxyRoute[], port = 0, secrets: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    [PROXY_CONFIG_ENV]: JSON.stringify({ version: 1, listenPort: port, routes, maxBodyBytes: 1024 * 1024, upstreamTimeoutMs: 5000 }),
  };
  for (const [name, value] of Object.entries(secrets)) env[`AV_SECRET_${name.toUpperCase().replace(/-/g, '_')}`] = value;
  return env;
}

function start(env: Record<string, string>): SidecarProcess {
  const child = spawnSidecar(script, env);
  children.push(child);
  return child;
}

async function fakeUpstream(...args: Parameters<typeof startUpstream>): Promise<FakeUpstream> {
  const up = await startUpstream(...args);
  closers.push(up.close);
  return up;
}

const injectingRoute = (up: FakeUpstream): ProxyRoute => ({
  name: 'svc',
  pathPrefix: '/svc',
  upstream: up.url,
  inject: [{ header: 'x-api-key', secret: 'svc-key' }],
  allowInsecureUpstream: true,
});

describe('startup', () => {
  it('fails closed with exit code 1, naming only the missing secret, and prints nothing on stdout', async () => {
    const up = await fakeUpstream();
    const env = configEnv([injectingRoute(up)]);
    env['AV_SECRET_UNRELATED'] = 'UNRELATED-CANARY-VALUE';
    const child = start(env);
    const { code } = await child.exited;
    expect(code).toBe(1);
    expect(child.stderr()).toContain('missing secret(s): svc-key');
    expect(child.stderr()).toContain('AV_SECRET_SVC_KEY');
    expect(child.stderr()).not.toContain('CANARY');
    expect(child.lines).toEqual([]);
  });

  it('treats an empty secret value as missing', async () => {
    const up = await fakeUpstream();
    const child = start({ ...configEnv([injectingRoute(up)]), AV_SECRET_SVC_KEY: '' });
    expect((await child.exited).code).toBe(1);
    expect(child.lines).toEqual([]);
  });

  it.each([
    ['no config at all', {}],
    ['config that is not JSON', { [PROXY_CONFIG_ENV]: '{nope CANARY' }],
    ['config with a bad version', { [PROXY_CONFIG_ENV]: '{"version":9}' }],
  ])('exits 1 for %s, without echoing the input', async (_label, env) => {
    const child = start(env);
    expect((await child.exited).code).toBe(1);
    expect(child.stderr()).toContain('agentvault-proxy:');
    expect(child.stderr()).not.toContain('CANARY');
    expect(child.lines).toEqual([]);
  });

  it('exits 1 when the port is already taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    closers.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const child = start(configEnv([], (blocker.address() as AddressInfo).port));
    expect((await child.exited).code).toBe(1);
    expect(child.stderr()).toContain('EADDRINUSE');
    expect(child.lines).toEqual([]);
  });

  it('prints exactly one listening line, as the first stdout line, and never repeats it', async () => {
    const up = await fakeUpstream();
    const child = start(configEnv([injectingRoute(up)], 0, { 'svc-key': REAL }));
    const port = await child.listening();
    await send({ port, path: '/svc/a' });
    await send({ port, path: '/nope' });
    await waitUntil(() => child.lines.length >= 3, 3_000, 'audit lines');
    expect(child.lines[0]).toBe(`{"event":"listening","port":${port}}`);
    expect(child.lines.filter((l) => l.includes('"listening"'))).toHaveLength(1);
  });
});

describe('stdout contract and secret hygiene (real process)', () => {
  it('every stdout line is one JSON object, and neither the real key nor a canary ever appears', async () => {
    const CANARY = 'CANARY-process-91b2c4';
    const up = await fakeUpstream();
    const child = start(configEnv([injectingRoute(up)], 0, { 'svc-key': REAL }));
    const port = await child.listening();

    const replies = [
      await send({ port, method: 'POST', path: `/svc/v1/x?api_key=${CANARY}`, body: CANARY, headers: { authorization: `Bearer ${CANARY}`, 'x-api-key': CANARY, cookie: CANARY } }),
      await send({ port, path: `/unknown?k=${CANARY}`, headers: { 'x-canary': CANARY } }),
      await send({ port, path: `/svc/%2e%2e/x?k=${CANARY}` }),
    ];
    await waitUntil(() => child.lines.length === 4, 3_000, 'four stdout lines');

    expect(replies.map((r) => r.status)).toEqual([200, 404, 400]);
    expect(up.requests[0]!.headers['x-api-key']).toBe(REAL);
    const entries = child.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((e) => e['event'])).toEqual(['listening', 'request', 'request', 'request']);
    const stdout = child.lines.join('\n');
    expect(stdout).not.toContain(REAL);
    expect(stdout).not.toContain(CANARY);
    expect(child.stderr()).not.toContain(REAL);
    expect(replies.map((r) => r.text + r.rawHeaders.join('\n')).join('\n')).not.toContain(REAL);
    expect(entries[1]).toMatchObject({ route: 'svc', method: 'POST', path: '/svc/v1/x', status: 200, bytesIn: CANARY.length });
    expect(entries[2]).toMatchObject({ route: null, path: '/unknown', status: 404 });
  });
});

describe('signals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s exits 0 promptly, even with an idle keep-alive connection open', async (signal) => {
    const child = start(configEnv([]));
    const port = await child.listening();
    const idle = net.connect(port, '127.0.0.1');
    idle.on('error', () => undefined);
    idle.resume();
    idle.write('GET /_agentvault/health HTTP/1.1\r\nHost: x\r\n\r\n');
    await sleep(100);
    const started = Date.now();
    child.kill(signal);
    const { code } = await within(child.exited, 4_000, `${signal} did not stop the sidecar`);
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    idle.destroy();
  });

  it('SIGTERM lets an in-flight stream finish before exiting', async () => {
    const secondChunkReleased = deferred();
    const up = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      await secondChunkReleased.promise;
      res.write('data: two\n\n');
      res.end();
    });
    const child = start(configEnv([{ name: 'svc', pathPrefix: '/svc', upstream: up.url, inject: [], allowInsecureUpstream: true }]));
    const port = await child.listening();
    const body = send({ port, path: '/svc/stream' });
    await waitUntil(() => up.requests.length === 1, 3_000, 'request to reach the upstream');
    await sleep(50);
    child.kill('SIGTERM');
    await sleep(150);
    expect(child.child.exitCode).toBeNull(); // still draining
    secondChunkReleased.resolve();
    expect((await body).text).toBe('data: one\n\ndata: two\n\n');
    expect((await within(child.exited, 4_000, 'exit after drain')).code).toBe(0);
  });
});

// A throwaway self-signed certificate for 127.0.0.1, trusted only via NODE_EXTRA_CA_CERTS.
const openssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!openssl)('TLS to the upstream is verified, never skipped', () => {
  let dir: string;
  let certPath: string;
  let tlsServer: https.Server;
  let tlsPort: number;
  const tlsRequests: Array<{ headers: Record<string, string | string[] | undefined>; encrypted: boolean }> = [];
  let handshakeFailures = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-d-tls-'));
    certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'pipe' });
    tlsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
      tlsRequests.push({ headers: req.headers, encrypted: (req.socket as unknown as { encrypted?: boolean }).encrypted === true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"tls":true}');
    });
    tlsServer.on('tlsClientError', () => {
      handshakeFailures++;
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      tlsServer.close(() => resolve());
      tlsServer.closeAllConnections();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tlsRoute = (): ProxyRoute => ({ name: 'tls', pathPrefix: '/tls', upstream: `https://127.0.0.1:${tlsPort}`, inject: [{ header: 'x-api-key', secret: 'tls-key' }] });

  it('forwards over TLS and injects the key when the upstream certificate is trusted', async () => {
    tlsRequests.length = 0;
    const child = start({ ...configEnv([tlsRoute()], 0, { 'tls-key': REAL }), NODE_EXTRA_CA_CERTS: certPath });
    const port = await child.listening();
    const reply = await send({ port, path: '/tls/v1/x', headers: { 'x-api-key': 'forged' } });
    expect(reply.status).toBe(200);
    expect(reply.text).toBe('{"tls":true}');
    expect(tlsRequests).toHaveLength(1);
    expect(tlsRequests[0]!.encrypted).toBe(true);
    expect(tlsRequests[0]!.headers['x-api-key']).toBe(REAL);
  });

  it('refuses an untrusted upstream certificate: 502, and the request never reaches the upstream', async () => {
    tlsRequests.length = 0;
    const failuresBefore = handshakeFailures;
    const child = start(configEnv([tlsRoute()], 0, { 'tls-key': REAL })); // no NODE_EXTRA_CA_CERTS
    const port = await child.listening();
    const reply = await send({ port, path: '/tls/v1/x' });
    expect(reply.status).toBe(502);
    expect(reply.text).toBe('{"error":"bad_gateway"}');
    expect(reply.text).not.toMatch(/certificate|self.signed|UNABLE_TO|DEPTH/i);
    await sleep(100);
    expect(tlsRequests).toHaveLength(0);
    expect(handshakeFailures).toBeGreaterThan(failuresBefore);
    expect(child.lines.join('\n')).not.toContain(REAL);
  });

  it('names the TLS failure by code in the audit line, so an operator can tell a CA problem from an outage', async () => {
    const child = start(configEnv([tlsRoute()], 0, { 'tls-key': REAL })); // untrusted: no NODE_EXTRA_CA_CERTS
    const port = await child.listening();
    const reply = await send({ port, path: '/tls/v1/x' });
    expect(reply.status).toBe(502);
    // The client still sees only the constant body; the diagnosis lives in the sidecar's own log.
    expect(reply.text).toBe('{"error":"bad_gateway"}');
    await waitUntil(() => child.lines.some((l) => l.includes('"event":"request"')), 3_000, 'audit line');
    const audit = child.lines
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { event?: string; status?: number; upstreamError?: string })
      .find((e) => e.event === 'request' && e.status === 502);
    expect(audit?.upstreamError).toMatch(/^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/);
    expect(child.lines.join('\n')).not.toContain(REAL);
  });
});
