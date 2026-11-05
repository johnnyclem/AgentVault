/**
 * Host-side data describing the services the credential proxy knows how to
 * reach. Never shipped to the sidecar: only the resulting routes are.
 *
 * WHY: the agent must call the proxy instead of the real API, so each service
 * needs (a) the fixed upstream and injection rule for the sidecar, and (b) the
 * env vars that point the vendor SDK at the proxy with a placeholder key.
 *
 * SECURITY STANCE: upstream hosts are literals here, never user input. The only
 * credential value in agentEnv is PROXY_PLACEHOLDER_KEY, which is not a secret.
 * Everything is deep-frozen so a caller cannot retarget a preset in-process.
 */

import { ContainerError, PROXY_ALIAS, PROXY_PLACEHOLDER_KEY, PROXY_PORT } from '../types.js';
import type { ProxyInjection } from '../types.js';

export interface ServicePreset {
  /** Fixed upstream origin plus optional base path. */
  readonly upstream: string;
  /** Path the agent calls on the proxy. */
  readonly pathPrefix: string;
  /** Empty = pass through without credentials. */
  readonly inject: readonly Readonly<ProxyInjection>[];
  /** Env for the AGENT: base URL at the proxy, placeholder key. Contains no secret. */
  readonly agentEnv: Readonly<Record<string, string>>;
  /** The conventional env var holding this service's real key on the host (secret name -> env var). */
  readonly keyEnv?: string;
  /** Permit an http:// upstream (local services only). */
  readonly allowInsecureUpstream?: boolean;
  /** `--add-host` entries the SIDECAR needs to reach the upstream. */
  readonly addHosts?: readonly string[];
}

const PROXY_ORIGIN = `http://${PROXY_ALIAS}:${PROXY_PORT}`;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const SERVICE_PRESETS: Readonly<Record<string, ServicePreset>> = deepFreeze({
  anthropic: {
    upstream: 'https://api.anthropic.com',
    pathPrefix: '/anthropic',
    inject: [{ header: 'x-api-key', secret: 'anthropic' }],
    agentEnv: {
      ANTHROPIC_BASE_URL: `${PROXY_ORIGIN}/anthropic`,
      ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY,
    },
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    upstream: 'https://api.openai.com',
    pathPrefix: '/openai',
    inject: [{ header: 'authorization', secret: 'openai', scheme: 'Bearer' }],
    agentEnv: {
      OPENAI_BASE_URL: `${PROXY_ORIGIN}/openai/v1`,
      OPENAI_API_KEY: PROXY_PLACEHOLDER_KEY,
    },
    keyEnv: 'OPENAI_API_KEY',
  },
  // src/inference/venice-client.ts defaults to https://api.venice.ai/api/v1.
  venice: {
    upstream: 'https://api.venice.ai',
    pathPrefix: '/venice',
    inject: [{ header: 'authorization', secret: 'venice', scheme: 'Bearer' }],
    agentEnv: {
      VENICE_BASE_URL: `${PROXY_ORIGIN}/venice/api/v1`,
      VENICE_API_KEY: PROXY_PLACEHOLDER_KEY,
    },
    keyEnv: 'VENICE_API_KEY',
  },
  ollama: {
    upstream: 'http://host.docker.internal:11434',
    pathPrefix: '/ollama',
    inject: [],
    agentEnv: {
      OLLAMA_HOST: `${PROXY_ORIGIN}/ollama`,
    },
    allowInsecureUpstream: true,
    addHosts: ['host.docker.internal:host-gateway'],
  },
});

/** Known service names, sorted. */
export function listPresetServices(): string[] {
  return Object.keys(SERVICE_PRESETS).sort();
}

/** Look up a preset or throw INVALID_INPUT naming the known services. */
export function getPreset(service: string): ServicePreset {
  const preset =
    typeof service === 'string' && Object.prototype.hasOwnProperty.call(SERVICE_PRESETS, service)
      ? SERVICE_PRESETS[service]
      : undefined;
  if (preset === undefined) {
    const shown = typeof service === 'string' ? service.slice(0, 64) : typeof service;
    throw new ContainerError(
      'INVALID_INPUT',
      `Unknown proxy service ${JSON.stringify(shown)}; known services: ${listPresetServices().join(', ')}`,
      { known: listPresetServices() }
    );
  }
  return preset;
}

/**
 * secret name -> the conventional env var that holds it on the host, for every
 * preset that injects a credential: { anthropic: 'ANTHROPIC_API_KEY', ... }.
 */
export function presetSecretEnvMapping(): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const service of listPresetServices()) {
    const preset = getPreset(service);
    if (preset.keyEnv === undefined) continue;
    for (const injection of preset.inject) mapping[injection.secret] = preset.keyEnv;
  }
  return mapping;
}
