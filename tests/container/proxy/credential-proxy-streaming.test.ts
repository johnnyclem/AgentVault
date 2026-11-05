/**
 * Credential proxy: streaming, size and time limits, failure mapping, audit log
 * and server timeouts. Several tests are built so that a buffering or leaking
 * implementation deadlocks or fails instead of passing by luck.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVER_TIMEOUTS, createCredentialProxy } from '../../../src/container/proxy/credential-proxy.js';
import { deferred, rawExchange, rawRequest, route, send, sleep, startProxy, startUpstream, waitUntil, within } from './harness.js';
import type { FakeUpstream, ProxyHarness } from './harness.js';

// Timing-based tests have generous budgets so a loaded CI machine does not flake them.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function upstream(...args: Parameters<typeof startUpstream>): Promise<FakeUpstream> {
  const u = await startUpstream(...args);
  disposers.push(u.close);
  return u;
}
async function proxy(...args: Parameters<typeof startProxy>): Promise<ProxyHarness> {
  const p = await startProxy(...args);
  disposers.push(p.close);
  return p;
}

const REAL = 'sk-real-0123456789abcdef';
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe('streaming', () => {
  it('delivers the first SSE chunk BEFORE the upstream has finished', async () => {
    const clientSawFirst = deferred();
    const up = await upstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      // The upstream cannot finish until the client has the first chunk: a proxy that
      // buffers the response deadlocks here and the `within` below reports it.
      await clientSawFirst.promise;
      res.write('data: second\n\n');
      res.end();
    });
    const p = await proxy({ routes: [route('svc', up)] });

    const received: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: p.port, path: '/svc/v1/messages', agent: false }, (res) => {
        res.on('data', (chunk: Buffer) => {
          received.push(chunk.toString());
          if (received.join('').includes('first')) clientSawFirst.resolve();
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    await within(finished, 4_000, 'first SSE chunk was not delivered before the upstream finished (response is being buffered)');
    expect(received.join('')).toBe('data: first\n\ndata: second\n\n');
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('forwards the request body while the client is still sending it', async () => {
    const upstreamSawFirst = deferred();
    const up = await upstream((req, res) => {
      req.once('data', () => upstreamSawFirst.resolve());
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const p = await proxy({ routes: [route('svc', up)] });
    const done = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/svc/upload', agent: false, headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.write('part-one');
      // Part two is withheld until the UPSTREAM has seen part one.
      void within(upstreamSawFirst.promise, 3_000, 'upstream never saw the first request chunk (request body is being buffered)').then(
        () => req.end('part-two'),
        reject
      );
    });
    expect(await done).toBe(200);
    expect(up.requests[0]!.body.toString()).toBe('part-onepart-two');
  });

  it('moves 8 MiB each way intact', async () => {
    const download = randomBytes(8 * 1024 * 1024);
    const up = await upstream((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': download.length });
        res.end(download);
        return;
      }
      const hash = createHash('sha256');
      let n = 0;
      req.on('data', (c: Buffer) => {
        hash.update(c);
        n += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sha256: hash.digest('hex'), bytes: n }));
      });
    });
    const p = await proxy({ routes: [route('svc', up)], maxBodyBytes: 16 * 1024 * 1024 });

    const downloaded = await send({ port: p.port, path: '/svc/download', timeoutMs: 20_000 });
    expect(downloaded.body.length).toBe(download.length);
    expect(sha256(downloaded.body)).toBe(sha256(download));

    const upload = randomBytes(8 * 1024 * 1024);
    const uploaded = await send({ port: p.port, method: 'POST', path: '/svc/upload', body: upload, timeoutMs: 20_000 });
    expect(JSON.parse(uploaded.text)).toEqual({ sha256: sha256(upload), bytes: upload.length });
  }, 30_000);
});

describe('body size limit', () => {
  it('rejects a declared Content-Length over the limit with 413 and never contacts the upstream', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)], maxBodyBytes: 1024 });
    const r = await send({ port: p.port, method: 'POST', path: '/svc/x', body: Buffer.alloc(1025, 1) });
    expect(r.status).toBe(413);
    expect(r.text).toBe('{"error":"payload_too_large"}');
    expect(up.requests).toHaveLength(0);
  });

  it('accepts a body of exactly the limit', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)], maxBodyBytes: 1024 });
    const r = await send({ port: p.port, method: 'POST', path: '/svc/x', body: Buffer.alloc(1024, 1) });
    expect(r.status).toBe(200);
    expect(up.requests[0]!.bytes).toBe(1024);
  });

  it('enforces the limit WHILE STREAMING a chunked body, and aborts the upstream request', async () => {
    const upstreamClosed = deferred();
    const up = await upstream((req, res) => {
      res.on('close', () => upstreamClosed.resolve());
      req.resume();
    });
    const p = await proxy({ routes: [route('svc', up)], maxBodyBytes: 1024 });
    const status = await new Promise<number>((resolve, reject) => {
      let gotResponse = false;
      const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/svc/x', agent: false, headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        gotResponse = true;
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      // The proxy hangs up on us mid-upload: errors after the response are expected.
      req.on('error', (err) => {
        if (!gotResponse) reject(err);
      });
      void (async () => {
        for (let i = 0; i < 6; i++) {
          req.write(Buffer.alloc(600, 7));
          await sleep(40);
        }
        req.end();
      })();
    });
    expect(status).toBe(413);
    await within(upstreamClosed.promise, 3_000, 'upstream request was not aborted after the body limit was hit');
    expect(up.requests[0]!.bytes).toBeLessThanOrEqual(1024);
    expect(up.requests[0]!.ended).toBe(false);
    await waitUntil(() => p.logs.length === 1, 2_000, 'audit entry for the 413');
    expect(p.logs[0]!.status).toBe(413);
  });
});

describe('failure mapping', () => {
  it('answers 504 with a generic body when the upstream stays silent past upstreamTimeoutMs', async () => {
    const up = await upstream(() => undefined); // accepts, never answers
    const p = await proxy({ routes: [route('svc', up)], upstreamTimeoutMs: 200 });
    const started = Date.now();
    const r = await send({ port: p.port, path: '/svc/x' });
    expect(r.status).toBe(504);
    expect(r.text).toBe('{"error":"gateway_timeout"}');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('treats the timeout as an IDLE timeout: a slow but live stream is not cut off', async () => {
    const up = await upstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 6; i++) {
        res.write(`data: ${i}\n\n`);
        await sleep(100); // total ~600ms, but never idle for more than 100ms
      }
      res.end();
    });
    const p = await proxy({ routes: [route('svc', up)], upstreamTimeoutMs: 350 });
    const r = await send({ port: p.port, path: '/svc/stream' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\ndata: 5\n\n');
  });

  it('answers 502 with a generic body that leaks no hostname, address, port or node error text', async () => {
    const gone = await startUpstream();
    const port = gone.port;
    await gone.close();
    const p = await proxy({ routes: [route('svc', `http://127.0.0.1:${port}`)] });
    const r = await send({ port: p.port, path: '/svc/x' });
    expect(r.status).toBe(502);
    expect(r.text).toBe('{"error":"bad_gateway"}');
    for (const leak of ['ECONNREFUSED', 'ENOTFOUND', 'connect ECONN', 'getaddrinfo', '127.0.0.1', String(port), 'Error']) {
      expect(r.text + r.rawHeaders.join('\n')).not.toContain(leak);
    }
  });

  it('answers 502 for an unresolvable upstream host without echoing the host', async () => {
    const p = await proxy({ routes: [route('svc', 'http://no-such-host.invalid:81')] });
    const r = await send({ port: p.port, path: '/svc/x' });
    expect(r.status).toBe(502);
    expect(r.text).toBe('{"error":"bad_gateway"}');
  });

  it.each(['099 Low', '600 High', '100 Continue', '1000 Huge'])(
    'answers 502 for an upstream status line it cannot relay (%s) and keeps serving',
    async (statusLine) => {
      // A raw TCP "upstream": node's own http server would refuse to write these.
      const raw = net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () => socket.end(`HTTP/1.1 ${statusLine}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`));
      });
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      disposers.push(() => new Promise<void>((resolve) => raw.close(() => resolve())));
      const good = await upstream();
      const p = await proxy({ routes: [route('weird', `http://127.0.0.1:${(raw.address() as AddressInfo).port}`), route('good', good)] });
      const bad = await send({ port: p.port, path: '/weird/x' });
      expect(bad.status).toBe(502);
      expect(bad.text).toBe('{"error":"bad_gateway"}');
      // The sidecar survived and still serves other traffic.
      expect((await send({ port: p.port, path: '/good/x' })).status).toBe(200);
    }
  );

  it('ends the client response when the upstream dies mid-body (no hang, no fake success)', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.destroy(), 30);
    });
    const p = await proxy({ routes: [route('svc', up)] });
    await expect(send({ port: p.port, path: '/svc/x' })).rejects.toThrow();
  });

  it('cancels the upstream request when the client goes away mid-stream', async () => {
    const upstreamClosed = deferred();
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      res.on('close', () => upstreamClosed.resolve());
    });
    const p = await proxy({ routes: [route('svc', up)] });
    const req = http.get({ host: '127.0.0.1', port: p.port, path: '/svc/stream', agent: false }, (res) => {
      res.once('data', () => req.destroy());
    });
    req.on('error', () => undefined);
    await within(upstreamClosed.promise, 3_000, 'upstream was not cancelled after the client aborted');
  });

  it('cancels the upstream request when the client leaves before any response, and logs 499', async () => {
    const upstreamClosed = deferred();
    const up = await upstream((_req, res) => {
      res.on('close', () => upstreamClosed.resolve());
    });
    const p = await proxy({ routes: [route('svc', up)] });
    const req = http.get({ host: '127.0.0.1', port: p.port, path: '/svc/slow', agent: false });
    req.on('error', () => undefined);
    await waitUntil(() => up.requests.length === 1, 2_000, 'upstream to receive the request');
    req.destroy();
    await within(upstreamClosed.promise, 3_000, 'upstream was not cancelled after the client aborted');
    await waitUntil(() => p.logs.length === 1, 2_000, 'audit entry');
    expect(p.logs[0]!.status).toBe(499);
  });
});

describe('audit log', () => {
  it('writes exactly the documented fields, path only, with the injected clock', async () => {
    const up = await upstream();
    let t = 1_700_000_000_000;
    const p = await proxy({
      routes: [route('anthropic', up, [{ header: 'x-api-key', secret: 'anthropic' }])],
      secrets: { anthropic: REAL },
      now: () => (t += 7),
    });
    const r = await send({ port: p.port, method: 'POST', path: '/anthropic/v1/messages?beta=true&key=q-secret', body: 'hello world' });
    await waitUntil(() => p.logs.length === 1, 2_000, 'audit entry');
    const entry = p.logs[0]!;
    expect(Object.keys(entry).sort()).toEqual(['bytesIn', 'bytesOut', 'durationMs', 'event', 'method', 'path', 'route', 'status', 'ts']);
    expect(entry).toEqual({
      event: 'request',
      ts: new Date(1_700_000_000_007).toISOString(),
      route: 'anthropic',
      method: 'POST',
      path: '/anthropic/v1/messages',
      status: 200,
      durationMs: 7,
      bytesIn: 11,
      bytesOut: r.body.length,
    });
  });

  it('logs rejected and unrouted requests too, with route null and no query string', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({ port: p.port, path: '/nowhere?token=QUERY-SECRET' });
    await rawExchange(p.port, rawRequest('http://evil.example/x?token=QUERY-SECRET'));
    await waitUntil(() => p.logs.length === 2, 2_000, 'two audit entries');
    expect(p.logs.map((e) => [e.route, e.status, e.path])).toEqual([
      [null, 404, '/nowhere'],
      [null, 400, 'http://evil.example/x'],
    ]);
  });

  it('never lets a canary placed in headers, body or query reach a log line or any response', async () => {
    const CANARY = 'CANARY-7f3a9c1e5d';
    const up = await upstream();
    const p = await proxy({
      routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])],
      secrets: { s: REAL },
    });
    const replies = [
      await send({ port: p.port, method: 'POST', path: `/svc/v1/x?api_key=${CANARY}`, body: CANARY, headers: { authorization: `Bearer ${CANARY}`, 'x-api-key': CANARY, 'x-canary': CANARY, cookie: `s=${CANARY}` } }),
      await send({ port: p.port, path: `/missing?key=${CANARY}`, headers: { 'x-canary': CANARY } }),
      await send({ port: p.port, path: `/svc/..%2f?key=${CANARY}` }),
      await send({ port: p.port, method: 'TRACE', path: `/svc/x?key=${CANARY}`, headers: { 'x-canary': CANARY } }),
    ];
    p.secrets['s'] = undefined;
    replies.push(await send({ port: p.port, path: `/svc/x?key=${CANARY}`, headers: { 'x-canary': CANARY } }));
    await waitUntil(() => p.logs.length === replies.length, 2_000, 'audit entries');

    const everything = JSON.stringify(p.logs) + replies.map((r) => r.text + r.rawHeaders.join('\n')).join('\n');
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(REAL);
    expect(replies.map((r) => r.status)).toEqual([200, 404, 400, 405, 503]);
  });

  it('keeps serving when the audit sink throws', async () => {
    const up = await upstream();
    const server = createCredentialProxy({
      config: { version: 1, listenPort: 0, routes: [route('svc', up)], maxBodyBytes: 1024, upstreamTimeoutMs: 2_000 },
      secrets: {},
      log: () => {
        throw new Error('disk full');
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    disposers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const port = (server.address() as AddressInfo).port;
    expect((await send({ port, path: '/svc/a' })).status).toBe(200);
    expect((await send({ port, path: '/svc/b' })).status).toBe(200);
  });
});

describe('Expect: 100-continue handshake', () => {
  it('withholds the interim response until the request is accepted, then streams the body', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const socket = net.connect(p.port, '127.0.0.1');
    const seen: string[] = [];
    const gotContinue = deferred();
    const gotFinal = deferred();
    socket.on('data', (chunk: Buffer) => {
      seen.push(chunk.toString('latin1'));
      const all = seen.join('');
      if (all.includes('100 Continue')) gotContinue.resolve();
      if (all.includes('200 OK')) gotFinal.resolve();
    });
    socket.write('POST /svc/v1/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n');
    await within(gotContinue.promise, 3_000, 'no 100 Continue');
    expect(up.requests[0]?.ended ?? false).toBe(false);
    socket.write('hello');
    await within(gotFinal.promise, 3_000, 'no final response');
    socket.destroy();
    expect(up.requests[0]!.body.toString()).toBe('hello');
  });
});

describe('server timeouts (a stalled client cannot hold a socket forever)', () => {
  const FAST = { headersMs: 300, requestMs: 900, keepAliveMs: 600 };

  function closedWithin(socket: net.Socket, ms: number, message: string): Promise<number> {
    const started = Date.now();
    return within(
      new Promise<number>((resolve) => {
        socket.on('error', () => undefined);
        socket.on('close', () => resolve(Date.now() - started));
        // An unread socket never emits end/close: the 408 body would sit in its buffer.
        socket.resume();
      }),
      ms,
      message
    );
  }

  it('uses deliberate defaults rather than node defaults', () => {
    const server = createCredentialProxy({ config: { version: 1, listenPort: 0, routes: [], maxBodyBytes: 1, upstreamTimeoutMs: 1 }, secrets: {} });
    expect(server.headersTimeout).toBe(DEFAULT_SERVER_TIMEOUTS.headersMs);
    expect(server.requestTimeout).toBe(DEFAULT_SERVER_TIMEOUTS.requestMs);
    expect(server.keepAliveTimeout).toBe(DEFAULT_SERVER_TIMEOUTS.keepAliveMs);
    expect([server.headersTimeout, server.requestTimeout, server.keepAliveTimeout]).not.toEqual([60_000, 300_000, 5_000]);
  });

  it('closes a connection that never finishes its request headers', async () => {
    const p = await proxy({ routes: [], timeouts: FAST });
    const socket = net.connect(p.port, '127.0.0.1');
    socket.write('GET /_agentvault/health HTTP/1.1\r\nHost: x\r\nX-Slow: '); // headers never complete
    const ms = await closedWithin(socket, 4_000, 'connection with unfinished headers was never closed');
    expect(ms).toBeLessThan(4_000);
  });

  it('closes a connection that stalls mid-body, and cancels the upstream call', async () => {
    const upstreamClosed = deferred();
    const up = await upstream((_req, res) => {
      res.on('close', () => upstreamClosed.resolve());
    });
    const p = await proxy({ routes: [route('svc', up)], timeouts: FAST });
    const socket = net.connect(p.port, '127.0.0.1');
    socket.write('POST /svc/x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n0123456789'); // 90 bytes never come
    await closedWithin(socket, 5_000, 'connection stalled mid-body was never closed');
    await within(upstreamClosed.promise, 3_000, 'upstream call was not cancelled when the client stalled');
  });

  it('closes an idle keep-alive connection, but still reuses it inside the window', async () => {
    const p = await proxy({ routes: [], timeouts: FAST });
    const socket = net.connect(p.port, '127.0.0.1');
    let responses = 0;
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      responses = buffered.split('HTTP/1.1 200 OK').length - 1;
    });
    const health = 'GET /_agentvault/health HTTP/1.1\r\nHost: x\r\n\r\n';
    socket.write(health);
    await waitUntil(() => responses === 1, 2_000, 'first response');
    await sleep(150);
    socket.write(health);
    await waitUntil(() => responses === 2, 2_000, 'second response on the same connection');
    const ms = await closedWithin(socket, 4_000, 'idle keep-alive connection was never closed');
    expect(ms).toBeLessThan(4_000);
  });
});

describe('upstream connection pool', () => {
  it('reuses one upstream connection for back-to-back requests', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    for (let i = 0; i < 5; i++) expect((await send({ port: p.port, path: `/svc/${i}` })).status).toBe(200);
    expect(up.requests).toHaveLength(5);
    expect(up.connections.opened).toBe(1);
  });

  it('drops an idle upstream connection after upstreamIdleMs, so a stale socket is never reused', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)], timeouts: { upstreamIdleMs: 150 } });
    expect((await send({ port: p.port, path: '/svc/a' })).status).toBe(200);
    expect(up.connections.open).toBe(1);
    await waitUntil(() => up.connections.open === 0, 2_000, 'idle upstream socket to be closed by the proxy');
    expect((await send({ port: p.port, path: '/svc/b' })).status).toBe(200);
    expect(up.connections.opened).toBe(2);
  });

  it('has a default idle window below the 5s that node servers use', () => {
    expect(DEFAULT_SERVER_TIMEOUTS.upstreamIdleMs).toBeLessThan(5_000);
  });
});

describe('stdout contract of the default sink', () => {
  it('writes one JSON object per line to stdout when no sink is given', async () => {
    const up = await upstream();
    const server = createCredentialProxy({
      config: { version: 1, listenPort: 0, routes: [route('svc', up)], maxBodyBytes: 1024, upstreamTimeoutMs: 2_000 },
      secrets: {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    disposers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const port = (server.address() as AddressInfo).port;

    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await send({ port, path: '/svc/a?secret=q' });
      await waitUntil(() => written.some((w) => w.includes('"event":"request"')), 2_000, 'stdout audit line');
    } finally {
      process.stdout.write = original;
    }
    const line = written.find((w) => w.includes('"event":"request"'))!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ event: 'request', route: 'svc', method: 'GET', path: '/svc/a', status: 200 });
    expect(line).not.toContain('secret=q');
  });
});
