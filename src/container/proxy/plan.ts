/**
 * Builds a ProxyPlan: everything the lifecycle needs to start the credential
 * sidecar for one agent.
 *
 * WHY: one place decides which routes exist, which secrets the sidecar gets and
 * which env the agent gets, so those three can never drift apart.
 *
 * SECURITY STANCE
 *  - Fail closed: a service that injects a credential requires that secret to be
 *    present and non-empty, otherwise MISSING_SECRET (names only, never values).
 *  - plan.secrets holds ONLY secrets the selected routes reference. Unrelated
 *    secrets the caller happened to resolve never reach the sidecar.
 *  - plan.agentEnv holds base URLs and placeholder keys. A final check refuses
 *    to return a plan whose agentEnv contains any secret value.
 *  - The route table is validated with the sidecar's own validator, so what the
 *    host accepts is exactly what the sidecar will accept.
 */

import { ContainerError } from '../types.js';
import type { CredentialProxyConfig, ProxyPlan, ProxyRoute } from '../types.js';
import { assertImageRef, assertSecretName } from '../validate.js';
import { ProxyConfigError, isValidSecretValue, referencedSecrets, validateProxyConfig } from './credential-proxy.js';
import { loadProxyScript } from './bundle.js';
import { getPreset } from './presets.js';

export const DEFAULT_PROXY_IMAGE = 'node:22-slim';
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;
const DEFAULT_LISTEN_PORT = 8080;

export interface PlanProxyOptions {
  /** Preset service names, e.g. ['anthropic', 'ollama']. */
  services: string[];
  /** secret name -> plaintext. Only the ones the selected routes reference are used. */
  secrets: Record<string, string>;
  /** Additional routes (tests aim one at a local fake upstream). Validated like the sidecar does. */
  extraRoutes?: ProxyRoute[];
  image?: string;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
}

function cloneRoute(route: ProxyRoute): ProxyRoute {
  const copy: ProxyRoute = {
    name: route.name,
    pathPrefix: route.pathPrefix,
    upstream: route.upstream,
    inject: route.inject.map((i) => (i.scheme === undefined ? { header: i.header, secret: i.secret } : { header: i.header, secret: i.secret, scheme: i.scheme })),
  };
  if (route.allowInsecureUpstream !== undefined) copy.allowInsecureUpstream = route.allowInsecureUpstream;
  return copy;
}

export async function planProxy(options: PlanProxyOptions): Promise<ProxyPlan> {
  const image = assertImageRef(options.image ?? DEFAULT_PROXY_IMAGE);

  const routes: ProxyRoute[] = [];
  const agentEnv: Record<string, string> = {};
  const addHosts: string[] = [];

  for (const service of [...new Set(options.services)]) {
    const preset = getPreset(service);
    routes.push(
      cloneRoute({
        name: service,
        pathPrefix: preset.pathPrefix,
        upstream: preset.upstream,
        inject: preset.inject.map((i) => ({ ...i })),
        ...(preset.allowInsecureUpstream === undefined ? {} : { allowInsecureUpstream: preset.allowInsecureUpstream }),
      })
    );
    Object.assign(agentEnv, preset.agentEnv);
    for (const host of preset.addHosts ?? []) {
      if (!addHosts.includes(host)) addHosts.push(host);
    }
  }
  for (const extra of options.extraRoutes ?? []) routes.push(cloneRoute(extra));

  let config: CredentialProxyConfig;
  try {
    config = validateProxyConfig({
      version: 1,
      listenPort: DEFAULT_LISTEN_PORT,
      routes,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      upstreamTimeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ProxyConfigError) throw new ContainerError('INVALID_INPUT', `Invalid proxy configuration: ${err.message}`);
    throw err;
  }

  // Fail closed, and hand the sidecar nothing beyond what its routes use.
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  const unusable: string[] = [];
  for (const name of referencedSecrets(config)) {
    assertSecretName(name);
    const value = Object.prototype.hasOwnProperty.call(options.secrets, name) ? options.secrets[name] : undefined;
    if (value === undefined || value === '') missing.push(name);
    else if (!isValidSecretValue(value)) unusable.push(name);
    else secrets[name] = value;
  }
  if (missing.length > 0) {
    throw new ContainerError(
      'MISSING_SECRET',
      `Credential proxy needs secret(s) that are not available: ${missing.join(', ')}. Store them before starting the agent.`,
      { missing }
    );
  }
  if (unusable.length > 0) {
    throw new ContainerError(
      'INVALID_INPUT',
      `Secret(s) ${unusable.join(', ')} cannot be injected: values must be printable ASCII with no newline, no leading or trailing space`,
      { unusable }
    );
  }

  for (const [secretName, value] of Object.entries(secrets)) {
    // Equality always; substring only for values long enough that a match is not a coincidence.
    const leaked = Object.values(agentEnv).some((v) => v === value || (value.length >= 8 && v.includes(value)));
    if (leaked) {
      throw new ContainerError('POLICY_VIOLATION', `Refusing to build a plan: agent environment would contain the value of secret ${secretName}`);
    }
  }

  const plan: ProxyPlan = {
    config,
    secrets,
    agentEnv,
    scriptSource: await loadProxyScript(),
    image,
  };
  if (addHosts.length > 0) plan.addHosts = addHosts;
  return plan;
}
