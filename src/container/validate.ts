/**
 * Input validation for everything that ends up in a docker argv, a docker
 * resource name, or a host path.
 *
 * Why this is strict: docker names double as flags (`--name=x`), mount specs
 * split on `,` and `:`, and image refs starting with `-` are parsed as options.
 * sanitizePathPart() in src/utils/path-validation.ts allows leading `-`/`.`
 * and so is NOT sufficient for Docker names (see the research brief); use
 * these instead, and still use sanitizePathPart for host path components.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { ContainerError, PROXY_SECRET_ENV_PREFIX } from './types.js';

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** No `_`: secretEnvName() maps `-` to `_`, so allowing both would make two names share one env var. */
export const SECRET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const VOLUME_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Loose but safe: no whitespace/control chars, cannot start with `-`. */
export const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;
/** Absolute container path; no `:`/`,`/`=`/quotes (mount-spec metacharacters). */
export const CONTAINER_PATH_RE = /^\/[A-Za-z0-9._/-]{0,200}$/;

function invalid(what: string, value: string, rule: string): never {
  // Value is echoed back for debuggability; callers must not pass secrets here.
  throw new ContainerError('INVALID_INPUT', `Invalid ${what} ${JSON.stringify(value)}: ${rule}`);
}

export function assertAgentName(name: string): string {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    invalid('agent name', String(name), 'use 1-40 chars of a-z, 0-9, "_" or "-", starting with a letter or digit');
  }
  return name;
}

export function assertSecretName(name: string): string {
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    invalid('secret name', String(name), 'use 1-32 chars of a-z, 0-9 or "-", starting with a letter');
  }
  return name;
}

export function assertVolumeKey(key: string): string {
  if (typeof key !== 'string' || !VOLUME_KEY_RE.test(key)) {
    invalid('volume key', String(key), 'use 1-32 chars of a-z, 0-9, "_" or "-", starting with a letter or digit');
  }
  return key;
}

export function assertEnvName(name: string): string {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
    invalid('environment variable name', String(name), 'must match [A-Za-z_][A-Za-z0-9_]*');
  }
  return name;
}

export function assertImageRef(ref: string): string {
  if (typeof ref !== 'string' || !IMAGE_REF_RE.test(ref)) {
    invalid('image reference', String(ref), 'no whitespace, cannot start with "-" or ".", max 255 chars');
  }
  return ref;
}

/** Absolute, normalized, no `..`, none of the mount-spec metacharacters. */
export function assertContainerPath(p: string): string {
  if (typeof p !== 'string' || !CONTAINER_PATH_RE.test(p)) {
    invalid('container path', String(p), 'must be absolute and use only [A-Za-z0-9._/-]');
  }
  if (p !== '/' && (p.endsWith('/') || p.split('/').some((seg) => seg === '..' || seg === '.'))) {
    invalid('container path', p, 'must be normalized (no "..", ".", or trailing "/")');
  }
  return p;
}

/**
 * A host path for a bind mount: absolute, no NUL/newline/`,`, and never the
 * Docker socket (mounting it hands the agent the host).
 */
export function assertBindSource(hostPath: string): string {
  if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) {
    invalid('bind-mount source', String(hostPath), 'must be an absolute host path');
  }
  if (/[\0\r\n,]/.test(hostPath)) {
    invalid('bind-mount source', hostPath, 'contains a forbidden character (NUL, newline, or comma)');
  }
  const normalized = path.resolve(hostPath);
  const base = path.basename(normalized);
  if (base === 'docker.sock' || base === 'containerd.sock' || normalized === '/' || normalized === '/var/run' || normalized === '/run') {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `Refusing to bind-mount ${normalized}: it would give the agent control of the host`
    );
  }
  return normalized;
}

/**
 * Env var the credential-proxy sidecar reads a secret from: "anthropic" ->
 * AV_SECRET_ANTHROPIC, "my-key" -> AV_SECRET_MY_KEY. The host (policy.ts) and
 * the sidecar (proxy/credential-proxy.ts) MUST agree on this mapping.
 */
export function secretEnvName(secretName: string): string {
  assertSecretName(secretName);
  return `${PROXY_SECRET_ENV_PREFIX}${secretName.toUpperCase().replace(/-/g, '_')}`;
}

/** "uid:gid", both numeric. Returns the parsed ids. */
export function parseUser(user: string): { uid: number; gid: number } {
  const m = /^(\d{1,10}):(\d{1,10})$/.exec(user);
  if (!m) {
    invalid('user', String(user), 'must be numeric "uid:gid"');
  }
  return { uid: Number(m![1]), gid: Number(m![2]) };
}

// ---------------------------------------------------------------------------
// Names of the Docker resources we create for one agent.
// ---------------------------------------------------------------------------

export interface ResourceNames {
  container: string;
  proxy: string;
  /** The INTERNAL network: the agent and its sidecar, no route out. */
  network: string;
  /**
   * The sidecar's own egress network (non-internal, sidecar only). It must not
   * be the shared default bridge: the sidecar listens on 0.0.0.0 and holds the
   * real credentials, so every container on a shared bridge could use them.
   */
  egress: string;
  /** Docker volume name for a volume key. */
  volume: (key: string) => string;
}

export function resourceNames(agent: string): ResourceNames {
  assertAgentName(agent);
  return {
    container: `av-${agent}`,
    proxy: `av-${agent}-proxy`,
    network: `av-${agent}-net`,
    egress: `av-${agent}-egress`,
    volume: (key: string) => `av-${agent}-${assertVolumeKey(key)}`,
  };
}

/** Derive a stable volume key from a container path: "/data" -> "data". */
export function volumeKeyForPath(containerPath: string): string {
  assertContainerPath(containerPath);
  const key = containerPath.replace(/^\/+/, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
  if (!key) {
    invalid('volume path', containerPath, 'cannot derive a volume key from the root path');
  }
  return assertVolumeKey(key.slice(0, 32));
}

/**
 * Map every manifest volume path to its key and refuse collisions. The key
 * derivation is lossy ("/a/b" and "/a-b" both give "a-b"), and a collision
 * would silently make two paths share one Docker volume.
 */
export function volumeKeysForPaths(containerPaths: readonly string[]): Array<{ key: string; containerPath: string }> {
  const seen = new Map<string, string>();
  const out: Array<{ key: string; containerPath: string }> = [];
  for (const containerPath of containerPaths) {
    const key = volumeKeyForPath(containerPath);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new ContainerError(
        'INVALID_INPUT',
        `Volume paths ${JSON.stringify(previous)} and ${JSON.stringify(containerPath)} both map to volume key ${JSON.stringify(key)}; rename one`
      );
    }
    seen.set(key, containerPath);
    out.push({ key, containerPath });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host directories
// ---------------------------------------------------------------------------

/**
 * Call-time (not import-time) so tests can redirect it. There is no central
 * helper elsewhere in the repo; src/container uses this one only.
 */
export function agentvaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENTVAULT_HOME'];
  if (override && path.isAbsolute(override)) {
    return override;
  }
  return path.join(os.homedir(), '.agentvault');
}
