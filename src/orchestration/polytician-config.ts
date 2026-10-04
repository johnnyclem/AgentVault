/**
 * How AgentVault starts Polytician: the namespace its calls go to, and the
 * AgentVault settings it passes on so Polytician registers its vault_* tools.
 * Shared by the CLI, orchestrate and the webapp; reads nothing from disk.
 */

import * as path from 'node:path';
import type { MCPServerConfig } from './mcp-client.js';

/** Polytician's namespace rule (its NAMESPACE_PATTERN); POLYTICIAN_NAMESPACES may narrow it further. */
export const POLYTICIAN_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The namespace Polytician uses for a call that names none. */
export const DEFAULT_POLYTICIAN_NAMESPACE = 'default';

/** The name AgentVault knows the Polytician server by (MCPServerConfig.namespace). */
export const POLYTICIAN_SERVER_LABEL = 'polytician';

const NAMESPACE_RULE = "1-64 letters, digits, '.', '_', ':' or '-', starting with a letter or digit";

/**
 * A Polytician setting AgentVault cannot use, found before Polytician is
 * started. Its message says what to change and carries no secret.
 */
export class PolyticianConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolyticianConfigError';
  }
}

export function isValidPolyticianNamespace(value: string): boolean {
  return POLYTICIAN_NAMESPACE_PATTERN.test(value);
}

/** The namespace, if it is one Polytician accepts; source says where it came from (an option name, say). */
export function checkPolyticianNamespace(value: string, source: string): string {
  if (!isValidPolyticianNamespace(value)) {
    throw new PolyticianConfigError(`${source} ${JSON.stringify(value)} is not a valid Polytician namespace (${NAMESPACE_RULE})`);
  }
  return value;
}

/**
 * The namespace an agent's concepts go to when none is given: the agent's
 * name (from the project's agent.json or .agentvault/config/agent.config.json),
 * which is also the agentId the webapp addresses the agent by, else "default".
 * A name that cannot be a namespace is refused rather than replaced by
 * "default", which every agent without one shares.
 */
export function defaultPolyticianNamespace(agentName: string | undefined, option: string): string {
  if (agentName === undefined) {
    return DEFAULT_POLYTICIAN_NAMESPACE;
  }
  if (!isValidPolyticianNamespace(agentName)) {
    throw new PolyticianConfigError(
      `The project's agent name ${JSON.stringify(agentName)} is not a valid Polytician namespace (${NAMESPACE_RULE}); ` +
      `choose one with ${option}`
    );
  }
  return agentName;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** As Polytician checks its AgentVault URL: https, or plain http to this machine only. */
export function isAllowedAgentVaultUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/**
 * Why this AgentVault URL cannot be used (null when it can): Polytician
 * refuses anything but https or local http, and a URL carrying credentials
 * fails every request (Node's fetch refuses one) with an error that repeats
 * the whole URL, password included. Shows no credentials or path.
 */
export function agentVaultUrlProblem(raw: string, setting: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${setting} is not an absolute URL; give AgentVault's base URL, such as https://agentvault.example.com`;
  }
  if (!isAllowedAgentVaultUrl(raw)) {
    return `${setting} (${url.protocol}//${url.host}) must use https; plain http is allowed only for localhost, ` +
      '127.0.0.1 or [::1]. Polytician refuses any other AgentVault URL and would not start';
  }
  if (url.username || url.password) {
    return `${setting} carries credentials; give AgentVault's base URL without them ` +
      '(Polytician authenticates with the API token, and its HTTP client refuses a URL with credentials)';
  }
  return null;
}

/**
 * The AgentVault settings to add to Polytician's environment: AGENTVAULT_API_URL
 * (AgentVault's webapp base URL; Polytician appends /api/...) as
 * POLYTICIAN_AV_API_URL, and AGENTVAULT_POLYTICIAN_API_TOKEN (the token the
 * webapp's API requires) as POLYTICIAN_AV_API_TOKEN. Both AgentVault settings
 * must be set. Nothing is added when the operator set either POLYTICIAN_AV_*
 * setting: theirs win, and AgentVault's token never goes to a URL AgentVault
 * did not choose. An empty one counts as unset, as it does for Polytician.
 * Throws PolyticianConfigError for a URL that cannot be used.
 */
export function polyticianAgentVaultEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const url = env['AGENTVAULT_API_URL'];
  const token = env['AGENTVAULT_POLYTICIAN_API_TOKEN'];
  if (!url || !token || env['POLYTICIAN_AV_API_URL'] || env['POLYTICIAN_AV_API_TOKEN']) {
    return {};
  }
  const problem = agentVaultUrlProblem(url, 'AGENTVAULT_API_URL');
  if (problem) {
    throw new PolyticianConfigError(`${problem}. Fix AGENTVAULT_API_URL, or unset it to start Polytician without its vault_* tools`);
  }
  return { POLYTICIAN_AV_API_URL: url, POLYTICIAN_AV_API_TOKEN: token };
}

export interface PolyticianServerOptions {
  /** The command that starts Polytician over stdio */
  entryPoint: string;
  /** The Polytician namespace the agent's concepts live in */
  namespace: string;
  /** Polytician's config file (passed as --config; Polytician reads ~/.polytician/config.json without it) */
  configPath?: string;
  /** Environment variables for Polytician; they win over the AgentVault settings added from AgentVault's environment */
  env?: Record<string, string>;
  healthPort?: number;
}

/**
 * The MCPServerConfig AgentVault starts Polytician with: the namespace every
 * namespace-taking call names, the config file, and the environment with
 * polyticianAgentVaultEnv's settings added. Throws PolyticianConfigError for
 * an invalid namespace or AgentVault URL, before anything is started.
 */
export function polyticianServerConfig(
  options: PolyticianServerOptions,
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig {
  const namespace = checkPolyticianNamespace(options.namespace, 'The namespace');
  const childEnv = { ...polyticianAgentVaultEnv({ ...env, ...options.env }), ...options.env };
  return {
    namespace: POLYTICIAN_SERVER_LABEL,
    entryPoint: options.entryPoint,
    polyticianNamespace: namespace,
    ...(options.configPath ? { configPath: path.resolve(options.configPath) } : {}),
    ...(options.healthPort ? { healthPort: options.healthPort } : {}),
    ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
  };
}
