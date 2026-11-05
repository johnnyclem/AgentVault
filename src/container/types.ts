/**
 * Container MVP — shared contracts
 *
 * Everything in src/container/ codes against these types. The runtime is
 * driven through an injected CommandRunner so it is unit-testable without a
 * Docker daemon, and so the exact argv we hand to `docker` can be asserted.
 *
 * Module boundary (PRD-07 §4): nothing in src/container/ may import from
 * src/hypervault, src/wiki or src/total-recall. Only CLI/MCP glue crosses it.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ContainerErrorCode =
  /** The docker binary is not installed or not executable. */
  | 'NOT_INSTALLED'
  /** The binary exists but cannot reach a daemon. */
  | 'DAEMON_UNREACHABLE'
  /** The daemon refused us (socket permissions). */
  | 'PERMISSION_DENIED'
  /** A docker command ran and exited non-zero. */
  | 'COMMAND_FAILED'
  /** A docker command exceeded its timeout. */
  | 'TIMEOUT'
  /** A name, path, image ref or option failed validation. */
  | 'INVALID_INPUT'
  /** Policy refused the request (for example: running as root). */
  | 'POLICY_VIOLATION'
  /** A secret the agent needs is not available. Fail closed. */
  | 'MISSING_SECRET'
  /** A snapshot or archive failed an integrity or safety check. */
  | 'INTEGRITY'
  /** The thing asked for does not exist. */
  | 'NOT_FOUND';

export class ContainerError extends Error {
  readonly code: ContainerErrorCode;
  /** Extra, non-secret context (never put secret values here). */
  readonly details?: Record<string, unknown>;

  constructor(code: ContainerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ContainerError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface CommandResult {
  /**
   * Process exit code. 127 when the binary could not be started, 124 on
   * timeout. Never undefined: callers must not have to guess.
   */
  exitCode: number;
  stdout: string;
  /**
   * Includes spawn-level failures folded in (ENOENT, EACCES, timeout) so that
   * "docker is not installed" is never an empty string.
   */
  stderr: string;
  timedOut: boolean;
  /** True when the binary itself could not be started (ENOENT / EACCES). */
  spawnFailed: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /** Text/bytes written to stdin. */
  input?: string | Buffer;
  /** Stream this file to stdin (binary-safe; for volume restore). */
  stdinFile?: string;
  /**
   * Stream stdout to this file (binary-safe; for volume snapshot). The file
   * is created with mode 0600. `CommandResult.stdout` is '' in this mode.
   */
  stdoutFile?: string;
  /** Inherit the parent's stdio (for `logs --follow`, interactive exec). */
  inheritStdio?: boolean;
}

/**
 * Never throws for a non-zero exit or a missing binary: it reports them in
 * the result. It may throw only for programmer errors (bad options).
 */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions
) => Promise<CommandResult>;

// ---------------------------------------------------------------------------
// Isolation policy (PRD-01 §4.3, PRD-08 §4)
// ---------------------------------------------------------------------------

/**
 * none   — no network at all (default when no proxy is requested)
 * proxy  — private `--internal` network; the only route out is the sidecar
 * bridge — Docker's default bridge: UNRESTRICTED egress. Explicit opt-out.
 */
export type NetworkMode = 'none' | 'proxy' | 'bridge';

export interface ResourceLimits {
  /** Docker --cpus */
  cpus: number;
  /** Docker --memory, e.g. "2g" */
  memory: string;
  /** Docker --pids-limit */
  pidsLimit: number;
}

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = {
  cpus: 2,
  memory: '2g',
  pidsLimit: 512,
};

/** Non-root UID:GID baked into generated images and enforced at run time. */
export const DEFAULT_AGENT_USER = '10001:10001';

export type ContainerRole = 'agent' | 'proxy' | 'helper';

export interface ContainerMount {
  kind: 'volume' | 'bind';
  /** Volume name (kind=volume) or absolute host path (kind=bind). */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  readOnly?: boolean;
}

/**
 * Pure description of one container. `buildRunArgs(spec)` (docker.ts) turns it
 * into argv. Invariants enforced there and covered by tests:
 *   always --cap-drop ALL and no-new-privileges; never --privileged, never
 *   host network/pid/ipc; always --pids-limit and --memory; non-root unless
 *   `allowRoot` (only the snapshot helper sets it).
 */
export interface ContainerSpec {
  name: string;
  image: string;
  role: ContainerRole;
  /** Overrides the image CMD. Everything after the image in `docker run`. */
  command?: string[];
  /** Overrides the image ENTRYPOINT (single executable). */
  entrypoint?: string;
  /** "uid:gid", both numeric. */
  user: string;
  /** Permit uid 0. Only for the snapshot/restore helper. */
  allowRoot?: boolean;
  /** Docker network name, or 'none'. */
  network: string;
  networkAliases?: string[];
  /** `--add-host name:ip` entries (for example host.docker.internal:host-gateway). */
  addHosts?: string[];
  mounts: ContainerMount[];
  /** Absolute container paths mounted as tmpfs. */
  tmpfs: string[];
  /**
   * Delivered through a 0600 --env-file that is deleted right after the
   * container is created. NEVER on argv (it would show in `ps`).
   */
  env: Record<string, string>;
  labels: Record<string, string>;
  limits: ResourceLimits;
  readOnlyRootfs: boolean;
  /** Capabilities added back after --cap-drop ALL. Default []. */
  capAdd?: string[];
  /** Detached (`-d`) vs foreground. */
  detach: boolean;
  /** Keep stdin open (`-i`). Set automatically when a stdinFile is given. */
  interactive?: boolean;
  /** `--rm` */
  autoRemove?: boolean;
  /** Use tini as PID 1 so signals are forwarded and zombies reaped. */
  init: boolean;
  restart?: 'no' | 'unless-stopped' | 'on-failure';
  stopTimeoutSec?: number;
}

// ---------------------------------------------------------------------------
// Labels — Docker is the source of truth; we keep no host-side registry.
// ---------------------------------------------------------------------------

export const LABEL_MANAGED = 'agentvault.managed';
export const LABEL_AGENT = 'agentvault.agent';
export const LABEL_ROLE = 'agentvault.role';
/** On images: the JSON-encoded ContainerManifest. */
export const LABEL_MANIFEST = 'agentvault.manifest';
export const LABEL_SOURCE_HASH = 'agentvault.source-hash';
/** On volumes: the volume key (e.g. "data") the snapshot code maps back. */
export const LABEL_VOLUME_KEY = 'agentvault.volume-key';

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface ImageInfo {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  labels: Record<string, string>;
  /** USER from the image config ('' when unset, meaning root). */
  user: string;
  sizeBytes: number;
}

export interface BuildRequest {
  /** Directory containing the (already filtered) build context. */
  contextDir: string;
  /** Path to the Dockerfile; defaults to <contextDir>/Dockerfile. */
  dockerfile?: string;
  tag: string;
  platform?: string;
  buildArgs?: Record<string, string>;
  /** Extra labels (the manifest label is already in the Dockerfile). */
  labels?: Record<string, string>;
  noCache?: boolean;
  timeoutMs?: number;
}

export interface BuildResult {
  imageId: string;
  tag: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** Docker state: running, exited, created, paused, restarting, dead. */
  state: string;
  /** Human status, e.g. "Up 3 minutes". */
  status: string;
  role: ContainerRole | 'unknown';
  agent: string;
  createdAt: string;
  labels: Record<string, string>;
}

export interface ContainerRuntime {
  readonly runner: CommandRunner;

  /** Throws ContainerError with a precise code if docker is unusable. */
  ensureAvailable(): Promise<{ serverVersion: string }>;

  inspectImage(ref: string): Promise<ImageInfo | null>;
  buildImage(request: BuildRequest): Promise<BuildResult>;
  /** Untag/remove an image. NOT_FOUND if it does not exist. */
  removeImage(ref: string): Promise<void>;

  /** Idempotent. `internal` => `docker network create --internal`. */
  ensureNetwork(name: string, options: { internal: boolean; labels?: Record<string, string> }): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  connectNetwork(container: string, network: string, aliases?: string[]): Promise<void>;

  /** Idempotent. */
  ensureVolume(name: string, labels?: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Names of AgentVault-managed volumes, optionally for one agent. */
  listVolumes(filter?: { agent?: string }): Promise<Array<{ name: string; key: string; agent: string }>>;

  /** Create + start detached. Returns the container id. */
  start(spec: ContainerSpec): Promise<{ id: string }>;
  /**
   * Run in the foreground and wait. Used for the attached agent run and for
   * helper containers. Honors spec-independent `io` for binary-safe streams.
   * Callers MUST check `exitCode`: a partial tar still exits non-zero only.
   */
  runForeground(
    spec: ContainerSpec,
    io?: {
      stdinFile?: string;
      stdoutFile?: string;
      inheritStdio?: boolean;
      /**
       * Kill the run after this long (exit code 124, timedOut). Helper
       * containers (snapshot, restore, emptiness probe) should always set it:
       * without one a wedged docker call blocks forever.
       */
      timeoutMs?: number;
    }
  ): Promise<CommandResult>;

  list(filter?: { agent?: string; all?: boolean }): Promise<ContainerInfo[]>;
  logs(name: string, options?: { tail?: number; follow?: boolean; since?: string }): Promise<CommandResult>;
  stop(name: string, timeoutSec?: number): Promise<void>;
  remove(name: string, options?: { force?: boolean }): Promise<void>;
  inspect(name: string): Promise<unknown>;
  stats(name: string): Promise<CommandResult>;
  exec(name: string, command: string[], options?: { interactive?: boolean }): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Credential proxy (PRD-04). Reverse-proxy model: the agent is pointed at
// http://agentvault-proxy:8080/<service> and never chooses the upstream host.
// ---------------------------------------------------------------------------

export interface ProxyInjection {
  /** Header written on the upstream request (any inbound copy is stripped). */
  header: string;
  /** Key into the sidecar's secret map. */
  secret: string;
  /** Prefix such as "Bearer" -> `Bearer <value>`. Omit for a bare value. */
  scheme?: string;
}

export interface ProxyRoute {
  /** Service name, e.g. "anthropic". */
  name: string;
  /** Path the agent calls, e.g. "/anthropic". Must start with "/", no "..". */
  pathPrefix: string;
  /** Fixed upstream origin plus optional base path, e.g. "https://api.anthropic.com". */
  upstream: string;
  /** Empty = pass through without credentials (e.g. local Ollama). */
  inject: ProxyInjection[];
  /** Permit http:// upstreams. Config is trusted (written by the CLI). */
  allowInsecureUpstream?: boolean;
}

/** Named CredentialProxyConfig to avoid clashing with src/pilot ProxyConfig. */
export interface CredentialProxyConfig {
  version: 1;
  listenPort: number;
  routes: ProxyRoute[];
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

export const PROXY_ALIAS = 'agentvault-proxy';
export const PROXY_PORT = 8080;
/** Placeholder the agent sees in place of a real key. Not a secret. */
export const PROXY_PLACEHOLDER_KEY = 'agentvault-proxy-placeholder';
/** Env var prefix the sidecar reads secrets from: AV_SECRET_<NAME>. */
export const PROXY_SECRET_ENV_PREFIX = 'AV_SECRET_';
export const PROXY_CONFIG_ENV = 'AV_PROXY_CONFIG';

/** Everything the lifecycle needs to start the sidecar. Built by proxy/plan.ts. */
export interface ProxyPlan {
  config: CredentialProxyConfig;
  /** secret name -> plaintext. Goes to the SIDECAR only, never to the agent. */
  secrets: Record<string, string>;
  /** Env for the AGENT: base URLs at the proxy plus placeholder keys. */
  agentEnv: Record<string, string>;
  /** Self-contained ESM source run as `node --input-type=module -e <source>`. */
  scriptSource: string;
  /** Image the sidecar runs in. */
  image: string;
  /** Extra `--add-host` entries for the sidecar (for example host-gateway). */
  addHosts?: string[];
}

// ---------------------------------------------------------------------------
// Lifecycle (lifecycle.ts): start/stop/remove one agent and its sidecar
// ---------------------------------------------------------------------------

export interface StartAgentRequest {
  runtime: ContainerRuntime;
  /** Valid agent name (assertAgentName). Resource names derive from it. */
  agent: string;
  /** Image to run. Its `agentvault.manifest` label is the source of truth. */
  image: string;
  /** Overrides the image CMD (exec-form argv). */
  command?: string[];
  /**
   * Default: 'proxy' when `proxyPlan` is given, otherwise the manifest's
   * isolation.network.
   */
  network?: NetworkMode;
  /** Required when network is 'proxy' or the manifest declares `secrets`. */
  proxyPlan?: ProxyPlan;
  /**
   * Docker network the sidecar uses to reach the internet. Default: a dedicated
   * per-agent network (resourceNames(agent).egress) that the lifecycle creates
   * and removes, with only the sidecar on it. Passing 'bridge' puts the sidecar
   * on the shared default bridge, where EVERY container on the host can reach
   * it and spend the agent's credentials - the lifecycle warns when asked to.
   */
  proxyEgressNetwork?: string;
  limits?: Partial<ResourceLimits>;
  /** Env the user typed (`--env K=V`). Subject to the secret-name denylist. */
  explicitEnv?: Record<string, string>;
  /**
   * The host environment (process.env). ONLY names the manifest declares in
   * `env` are copied from it; nothing else is forwarded.
   */
  hostEnv?: Record<string, string | undefined>;
  extraMounts?: ContainerMount[];
  /** Opt out of the read-only root filesystem. */
  writableRootfs?: boolean;
  /** Default true. false = run in the foreground and wait. */
  detach?: boolean;
  restart?: 'no' | 'unless-stopped' | 'on-failure';
  onWarning?: (message: string) => void;
}

export interface StartedAgent {
  agent: string;
  containerName: string;
  /** Set when detached. */
  containerId?: string;
  proxyContainerName?: string;
  networkName?: string;
  /** Docker volume names backing the manifest's volumes. */
  volumes: string[];
  network: NetworkMode;
  warnings: string[];
  /** Set when run in the foreground. */
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface SecretResolver {
  /** Resolve every name or throw ContainerError('MISSING_SECRET'). */
  resolve(names: readonly string[]): Promise<Record<string, string>>;
}
