/**
 * Policy: pure builders that turn a manifest plus a run request into the
 * ContainerSpec for the agent and for the credential-proxy sidecar. No I/O.
 *
 * Why it is separate from docker.ts: docker.ts knows how to express a spec as
 * argv and refuses unsafe ones; this file decides WHAT the spec is, and it is
 * where "the agent never holds a real API key" is made true.
 *
 * Security stance:
 *  - The agent environment is allow-listed. Only names the manifest declares
 *    are read from the host environment; nothing else is forwarded.
 *  - AgentVault's own variables, proxy secrets and docker/ssh credentials can
 *    never reach the agent: an explicit attempt is a POLICY_VIOLATION, a host
 *    value is silently dropped.
 *  - In proxy mode the placeholders are applied last, so a real key in the
 *    host environment cannot survive into the agent.
 *  - The sidecar receives secrets only through its environment, never in its
 *    command line or its config.
 */

import {
  ContainerError,
  DEFAULT_LIMITS,
  LABEL_AGENT,
  LABEL_MANAGED,
  LABEL_ROLE,
  PROXY_ALIAS,
  PROXY_CONFIG_ENV,
} from './types.js';
import type {
  ContainerMount,
  ContainerSpec,
  NetworkMode,
  ProxyPlan,
  ResourceLimits,
} from './types.js';
import type { ContainerManifest } from './manifest.js';
import {
  assertEnvName,
  assertImageRef,
  parseUser,
  resourceNames,
  secretEnvName,
  volumeKeysForPaths,
} from './validate.js';

// ---------------------------------------------------------------------------
// Agent environment denylist
// ---------------------------------------------------------------------------

/**
 * Names the agent must never receive. Matching is case-insensitive: a
 * lower-case twin of a protected variable is still a way to smuggle one in.
 */
export const AGENT_ENV_DENYLIST = {
  prefixes: ['AGENTVAULT_', 'AV_SECRET_', 'AV_PROXY_'],
  names: ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK'],
} as const;

export function isDeniedAgentEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    AGENT_ENV_DENYLIST.prefixes.some((prefix) => upper.startsWith(prefix)) ||
    (AGENT_ENV_DENYLIST.names as readonly string[]).includes(upper)
  );
}

function denied(name: string, origin: string): never {
  // The name is echoed, the value never is.
  throw new ContainerError(
    'POLICY_VIOLATION',
    `Refusing to pass ${name} to the agent (${origin}): it is reserved for AgentVault or grants access to the host`
  );
}

// ---------------------------------------------------------------------------
// Agent spec
// ---------------------------------------------------------------------------

export interface BuildAgentSpecInput {
  /** Valid agent name; every Docker resource name derives from it. */
  agent: string;
  image: string;
  manifest: ContainerManifest;
  /** Overrides the image CMD (exec-form argv). */
  command?: string[];
  network: NetworkMode;
  limits?: Partial<ResourceLimits>;
  /** The host environment. Only names the manifest declares are read from it. */
  hostEnv: Record<string, string | undefined>;
  /** Env the user typed (`--env K=V`). Subject to the denylist. */
  explicitEnv: Record<string, string>;
  /** Proxy mode: base URLs and placeholder keys. Applied last. */
  proxyAgentEnv?: Record<string, string>;
  extraMounts?: ContainerMount[];
  /** Opt out of the read-only root filesystem. */
  writableRootfs?: boolean;
  detach: boolean;
  restart?: 'no' | 'unless-stopped' | 'on-failure';
  interactive?: boolean;
}

const AGENT_TMPFS = ['/tmp', '/home/agent'];

/** A mount at `target` makes a tmpfs at `path` pointless or harmful. */
function covers(target: string, tmpfsPath: string): boolean {
  return target === tmpfsPath || tmpfsPath.startsWith(`${target}/`);
}

function definedLimits(limits: Partial<ResourceLimits> | undefined): Partial<ResourceLimits> {
  const out: Partial<ResourceLimits> = {};
  if (limits?.cpus !== undefined) out.cpus = limits.cpus;
  if (limits?.memory !== undefined) out.memory = limits.memory;
  if (limits?.pidsLimit !== undefined) out.pidsLimit = limits.pidsLimit;
  return out;
}

function dockerNetwork(mode: NetworkMode, internalNetwork: string): string {
  switch (mode) {
    case 'none':
      return 'none';
    case 'bridge':
      return 'bridge';
    case 'proxy':
      return internalNetwork;
    default:
      throw new ContainerError('INVALID_INPUT', `Unknown network mode ${JSON.stringify(String(mode))}`);
  }
}

function buildAgentEnv(input: BuildAgentSpecInput): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. What the user typed. A reserved name here is an error, not something to drop quietly.
  const explicit = new Set<string>();
  for (const [name, value] of Object.entries(input.explicitEnv)) {
    assertEnvName(name);
    if (isDeniedAgentEnvName(name)) denied(name, 'passed explicitly');
    env[name] = value;
    explicit.add(name);
  }

  // 2. Names the manifest declares, taken from the host. Reserved names are skipped silently:
  //    the host has them for its own reasons and the user did not ask for this one.
  for (const name of input.manifest.env) {
    if (explicit.has(name) || isDeniedAgentEnvName(name)) continue;
    const value = input.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }

  // 3. Proxy mode: placeholders and base URLs win over anything above, including a real host key.
  if (input.network === 'proxy' && input.proxyAgentEnv !== undefined) {
    for (const [name, value] of Object.entries(input.proxyAgentEnv)) {
      assertEnvName(name);
      if (isDeniedAgentEnvName(name)) denied(name, 'from the proxy plan');
      env[name] = value;
    }
  }
  return env;
}

export function buildAgentSpec(input: BuildAgentSpecInput): ContainerSpec {
  const names = resourceNames(input.agent);
  const image = assertImageRef(input.image);

  const user = input.manifest.isolation.user;
  const { uid, gid } = parseUser(user);
  if (uid === 0 || gid === 0) {
    throw new ContainerError('POLICY_VIOLATION', `Refusing to run agent "${input.agent}" as ${user}: uid and gid must be non-zero`);
  }

  const volumeMounts: ContainerMount[] = volumeKeysForPaths(input.manifest.volumes).map(({ key, containerPath }) => ({
    kind: 'volume',
    source: names.volume(key),
    target: containerPath,
  }));
  const mounts = [...volumeMounts, ...(input.extraMounts ?? [])];
  const seenTargets = new Set<string>();
  for (const mount of mounts) {
    if (seenTargets.has(mount.target)) {
      throw new ContainerError('INVALID_INPUT', `Mount target ${JSON.stringify(mount.target)} is used more than once`);
    }
    seenTargets.add(mount.target);
  }

  const tmpfs = AGENT_TMPFS.filter((p) => !mounts.some((m) => covers(m.target, p)));

  return {
    name: names.container,
    image,
    role: 'agent',
    ...(input.command !== undefined ? { command: input.command } : {}),
    user,
    network: dockerNetwork(input.network, names.network),
    mounts,
    tmpfs,
    env: buildAgentEnv(input),
    labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: input.agent, [LABEL_ROLE]: 'agent' },
    limits: { ...DEFAULT_LIMITS, ...definedLimits(input.limits) },
    readOnlyRootfs: input.writableRootfs !== true,
    detach: input.detach,
    ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
    init: true,
    restart: input.restart ?? 'no',
  };
}

// ---------------------------------------------------------------------------
// Credential-proxy sidecar spec
// ---------------------------------------------------------------------------

export interface BuildProxySpecInput {
  agent: string;
  plan: ProxyPlan;
  /**
   * The INTERNAL network the agent also sits on. Default: the agent's own
   * network from resourceNames(). The lifecycle connects the egress network
   * after the sidecar is created.
   */
  internalNetwork?: string;
}

/** Secrets shorter than this are not scanned for in the plan (too many false positives). */
const MIN_SCANNED_SECRET_LENGTH = 16;

/**
 * The sidecar runs as the node image's own non-root user, uid/gid 1000
 * ("node"). The sidecar image is node:22-slim, which ships that user; a
 * distinct UID from the agent's keeps the two processes' files apart.
 */
const PROXY_USER = '1000:1000';

function assertPlanHoldsNoSecretValues(plan: ProxyPlan, configJson: string): void {
  for (const value of Object.values(plan.secrets)) {
    if (value.length < MIN_SCANNED_SECRET_LENGTH) continue;
    if (plan.scriptSource.includes(value) || configJson.includes(value)) {
      throw new ContainerError(
        'POLICY_VIOLATION',
        'The proxy plan embeds a secret value in its script or config; secrets must travel only in the sidecar environment'
      );
    }
  }
}

export function buildProxySpec(input: BuildProxySpecInput): ContainerSpec {
  const names = resourceNames(input.agent);
  const { plan } = input;
  const configJson = JSON.stringify(plan.config);
  assertPlanHoldsNoSecretValues(plan, configJson);

  const env: Record<string, string> = { [PROXY_CONFIG_ENV]: configJson };
  for (const [secretName, value] of Object.entries(plan.secrets)) {
    env[secretEnvName(secretName)] = value;
  }

  return {
    name: names.proxy,
    image: assertImageRef(plan.image),
    role: 'proxy',
    command: ['node', '--input-type=module', '-e', plan.scriptSource],
    user: PROXY_USER,
    network: input.internalNetwork ?? names.network,
    networkAliases: [PROXY_ALIAS],
    ...(plan.addHosts !== undefined && plan.addHosts.length > 0 ? { addHosts: [...plan.addHosts] } : {}),
    mounts: [],
    tmpfs: ['/tmp'],
    env,
    labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: input.agent, [LABEL_ROLE]: 'proxy' },
    limits: { cpus: 1, memory: '256m', pidsLimit: 128 },
    readOnlyRootfs: true,
    detach: true,
    init: true,
    restart: 'no',
  };
}
