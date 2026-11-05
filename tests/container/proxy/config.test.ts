/**
 * Credential proxy: config validation, request-target inspection, secret
 * loading and startup behaviour. These are the pure and in-process pieces; the
 * bundled script as a real process is covered in process.test.ts.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProxyConfigError,
  buildUpstreamUrl,
  compileRoutes,
  inspectRequestTarget,
  isValidSecretValue,
  loadProxyInputs,
  referencedSecrets,
  runFromEnv,
  secretEnvName,
  validateProxyConfig,
} from '../../../src/container/proxy/credential-proxy.js';
import { PROXY_CONFIG_ENV, PROXY_SECRET_ENV_PREFIX } from '../../../src/container/types.js';
import { SECRET_NAME_RE, secretEnvName as hostSecretEnvName } from '../../../src/container/validate.js';
import { send } from './harness.js';

const goodRoute = { name: 'anthropic', pathPrefix: '/anthropic', upstream: 'https://api.anthropic.com', inject: [{ header: 'x-api-key', secret: 'anthropic' }] };
const goodConfig = { version: 1, listenPort: 8080, routes: [goodRoute], maxBodyBytes: 1024, upstreamTimeoutMs: 5000 };

function expectConfigError(input: unknown, fragment: string): void {
  let caught: unknown;
  try {
    validateProxyConfig(input);
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a ProxyConfigError containing "${fragment}"`).toBeInstanceOf(ProxyConfigError);
  expect((caught as Error).message).toContain(fragment);
}

describe('secretEnvName parity with the host-side mapping', () => {
  it('agrees with validate.ts for fixed and generated names', () => {
    const names = ['anthropic', 'openai', 'venice', 'my-key', 'a', 'a-b-c-d', 'x1-y2', 'z'.repeat(32), 'a' + '-b'.repeat(15)];
    // Deterministic pseudo-random names that satisfy the host's SECRET_NAME_RE.
    let seed = 12345;
    const rnd = (n: number): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-';
    for (let i = 0; i < 200; i++) {
      let name = 'abcdefghijklmnopqrstuvwxyz'[rnd(26)]!;
      const length = rnd(31);
      for (let j = 0; j < length; j++) name += alphabet[rnd(alphabet.length)]!;
      names.push(name);
    }
    for (const name of names) {
      expect(SECRET_NAME_RE.test(name), name).toBe(true);
      expect(secretEnvName(name), name).toBe(hostSecretEnvName(name));
    }
  });

  it('uses the shared prefix and config variable names from types.ts', () => {
    expect(secretEnvName('anthropic')).toBe(`${PROXY_SECRET_ENV_PREFIX}ANTHROPIC`);
    expect(() => loadProxyInputs({})).toThrow(PROXY_CONFIG_ENV);
  });
});

describe('validateProxyConfig', () => {
  it('accepts a good config and returns a normalised copy', () => {
    const out = validateProxyConfig(goodConfig);
    expect(out).toEqual(goodConfig);
    expect(out).not.toBe(goodConfig);
    expect(out.routes[0]).not.toBe(goodRoute);
  });

  it('accepts port 0, an empty route list, an auth scheme and allowInsecureUpstream', () => {
    expect(validateProxyConfig({ ...goodConfig, listenPort: 0, routes: [] }).routes).toEqual([]);
    const withScheme = validateProxyConfig({
      ...goodConfig,
      routes: [{ name: 'local', pathPrefix: '/local/v1', upstream: 'http://host.docker.internal:11434/base', inject: [{ header: 'Authorization', secret: 'k', scheme: 'Bearer' }], allowInsecureUpstream: true }],
    });
    expect(withScheme.routes[0]!.inject[0]!.scheme).toBe('Bearer');
  });

  const bad: Array<[label: string, input: unknown, fragment: string]> = [
    ['null', null, 'config'],
    ['array', [], 'config'],
    ['wrong version', { ...goodConfig, version: 2 }, 'config.version'],
    ['unknown top-level field', { ...goodConfig, extra: 1 }, 'unknown field'],
    ['negative port', { ...goodConfig, listenPort: -1 }, 'listenPort'],
    ['port too large', { ...goodConfig, listenPort: 70000 }, 'listenPort'],
    ['fractional port', { ...goodConfig, listenPort: 80.5 }, 'listenPort'],
    ['string port', { ...goodConfig, listenPort: '8080' }, 'listenPort'],
    ['zero body limit', { ...goodConfig, maxBodyBytes: 0 }, 'maxBodyBytes'],
    ['zero timeout', { ...goodConfig, upstreamTimeoutMs: 0 }, 'upstreamTimeoutMs'],
    ['NaN timeout', { ...goodConfig, upstreamTimeoutMs: Number.NaN }, 'upstreamTimeoutMs'],
    ['routes not an array', { ...goodConfig, routes: {} }, 'routes'],
    ['too many routes', { ...goodConfig, routes: Array.from({ length: 65 }, (_, i) => ({ ...goodRoute, name: `r${i}`, pathPrefix: `/r${i}` })) }, 'routes'],
    ['route not an object', { ...goodConfig, routes: ['x'] }, 'routes[0]'],
    ['route unknown field', { ...goodConfig, routes: [{ ...goodRoute, upstreamHost: 'x' }] }, 'unknown field'],
    ['route name uppercase', { ...goodConfig, routes: [{ ...goodRoute, name: 'Anthropic' }] }, '.name'],
    ['route name empty', { ...goodConfig, routes: [{ ...goodRoute, name: '' }] }, '.name'],
    ['route name too long', { ...goodConfig, routes: [{ ...goodRoute, name: 'a'.repeat(33) }] }, '.name'],
    ['duplicate name', { ...goodConfig, routes: [goodRoute, { ...goodRoute, pathPrefix: '/other' }] }, 'duplicate route name'],
    ['duplicate prefix', { ...goodConfig, routes: [goodRoute, { ...goodRoute, name: 'other' }] }, 'duplicate path prefix'],
    ['prefix root', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/' }] }, 'pathPrefix'],
    ['prefix without slash', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: 'anthropic' }] }, 'pathPrefix'],
    ['prefix trailing slash', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/anthropic/' }] }, 'pathPrefix'],
    ['prefix with dot-dot', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a/../b' }] }, 'pathPrefix'],
    ['prefix with dot', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a.b' }] }, 'pathPrefix'],
    ['prefix empty segment', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a//b' }] }, 'pathPrefix'],
    ['prefix with space', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a b' }] }, 'pathPrefix'],
    ['prefix with query', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a?x=1' }] }, 'pathPrefix'],
    ['prefix with percent', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/%61' }] }, 'pathPrefix'],
    ['prefix too deep', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/a/b/c/d/e/f/g/h/i' }] }, 'pathPrefix'],
    ['prefix shadows the health endpoint', { ...goodConfig, routes: [{ ...goodRoute, pathPrefix: '/_agentvault' }] }, 'pathPrefix'],
    ['upstream missing', { ...goodConfig, routes: [{ ...goodRoute, upstream: undefined }] }, 'upstream'],
    ['upstream not a URL', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'not a url' }] }, 'upstream'],
    ['upstream ftp', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'ftp://example.com' }] }, 'scheme'],
    ['upstream javascript', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'javascript:alert(1)' }] }, 'upstream'],
    ['upstream file', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'file:///etc/passwd' }] }, 'upstream'],
    ['upstream without host', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://' }] }, 'upstream'],
    ['upstream credentials', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://user:hunter2@api.example.com' }] }, 'credentials'],
    ['upstream user only', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://tokenvalue@api.example.com' }] }, 'credentials'],
    ['upstream query', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com/?k=v' }] }, 'query'],
    ['upstream fragment', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com/#f' }] }, 'fragment'],
    ['upstream dot-dot', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com/a/../b' }] }, '".."'],
    ['upstream backslash', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com\\@evil.example' }] }, 'characters'],
    ['upstream with space', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com/a b' }] }, 'characters'],
    ['upstream with control character', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'https://api.example.com/\u0001' }] }, 'characters'],
    ['http upstream without opt-in', { ...goodConfig, routes: [{ ...goodRoute, upstream: 'http://api.example.com' }] }, 'allowInsecureUpstream'],
    ['allowInsecureUpstream not boolean', { ...goodConfig, routes: [{ ...goodRoute, allowInsecureUpstream: 'yes' }] }, 'allowInsecureUpstream'],
    ['inject not an array', { ...goodConfig, routes: [{ ...goodRoute, inject: {} }] }, 'inject'],
    ['inject missing', { ...goodConfig, routes: [{ ...goodRoute, inject: undefined }] }, 'inject'],
    ['too many injections', { ...goodConfig, routes: [{ ...goodRoute, inject: Array.from({ length: 9 }, (_, i) => ({ header: `x-h${i}`, secret: 'k' })) }] }, 'inject'],
    ['inject entry not an object', { ...goodConfig, routes: [{ ...goodRoute, inject: ['x'] }] }, 'inject[0]'],
    ['inject unknown field', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-api-key', secret: 'k', query: 'key' }] }] }, 'unknown field'],
    ['header with space', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x api key', secret: 'k' }] }] }, '.header'],
    ['header with colon', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x:key', secret: 'k' }] }] }, '.header'],
    ['header empty', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: '', secret: 'k' }] }] }, '.header'],
    ['header with CRLF', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-a\r\nx-b', secret: 'k' }] }] }, '.header'],
    ['header host', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'Host', secret: 'k' }] }] }, 'cannot be injected'],
    ['header content-length', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'Content-Length', secret: 'k' }] }] }, 'cannot be injected'],
    ['header transfer-encoding', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'transfer-encoding', secret: 'k' }] }] }, 'cannot be injected'],
    ['header proxy-authorization', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'proxy-authorization', secret: 'k' }] }] }, 'cannot be injected'],
    ['duplicate injected header', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-api-key', secret: 'a' }, { header: 'X-API-KEY', secret: 'b' }] }] }, 'duplicate header'],
    ['secret uppercase', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-api-key', secret: 'Anthropic' }] }] }, '.secret'],
    ['secret with underscore', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-api-key', secret: 'a_b' }] }] }, '.secret'],
    ['secret path traversal', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'x-api-key', secret: '../x' }] }] }, '.secret'],
    ['scheme with space', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'authorization', secret: 'k', scheme: 'Bearer x' }] }] }, '.scheme'],
    ['scheme empty', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'authorization', secret: 'k', scheme: '' }] }] }, '.scheme'],
    ['scheme not a string', { ...goodConfig, routes: [{ ...goodRoute, inject: [{ header: 'authorization', secret: 'k', scheme: 5 }] }] }, '.scheme'],
  ];
  it.each(bad)('rejects: %s', (_label, input, fragment) => {
    expectConfigError(input, fragment);
  });

  it('rejects an own "__proto__" key arriving through JSON as an unknown field', () => {
    const parsed: unknown = JSON.parse('{"version":1,"listenPort":1,"routes":[],"maxBodyBytes":1,"upstreamTimeoutMs":1,"__proto__":{"polluted":true}}');
    expectConfigError(parsed, 'unknown field');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never echoes a credential embedded in an upstream URL, in any error message', () => {
    for (const upstream of ['https://user:hunter2-SECRET@api.example.com', 'https://hunter2-SECRET@api.example.com', 'https://api.example.com/?key=hunter2-SECRET', 'ftp://hunter2-SECRET.example.com']) {
      let message = '';
      try {
        validateProxyConfig({ ...goodConfig, routes: [{ ...goodRoute, upstream }] });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, upstream).not.toBe('');
      expect(message, upstream).not.toContain('hunter2');
    }
  });

  it('lists each referenced secret once', () => {
    const config = validateProxyConfig({
      ...goodConfig,
      routes: [
        goodRoute,
        { name: 'b', pathPrefix: '/b', upstream: 'https://b.example.com', inject: [{ header: 'x-api-key', secret: 'anthropic' }, { header: 'authorization', secret: 'other', scheme: 'Bearer' }] },
      ],
    });
    expect(referencedSecrets(config)).toEqual(['anthropic', 'other']);
  });
});

describe('isValidSecretValue', () => {
  it.each(['sk-ant-api03-AbC_123', 'a', 'with space inside', '~!@#$%^&*()_+{}|:"<>?', 'x'.repeat(8192)])('accepts %j', (value) => {
    expect(isValidSecretValue(value)).toBe(true);
  });
  it.each([
    ['empty', ''],
    ['newline', 'abc\ndef'],
    ['carriage return', 'abc\rdef'],
    ['NUL', 'abc\0def'],
    ['tab', 'abc\tdef'],
    ['DEL', 'abc\u007fdef'],
    ['non-ASCII', 'abcé'],
    ['leading space', ' abc'],
    ['trailing space', 'abc '],
    ['too long', 'x'.repeat(8193)],
    ['not a string', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isValidSecretValue(value)).toBe(false);
  });
});

describe('inspectRequestTarget (unit; independent of node\'s own parser)', () => {
  it.each([
    ['/anthropic', '/anthropic', ''],
    ['/anthropic/v1/messages', '/anthropic/v1/messages', ''],
    ['/anthropic/v1/messages?beta=true', '/anthropic/v1/messages', '?beta=true'],
    ['/a/b%20c/%E2%9C%93', '/a/b%20c/%E2%9C%93', ''],
    ['/a?/..', '/a', '?/..'],
    ['/a?u=http://x//y', '/a', '?u=http://x//y'],
    ['/a/b:c@d', '/a/b:c@d', ''],
    ['/a/100%25', '/a/100%25', ''],
    ['/a/%2541', '/a/%2541', ''],
  ])('accepts %s', (raw, path, query) => {
    expect(inspectRequestTarget(raw)).toEqual({ ok: true, path, query });
  });

  it.each([
    ['empty', '', 'length'],
    ['too long', `/${'a'.repeat(9000)}`, 'length'],
    ['absolute-form', 'http://evil.example/', 'not-origin-form'],
    ['authority-form', 'evil.example:443', 'not-origin-form'],
    ['asterisk', '*', 'not-origin-form'],
    ['network-path', '//evil.example/x', 'network-path'],
    ['NUL', '/a\u0000b', 'character'],
    ['control character', '/a\u0001b', 'character'],
    ['newline', '/a\nb', 'character'],
    ['carriage return', '/a\rb', 'character'],
    ['tab', '/a\tb', 'character'],
    ['space', '/a b', 'character'],
    ['DEL', '/a\u007fb', 'character'],
    ['non-ASCII', '/aé', 'character'],
    ['control character in the query', '/a?x=\u0001', 'character'],
    ['fragment', '/a#b', 'fragment'],
    ['fragment in query', '/a?x#y', 'fragment'],
    ['backslash', '/a\\b', 'backslash'],
    ['dot-dot', '/a/../b', 'dot-dot'],
    ['dot-dot inside a segment', '/a/b..c', 'dot-dot'],
    ['dot segment', '/a/./b', 'dot-segment'],
    ['empty segment', '/a//b', 'double-slash'],
    ['encoded dot lower', '/a/%2e/b', 'encoded-dot-or-slash'],
    ['encoded dot upper', '/a/%2E/b', 'encoded-dot-or-slash'],
    ['encoded slash', '/a%2fb', 'encoded-dot-or-slash'],
    ['encoded backslash', '/a%5Cb', 'encoded-dot-or-slash'],
    ['double-encoded dot', '/a/%252e/b', 'encoded-dot-or-slash'],
    ['quadruple-encoded dot', '/a/%2525252e/b', 'encoded-dot-or-slash'],
    ['encoded NUL', '/a%00b', 'encoded-control'],
    ['encoded CR', '/a%0db', 'encoded-control'],
    ['encoded LF', '/a%0Ab', 'encoded-control'],
    ['encoded DEL', '/a%7fb', 'encoded-control'],
    ['double-encoded LF', '/a%250ab', 'control-character'],
    ['malformed percent', '/a%zz', 'malformed-percent'],
    ['dangling percent', '/a%', 'malformed-percent'],
    ['one hex digit', '/a%2', 'malformed-percent'],
    ['invalid UTF-8', '/a%ff', 'malformed-percent'],
    ['obfuscated double-encoded dot-dot', '/a/%25%32e%25%32e/b', 'dot-dot'],
    ['obfuscated double-encoded slash', '/a%25%32fb', 'encoded-slash'],
    ['encoding nested too deep', `/a%${'25'.repeat(7)}41`, 'nested-encoding'],
    ['obfuscated dot-dot hidden behind a dangling percent', '/a/%25%32e%25%32e%25', 'dot-dot'],
  ])('rejects %s', (_label, raw, reason) => {
    expect(inspectRequestTarget(raw)).toEqual({ ok: false, reason });
  });
});

describe('loadProxyInputs (fail closed at startup)', () => {
  const configJson = JSON.stringify({
    ...goodConfig,
    routes: [goodRoute, { name: 'openai', pathPrefix: '/openai', upstream: 'https://api.openai.com', inject: [{ header: 'authorization', secret: 'openai', scheme: 'Bearer' }] }],
  });

  it('reads only the secrets the routes reference', () => {
    const { secrets } = loadProxyInputs({
      [PROXY_CONFIG_ENV]: configJson,
      AV_SECRET_ANTHROPIC: 'key-a',
      AV_SECRET_OPENAI: 'key-o',
      AV_SECRET_UNRELATED: 'must-not-be-loaded',
    });
    expect(secrets).toEqual({ anthropic: 'key-a', openai: 'key-o' });
  });

  it('names every missing secret and echoes no secret value', () => {
    let message = '';
    try {
      loadProxyInputs({ [PROXY_CONFIG_ENV]: configJson, AV_SECRET_UNRELATED: 'CANARY-VALUE-123' });
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('anthropic');
    expect(message).toContain('openai');
    expect(message).toContain('AV_SECRET_ANTHROPIC');
    expect(message).not.toContain('CANARY');
  });

  it('treats an empty value as missing', () => {
    expect(() => loadProxyInputs({ [PROXY_CONFIG_ENV]: configJson, AV_SECRET_ANTHROPIC: 'k', AV_SECRET_OPENAI: '' })).toThrow(/openai/);
  });

  it('refuses a value with unusable characters, by name only', () => {
    let message = '';
    try {
      loadProxyInputs({ [PROXY_CONFIG_ENV]: configJson, AV_SECRET_ANTHROPIC: 'CANARY\nINJECT=1', AV_SECRET_OPENAI: 'ok' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('anthropic');
    expect(message).not.toContain('CANARY');
  });

  it('refuses a missing, unparsable or invalid config without echoing it', () => {
    expect(() => loadProxyInputs({})).toThrow(PROXY_CONFIG_ENV);
    expect(() => loadProxyInputs({ [PROXY_CONFIG_ENV]: '' })).toThrow(PROXY_CONFIG_ENV);
    let message = '';
    try {
      loadProxyInputs({ [PROXY_CONFIG_ENV]: '{"routes": CANARY-NOT-JSON' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain('CANARY');
    expect(() => loadProxyInputs({ [PROXY_CONFIG_ENV]: '{"version":2}' })).toThrow(ProxyConfigError);
  });

  it('does not need any secret for routes that inject nothing', () => {
    const open = JSON.stringify({ ...goodConfig, routes: [{ name: 'ollama', pathPrefix: '/ollama', upstream: 'http://host.docker.internal:11434', inject: [], allowInsecureUpstream: true }] });
    expect(loadProxyInputs({ [PROXY_CONFIG_ENV]: open }).secrets).toEqual({});
  });
});

describe('runFromEnv', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  const env = (port: number): NodeJS.ProcessEnv => ({
    [PROXY_CONFIG_ENV]: JSON.stringify({ ...goodConfig, listenPort: port }),
    AV_SECRET_ANTHROPIC: 'sk-test-key',
  });

  it('prints exactly one listening line with the real port, binds 0.0.0.0, and serves health', async () => {
    const lines: string[] = [];
    const server = await runFromEnv(env(0), { stdout: (text) => lines.push(text), handleSignals: false, log: () => undefined });
    servers.push(server);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('0.0.0.0');
    expect(lines).toEqual([`{"event":"listening","port":${address.port}}\n`]);
    expect((await send({ port: address.port, path: '/_agentvault/health' })).text).toBe('{"ok":true}');
    expect(lines).toHaveLength(1);
  });

  it('rejects instead of exiting, and prints nothing, when a secret is missing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const lines: string[] = [];
    const bad = { [PROXY_CONFIG_ENV]: JSON.stringify(goodConfig) };
    await expect(runFromEnv(bad, { stdout: (text) => lines.push(text), handleSignals: false })).rejects.toThrow(/missing secret\(s\): anthropic/);
    expect(lines).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rejects when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const lines: string[] = [];
    try {
      await expect(runFromEnv(env(port), { stdout: (text) => lines.push(text), handleSignals: false })).rejects.toThrow();
      expect(lines).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('importing the module started nothing: no listener on SIGTERM from this file', () => {
    // runFromEnv with handleSignals:false installed none, and merely importing installs none.
    expect(process.listeners('SIGTERM').some((l) => String(l).includes('closing'))).toBe(false);
  });
});

describe('buildUpstreamUrl (the origin assertion behind the path validation)', () => {
  const [anthropic] = compileRoutes([goodRoute]);
  const [based] = compileRoutes([{ ...goodRoute, upstream: 'https://api.example.com/base/v1/' }]);
  const [plain] = compileRoutes([{ ...goodRoute, upstream: 'http://127.0.0.1:8081', allowInsecureUpstream: true }]);

  it('joins upstream, remainder and query', () => {
    expect(buildUpstreamUrl(anthropic!, '/v1/messages', '?a=1')?.href).toBe('https://api.anthropic.com/v1/messages?a=1');
    expect(buildUpstreamUrl(anthropic!, '', '')?.href).toBe('https://api.anthropic.com/');
    expect(buildUpstreamUrl(based!, '/chat', '')?.href).toBe('https://api.example.com/base/v1/chat');
    expect(buildUpstreamUrl(plain!, '/x', '')?.href).toBe('http://127.0.0.1:8081/x');
  });

  // Remainders the HTTP layer would never produce (they do not start with "/"): the point is that
  // even if request validation were bypassed, the connection could still not leave the route's origin.
  it.each(['.evil.example/x', '@evil.example/x', ':81/x', '.evil.example', '@evil.example', ':9999', 'x.evil.example'])(
    'returns null instead of changing the authority for remainder %j',
    (remainder) => {
      expect(buildUpstreamUrl(anthropic!, remainder, '')).toBeNull();
      expect(buildUpstreamUrl(plain!, remainder, '')).toBeNull();
      expect(buildUpstreamUrl(based!, remainder, '')).toBeNull();
    }
  );

  it.each(['\\@evil.example/x', '/..\\..\\@evil.example', '/@evil.example', '/a:b@evil.example/x'])(
    'keeps the route origin when the URL parser folds or resolves %j',
    (remainder) => {
      expect(buildUpstreamUrl(anthropic!, remainder, '')?.origin).toBe('https://api.anthropic.com');
      expect(buildUpstreamUrl(plain!, remainder, '')?.origin).toBe('http://127.0.0.1:8081');
    }
  );

  it.each(['/../../x', '/..', '/../other', '\\..\\x', '/../x'])(
    'refuses to climb out of the upstream base path with remainder %j',
    (remainder) => {
      expect(buildUpstreamUrl(based!, remainder, '')).toBeNull();
    }
  );

  it('returns null when the join leaves the origin through the query part', () => {
    expect(buildUpstreamUrl(anthropic!, '', '@evil.example')).toBeNull();
  });
});
