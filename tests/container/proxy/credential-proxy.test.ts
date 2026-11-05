/**
 * Credential proxy: injection, header hygiene, routing and the open-relay / SSRF
 * table. Everything runs against real loopback sockets (a recording fake upstream
 * and the proxy), so what is asserted is what a real client would observe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countHeader,
  rawExchange,
  rawRequest,
  route,
  send,
  startProxy,
  startUpstream,
  statusOf,
} from './harness.js';
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

describe('credential injection', () => {
  it('writes the real key on the upstream request, with a bare value', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('anthropic', up, [{ header: 'x-api-key', secret: 'anthropic' }])], secrets: { anthropic: REAL } });
    const r = await send({ port: p.port, method: 'POST', path: '/anthropic/v1/messages', body: '{}' });
    expect(r.status).toBe(200);
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]!.headers['x-api-key']).toBe(REAL);
  });

  it('prefixes the scheme when one is configured', async () => {
    const up = await upstream();
    const p = await proxy({
      routes: [route('openai', up, [{ header: 'Authorization', secret: 'openai', scheme: 'Bearer' }])],
      secrets: { openai: REAL },
    });
    await send({ port: p.port, path: '/openai/v1/models' });
    expect(up.requests[0]!.headers['authorization']).toBe(`Bearer ${REAL}`);
  });

  it('REPLACES forged inbound credentials: exactly one header line, holding the real value', async () => {
    const up = await upstream();
    const p = await proxy({
      routes: [route('anthropic', up, [{ header: 'x-api-key', secret: 'anthropic' }, { header: 'authorization', secret: 'anthropic', scheme: 'Bearer' }])],
      secrets: { anthropic: REAL },
    });
    await send({
      port: p.port,
      path: '/anthropic/v1/messages',
      // Two forged x-api-key lines: an array value makes node send the header twice.
      headers: { 'x-api-key': ['forged-1', 'forged-2'], Authorization: 'Bearer forged-3', 'api-key': 'forged-4', cookie: 'session=forged-5' },
    });
    const seen = up.requests[0]!;
    expect(countHeader(seen.rawHeaders, 'x-api-key')).toBe(1);
    expect(countHeader(seen.rawHeaders, 'authorization')).toBe(1);
    expect(seen.headers['x-api-key']).toBe(REAL);
    expect(seen.headers['authorization']).toBe(`Bearer ${REAL}`);
    expect(JSON.stringify(seen.rawHeaders)).not.toContain('forged');
  });

  it('strips a header named by the route inject list even when it is not in the static strip list', async () => {
    const up = await upstream();
    const p = await proxy({
      routes: [route('gemini', up, [{ header: 'X-Goog-Api-Key', secret: 'gemini' }])],
      secrets: { gemini: REAL },
    });
    await send({ port: p.port, path: '/gemini/v1/x', headers: { 'x-goog-api-key': 'forged' } });
    const seen = up.requests[0]!;
    expect(countHeader(seen.rawHeaders, 'x-goog-api-key')).toBe(1);
    expect(seen.headers['x-goog-api-key']).toBe(REAL);
  });

  it('strips credentials even on a route that injects nothing', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('ollama', up)] });
    await send({ port: p.port, path: '/ollama/api/tags', headers: { authorization: 'Bearer forged', 'x-api-key': 'forged' } });
    expect(up.requests[0]!.headers['authorization']).toBeUndefined();
    expect(up.requests[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('keeps two routes with different secrets from crossing, under concurrent mixed load', async () => {
    const upA = await upstream();
    const upB = await upstream();
    const p = await proxy({
      routes: [
        route('alpha', upA, [{ header: 'x-api-key', secret: 'alpha-key' }]),
        route('beta', upB, [{ header: 'x-api-key', secret: 'beta-key' }]),
      ],
      secrets: { 'alpha-key': 'SECRET-ALPHA-aaaaaaaa', 'beta-key': 'SECRET-BETA-bbbbbbbbb' },
    });
    const calls = Array.from({ length: 60 }, (_, i) => send({ port: p.port, path: `/${i % 2 === 0 ? 'alpha' : 'beta'}/n/${i}` }));
    const replies = await Promise.all(calls);
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(upA.requests).toHaveLength(30);
    expect(upB.requests).toHaveLength(30);
    for (const seen of upA.requests) expect(seen.headers['x-api-key']).toBe('SECRET-ALPHA-aaaaaaaa');
    for (const seen of upB.requests) expect(seen.headers['x-api-key']).toBe('SECRET-BETA-bbbbbbbbb');
    expect(JSON.stringify(upA.requests.map((r) => r.headers))).not.toContain('BETA');
    expect(JSON.stringify(upB.requests.map((r) => r.headers))).not.toContain('ALPHA');
  });
});

describe('request header hygiene', () => {
  const STRIPPED: Record<string, string> = {
    'proxy-authorization': 'Basic eHg6eHg=',
    'proxy-connection': 'keep-alive',
    'proxy-x-anything': 'v',
    te: 'trailers',
    trailer: 'x-t',
    upgrade: 'websocket',
    authorization: 'Bearer forged',
    'x-api-key': 'forged',
    'api-key': 'forged',
    cookie: 'a=b',
    'x-forwarded-for': '10.9.9.9',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
    forwarded: 'for=10.9.9.9',
    'x-real-ip': '10.9.9.9',
    'keep-alive': 'timeout=99',
  };

  it('drops every hop-by-hop and identity header', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    // Raw bytes: node's own client refuses some of these (for example Trailer without chunking).
    const lines = Object.entries(STRIPPED).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    expect(statusOf(await rawExchange(p.port, rawRequest('/svc/x', lines)))).toBe(200);
    const seen = up.requests[0]!.headers;
    for (const name of Object.keys(STRIPPED)) {
      // `connection` and `host` are rewritten by node's own client, so only the stripped values are checked.
      expect(seen[name], name).toBeUndefined();
    }
  });

  it('never forwards the client Host header: the upstream sees its own', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({ port: p.port, path: '/svc/x', headers: { host: 'evil.example:9999' } });
    expect(up.requests[0]!.headers.host).toBe(`127.0.0.1:${up.port}`);
  });

  it('honours Connection: <header> by dropping the named hop-by-hop header', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({ port: p.port, path: '/svc/x', headers: { connection: 'close, x-hop', 'x-hop': 'secret-hop', 'x-keep': 'kept' } });
    expect(up.requests[0]!.headers['x-hop']).toBeUndefined();
    expect(up.requests[0]!.headers['x-keep']).toBe('kept');
  });

  it('passes ordinary headers through untouched', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({
      port: p.port,
      method: 'POST',
      path: '/svc/v1/messages',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
        'user-agent': 'agent-sdk/1.2.3',
        'x-custom': 'yes',
      },
    });
    const seen = up.requests[0]!;
    expect(seen.headers['content-type']).toBe('application/json');
    expect(seen.headers['accept']).toBe('text/event-stream');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers['anthropic-beta']).toBe('tools-2024-04-04');
    expect(seen.headers['user-agent']).toBe('agent-sdk/1.2.3');
    expect(seen.headers['x-custom']).toBe('yes');
    expect(seen.body.toString()).toBe('{"a":1}');
  });

  it('survives a header literally named __proto__', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const r = await rawExchange(p.port, rawRequest('/svc/x', '__proto__: polluted\r\n'));
    expect(statusOf(r)).toBe(200);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('routing', () => {
  it('matches on a path-segment boundary only', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('anthropic', up)] });
    expect((await send({ port: p.port, path: '/anthropic' })).status).toBe(200);
    expect((await send({ port: p.port, path: '/anthropic/' })).status).toBe(200);
    expect((await send({ port: p.port, path: '/anthropic/v1/x' })).status).toBe(200);
    expect((await send({ port: p.port, path: '/anthropic?x=1' })).status).toBe(200);
    const hitsBefore = up.requests.length;
    for (const path of ['/anthropicevil', '/anthropicevil/x', '/anthropic-x', '/anthropic.evil', '/ANTHROPIC/x', '/anthr%6fpic/x', '/%61nthropic/x', '/']) {
      expect((await send({ port: p.port, path })).status, path).toBe(404);
    }
    expect(up.requests).toHaveLength(hitsBefore);
  });

  it('answers an unknown route with a generic 404 that echoes nothing from the request', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('anthropic', up)] });
    const r = await send({ port: p.port, path: '/needle-path-123/x?needle-query=456', headers: { 'x-needle': 'needle-header-789' } });
    expect(r.status).toBe(404);
    expect(r.text).toBe('{"error":"not_found"}');
    expect(r.rawHeaders.join('\n')).not.toContain('needle');
  });

  it('prefers the longest matching prefix', async () => {
    const outer = await upstream();
    const inner = await upstream();
    const p = await proxy({ routes: [route('svc', outer), { ...route('inner', inner), pathPrefix: '/svc/inner' }] });
    await send({ port: p.port, path: '/svc/inner/a' });
    await send({ port: p.port, path: '/svc/other' });
    expect(inner.requests.map((r) => r.url)).toEqual(['/a']);
    expect(outer.requests.map((r) => r.url)).toEqual(['/other']);
  });

  it('keeps path and query byte-for-byte (percent-encoding preserved)', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({ port: p.port, path: '/svc/v1/a%20b/c?beta=true&x=a%20b&y=%E2%9C%93&z=1+2&e=' });
    await send({ port: p.port, path: '/svc/v1/models/gemini:generateContent?key=ignored' });
    await send({ port: p.port, path: '/svc?x=1' });
    await send({ port: p.port, path: '/svc' });
    await send({ port: p.port, path: '/svc/x?/..' });
    expect(up.requests.map((r) => r.url)).toEqual([
      '/v1/a%20b/c?beta=true&x=a%20b&y=%E2%9C%93&z=1+2&e=',
      '/v1/models/gemini:generateContent?key=ignored',
      '/?x=1',
      '/',
      '/x?/..',
    ]);
  });

  it('prepends the upstream base path', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [{ ...route('svc', up), upstream: `${up.url}/base/v1/` }] });
    await send({ port: p.port, path: '/svc/chat?a=1' });
    await send({ port: p.port, path: '/svc' });
    expect(up.requests.map((r) => r.url)).toEqual(['/base/v1/chat?a=1', '/base/v1']);
  });

  it('serves GET /_agentvault/health locally and never forwards it', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const r = await send({ port: p.port, path: '/_agentvault/health' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"ok":true}');
    expect(r.headers['content-type']).toBe('application/json');
    expect((await send({ port: p.port, path: '/_agentvault/other' })).status).toBe(404);
    expect((await send({ port: p.port, method: 'POST', path: '/_agentvault/health' })).status).toBe(404);
    expect(up.requests).toHaveLength(0);
  });
});

describe('methods and protocols', () => {
  it('passes HEAD and OPTIONS to the upstream', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5', allow: 'GET, HEAD, OPTIONS' });
      res.end('hello');
    });
    const p = await proxy({ routes: [route('svc', up)] });
    const head = await send({ port: p.port, method: 'HEAD', path: '/svc/x' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('5');
    expect(head.body.length).toBe(0);
    const options = await send({ port: p.port, method: 'OPTIONS', path: '/svc/x' });
    expect(options.status).toBe(200);
    expect(options.headers['allow']).toBe('GET, HEAD, OPTIONS');
    expect(up.requests.map((r) => r.method)).toEqual(['HEAD', 'OPTIONS']);
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'POST'])('forwards %s with its body', async (method) => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const r = await send({ port: p.port, method, path: '/svc/r/1', body: `body-for-${method}` });
    expect(r.status).toBe(200);
    expect(up.requests[0]!.method).toBe(method);
    expect(up.requests[0]!.body.toString()).toBe(`body-for-${method}`);
  });

  it('refuses TRACE (it would reflect the injected credential back) and unknown methods', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])], secrets: { s: REAL } });
    for (const method of ['TRACE', 'PURGE', 'PROPFIND']) {
      const r = await rawExchange(p.port, rawRequest('/svc/x', '', method));
      expect(statusOf(r), method).toBe(405);
    }
    expect(up.requests).toHaveLength(0);
  });

  it('answers a CONNECT tunnel request with 501 and opens nothing', async () => {
    const evil = await upstream();
    const p = await proxy({ routes: [route('svc', await upstream())] });
    const r = await rawExchange(p.port, `CONNECT 127.0.0.1:${evil.port} HTTP/1.1\r\nHost: 127.0.0.1:${evil.port}\r\n\r\n`);
    expect(statusOf(r)).toBe(501);
    expect(evil.requests).toHaveLength(0);
  });

  it('answers WebSocket/Upgrade with 501 and never reaches the upstream', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const r = await rawExchange(
      p.port,
      rawRequest('/svc/ws', 'Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nConnection: Upgrade\r\n').replace('Connection: close\r\n', '')
    );
    expect(statusOf(r)).toBe(501);
    expect(up.requests).toHaveLength(0);
  });

  it('refuses an empty-bodied request that lies about its Transfer-Encoding', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const r = await rawExchange(p.port, rawRequest('/svc/x', 'Transfer-Encoding: gzip, chunked\r\n\r\n0\r\n'), 2_000);
    expect(statusOf(r)).toBe(400);
    expect(up.requests).toHaveLength(0);
  });
});

describe('Expect: 100-continue', () => {
  it('lets an accepted request upload after the interim response', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const raw = await rawExchange(
      p.port,
      // Body is withheld until the server answers "100 Continue"; we send it after a pause.
      rawRequest('/svc/v1/x', 'Expect: 100-continue\r\nContent-Length: 5\r\n\r\nhello', 'POST'),
      4_000
    );
    expect(raw).toContain('100 Continue');
    expect(raw).toContain('200 OK');
    expect(up.requests[0]!.body.toString()).toBe('hello');
    expect(up.requests[0]!.headers['expect']).toBeUndefined();
  });

  it('rejects an unknown route before inviting the body (no 100 Continue)', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    const raw = await rawExchange(p.port, rawRequest('/nope', 'Expect: 100-continue\r\nContent-Length: 5\r\n\r\n', 'POST'));
    expect(raw).not.toContain('100 Continue');
    expect(statusOf(raw)).toBe(404);
  });

  it('rejects an oversized declared body before inviting it, and never contacts the upstream', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up)], maxBodyBytes: 10 });
    const raw = await rawExchange(p.port, rawRequest('/svc/x', 'Expect: 100-continue\r\nContent-Length: 11\r\n\r\n', 'POST'));
    expect(raw).not.toContain('100 Continue');
    expect(statusOf(raw)).toBe(413);
    expect(up.requests).toHaveLength(0);
  });
});

describe('open-relay and SSRF attempts', () => {
  it('never connects anywhere but the fixed upstream, for every hostile request-target', async () => {
    const up = await upstream();
    const evil = await upstream(); // the attacker-chosen target: it must see nothing
    const evilAuthority = `127.0.0.1:${evil.port}`;
    const p = await proxy({ routes: [route('anthropic', up, [{ header: 'x-api-key', secret: 'anthropic' }])], secrets: { anthropic: REAL } });

    const rejected: Array<[label: string, target: string]> = [
      ['absolute-form http to attacker', `http://${evilAuthority}/anthropic/x`],
      ['absolute-form https', 'https://evil.example/'],
      ['absolute-form with credentials', `http://anthropic@${evilAuthority}/`],
      ['authority-form', evilAuthority],
      ['asterisk-form', '*'],
      ['no leading slash', 'anthropic/x'],
      ['network-path reference', `//${evilAuthority}/x`],
      ['triple slash', '///x'],
      ['dot-dot', '/anthropic/../x'],
      ['bare dot-dot', '/anthropic/..'],
      ['dot segment', '/anthropic/./x'],
      ['encoded dot-dot lower', '/anthropic/%2e%2e/x'],
      ['encoded dot-dot upper', '/anthropic/%2E%2E/x'],
      ['half-encoded dot-dot a', '/anthropic/.%2e/x'],
      ['half-encoded dot-dot b', '/anthropic/%2e./x'],
      ['double-encoded dot-dot', '/anthropic/%252e%252e/x'],
      ['triple-encoded dot-dot', '/anthropic/%25252e%25252e/x'],
      ['obfuscated double-encoded dot-dot', '/anthropic/%25%32e%25%32e/x'],
      ['encoded slash lower', '/anthropic%2fx'],
      ['encoded slash upper', '/anthropic%2Fx'],
      ['encoded slash in remainder', '/anthropic/a%2f..%2fb'],
      ['double-encoded slash', '/anthropic/a%252fb'],
      ['obfuscated encoded slash', '/anthropic/a%25%32fb'],
      ['encoded backslash lower', '/anthropic/x%5cy'],
      ['encoded backslash upper', '/anthropic/x%5Cy'],
      ['double-encoded backslash', '/anthropic/x%255cy'],
      ['raw backslash', '/anthropic\\x'],
      ['backslash dot-dot', '/anthropic/..\\x'],
      ['empty segment', `/anthropic//${evilAuthority}/x`],
      ['empty segment mid-path', '/anthropic/x//y'],
      ['fragment', '/anthropic/x#frag'],
      ['encoded NUL', '/anthropic/%00'],
      ['encoded NUL truncation', '/anthropic/x%00.png'],
      ['encoded CRLF', '/anthropic/%0d%0aX-Injected:%201'],
      ['double-encoded CRLF', '/anthropic/%250d%250a'],
      ['malformed percent', '/anthropic/%zz'],
      ['dangling percent', '/anthropic/%'],
      ['invalid UTF-8 after decoding', '/anthropic/%ff'],
      ['raw control character', '/anthropic/\u0001x'],
      ['DEL', '/anthropic/\u007fx'],
      ['raw space', '/anthropic/a b'],
      ['non-ASCII byte', '/anthropic/é'],
    ];
    for (const [label, target] of rejected) {
      const raw = await rawExchange(p.port, Buffer.from(rawRequest(target), 'latin1'));
      expect(statusOf(raw), `${label}: ${JSON.stringify(target)}`).toBe(400);
    }
    expect(up.requests).toHaveLength(0);
    expect(evil.requests).toHaveLength(0);
  });

  it('keeps an @ or host-looking remainder inside the upstream path instead of changing the authority', async () => {
    const up = await upstream();
    const evil = await upstream();
    const p = await proxy({ routes: [route('anthropic', up, [{ header: 'x-api-key', secret: 'anthropic' }])], secrets: { anthropic: REAL } });
    const evilAuthority = `127.0.0.1:${evil.port}`;
    for (const remainder of [`/@${evilAuthority}/x`, `/${evilAuthority}`, `/:${evil.port}/x`, `/x@${evilAuthority}`]) {
      const r = await send({ port: p.port, path: `/anthropic${remainder}` });
      expect(r.status, remainder).toBe(200);
    }
    expect(up.requests.map((r) => r.url)).toEqual([`/@${evilAuthority}/x`, `/${evilAuthority}`, `/:${evil.port}/x`, `/x@${evilAuthority}`]);
    expect(evil.requests).toHaveLength(0);
  });

  it('ignores a client Host / X-Forwarded-Host that names another server', async () => {
    const up = await upstream();
    const evil = await upstream();
    const p = await proxy({ routes: [route('svc', up)] });
    await send({ port: p.port, path: '/svc/x', headers: { host: `127.0.0.1:${evil.port}`, 'x-forwarded-host': `127.0.0.1:${evil.port}` } });
    expect(up.requests).toHaveLength(1);
    expect(evil.requests).toHaveLength(0);
  });

  it('follows no redirect: a 3xx is passed to the client and the Location is not fetched', async () => {
    const evil = await upstream();
    const up = await upstream((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${evil.port}/stolen`, 'content-length': '0' });
      res.end();
    });
    const p = await proxy({ routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])], secrets: { s: REAL } });
    const r = await send({ port: p.port, path: '/svc/x' });
    expect(r.status).toBe(302);
    expect(r.headers['location']).toBe(`http://127.0.0.1:${evil.port}/stolen`);
    expect(evil.requests).toHaveLength(0);
  });
});

describe('missing secret at request time (fail closed)', () => {
  it.each([
    ['removed', undefined],
    ['emptied', ''],
    ['corrupted with a newline', 'abc\ndef'],
  ])('answers 503 and never calls the upstream when the secret is %s', async (_label, replacement) => {
    const up = await upstream();
    const p = await proxy({ routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])], secrets: { s: REAL } });
    expect((await send({ port: p.port, path: '/svc/x' })).status).toBe(200);
    p.secrets['s'] = replacement;
    const r = await send({ port: p.port, path: '/svc/x', headers: { 'x-api-key': 'forged' } });
    expect(r.status).toBe(503);
    expect(r.text).toBe('{"error":"service_unavailable"}');
    expect(up.requests).toHaveLength(1);
  });

  it('still serves a route that injects nothing when other secrets are missing', async () => {
    const up = await upstream();
    const p = await proxy({ routes: [route('open', up)], secrets: {} });
    expect((await send({ port: p.port, path: '/open/x' })).status).toBe(200);
  });
});

describe('response header filtering', () => {
  it('drops hop-by-hop headers and any header carrying an injected secret, keeps the rest', async () => {
    const up = await upstream((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.setHeader('x-request-id', 'req_123');
      res.setHeader('connection', 'x-hop, keep-alive');
      res.setHeader('x-hop', 'dropped-because-named-by-connection');
      res.setHeader('keep-alive', 'timeout=5');
      res.setHeader('x-reflected', `Bearer ${REAL}`);
      res.setHeader('set-cookie', ['a=1', `session=${REAL}`]);
      res.setHeader('location', `https://example.test/?k=${REAL}`);
      res.setHeader('x-multi', ['one', 'two']);
      res.end('body-without-secret');
    });
    const p = await proxy({ routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])], secrets: { s: REAL } });
    const r = await send({ port: p.port, path: '/svc/x' });
    expect(r.status).toBe(200);
    expect(r.headers['x-request-id']).toBe('req_123');
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.headers['x-multi']).toBe('one, two');
    expect(r.headers['x-hop']).toBeUndefined();
    expect(r.headers['x-reflected']).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['location']).toBeUndefined();
    expect(r.rawHeaders.join('\n')).not.toContain(REAL);
    expect(r.text).toBe('body-without-secret');
  });
});

describe('concurrency', () => {
  it('serves 100 parallel requests, each with its own path, body and response', async () => {
    const up = await upstream((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        const echo = JSON.stringify({ url: req.url, body: Buffer.concat(parts).toString() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(echo);
      });
    });
    const p = await proxy({ routes: [route('svc', up, [{ header: 'x-api-key', secret: 's' }])], secrets: { s: REAL } });
    const replies = await Promise.all(
      Array.from({ length: 100 }, (_, i) => send({ port: p.port, method: 'POST', path: `/svc/item/${i}?n=${i}`, body: `payload-${i}` }))
    );
    replies.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text)).toEqual({ url: `/item/${i}?n=${i}`, body: `payload-${i}` });
    });
  });
});
