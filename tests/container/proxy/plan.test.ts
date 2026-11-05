/**
 * planProxy: which routes, which secrets, which agent env. The properties that
 * matter are the negative ones: nothing secret reaches the agent, nothing
 * unrelated reaches the sidecar, and missing secrets stop the plan.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProxyScript } from '../../../src/container/proxy/bundle.js';
import { runFromEnv, secretEnvName, validateProxyConfig } from '../../../src/container/proxy/credential-proxy.js';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PROXY_IMAGE, DEFAULT_UPSTREAM_TIMEOUT_MS, planProxy } from '../../../src/container/proxy/plan.js';
import { SERVICE_PRESETS } from '../../../src/container/proxy/presets.js';
import { ContainerError, PROXY_CONFIG_ENV, PROXY_PLACEHOLDER_KEY, PROXY_PORT } from '../../../src/container/types.js';
import type { ProxyRoute } from '../../../src/container/types.js';
import { send, startUpstream } from './harness.js';

const ALL = {
  anthropic: 'sk-ant-CANARY-aaaaaaaaaaaa',
  openai: 'sk-openai-CANARY-bbbbbbbbbb',
  venice: 'venice-CANARY-cccccccccccc',
};

async function failureOf(promise: Promise<unknown>): Promise<ContainerError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ContainerError);
    return err as ContainerError;
  }
  throw new Error('expected planProxy to reject');
}

const extra = (patch: Partial<ProxyRoute> = {}): ProxyRoute => ({
  name: 'fake',
  pathPrefix: '/fake',
  upstream: 'http://127.0.0.1:9',
  inject: [],
  allowInsecureUpstream: true,
  ...patch,
});

describe('planProxy: the plan', () => {
  it('builds config, env, secrets, hosts and script for every preset', async () => {
    const plan = await planProxy({ services: ['anthropic', 'openai', 'venice', 'ollama'], secrets: ALL });
    expect(plan.config).toEqual({
      version: 1,
      listenPort: PROXY_PORT,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
      routes: [
        { name: 'anthropic', pathPrefix: '/anthropic', upstream: 'https://api.anthropic.com', inject: [{ header: 'x-api-key', secret: 'anthropic' }] },
        { name: 'openai', pathPrefix: '/openai', upstream: 'https://api.openai.com', inject: [{ header: 'authorization', secret: 'openai', scheme: 'Bearer' }] },
        { name: 'venice', pathPrefix: '/venice', upstream: 'https://api.venice.ai', inject: [{ header: 'authorization', secret: 'venice', scheme: 'Bearer' }] },
        { name: 'ollama', pathPrefix: '/ollama', upstream: 'http://host.docker.internal:11434', inject: [], allowInsecureUpstream: true },
      ],
    });
    expect(DEFAULT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(600_000);
    expect(plan.image).toBe('node:22-slim');
    expect(DEFAULT_PROXY_IMAGE).toBe('node:22-slim');
    expect(plan.addHosts).toEqual(['host.docker.internal:host-gateway']);
    expect(plan.agentEnv).toEqual({
      ANTHROPIC_BASE_URL: 'http://agentvault-proxy:8080/anthropic',
      ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY,
      OPENAI_BASE_URL: 'http://agentvault-proxy:8080/openai/v1',
      OPENAI_API_KEY: PROXY_PLACEHOLDER_KEY,
      VENICE_BASE_URL: 'http://agentvault-proxy:8080/venice/api/v1',
      VENICE_API_KEY: PROXY_PLACEHOLDER_KEY,
      OLLAMA_HOST: 'http://agentvault-proxy:8080/ollama',
    });
    expect(plan.secrets).toEqual(ALL);
    expect(plan.scriptSource).toBe(await loadProxyScript());
    expect(() => validateProxyConfig(plan.config)).not.toThrow();
  });

  it('puts ONLY the secrets the selected routes reference into plan.secrets', async () => {
    const plan = await planProxy({
      services: ['anthropic'],
      secrets: { ...ALL, github: 'ghp_UNRELATED_CANARY_dddddd', 'wallet-key': 'UNRELATED-eeee' },
    });
    expect(plan.secrets).toEqual({ anthropic: ALL.anthropic });
    expect(JSON.stringify(plan)).not.toContain('UNRELATED');
    expect(JSON.stringify(plan)).not.toContain(ALL.openai);
  });

  it('never lets a secret value reach the agent env, the config, the script or the image', async () => {
    const plan = await planProxy({ services: ['anthropic', 'openai', 'venice', 'ollama'], secrets: ALL });
    const everythingButSecrets = JSON.stringify({ config: plan.config, agentEnv: plan.agentEnv, image: plan.image, addHosts: plan.addHosts }) + plan.scriptSource;
    for (const value of Object.values(ALL)) {
      expect(everythingButSecrets).not.toContain(value);
      expect(Object.values(plan.agentEnv)).not.toContain(value);
    }
    expect(everythingButSecrets).not.toContain('CANARY');
  });

  it('needs no secret and no add-host for services that inject nothing and are not ollama', async () => {
    const plan = await planProxy({ services: ['ollama'], secrets: {} });
    expect(plan.secrets).toEqual({});
    expect(plan.addHosts).toEqual(['host.docker.internal:host-gateway']);
    const onlyAnthropic = await planProxy({ services: ['anthropic'], secrets: { anthropic: ALL.anthropic } });
    expect(onlyAnthropic.addHosts).toBeUndefined();
  });

  it('plans an empty route table for no services', async () => {
    const plan = await planProxy({ services: [], secrets: {} });
    expect(plan.config.routes).toEqual([]);
    expect(plan.agentEnv).toEqual({});
    expect(plan.secrets).toEqual({});
  });

  it('collapses duplicate service names', async () => {
    const plan = await planProxy({ services: ['anthropic', 'anthropic'], secrets: { anthropic: ALL.anthropic } });
    expect(plan.config.routes).toHaveLength(1);
  });

  it('honours image and limit overrides', async () => {
    const plan = await planProxy({ services: [], secrets: {}, image: 'registry.example/node:22-slim@sha256:' + 'a'.repeat(64), maxBodyBytes: 1000, upstreamTimeoutMs: 2000 });
    expect(plan.image).toContain('registry.example/node');
    expect(plan.config.maxBodyBytes).toBe(1000);
    expect(plan.config.upstreamTimeoutMs).toBe(2000);
  });

  it('returns fresh objects: editing a plan cannot change a preset or a later plan', async () => {
    const first = await planProxy({ services: ['anthropic'], secrets: { anthropic: ALL.anthropic } });
    first.config.routes[0]!.upstream = 'https://evil.example';
    first.config.routes[0]!.inject.length = 0;
    first.agentEnv['EXTRA'] = 'x';
    expect(SERVICE_PRESETS['anthropic']!.upstream).toBe('https://api.anthropic.com');
    const second = await planProxy({ services: ['anthropic'], secrets: { anthropic: ALL.anthropic } });
    expect(second.config.routes[0]!.upstream).toBe('https://api.anthropic.com');
    expect(second.config.routes[0]!.inject).toHaveLength(1);
    expect(second.agentEnv['EXTRA']).toBeUndefined();
  });
});

describe('planProxy: fail closed', () => {
  it('throws MISSING_SECRET naming every missing secret and no values', async () => {
    const error = await failureOf(planProxy({ services: ['anthropic', 'openai', 'venice'], secrets: { venice: ALL.venice, github: 'ghp_OTHER_CANARY_ffffff' } }));
    expect(error.code).toBe('MISSING_SECRET');
    expect(error.message).toContain('anthropic');
    expect(error.message).toContain('openai');
    expect(error.message).not.toContain('venice,');
    expect(JSON.stringify(error.details)).toBe(JSON.stringify({ missing: ['anthropic', 'openai'] }));
    expect(error.message + JSON.stringify(error.details)).not.toContain('CANARY');
  });

  it('treats an empty string and a non-own property as missing', async () => {
    expect((await failureOf(planProxy({ services: ['anthropic'], secrets: { anthropic: '' } }))).code).toBe('MISSING_SECRET');
    const inherited = Object.create({ anthropic: ALL.anthropic }) as Record<string, string>;
    expect((await failureOf(planProxy({ services: ['anthropic'], secrets: inherited }))).code).toBe('MISSING_SECRET');
  });

  it.each([
    ['newline', 'abc\ndef'],
    ['carriage return', 'abc\rdef'],
    ['NUL', 'abc\0def'],
    ['leading space', ' abc'],
    ['trailing newline', 'abc\n'],
    ['non-ASCII', 'abcé'],
  ])('refuses a secret value containing %s (it would corrupt the env file or the header)', async (_label, value) => {
    const error = await failureOf(planProxy({ services: ['anthropic'], secrets: { anthropic: `${value}-CANARY` } }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('anthropic');
    expect(error.message).not.toContain('CANARY');
  });

  it('refuses to build a plan whose agent env would contain a secret value', async () => {
    const error = await failureOf(planProxy({ services: ['anthropic'], secrets: { anthropic: PROXY_PLACEHOLDER_KEY } }));
    expect(error.code).toBe('POLICY_VIOLATION');
  });

  it('rejects an unknown service with INVALID_INPUT', async () => {
    const error = await failureOf(planProxy({ services: ['anthropic', 'gemini'], secrets: ALL }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('anthropic, ollama, openai, venice');
  });

  it('rejects a bad image reference and bad limits', async () => {
    expect((await failureOf(planProxy({ services: [], secrets: {}, image: '--privileged' }))).code).toBe('INVALID_INPUT');
    expect((await failureOf(planProxy({ services: [], secrets: {}, maxBodyBytes: 0 }))).code).toBe('INVALID_INPUT');
    expect((await failureOf(planProxy({ services: [], secrets: {}, upstreamTimeoutMs: -5 }))).code).toBe('INVALID_INPUT');
  });
});

describe('planProxy: extraRoutes get the sidecar\'s own validation', () => {
  const bad: Array<[label: string, route: ProxyRoute]> = [
    ['prefix without a leading slash', extra({ pathPrefix: 'fake' })],
    ['prefix containing ..', extra({ pathPrefix: '/a/../b' })],
    ['root prefix', extra({ pathPrefix: '/' })],
    ['prefix colliding with a preset', extra({ pathPrefix: '/anthropic' })],
    ['name colliding with a preset', extra({ name: 'anthropic', pathPrefix: '/other' })],
    ['ftp upstream', extra({ upstream: 'ftp://example.com' })],
    ['javascript upstream', extra({ upstream: 'javascript:alert(1)' })],
    ['upstream with embedded credentials', extra({ upstream: 'https://user:pass@example.com' })],
    ['http upstream without opt-in', extra({ upstream: 'http://example.com', allowInsecureUpstream: false })],
    ['header that is not a token', extra({ inject: [{ header: 'x api key', secret: 'k' }] })],
    ['hop-by-hop header', extra({ inject: [{ header: 'Transfer-Encoding', secret: 'k' }] })],
    ['bad secret name', extra({ inject: [{ header: 'x-api-key', secret: 'Not_Valid' }] })],
    ['bad scheme', extra({ inject: [{ header: 'authorization', secret: 'k', scheme: 'Bearer token' }] })],
  ];
  it.each(bad)('rejects: %s', async (_label, route) => {
    const error = await failureOf(planProxy({ services: ['anthropic'], secrets: { anthropic: ALL.anthropic, k: 'v' }, extraRoutes: [route] }));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('rejects two extra routes that share a prefix', async () => {
    const error = await failureOf(planProxy({ services: [], secrets: {}, extraRoutes: [extra(), extra({ name: 'fake2' })] }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('duplicate path prefix');
  });

  it('requires the secret an extra route injects', async () => {
    const route = extra({ inject: [{ header: 'x-api-key', secret: 'fake-key' }] });
    expect((await failureOf(planProxy({ services: [], secrets: {}, extraRoutes: [route] }))).code).toBe('MISSING_SECRET');
    const plan = await planProxy({ services: [], secrets: { 'fake-key': 'v-1', unrelated: 'u' }, extraRoutes: [route] });
    expect(plan.secrets).toEqual({ 'fake-key': 'v-1' });
  });

  it('copies extra routes instead of keeping a reference to the caller\'s objects', async () => {
    const route = extra();
    const plan = await planProxy({ services: [], secrets: {}, extraRoutes: [route] });
    route.upstream = 'http://127.0.0.1:1';
    expect(plan.config.routes[0]!.upstream).toBe('http://127.0.0.1:9');
  });
});

describe('planProxy -> sidecar contract', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('a plan, delivered as env exactly like the lifecycle will, produces a working injecting sidecar', async () => {
    const up = await startUpstream();
    closers.push(up.close);
    const plan = await planProxy({
      services: [],
      secrets: { 'fake-key': 'plan-secret-value-123' },
      extraRoutes: [{ name: 'fake', pathPrefix: '/fake', upstream: up.url, inject: [{ header: 'x-api-key', secret: 'fake-key' }], allowInsecureUpstream: true }],
    });
    const env: NodeJS.ProcessEnv = { [PROXY_CONFIG_ENV]: JSON.stringify({ ...plan.config, listenPort: 0 }) };
    for (const [name, value] of Object.entries(plan.secrets)) env[secretEnvName(name)] = value;
    const lines: string[] = [];
    const server: http.Server = await runFromEnv(env, { stdout: (t) => lines.push(t), handleSignals: false, log: () => undefined });
    closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const port = (server.address() as AddressInfo).port;
    const reply = await send({ port, method: 'POST', path: '/fake/v1/x', body: '{}', headers: { 'x-api-key': PROXY_PLACEHOLDER_KEY } });
    expect(reply.status).toBe(200);
    expect(up.requests[0]!.headers['x-api-key']).toBe('plan-secret-value-123');
    expect(lines).toHaveLength(1);
  });
});
