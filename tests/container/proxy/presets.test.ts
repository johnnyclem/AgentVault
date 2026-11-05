/**
 * Service presets: the host-side description of what the agent is pointed at.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_PRESETS, getPreset, listPresetServices, presetSecretEnvMapping } from '../../../src/container/proxy/presets.js';
import { validateProxyConfig } from '../../../src/container/proxy/credential-proxy.js';
import { ContainerError, PROXY_ALIAS, PROXY_PLACEHOLDER_KEY, PROXY_PORT } from '../../../src/container/types.js';

const ORIGIN = `http://${PROXY_ALIAS}:${PROXY_PORT}`;

describe('SERVICE_PRESETS', () => {
  it('describes the four supported services exactly', () => {
    expect(listPresetServices()).toEqual(['anthropic', 'ollama', 'openai', 'venice']);
    expect(SERVICE_PRESETS['anthropic']).toEqual({
      upstream: 'https://api.anthropic.com',
      pathPrefix: '/anthropic',
      inject: [{ header: 'x-api-key', secret: 'anthropic' }],
      agentEnv: { ANTHROPIC_BASE_URL: `${ORIGIN}/anthropic`, ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY },
      keyEnv: 'ANTHROPIC_API_KEY',
    });
    expect(SERVICE_PRESETS['openai']).toEqual({
      upstream: 'https://api.openai.com',
      pathPrefix: '/openai',
      inject: [{ header: 'authorization', secret: 'openai', scheme: 'Bearer' }],
      agentEnv: { OPENAI_BASE_URL: `${ORIGIN}/openai/v1`, OPENAI_API_KEY: PROXY_PLACEHOLDER_KEY },
      keyEnv: 'OPENAI_API_KEY',
    });
    expect(SERVICE_PRESETS['venice']).toEqual({
      upstream: 'https://api.venice.ai',
      pathPrefix: '/venice',
      inject: [{ header: 'authorization', secret: 'venice', scheme: 'Bearer' }],
      agentEnv: { VENICE_BASE_URL: `${ORIGIN}/venice/api/v1`, VENICE_API_KEY: PROXY_PLACEHOLDER_KEY },
      keyEnv: 'VENICE_API_KEY',
    });
    expect(SERVICE_PRESETS['ollama']).toEqual({
      upstream: 'http://host.docker.internal:11434',
      pathPrefix: '/ollama',
      inject: [],
      agentEnv: { OLLAMA_HOST: `${ORIGIN}/ollama` },
      allowInsecureUpstream: true,
      addHosts: ['host.docker.internal:host-gateway'],
    });
  });

  it('every preset is a valid sidecar route', () => {
    const routes = listPresetServices().map((name) => {
      const preset = getPreset(name);
      return {
        name,
        pathPrefix: preset.pathPrefix,
        upstream: preset.upstream,
        inject: preset.inject.map((i) => ({ ...i })),
        ...(preset.allowInsecureUpstream === undefined ? {} : { allowInsecureUpstream: preset.allowInsecureUpstream }),
      };
    });
    expect(() => validateProxyConfig({ version: 1, listenPort: 8080, routes, maxBodyBytes: 1, upstreamTimeoutMs: 1 })).not.toThrow();
  });

  it('only ollama may use plain http, and only it needs add-host', () => {
    for (const name of listPresetServices()) {
      const preset = getPreset(name);
      if (name === 'ollama') continue;
      expect(preset.upstream.startsWith('https://'), name).toBe(true);
      expect(preset.allowInsecureUpstream, name).toBeUndefined();
      expect(preset.addHosts, name).toBeUndefined();
    }
  });

  it('hands the agent only proxy URLs and the placeholder, never a key-shaped value', () => {
    for (const name of listPresetServices()) {
      for (const [key, value] of Object.entries(getPreset(name).agentEnv)) {
        if (key.endsWith('_KEY')) expect(value, `${name}.${key}`).toBe(PROXY_PLACEHOLDER_KEY);
        else expect(value.startsWith(`${ORIGIN}/${name}`), `${name}.${key}`).toBe(true);
      }
    }
  });

  it('maps an SDK base URL + call path onto the upstream path the real API expects', () => {
    // upstream path = (agent path - pathPrefix); the preset upstreams carry no base path.
    const upstreamPathFor = (service: string, envName: string, sdkSuffix: string): string => {
      const preset = getPreset(service);
      const agentPath = new URL(`${preset.agentEnv[envName]}${sdkSuffix}`).pathname;
      expect(agentPath.startsWith(`${preset.pathPrefix}/`)).toBe(true);
      return agentPath.slice(preset.pathPrefix.length);
    };
    expect(upstreamPathFor('anthropic', 'ANTHROPIC_BASE_URL', '/v1/messages')).toBe('/v1/messages');
    expect(upstreamPathFor('openai', 'OPENAI_BASE_URL', '/chat/completions')).toBe('/v1/chat/completions');
    expect(upstreamPathFor('venice', 'VENICE_BASE_URL', '/chat/completions')).toBe('/api/v1/chat/completions');
    expect(upstreamPathFor('ollama', 'OLLAMA_HOST', '/api/chat')).toBe('/api/chat');
  });

  it('keeps the Venice preset consistent with the repo\'s own Venice client default', () => {
    const client = fs.readFileSync(new URL('../../../src/inference/venice-client.ts', import.meta.url), 'utf8');
    const preset = getPreset('venice');
    const base = new URL(`${preset.upstream}${new URL(preset.agentEnv['VENICE_BASE_URL']!).pathname.slice(preset.pathPrefix.length)}`).href;
    expect(client).toContain(`'${base}'`);
  });

  it('is frozen: nothing in-process can retarget a preset', () => {
    expect(Object.isFrozen(SERVICE_PRESETS)).toBe(true);
    expect(Object.isFrozen(SERVICE_PRESETS['anthropic'])).toBe(true);
    expect(Object.isFrozen(SERVICE_PRESETS['anthropic']!.inject[0])).toBe(true);
    expect(Object.isFrozen(SERVICE_PRESETS['ollama']!.addHosts)).toBe(true);
    expect(() => {
      (SERVICE_PRESETS['anthropic'] as { upstream: string }).upstream = 'https://evil.example';
    }).toThrow(TypeError);
    expect(SERVICE_PRESETS['anthropic']!.upstream).toBe('https://api.anthropic.com');
  });
});

describe('getPreset', () => {
  it('rejects an unknown service with INVALID_INPUT listing the known ones', () => {
    let caught: unknown;
    try {
      getPreset('gemini');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContainerError);
    expect((caught as ContainerError).code).toBe('INVALID_INPUT');
    expect((caught as ContainerError).message).toContain('anthropic, ollama, openai, venice');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'ANTHROPIC', ' anthropic'])('does not resolve %j through the prototype chain or by loose matching', (name) => {
    expect(() => getPreset(name)).toThrow(ContainerError);
  });

  it('survives a non-string and truncates a long name in the message', () => {
    expect(() => getPreset(undefined as unknown as string)).toThrow(ContainerError);
    try {
      getPreset('x'.repeat(500));
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('presetSecretEnvMapping', () => {
  it('maps secret names to their conventional env vars, and leaves out services with no key', () => {
    expect(presetSecretEnvMapping()).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      venice: 'VENICE_API_KEY',
    });
  });

  it('returns a fresh object each call', () => {
    const a = presetSecretEnvMapping();
    a['anthropic'] = 'CHANGED';
    expect(presetSecretEnvMapping()['anthropic']).toBe('ANTHROPIC_API_KEY');
  });
});
