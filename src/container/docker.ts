/**
 * Docker runtime adapter: turns a ContainerSpec into a locked-down
 * `docker run` argv and drives the docker CLI through an injected
 * CommandRunner (so every argv is unit-testable without a daemon).
 *
 * Security stance (PRD-01 section 4.3, PRD-08 section 4):
 *  - buildRunArgs() always emits --cap-drop=ALL and no-new-privileges, always
 *    bounds pids/memory/cpus, and refuses (throws) rather than emits anything
 *    that would weaken isolation: host network/pid/ipc, --privileged,
 *    --device, --volumes-from, -v, extra --security-opt, root outside the
 *    snapshot helper, capabilities for agent/proxy containers.
 *  - Env VALUES never touch argv (visible in `ps` and `docker inspect`
 *    history of the client). They go through a 0600 --env-file that lives in a
 *    fresh 0700 directory and is removed in a finally block.
 *  - Every name is validated before it is placed in argv, and every option
 *    that takes a value is emitted as one `--flag=value` element, so no
 *    user-controlled string can be parsed as a separate flag.
 *  - inspect() redacts environment values: its output is meant for display.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { execaRunner } from './runner.js';
import {
  ContainerError,
  LABEL_AGENT,
  LABEL_MANAGED,
  LABEL_ROLE,
  LABEL_VOLUME_KEY,
} from './types.js';
import type {
  BuildRequest,
  BuildResult,
  CommandOptions,
  CommandResult,
  CommandRunner,
  ContainerInfo,
  ContainerMount,
  ContainerRole,
  ContainerRuntime,
  ContainerSpec,
  ImageInfo,
} from './types.js';
import {
  AGENT_NAME_RE,
  VOLUME_KEY_RE,
  assertAgentName,
  assertBindSource,
  assertContainerPath,
  assertEnvName,
  assertImageRef,
  parseUser,
} from './validate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Docker's own rule for container, network and volume names. */
export const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The only capabilities a helper container may add back after --cap-drop=ALL. */
export const ALLOWED_HELPER_CAPS: readonly string[] = ['DAC_READ_SEARCH', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE'];

export const TMPFS_OPTIONS = 'rw,nosuid,nodev,size=128m';
export const LOG_MAX_SIZE = '10m';
export const LOG_MAX_FILE = '3';

/**
 * docker reads env files with bufio.Scanner (64 KiB per line) and fails the
 * whole run on a longer line. Reject early with a clear message instead.
 */
const MAX_ENV_LINE_BYTES = 60_000;
const MAX_LABEL_VALUE_BYTES = 8192;
const MAX_STDERR_IN_MESSAGE = 4000;

const ROLES: readonly ContainerRole[] = ['agent', 'proxy', 'helper'];
const RESTART_POLICIES = ['no', 'unless-stopped', 'on-failure'] as const;
const MEMORY_RE = /^[1-9][0-9]{0,11}[bkmgBKMG]?$/;
const ADD_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}:(host-gateway|[0-9A-Fa-f:.]{2,45})$/;
const PLATFORM_RE = /^[a-z0-9_.-]+(\/[a-z0-9_.-]+){1,2}$/i;
const SINCE_RE = /^[A-Za-z0-9][A-Za-z0-9.:+-]{0,63}$/;
const BUILTIN_NETWORKS = ['bridge', 'host', 'none'];

const QUICK_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 5 * 60_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new ContainerError('INVALID_INPUT', message);
}

function violation(message: string): never {
  throw new ContainerError('POLICY_VIOLATION', message);
}

/** Validate a docker container/network/volume/alias name. Returns it. */
export function assertDockerName(name: string, what = 'docker name'): string {
  if (typeof name !== 'string' || !DOCKER_NAME_RE.test(name)) {
    invalid(`Invalid ${what} ${JSON.stringify(String(name))}: use 1-128 chars of a-z, A-Z, 0-9, "_", "." or "-", starting with a letter or digit`);
  }
  return name;
}

function hasLineBreakOrNul(value: string): boolean {
  return /[\0\r\n]/.test(value);
}

function assertNoNul(value: string, what: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    invalid(`Invalid ${what}: must be a string without NUL characters`);
  }
  return value;
}

/** 'none' | 'bridge' | a docker-safe user-defined network name. Never host or container:<id>. */
function assertNetworkArg(network: string): string {
  if (typeof network !== 'string') {
    invalid('Invalid network: must be a string');
  }
  const lower = network.toLowerCase();
  if (lower === 'host') {
    violation('Refusing --network=host: it removes network isolation');
  }
  if (lower.startsWith('container:')) {
    violation('Refusing a container: network: it would share another container\'s network namespace');
  }
  if (network === 'none' || network === 'bridge') return network;
  return assertDockerName(network, 'network name');
}

function resolveUser(spec: ContainerSpec): string {
  const { uid, gid } = parseUser(spec.user);
  const isHelper = spec.role === 'helper';
  if (spec.allowRoot === true && !isHelper) {
    violation(`allowRoot is only valid for helper containers (role is "${spec.role}")`);
  }
  if ((uid === 0 || gid === 0) && !(spec.allowRoot === true && isHelper)) {
    violation(
      `Refusing to run ${JSON.stringify(spec.name)} as ${spec.user}: uid/gid 0 is allowed only for helper containers with allowRoot`
    );
  }
  return `${uid}:${gid}`;
}

function resolveLimits(spec: ContainerSpec): { cpus: string; memory: string; pids: string } {
  const { cpus, memory, pidsLimit } = spec.limits;
  const cpusText = String(cpus);
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 1024 || !/^\d+(\.\d{1,3})?$/.test(cpusText)) {
    invalid(`Invalid cpus ${JSON.stringify(cpus)}: use a positive number with at most 3 decimals`);
  }
  if (typeof memory !== 'string' || !MEMORY_RE.test(memory)) {
    invalid(`Invalid memory limit ${JSON.stringify(memory)}: use a number with an optional b, k, m or g suffix (for example "2g")`);
  }
  if (!Number.isInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 4_194_304) {
    invalid(`Invalid pids limit ${JSON.stringify(pidsLimit)}: use an integer between 1 and 4194304 (unlimited is not allowed)`);
  }
  return { cpus: cpusText, memory, pids: String(pidsLimit) };
}

function resolveMounts(spec: ContainerSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mount of spec.mounts) {
    const m: ContainerMount = mount;
    if (m.kind !== 'volume' && m.kind !== 'bind') {
      invalid(`Invalid mount kind ${JSON.stringify(String(m.kind))}: use "volume" or "bind"`);
    }
    const target = assertContainerPath(m.target);
    if (target === '/') {
      invalid('Invalid mount target "/": mounting over the root filesystem is not allowed');
    }
    if (seen.has(target)) {
      invalid(`Duplicate mount target ${JSON.stringify(target)}`);
    }
    seen.add(target);
    let source: string;
    if (m.kind === 'volume') {
      source = assertDockerName(m.source, 'volume name');
    } else {
      source = assertBindSource(m.source);
      if (source.includes('"')) {
        invalid(`Invalid bind-mount source ${JSON.stringify(source)}: double quotes are not allowed`);
      }
    }
    out.push(`--mount=type=${m.kind},source=${source},target=${target}${m.readOnly === true ? ',readonly' : ''}`);
  }
  return out;
}

function resolveTmpfs(spec: ContainerSpec): string[] {
  const mountTargets = new Set(spec.mounts.map((m) => m.target));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of spec.tmpfs) {
    const p = assertContainerPath(raw);
    if (p === '/') {
      invalid('Invalid tmpfs path "/": use a sub-directory');
    }
    if (mountTargets.has(p)) {
      invalid(`tmpfs path ${JSON.stringify(p)} is also a mount target`);
    }
    if (seen.has(p)) {
      invalid(`Duplicate tmpfs path ${JSON.stringify(p)}`);
    }
    seen.add(p);
    out.push(`--tmpfs=${p}:${TMPFS_OPTIONS}`);
  }
  return out;
}

function resolveCapAdd(spec: ContainerSpec): string[] {
  const requested = spec.capAdd ?? [];
  if (requested.length === 0) return [];
  if (spec.role !== 'helper') {
    violation(`Refusing --cap-add for a "${spec.role}" container: only helper containers may add capabilities`);
  }
  const out: string[] = [];
  for (const cap of requested) {
    if (!ALLOWED_HELPER_CAPS.includes(cap)) {
      violation(`Refusing capability ${JSON.stringify(cap)}: helpers may only add ${ALLOWED_HELPER_CAPS.join(', ')}`);
    }
    if (!out.includes(`--cap-add=${cap}`)) out.push(`--cap-add=${cap}`);
  }
  return out;
}

function validateLabels(labels: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) {
    if (!LABEL_KEY_RE.test(key)) {
      invalid(`Invalid label key ${JSON.stringify(key)}: use lowercase a-z, 0-9, ".", "_" or "-"`);
    }
    if (typeof value !== 'string' || hasLineBreakOrNul(value)) {
      invalid(`Invalid value for label ${JSON.stringify(key)}: must not contain NUL, CR or LF`);
    }
    if (Buffer.byteLength(value) > MAX_LABEL_VALUE_BYTES) {
      invalid(`Label ${JSON.stringify(key)} value is longer than ${MAX_LABEL_VALUE_BYTES} bytes`);
    }
  }
  return entries;
}

function validateEnv(env: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of entries) {
    assertEnvName(name);
    if (typeof value !== 'string') {
      invalid(`Invalid value for environment variable ${name}: must be a string`);
    }
    // The env file is line based. Reject instead of letting docker truncate or split the value.
    if (hasLineBreakOrNul(value)) {
      invalid(`Environment variable ${name} contains a NUL, CR or LF character, which the env-file format cannot carry`);
    }
    if (Buffer.byteLength(`${name}=${value}`) > MAX_ENV_LINE_BYTES) {
      invalid(`Environment variable ${name} is too large for an env file (limit ${MAX_ENV_LINE_BYTES} bytes)`);
    }
  }
  return entries;
}

/**
 * The text of the docker --env-file for `env`: one `NAME=value` line each,
 * values verbatim (docker does not trim, unquote or expand them). Throws on
 * anything the format cannot represent. The message never contains a value.
 */
export function renderEnvFile(env: Record<string, string>): string {
  const entries = validateEnv(env);
  return entries.map(([name, value]) => `${name}=${value}`).join('\n') + (entries.length > 0 ? '\n' : '');
}

// ---------------------------------------------------------------------------
// docker run argv
// ---------------------------------------------------------------------------

/**
 * Build the argv (without the binary) for `docker run`. Pure. Throws
 * ContainerError (INVALID_INPUT or POLICY_VIOLATION) on anything unsafe.
 * `envFilePath` is required when `spec.env` is non-empty: values are never
 * placed on argv, and silently dropping them would be worse than failing.
 */
export function buildRunArgs(spec: ContainerSpec, envFilePath?: string): string[] {
  const name = assertDockerName(spec.name, 'container name');
  const image = assertImageRef(spec.image);
  if (!ROLES.includes(spec.role)) {
    invalid(`Invalid container role ${JSON.stringify(String(spec.role))}`);
  }
  const user = resolveUser(spec);
  const network = assertNetworkArg(spec.network);
  const limits = resolveLimits(spec);
  const mounts = resolveMounts(spec);
  const tmpfs = resolveTmpfs(spec);
  const capAdd = resolveCapAdd(spec);
  const labels = validateLabels(spec.labels);
  const envEntries = validateEnv(spec.env);

  const restart = spec.restart ?? 'no';
  if (!RESTART_POLICIES.includes(restart)) {
    invalid(`Invalid restart policy ${JSON.stringify(String(restart))}`);
  }
  if (spec.autoRemove === true && restart !== 'no') {
    invalid('autoRemove (--rm) cannot be combined with a restart policy');
  }
  if (spec.stopTimeoutSec !== undefined && (!Number.isInteger(spec.stopTimeoutSec) || spec.stopTimeoutSec < 0 || spec.stopTimeoutSec > 3600)) {
    invalid(`Invalid stop timeout ${JSON.stringify(spec.stopTimeoutSec)}: use an integer between 0 and 3600`);
  }

  const aliases = spec.networkAliases ?? [];
  for (const alias of aliases) assertDockerName(alias, 'network alias');
  if (aliases.length > 0 && (network === 'none' || network === 'bridge')) {
    invalid(`Network aliases need a user-defined network (network is "${network}")`);
  }

  const addHosts = spec.addHosts ?? [];
  for (const host of addHosts) {
    if (typeof host !== 'string' || !ADD_HOST_RE.test(host)) {
      invalid(`Invalid add-host entry ${JSON.stringify(String(host))}: use "name:ip" or "name:host-gateway"`);
    }
  }

  if (spec.entrypoint !== undefined) {
    assertNoNul(spec.entrypoint, 'entrypoint');
    if (spec.entrypoint.length === 0) invalid('Invalid entrypoint: must not be empty');
  }
  const command = spec.command ?? [];
  for (const arg of command) assertNoNul(arg, 'command argument');

  if (envEntries.length > 0) {
    if (envFilePath === undefined) {
      invalid('spec.env is not empty but no env-file path was given; env values are never placed on argv');
    }
    if (!path.isAbsolute(envFilePath) || hasLineBreakOrNul(envFilePath)) {
      invalid('Invalid env-file path: must be absolute and contain no NUL, CR or LF');
    }
  }

  const args: string[] = ['run'];
  if (spec.detach) args.push('-d');
  if (spec.interactive === true) args.push('-i');
  if (spec.autoRemove === true) args.push('--rm');
  args.push(
    `--name=${name}`,
    `--user=${user}`,
    '--cap-drop=ALL',
    ...capAdd,
    '--security-opt=no-new-privileges',
    `--pids-limit=${limits.pids}`,
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memory}`,
    `--cpus=${limits.cpus}`
  );
  if (spec.init) args.push('--init');
  if (spec.readOnlyRootfs) args.push('--read-only');
  args.push(`--network=${network}`);
  for (const alias of aliases) args.push(`--network-alias=${alias}`);
  for (const host of addHosts) args.push(`--add-host=${host}`);
  for (const [key, value] of labels) args.push(`--label=${key}=${value}`);
  args.push(`--restart=${restart}`);
  if (spec.stopTimeoutSec !== undefined) args.push(`--stop-timeout=${spec.stopTimeoutSec}`);
  args.push(`--log-opt=max-size=${LOG_MAX_SIZE}`, `--log-opt=max-file=${LOG_MAX_FILE}`);
  args.push(...mounts, ...tmpfs);
  if (envEntries.length > 0 && envFilePath !== undefined) args.push(`--env-file=${envFilePath}`);
  if (spec.entrypoint !== undefined) args.push(`--entrypoint=${spec.entrypoint}`);
  args.push(image, ...command);
  return args;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function tail(text: string, max = MAX_STDERR_IN_MESSAGE): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `...${trimmed.slice(-max)}` : trimmed;
}

const DAEMON_UNREACHABLE_RE =
  /Cannot connect to the Docker daemon|failed to connect to the docker API|error during connect|Is the docker daemon running/i;
const NOT_FOUND_RE =
  /\bNo such (container|image|network|volume|object|plugin)\b|no such volume|\bnetwork \S+ not found\b/i;

/**
 * Map a failed docker invocation onto a precise ContainerError. Pure: it only
 * looks at the result. Order matters: spawn failure and timeout first, then
 * the daemon connection messages (which can contain "no such file"), and only
 * then the generic NOT_FOUND patterns.
 */
export function classifyDockerFailure(result: CommandResult): ContainerError {
  if (result.spawnFailed) {
    return new ContainerError('NOT_INSTALLED', 'Docker CLI not found - install Docker Desktop or Docker Engine', {
      exitCode: result.exitCode,
    });
  }
  if (result.timedOut) {
    return new ContainerError('TIMEOUT', 'Docker command timed out', { exitCode: result.exitCode });
  }
  const stderr = result.stderr;
  if (/permission denied/i.test(stderr) && /docker\.sock/i.test(stderr)) {
    return new ContainerError(
      'PERMISSION_DENIED',
      'Permission denied talking to the Docker daemon socket - add your user to the "docker" group or fix the socket permissions',
      { exitCode: result.exitCode }
    );
  }
  if (DAEMON_UNREACHABLE_RE.test(stderr)) {
    return new ContainerError('DAEMON_UNREACHABLE', 'Docker is installed but its daemon is not reachable - start Docker', {
      exitCode: result.exitCode,
    });
  }
  if (NOT_FOUND_RE.test(stderr)) {
    return new ContainerError('NOT_FOUND', tail(stderr), { exitCode: result.exitCode });
  }
  const detail = tail(stderr);
  return new ContainerError(
    'COMMAND_FAILED',
    detail.length > 0 ? `docker failed (exit ${result.exitCode}): ${detail}` : `docker failed (exit ${result.exitCode})`,
    { exitCode: result.exitCode }
  );
}

const INFRASTRUCTURE_CODES = new Set(['NOT_INSTALLED', 'DAEMON_UNREACHABLE', 'PERMISSION_DENIED']);

/**
 * For commands whose stderr is shared with a user process (run, exec): only
 * treat the failure as a docker/daemon problem when it is the FIRST thing on
 * stderr, so a container that happens to print "Cannot connect to the Docker
 * daemon" cannot turn its own exit into an infrastructure error.
 */
function infrastructureFailure(result: CommandResult): ContainerError | null {
  if (result.exitCode === 0) return null;
  const firstLine = result.stderr.split('\n').find((l) => l.trim().length > 0) ?? '';
  const candidate = classifyDockerFailure({ ...result, stderr: firstLine });
  return INFRASTRUCTURE_CODES.has(candidate.code) ? classifyDockerFailure(result) : null;
}

// ---------------------------------------------------------------------------
// Parsing docker output
// ---------------------------------------------------------------------------

const imageInspectSchema = z.object({
  Id: z.string().min(1),
  RepoTags: z.array(z.string()).nullable().optional(),
  RepoDigests: z.array(z.string()).nullable().optional(),
  Size: z.number().nullable().optional(),
  Config: z
    .object({
      Labels: z.record(z.string(), z.string()).nullable().optional(),
      User: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * One JSON object per line. role and agent come from `.Label`, which the
 * daemon resolves exactly; the flattened `.Labels` string is ambiguous (a
 * label value can contain "," and "key=") and containers inherit labels from
 * their image, so it must not be trusted for those two.
 */
const PS_FORMAT =
  '--format={"id":{{json .ID}},"names":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},' +
  '"status":{{json .Status}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}},' +
  `"role":{{json (.Label "${LABEL_ROLE}")}},"agent":{{json (.Label "${LABEL_AGENT}")}}}`;

const psRowSchema = z.object({
  id: z.string().min(1),
  names: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  createdAt: z.string(),
  labels: z.string().nullable().optional(),
  role: z.string(),
  agent: z.string(),
});

const volumeRowSchema = z.object({
  name: z.string().min(1),
  key: z.string(),
  agent: z.string(),
});

/**
 * Parse docker's flattened label string "k1=v1,k2=v2". Values may contain
 * commas, so a segment that does not start like `key=` continues the
 * previous value.
 */
export function parseDockerLabels(flat: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!flat) return out;
  let currentKey: string | undefined;
  for (const segment of flat.split(',')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._/-]*)=(.*)$/s.exec(segment);
    if (m && m[1] !== undefined) {
      currentKey = m[1];
      out[currentKey] = m[2] ?? '';
    } else if (currentKey !== undefined) {
      out[currentKey] = `${out[currentKey] ?? ''},${segment}`;
    }
  }
  return out;
}

function parseJsonLines(stdout: string, what: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new ContainerError('COMMAND_FAILED', `Unexpected output from docker ${what}`);
    }
  }
  return rows;
}

function toRole(value: string | undefined): ContainerRole | 'unknown' {
  return value === 'agent' || value === 'proxy' || value === 'helper' ? value : 'unknown';
}

/** Replace every `NAME=value` in Config.Env with `NAME=<redacted>`. */
function redactInspect(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const root = value as { Config?: { Env?: unknown } };
  if (root.Config && Array.isArray(root.Config.Env)) {
    root.Config.Env = root.Config.Env.map((entry: unknown) => {
      if (typeof entry !== 'string') return entry;
      const eq = entry.indexOf('=');
      return eq === -1 ? entry : `${entry.slice(0, eq)}=<redacted>`;
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface DockerRuntimeOptions {
  runner?: CommandRunner;
  /** Path or name of the docker binary. Default 'docker'. */
  dockerBin?: string;
  /** Whether to add -t to an interactive exec. Default: stdin and stdout are TTYs. */
  isTty?: () => boolean;
}

export interface ForegroundIo {
  stdinFile?: string;
  stdoutFile?: string;
  inheritStdio?: boolean;
  /** Not in the ContainerRuntime contract: kill the run after this long (exit 124). */
  timeoutMs?: number;
}

function writePrivateFile(file: string, content: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function removeQuietly(dir: string, file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // keep going: the directory removal below is the one that matters
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // the dir is 0700 and empty of secrets once the file is gone; never mask the real error
  }
}

export class DockerRuntime implements ContainerRuntime {
  readonly runner: CommandRunner;
  private readonly bin: string;
  private readonly isTty: () => boolean;

  constructor(options: DockerRuntimeOptions = {}) {
    this.runner = options.runner ?? execaRunner;
    this.bin = options.dockerBin ?? 'docker';
    this.isTty = options.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  }

  private invoke(args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    return this.runner(this.bin, args, options);
  }

  /** Run and require success; anything else becomes a classified ContainerError. */
  private async invokeOk(args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
    const result = await this.invoke(args, options);
    if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
      throw classifyDockerFailure(result);
    }
    return result;
  }

  /**
   * Validate the spec, then (only if it has env) put the env on disk in a
   * 0600 file inside a fresh 0700 directory for the duration of `fn`.
   * Validation happens before any secret is written.
   */
  private async withRunArgs<T>(spec: ContainerSpec, fn: (args: string[]) => Promise<T>): Promise<T> {
    if (Object.keys(spec.env).length === 0) {
      return fn(buildRunArgs(spec));
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-env-'));
    const file = path.join(dir, 'env');
    try {
      const args = buildRunArgs(spec, file);
      writePrivateFile(file, renderEnvFile(spec.env));
      return await fn(args);
    } finally {
      removeQuietly(dir, file);
    }
  }

  async ensureAvailable(): Promise<{ serverVersion: string }> {
    const result = await this.invokeOk(['version', '--format={{.Server.Version}}'], { timeoutMs: VERSION_TIMEOUT_MS });
    const serverVersion = result.stdout.trim();
    if (serverVersion.length === 0) {
      throw new ContainerError('COMMAND_FAILED', 'docker version did not report a server version');
    }
    return { serverVersion };
  }

  // -- images ---------------------------------------------------------------

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    assertImageRef(ref);
    const result = await this.invoke(['image', 'inspect', '--format={{json .}}', ref], { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
      const error = classifyDockerFailure(result);
      if (error.code === 'NOT_FOUND') return null;
      throw error;
    }
    let parsed: z.infer<typeof imageInspectSchema>;
    try {
      parsed = imageInspectSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw new ContainerError('COMMAND_FAILED', `Unexpected output from docker image inspect ${ref}`);
    }
    return {
      id: parsed.Id,
      repoTags: parsed.RepoTags ?? [],
      repoDigests: parsed.RepoDigests ?? [],
      labels: parsed.Config?.Labels ?? {},
      user: parsed.Config?.User ?? '',
      sizeBytes: parsed.Size ?? 0,
    };
  }

  /**
   * NOTE: build args and labels are visible in argv (and in image history).
   * Never pass a secret through them.
   */
  async buildImage(request: BuildRequest): Promise<BuildResult> {
    const tag = assertImageRef(request.tag);
    assertNoNul(request.contextDir, 'build context path');
    const contextDir = path.resolve(request.contextDir);
    const dockerfile =
      request.dockerfile !== undefined
        ? path.resolve(assertNoNul(request.dockerfile, 'Dockerfile path'))
        : path.join(contextDir, 'Dockerfile');
    if (request.platform !== undefined && !PLATFORM_RE.test(request.platform)) {
      invalid(`Invalid platform ${JSON.stringify(request.platform)}: use os/arch such as "linux/amd64"`);
    }
    const buildArgs = Object.entries(request.buildArgs ?? {});
    for (const [key, value] of buildArgs) {
      assertEnvName(key);
      if (hasLineBreakOrNul(value)) invalid(`Invalid value for build arg ${key}: must not contain NUL, CR or LF`);
    }
    const labels = validateLabels(request.labels ?? {});

    const args = ['build', `--tag=${tag}`];
    if (request.platform !== undefined) args.push(`--platform=${request.platform}`);
    for (const [key, value] of buildArgs) args.push(`--build-arg=${key}=${value}`);
    for (const [key, value] of labels) args.push(`--label=${key}=${value}`);
    if (request.noCache === true) args.push('--no-cache');
    args.push(`--file=${dockerfile}`, contextDir);

    const timeoutMs = request.timeoutMs ?? BUILD_TIMEOUT_MS;
    let result = await this.invoke(args, { timeoutMs, env: { DOCKER_BUILDKIT: '1' } });
    if (result.exitCode !== 0 && /buildx component is missing/i.test(result.stderr)) {
      // BuildKit was forced but buildx is not installed: the legacy builder still works.
      result = await this.invoke(args, { timeoutMs, env: { DOCKER_BUILDKIT: '0' } });
    }
    if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
      throw classifyDockerFailure(result);
    }
    const idResult = await this.invokeOk(['image', 'inspect', '--format={{.Id}}', tag], { timeoutMs: QUICK_TIMEOUT_MS });
    const imageId = idResult.stdout.trim();
    if (imageId.length === 0) {
      throw new ContainerError('COMMAND_FAILED', `docker did not report an image id for ${tag}`);
    }
    return { imageId, tag };
  }

  // -- networks -------------------------------------------------------------

  async ensureNetwork(name: string, options: { internal: boolean; labels?: Record<string, string> }): Promise<void> {
    assertDockerName(name, 'network name');
    if (BUILTIN_NETWORKS.includes(name)) {
      violation(`Refusing to manage the built-in "${name}" network`);
    }
    const labels = validateLabels({ ...(options.labels ?? {}), [LABEL_MANAGED]: 'true' });

    const existing = await this.networkInternalFlag(name);
    if (existing !== null) {
      this.assertNetworkMatches(name, existing, options.internal);
      return;
    }
    const args = ['network', 'create', '--driver=bridge'];
    if (options.internal) args.push('--internal');
    for (const [key, value] of labels) args.push(`--label=${key}=${value}`);
    args.push(name);
    const created = await this.invoke(args, { timeoutMs: QUICK_TIMEOUT_MS });
    if (created.exitCode === 0 && !created.spawnFailed && !created.timedOut) return;
    if (/already exists/i.test(created.stderr)) {
      // Lost a race with another creator: verify what they made.
      const raced = await this.networkInternalFlag(name);
      if (raced !== null) {
        this.assertNetworkMatches(name, raced, options.internal);
        return;
      }
    }
    throw classifyDockerFailure(created);
  }

  /** null when the network does not exist. */
  private async networkInternalFlag(name: string): Promise<boolean | null> {
    const result = await this.invoke(['network', 'inspect', '--format={{.Internal}}', name], { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
      const text = result.stdout.trim();
      if (text !== 'true' && text !== 'false') {
        throw new ContainerError('COMMAND_FAILED', `Unexpected output from docker network inspect ${name}`);
      }
      return text === 'true';
    }
    const error = classifyDockerFailure(result);
    if (error.code === 'NOT_FOUND') return null;
    throw error;
  }

  private assertNetworkMatches(name: string, isInternal: boolean, wantInternal: boolean): void {
    if (isInternal !== wantInternal) {
      violation(
        `Network ${JSON.stringify(name)} already exists with internal=${isInternal}, but internal=${wantInternal} was requested. ` +
          'Reusing it would change the isolation guarantee; remove it or use another name.'
      );
    }
  }

  async removeNetwork(name: string): Promise<void> {
    assertDockerName(name, 'network name');
    if (BUILTIN_NETWORKS.includes(name)) {
      violation(`Refusing to remove the built-in "${name}" network`);
    }
    await this.invokeOk(['network', 'rm', name], { timeoutMs: QUICK_TIMEOUT_MS });
  }

  /** Idempotent: connecting a container that is already on the network succeeds. */
  async connectNetwork(container: string, network: string, aliases: string[] = []): Promise<void> {
    assertDockerName(container, 'container name');
    assertDockerName(network, 'network name');
    for (const alias of aliases) assertDockerName(alias, 'network alias');
    const args = ['network', 'connect', ...aliases.map((a) => `--alias=${a}`), network, container];
    const result = await this.invoke(args, { timeoutMs: QUICK_TIMEOUT_MS });
    if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) return;
    if (/already exists in network/i.test(result.stderr)) return;
    throw classifyDockerFailure(result);
  }

  // -- volumes --------------------------------------------------------------

  /** Idempotent (`docker volume create` of an existing volume succeeds). Always labelled managed. */
  async ensureVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    assertDockerName(name, 'volume name');
    const all = validateLabels({ ...labels, [LABEL_MANAGED]: 'true' });
    await this.invokeOk(['volume', 'create', ...all.map(([k, v]) => `--label=${k}=${v}`), name], { timeoutMs: QUICK_TIMEOUT_MS });
  }

  async removeVolume(name: string): Promise<void> {
    assertDockerName(name, 'volume name');
    await this.invokeOk(['volume', 'rm', name], { timeoutMs: QUICK_TIMEOUT_MS });
  }

  async listVolumes(filter: { agent?: string } = {}): Promise<Array<{ name: string; key: string; agent: string }>> {
    const args = ['volume', 'ls', `--filter=label=${LABEL_MANAGED}=true`];
    if (filter.agent !== undefined) {
      args.push(`--filter=label=${LABEL_AGENT}=${assertAgentName(filter.agent)}`);
    }
    args.push(`--format={"name":{{json .Name}},"key":{{json (.Label "${LABEL_VOLUME_KEY}")}},"agent":{{json (.Label "${LABEL_AGENT}")}}}`);
    const result = await this.invokeOk(args, { timeoutMs: QUICK_TIMEOUT_MS });
    const volumes: Array<{ name: string; key: string; agent: string }> = [];
    for (const row of parseJsonLines(result.stdout, 'volume ls')) {
      const parsed = volumeRowSchema.safeParse(row);
      if (!parsed.success) continue;
      const { name, key, agent } = parsed.data;
      // Labels are untrusted input to later path building: skip anything that is not ours.
      if (!AGENT_NAME_RE.test(agent) || !VOLUME_KEY_RE.test(key)) continue;
      volumes.push({ name, key, agent });
    }
    return volumes;
  }

  // -- containers -----------------------------------------------------------

  async start(spec: ContainerSpec): Promise<{ id: string }> {
    const detached: ContainerSpec = { ...spec, detach: true };
    return this.withRunArgs(detached, async (args) => {
      const result = await this.invoke(args, { timeoutMs: START_TIMEOUT_MS });
      if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
        if (/is already in use by container/i.test(result.stderr)) {
          throw new ContainerError(
            'COMMAND_FAILED',
            `A container named "${spec.name}" already exists. Remove it or choose another name.`,
            { reason: 'name_in_use', name: spec.name }
          );
        }
        throw classifyDockerFailure(result);
      }
      const id = result.stdout.trim().split('\n').pop()?.trim() ?? '';
      if (!/^[0-9a-f]{64}$/.test(id)) {
        throw new ContainerError('COMMAND_FAILED', 'docker run -d did not return a container id');
      }
      return { id };
    });
  }

  /**
   * Run attached and wait. A non-zero exit is returned, not thrown (the caller
   * checks it: a partial tar still exits non-zero only). Throws for spawn
   * failure and for daemon-level problems reported as the first stderr line.
   */
  async runForeground(spec: ContainerSpec, io: ForegroundIo = {}): Promise<CommandResult> {
    const foreground: ContainerSpec = {
      ...spec,
      detach: false,
      ...(io.stdinFile !== undefined ? { interactive: true } : {}),
    };
    return this.withRunArgs(foreground, async (args) => {
      const options: CommandOptions = {
        ...(io.stdinFile !== undefined ? { stdinFile: io.stdinFile } : {}),
        ...(io.stdoutFile !== undefined ? { stdoutFile: io.stdoutFile } : {}),
        ...(io.inheritStdio === true ? { inheritStdio: true } : {}),
        ...(io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {}),
      };
      const result = await this.invoke(args, options);
      if (result.spawnFailed) throw classifyDockerFailure(result);
      const infrastructure = infrastructureFailure(result);
      if (infrastructure) throw infrastructure;
      return result;
    });
  }

  async list(filter: { agent?: string; all?: boolean } = {}): Promise<ContainerInfo[]> {
    const args = ['ps'];
    if (filter.all === true) args.push('-a');
    args.push(`--filter=label=${LABEL_MANAGED}=true`);
    if (filter.agent !== undefined) {
      args.push(`--filter=label=${LABEL_AGENT}=${assertAgentName(filter.agent)}`);
    }
    args.push(PS_FORMAT);
    const result = await this.invokeOk(args, { timeoutMs: QUICK_TIMEOUT_MS });
    return parseJsonLines(result.stdout, 'ps').map((row) => {
      const parsed = psRowSchema.safeParse(row);
      if (!parsed.success) {
        throw new ContainerError('COMMAND_FAILED', 'Unexpected output from docker ps');
      }
      const r = parsed.data;
      // Best-effort flat labels, with the exact values for our own keys laid over them.
      const labels = { ...parseDockerLabels(r.labels), [LABEL_MANAGED]: 'true', [LABEL_ROLE]: r.role, [LABEL_AGENT]: r.agent };
      return {
        id: r.id,
        name: (r.names.split(',')[0] ?? r.names).replace(/^\//, ''),
        image: r.image,
        state: r.state,
        status: r.status,
        role: toRole(r.role),
        agent: r.agent,
        createdAt: r.createdAt,
        labels,
      };
    });
  }

  /**
   * Without `follow` the logs are captured and a missing container throws
   * NOT_FOUND. With `follow` the output streams straight to the terminal and
   * the result carries only the exit code.
   */
  async logs(name: string, options: { tail?: number; follow?: boolean; since?: string } = {}): Promise<CommandResult> {
    assertDockerName(name, 'container name');
    const args = ['logs'];
    if (options.tail !== undefined) {
      if (!Number.isInteger(options.tail) || options.tail < 0) invalid(`Invalid tail ${JSON.stringify(options.tail)}: use a non-negative integer`);
      args.push(`--tail=${options.tail}`);
    }
    if (options.since !== undefined) {
      if (!SINCE_RE.test(options.since)) invalid(`Invalid since ${JSON.stringify(options.since)}: use a duration like "10m" or an RFC 3339 timestamp`);
      args.push(`--since=${options.since}`);
    }
    if (options.follow === true) {
      args.push('--follow', name);
      const result = await this.invoke(args, { inheritStdio: true });
      if (result.spawnFailed) throw classifyDockerFailure(result);
      return result;
    }
    args.push(name);
    return this.invokeOk(args, { timeoutMs: QUICK_TIMEOUT_MS });
  }

  async stop(name: string, timeoutSec = 10): Promise<void> {
    assertDockerName(name, 'container name');
    if (!Number.isInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 3600) {
      invalid(`Invalid stop timeout ${JSON.stringify(timeoutSec)}: use an integer between 0 and 3600`);
    }
    // -t, not --time: --time is deprecated (warns on stderr) on current Docker.
    await this.invokeOk(['stop', '-t', String(timeoutSec), name], { timeoutMs: (timeoutSec + 30) * 1000 });
  }

  async remove(name: string, options: { force?: boolean } = {}): Promise<void> {
    assertDockerName(name, 'container name');
    const args = ['rm'];
    if (options.force === true) args.push('-f');
    args.push(name);
    await this.invokeOk(args, { timeoutMs: 60_000 });
  }

  /** Parsed `docker container inspect`, with environment VALUES redacted. */
  async inspect(name: string): Promise<unknown> {
    assertDockerName(name, 'container name');
    const result = await this.invokeOk(['container', 'inspect', name], { timeoutMs: QUICK_TIMEOUT_MS });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new ContainerError('COMMAND_FAILED', `Unexpected output from docker container inspect ${name}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ContainerError('NOT_FOUND', `No such container: ${name}`);
    }
    return redactInspect(parsed[0]);
  }

  async stats(name: string): Promise<CommandResult> {
    assertDockerName(name, 'container name');
    return this.invokeOk(['stats', '--no-stream', name], { timeoutMs: QUICK_TIMEOUT_MS });
  }

  /**
   * Run `command` (argv, no shell) in a running container. The command's own
   * non-zero exit is returned; docker-level failures (spawn, daemon, missing
   * container) throw.
   */
  async exec(name: string, command: string[], options: { interactive?: boolean } = {}): Promise<CommandResult> {
    assertDockerName(name, 'container name');
    if (command.length === 0) invalid('exec needs a command');
    for (const arg of command) assertNoNul(arg, 'command argument');
    const interactive = options.interactive === true;
    const args = ['exec'];
    if (interactive) {
      args.push('-i');
      if (this.isTty()) args.push('-t');
    }
    args.push(name, ...command);
    const result = await this.invoke(args, interactive ? { inheritStdio: true } : {});
    if (result.spawnFailed) throw classifyDockerFailure(result);
    const infrastructure = infrastructureFailure(result);
    if (infrastructure) throw infrastructure;
    if (result.exitCode !== 0 && /^Error response from daemon: No such container/m.test(result.stderr)) {
      throw classifyDockerFailure(result);
    }
    return result;
  }
}
