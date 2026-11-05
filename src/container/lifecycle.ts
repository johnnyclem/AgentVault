/**
 * Lifecycle: start, stop, remove and list one AgentVault agent together with
 * its credential-proxy sidecar.
 *
 * Why it exists: policy.ts decides WHAT a container looks like and docker.ts
 * knows HOW to run it; nothing so far decides in which ORDER the pieces may be
 * created, what must be refused before anything exists, and what must be torn
 * down again when a step fails. That ordering is where the guarantees
 * "the agent never holds a real key" and "a failed start leaves nothing
 * behind" are made true.
 *
 * Security stance:
 *  - Fail closed BEFORE any Docker resource is created. A manifest that
 *    declares secrets is refused unless a proxy plan covers every one of them
 *    (names only in the message, never values). Both container specs are built
 *    and their argv validated up front, so a bad env name, a reserved variable
 *    or a multi-line secret is rejected while there is still nothing to clean up.
 *  - In proxy mode the agent sits on an --internal network whose only other
 *    member is the sidecar. The sidecar reaches the internet through its OWN
 *    egress network (only the sidecar on it), never the shared default bridge:
 *    it listens on 0.0.0.0 and holds the real credentials, so on a shared
 *    bridge any container on the host could reach it by IP and spend them.
 *    Choosing a shared network anyway is allowed, but warned about loudly.
 *  - The agent environment is checked once more: if any value in it contains a
 *    plan secret (a host variable under an unexpected name, say) the start is
 *    refused. The real secret lives in the sidecar environment only.
 *  - Rollback removes only what THIS call created, in reverse order, best
 *    effort, and never masks the original error. Volumes that existed before
 *    are never deleted, and volumes created by this call are deleted only if
 *    the agent never started (once it ran it may have written data).
 *  - removeAgent keeps volumes unless the caller passes removeVolumes === true:
 *    data loss is an explicit opt-in.
 *  - No error or warning produced here carries a plan secret: sidecar log lines
 *    are redacted (exact value, and its JSON-escaped form) before they are put
 *    in a message, and every error leaving startAgent is scrubbed once more.
 */

import { assertDockerName, buildRunArgs } from './docker.js';
import { manifestFromLabels } from './manifest.js';
import type { ContainerManifest } from './manifest.js';
import { buildAgentSpec, buildProxySpec } from './policy.js';
import { ContainerError, LABEL_AGENT, LABEL_MANAGED, LABEL_VOLUME_KEY } from './types.js';
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  NetworkMode,
  ProxyPlan,
  StartAgentRequest,
  StartedAgent,
} from './types.js';
import { AGENT_NAME_RE, assertAgentName, assertImageRef, resourceNames, volumeKeysForPaths } from './validate.js';
import type { ResourceNames } from './validate.js';

// ---------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------

/** How long startAgent waits for the sidecar's {"event":"listening"} line. */
export const PROXY_READY_TIMEOUT_MS = 20_000;
export const PROXY_READY_POLL_MS = 250;
function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ContainerError('INTERRUPTED', 'Interrupted before the agent was running; everything created so far was removed again');
}

/** How long the CLI watches a detached agent for an immediate crash. */
export const LIVENESS_GRACE_MS = 1_500;
export const LIVENESS_POLL_MS = 150;

/**
 * StartAgentRequest plus knobs the shared contract does not carry. A plain
 * StartAgentRequest is assignable to it, so callers that only know the
 * contract keep working.
 */
export interface StartAgentOptions extends StartAgentRequest {
  /** Sidecar readiness deadline. Default PROXY_READY_TIMEOUT_MS. */
  proxyReadyTimeoutMs?: number;
  /** Readiness poll interval. Default PROXY_READY_POLL_MS. */
  proxyReadyPollMs?: number;
  /** Keep stdin open (`docker run -i`) for a foreground run. Default false. */
  interactive?: boolean;
  /**
   * Detached runs: how long to watch for the agent dying right after it starts (a missing binary
   * exits 127 *after* `docker run -d` has already returned success). 0 (the default) skips the
   * check and its delay; the CLI turns it on with LIVENESS_GRACE_MS.
   */
  livenessGraceMs?: number;
  /** Liveness poll interval. Default LIVENESS_POLL_MS. */
  livenessPollMs?: number;
}

export interface AgentSummary {
  agent: string;
  /** Docker state of the agent container ("running", "exited", ...). */
  state: string;
  image: string;
  /** True when a sidecar container for this agent exists (in the listed states). */
  hasProxy: boolean;
  containerName: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const NETWORK_MODES: readonly NetworkMode[] = ['none', 'proxy', 'bridge'];
const LISTENING_RE = /"event"\s*:\s*"listening"/;
const LOG_TAIL_LINES = 10;
const MAX_LOG_LINE_CHARS = 500;
const REDACTED = '[redacted]';
/** Same threshold policy.ts uses before it scans for a secret inside a larger string. */
const MIN_SUBSTRING_SECRET_LENGTH = 16;
/** buildRunArgs() only needs an absolute path to validate an env-bearing spec; nothing is ever written there. */
const VALIDATION_ENV_FILE = '/dev/null';
const INACTIVE_STATES = new Set(['exited', 'created', 'dead']);

function isNotFound(error: unknown): boolean {
  return error instanceof ContainerError && error.code === 'NOT_FOUND';
}

function isNameInUse(error: unknown): boolean {
  return error instanceof ContainerError && error.details?.['reason'] === 'name_in_use';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A container that is not stopped: running, restarting, paused, being removed. */
function isActive(container: ContainerInfo): boolean {
  return !INACTIVE_STATES.has(container.state);
}

/**
 * Replace every occurrence of each value (and of its JSON-escaped form, which
 * is how a JSON log line would carry a value with quotes or backslashes) with
 * "[redacted]". Exact-value replacement: encodings such as base64 or URL
 * escaping are not recognised. Empty values are skipped. Longer values go
 * first so a secret that contains another one is removed whole.
 */
export function redactSecrets(text: string, values: Iterable<string>): string {
  const needles = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    needles.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped.length > 0) needles.add(escaped);
  }
  let out = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    out = out.split(needle).join(REDACTED);
  }
  return out;
}

/** Same error with secrets scrubbed from the message; the original object when there is nothing to scrub. */
function scrubError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error) || secrets.length === 0) return error;
  const message = redactSecrets(error.message, secrets);
  if (message === error.message) return error;
  if (error instanceof ContainerError) return new ContainerError(error.code, message, error.details);
  return new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Step 2: the image
// ---------------------------------------------------------------------------

function assertImageUserNonRoot(user: string, image: string): void {
  const isRootId = (id: string): boolean => id === 'root' || (/^\d+$/.test(id) && Number(id) === 0);
  const [uid = '', gid = ''] = user.split(':');
  if (uid === '' || isRootId(uid) || (gid !== '' && isRootId(gid))) {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `Image ${image} runs as ${user === '' ? 'root (it sets no USER)' : user}; AgentVault agents must run as a non-root user`
    );
  }
}

async function loadManifest(runtime: ContainerRuntime, imageRef: string): Promise<{ image: string; manifest: ContainerManifest }> {
  const image = assertImageRef(imageRef);
  const info = await runtime.inspectImage(image);
  if (info === null) {
    throw new ContainerError(
      'NOT_FOUND',
      `Image ${image} was not found. Build it with 'agentvault package' or fetch it with 'docker pull ${image}'.`
    );
  }
  const manifest = manifestFromLabels(info.labels);
  if (manifest === null) {
    throw new ContainerError(
      'INVALID_INPUT',
      `Image ${image} is not an AgentVault image (it has no agentvault.manifest label). Build one with 'agentvault package'.`
    );
  }
  assertImageUserNonRoot(info.user, image);
  return { image, manifest };
}

// ---------------------------------------------------------------------------
// Step 3: network resolution (all of it before any Docker resource exists)
// ---------------------------------------------------------------------------

type ResolvedNetwork = { mode: 'proxy'; plan: ProxyPlan } | { mode: 'none' | 'bridge' };

function resolveNetwork(request: StartAgentRequest, manifest: ContainerManifest): ResolvedNetwork {
  const requested = request.network;
  if (requested !== undefined && !NETWORK_MODES.includes(requested)) {
    throw new ContainerError('INVALID_INPUT', `Unknown network mode ${JSON.stringify(String(requested))}: use none, proxy or bridge`);
  }
  // The manifest is written by whoever built the image: it may narrow isolation, never widen it.
  if (requested === undefined && request.proxyPlan === undefined && manifest.isolation.network === 'bridge') {
    throw new ContainerError(
      'POLICY_VIOLATION',
      'The image asks for unrestricted network access (bridge). An image cannot choose that for itself: request the "bridge" network explicitly if you trust it.'
    );
  }
  const mode: NetworkMode = requested ?? (request.proxyPlan !== undefined ? 'proxy' : manifest.isolation.network);
  const declared = manifest.secrets;

  if (mode === 'proxy') {
    const plan = request.proxyPlan;
    if (plan === undefined) {
      if (declared.length > 0) {
        throw new ContainerError(
          'MISSING_SECRET',
          `The agent needs credentials (${declared.join(', ')}) but no credential-proxy plan was given. ` +
            'Refusing to start it without one: the agent would have no safe way to reach its services.'
        );
      }
      throw new ContainerError('INVALID_INPUT', 'Network mode "proxy" needs a credential-proxy plan, and none was given');
    }
    const covered = new Set(plan.config.routes.map((route) => route.name));
    const uncovered = declared.filter((name) => !covered.has(name));
    if (uncovered.length > 0) {
      throw new ContainerError(
        'MISSING_SECRET',
        `The agent declares credentials the proxy plan has no route for: ${uncovered.join(', ')}. ` +
          'Add a route for each one (or remove it from the manifest) before starting.'
      );
    }
    // A route that injects a credential the plan does not carry would only fail later, with resources already created.
    const absent = new Set<string>();
    for (const route of plan.config.routes) {
      for (const injection of route.inject) {
        const value = Object.hasOwn(plan.secrets, injection.secret) ? plan.secrets[injection.secret] : undefined;
        if (typeof value !== 'string' || value.length === 0) absent.add(injection.secret);
      }
    }
    if (absent.size > 0) {
      throw new ContainerError(
        'MISSING_SECRET',
        `The proxy plan routes inject credentials it does not carry a value for: ${[...absent].join(', ')}`
      );
    }
    return { mode: 'proxy', plan };
  }

  if (declared.length > 0) {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `The agent declares credentials (${declared.join(', ')}) but network mode is "${mode}": ` +
        'only the credential proxy can deliver them without handing the agent the real keys. Use network "proxy" with a plan.'
    );
  }
  if (request.proxyPlan !== undefined) {
    throw new ContainerError('INVALID_INPUT', `A credential-proxy plan was given but the network mode is "${mode}"; use "proxy" or drop the plan`);
  }
  return { mode };
}

/** The sidecar's route to the internet: its own network by default, a caller-named one on request. */
function resolveEgress(requested: string | undefined, names: ResourceNames): { name: string; owned: boolean } {
  if (requested === undefined || requested === names.egress) return { name: names.egress, owned: true };
  assertDockerName(requested, 'proxy egress network');
  const lower = requested.toLowerCase();
  if (lower === 'host') {
    throw new ContainerError('POLICY_VIOLATION', 'Refusing to attach the credential proxy to the host network');
  }
  if (lower === 'none') {
    throw new ContainerError('INVALID_INPUT', 'The proxy egress network cannot be "none": the sidecar could not reach any upstream');
  }
  if (requested === names.network) {
    throw new ContainerError('INVALID_INPUT', 'The proxy egress network cannot be the internal network: it has no route out');
  }
  return { name: requested, owned: false };
}

/**
 * The agent must never hold a real credential. policy.ts already lets the
 * plan's placeholders win over anything with the same name; this catches the
 * rest (a real key reaching the agent under another variable name).
 */
function assertAgentHoldsNoProxySecret(agentEnv: Record<string, string>, secrets: Record<string, string>): void {
  for (const [secretName, secret] of Object.entries(secrets)) {
    if (secret.length === 0) continue;
    for (const [envName, envValue] of Object.entries(agentEnv)) {
      const leaks = envValue === secret || (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && envValue.includes(secret));
      if (leaks) {
        throw new ContainerError(
          'POLICY_VIOLATION',
          `Refusing to start: environment variable ${envName} for the agent carries the value of proxy secret "${secretName}". ` +
            'The agent must only ever see the proxy placeholder.'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Steps 4 and 6: stale resources, sidecar readiness
// ---------------------------------------------------------------------------

/**
 * Restarting "the same agent with the same data": a stopped container of the
 * same name is removed (its volumes stay), a stale sidecar and stale networks
 * are removed too. A running agent is never replaced.
 */
async function removeStale(runtime: ContainerRuntime, agent: string, names: ResourceNames, staleNetworks: readonly string[]): Promise<void> {
  const containers = await runtime.list({ agent, all: true });
  const existing = containers.find((c) => c.name === names.container);
  if (existing !== undefined && isActive(existing)) {
    throw new ContainerError(
      'INVALID_INPUT',
      `Agent "${agent}" is already running (container ${names.container}, ${existing.status}); stop it first`
    );
  }
  if (existing !== undefined) {
    await runtime.remove(names.container, { force: true });
  }
  if (containers.some((c) => c.name === names.proxy)) {
    await runtime.remove(names.proxy, { force: true });
  }
  for (const network of staleNetworks) {
    try {
      await runtime.removeNetwork(network);
    } catch {
      // Not there (the normal case) or still in use: ensureNetwork() below reuses or rejects it.
    }
  }
}

function redactedLogTail(text: string, secrets: readonly string[]): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-LOG_TAIL_LINES)
    // Redact the whole line BEFORE truncating it: a cut through the middle of a secret would leak its prefix.
    .map((line) => redactSecrets(line, secrets))
    .map((line) => (line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}...` : line));
  return lines.length === 0 ? '(no output)' : lines.join('\n');
}

async function readLogs(runtime: ContainerRuntime, container: string): Promise<string | null> {
  try {
    const result = await runtime.logs(container);
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function waitForProxyReady(
  runtime: ContainerRuntime,
  agent: string,
  names: ResourceNames,
  secrets: readonly string[],
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfInterrupted(signal);
    const sidecar = (await runtime.list({ agent, all: true })).find((c) => c.name === names.proxy);
    if (sidecar === undefined || sidecar.state !== 'running') {
      let tail = '(no output)';
      try {
        const logs = await readLogs(runtime, names.proxy);
        if (logs !== null) tail = redactedLogTail(logs, secrets);
      } catch {
        // the exit itself is the news; missing logs do not change it
      }
      throw new ContainerError(
        'COMMAND_FAILED',
        `Credential proxy sidecar ${names.proxy} stopped before it was ready (${sidecar === undefined ? 'it no longer exists' : sidecar.status}). Last log lines:\n${tail}`
      );
    }
    const logs = await readLogs(runtime, names.proxy);
    if (logs !== null && logs.split(/\r?\n/).some((line) => LISTENING_RE.test(line))) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ContainerError(
        'TIMEOUT',
        `Credential proxy sidecar ${names.proxy} did not report ready within ${timeoutMs} ms. Last log lines:\n${redactedLogTail(logs ?? '', secrets)}`
      );
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Watch a just-started detached agent for `graceMs`. Returns the exit code if it died (or is
 * crash-looping under a restart policy) with a non-zero code inside the window, otherwise
 * undefined: still running, exited 0 (a short job is legitimate), or the check could not be made.
 */
async function watchForEarlyExit(
  runtime: ContainerRuntime,
  agent: string,
  containerName: string,
  graceMs: number,
  pollMs: number,
  signal?: AbortSignal
): Promise<{ exitCode: number; state: string } | undefined> {
  if (!(graceMs > 0)) return undefined;
  const deadline = Date.now() + graceMs;
  for (;;) {
    // The agent is running, so the start has succeeded: an interrupt only ends the watching.
    if (signal?.aborted) return undefined;
    try {
      const row = (await runtime.list({ agent, all: true })).find((c) => c.name === containerName);
      if (row === undefined) return undefined;
      if (row.state === 'exited' || row.state === 'dead' || row.state === 'restarting') {
        const code = /\((-?\d+)\)/.exec(row.status)?.[1];
        if (code === undefined) return undefined;
        const exitCode = Number(code);
        return exitCode === 0 ? undefined : { exitCode, state: row.state };
      }
    } catch {
      return undefined;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Make sure the Docker volume for (agent, key) exists and is THIS agent's; true when this call created it.
 *
 * Volume names are `av-<agent>-<key>` and both parts may contain dashes, so different (agent, key) pairs can
 * derive the same name ("my" + "agent-data" and "my-agent" + "data"). The agent name and volume paths come from
 * the image's manifest, so an image can aim at another agent's data this way. An existing volume is therefore
 * used only if its labels say it belongs to exactly this agent and key; an unlabelled one (somebody else's) or
 * another agent's is refused, never adopted, and so never removed by a rollback either.
 */
export async function ensureAgentVolume(
  runtime: ContainerRuntime,
  agent: string,
  key: string,
  name: string = resourceNames(agent).volume(key)
): Promise<boolean> {
  const existing = await runtime.inspectVolume(name);
  if (existing === null) {
    await runtime.ensureVolume(name, { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: key });
    return true;
  }
  const labels = existing.labels;
  if (labels[LABEL_MANAGED] !== 'true') {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `Docker volume ${name} already exists but was not created by AgentVault, so it will not be used or removed. ` +
        `If it is yours to discard: docker volume rm ${name}`
    );
  }
  if (labels[LABEL_AGENT] === agent && labels[LABEL_VOLUME_KEY] === key) return false;
  const shown = (value: string | undefined): string => JSON.stringify((value ?? '').slice(0, 64));
  throw new ContainerError(
    'POLICY_VIOLATION',
    `Docker volume ${name} belongs to agent ${shown(labels[LABEL_AGENT])} (volume ${shown(labels[LABEL_VOLUME_KEY])}), not to "${agent}" (volume "${key}"): ` +
      'agent and volume names combine into the same Docker name. Use a different agent name (--name) or volume name.'
  );
}

// ---------------------------------------------------------------------------
// Step 8: ledger and rollback
// ---------------------------------------------------------------------------

/** What THIS call has created, and so may remove again. Nothing else is ever removed. */
interface Ledger {
  agentContainer: boolean;
  sidecar: boolean;
  internalNetwork: boolean;
  egressNetwork: boolean;
  createdVolumes: string[];
  agentStarted: boolean;
}

type Report = (what: string, error: unknown) => void;

async function attempt(what: string, action: () => Promise<void>, report: Report): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!isNotFound(error)) report(what, error);
  }
}

/** Sidecar first, then the networks it was attached to. Idempotent. */
async function releaseProxyStack(runtime: ContainerRuntime, names: ResourceNames, ledger: Ledger, report: Report): Promise<void> {
  if (ledger.sidecar) {
    ledger.sidecar = false;
    await attempt(`sidecar ${names.proxy}`, () => runtime.remove(names.proxy, { force: true }), report);
  }
  if (ledger.egressNetwork) {
    ledger.egressNetwork = false;
    await attempt(`network ${names.egress}`, () => runtime.removeNetwork(names.egress), report);
  }
  if (ledger.internalNetwork) {
    ledger.internalNetwork = false;
    await attempt(`network ${names.network}`, () => runtime.removeNetwork(names.network), report);
  }
}

async function rollback(runtime: ContainerRuntime, names: ResourceNames, ledger: Ledger, report: Report): Promise<void> {
  if (ledger.agentContainer) {
    ledger.agentContainer = false;
    await attempt(`container ${names.container}`, () => runtime.remove(names.container, { force: true }), report);
  }
  await releaseProxyStack(runtime, names, ledger, report);
  if (!ledger.agentStarted) {
    // Created by this call and never used by a running agent: nothing in them can be worth keeping.
    for (const volume of [...ledger.createdVolumes].reverse()) {
      await attempt(`volume ${volume}`, () => runtime.removeVolume(volume), report);
    }
  }
  ledger.createdVolumes = [];
}

// ---------------------------------------------------------------------------
// startAgent
// ---------------------------------------------------------------------------

export async function startAgent(request: StartAgentOptions): Promise<StartedAgent> {
  const secrets = request.proxyPlan !== undefined ? Object.values(request.proxyPlan.secrets) : [];
  try {
    return await startAgentChecked(request);
  } catch (error) {
    // Defence in depth: whatever failed and wherever, no plan secret leaves in a message.
    throw scrubError(error, secrets);
  }
}

async function startAgentChecked(request: StartAgentOptions): Promise<StartedAgent> {
  const { runtime } = request;
  const agent = assertAgentName(request.agent);
  const names = resourceNames(agent);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    try {
      request.onWarning?.(message);
    } catch {
      // a faulty callback must not abort a start half-way through
    }
  };

  // 1-2. The daemon and the image.
  await runtime.ensureAvailable();
  const { image, manifest } = await loadManifest(runtime, request.image);

  // 3. Everything that can be refused is refused here, before a single Docker resource exists.
  const resolved = resolveNetwork(request, manifest);
  const proxyMode = resolved.mode === 'proxy';
  if (!proxyMode && request.proxyEgressNetwork !== undefined) {
    throw new ContainerError('INVALID_INPUT', `proxyEgressNetwork only applies to network "proxy" (network is "${resolved.mode}")`);
  }
  const egress = proxyMode ? resolveEgress(request.proxyEgressNetwork, names) : undefined;
  const secretValues = resolved.mode === 'proxy' ? Object.values(resolved.plan.secrets) : [];
  const detach = request.detach !== false;

  const agentSpec: ContainerSpec = {
    ...buildAgentSpec({
      agent,
      image,
      manifest,
      network: resolved.mode,
      hostEnv: request.hostEnv ?? {},
      explicitEnv: request.explicitEnv ?? {},
      detach,
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.limits !== undefined ? { limits: request.limits } : {}),
      ...(resolved.mode === 'proxy' ? { proxyAgentEnv: resolved.plan.agentEnv } : {}),
      ...(request.extraMounts !== undefined ? { extraMounts: request.extraMounts } : {}),
      ...(request.writableRootfs !== undefined ? { writableRootfs: request.writableRootfs } : {}),
      ...(request.restart !== undefined ? { restart: request.restart } : {}),
      // Only a foreground run can use stdin; a detached container has nobody to read it.
      ...(request.interactive === true && !detach ? { interactive: true } : {}),
    }),
    // A foreground run that is not auto-removed leaves a stopped av-<agent> that blocks the next start.
    ...(detach ? {} : { autoRemove: true }),
  };
  const proxySpec = resolved.mode === 'proxy' ? buildProxySpec({ agent, plan: resolved.plan }) : undefined;

  // Validate the exact argv docker would get, now, while there is nothing to clean up.
  buildRunArgs(agentSpec, VALIDATION_ENV_FILE);
  if (proxySpec !== undefined) buildRunArgs(proxySpec, VALIDATION_ENV_FILE);
  if (resolved.mode === 'proxy') assertAgentHoldsNoProxySecret(agentSpec.env, resolved.plan.secrets);

  const volumes = volumeKeysForPaths(manifest.volumes);

  if (resolved.mode === 'bridge') {
    warn(
      'Network "bridge": the agent has unrestricted network access and no credential protection. ' +
        'Anything it runs can reach any host, and any secret in its environment is exposed to them.'
    );
  }
  if (request.writableRootfs === true) {
    warn('--writable-rootfs: the agent can modify its own root filesystem (its code and system files), which weakens the read-only isolation.');
  }
  if (egress !== undefined && !egress.owned) {
    warn(
      egress.name.toLowerCase() === 'bridge'
        ? `Credential proxy egress goes through the shared "bridge" network: every container on this host can reach the sidecar (${names.proxy}) by IP and spend the agent's credentials.`
        : `Credential proxy egress goes through network "${egress.name}", which AgentVault does not manage: every container attached to it can reach the sidecar (${names.proxy}) and spend the agent's credentials.`
    );
  }

  // 4-9. From here on something may be created, so everything is tracked and rolled back on failure.
  const ledger: Ledger = {
    agentContainer: false,
    sidecar: false,
    internalNetwork: false,
    egressNetwork: false,
    createdVolumes: [],
    agentStarted: false,
  };
  const report: Report = (what, error) => {
    warn(`Could not remove ${what}: ${redactSecrets(messageOf(error), secretValues)}. Remove it manually or run the remove command.`);
  };
  /** Start a container; remember it for rollback unless the failure was a name clash with something we did not create. */
  const startOwned = async (spec: ContainerSpec, mark: () => void): Promise<{ id: string }> => {
    try {
      const started = await runtime.start(spec);
      mark();
      return started;
    } catch (error) {
      if (!isNameInUse(error)) mark();
      throw error;
    }
  };

  // Nothing exists yet, so an interrupt here needs no rollback at all.
  throwIfInterrupted(request.signal);

  try {
    // 4. Same-named leftovers.
    const staleNetworks =
      egress === undefined ? [] : [names.network, ...(egress.owned ? [names.egress] : [])];
    await removeStale(runtime, agent, names, staleNetworks);

    // 5. Volumes. Only one this call CREATED may be taken away again by its rollback.
    for (const { key } of volumes) {
      throwIfInterrupted(request.signal);
      const name = names.volume(key);
      if (await ensureAgentVolume(runtime, agent, key, name)) ledger.createdVolumes.push(name);
    }

    // 6. Proxy mode: internal network, sidecar, its way out, readiness.
    if (resolved.mode === 'proxy' && proxySpec !== undefined && egress !== undefined) {
      const labels = { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: agent };
      throwIfInterrupted(request.signal);
      ledger.internalNetwork = true;
      await runtime.ensureNetwork(names.network, { internal: true, labels });
      throwIfInterrupted(request.signal);
      await startOwned(proxySpec, () => {
        ledger.sidecar = true;
      });
      if (egress.owned) {
        throwIfInterrupted(request.signal);
        ledger.egressNetwork = true;
        await runtime.ensureNetwork(names.egress, { internal: false, labels });
      }
      throwIfInterrupted(request.signal);
      // No aliases: the alias lives on the internal network only, so the sidecar is not discoverable by name from its egress side.
      await runtime.connectNetwork(names.proxy, egress.name);
      await waitForProxyReady(
        runtime,
        agent,
        names,
        secretValues,
        request.proxyReadyTimeoutMs ?? PROXY_READY_TIMEOUT_MS,
        request.proxyReadyPollMs ?? PROXY_READY_POLL_MS,
        request.signal
      );
    }

    // 7. The agent.
    const started: StartedAgent = {
      agent,
      containerName: names.container,
      ...(proxyMode ? { proxyContainerName: names.proxy, networkName: names.network } : {}),
      volumes: volumes.map(({ key }) => names.volume(key)),
      network: resolved.mode,
      warnings,
    };

    throwIfInterrupted(request.signal);
    if (detach) {
      const { id } = await startOwned(agentSpec, () => {
        ledger.agentContainer = true;
      });
      ledger.agentStarted = true;
      // Best effort and after agentStarted: nothing here may throw into the rollback below,
      // which would tear down an agent that is running fine.
      const earlyExit = await watchForEarlyExit(
        runtime,
        agent,
        names.container,
        request.livenessGraceMs ?? 0,
        request.livenessPollMs ?? LIVENESS_POLL_MS,
        request.signal
      );
      return { ...started, containerId: id, warnings: [...warnings], ...(earlyExit !== undefined ? { earlyExit } : {}) };
    }

    // From here the agent may write to its volumes, so a failure keeps them.
    ledger.agentStarted = true;
    let exitCode: number;
    try {
      exitCode = (await runtime.runForeground(agentSpec, { inheritStdio: true })).exitCode;
    } finally {
      // Never the volumes: the sidecar and the networks only.
      await releaseProxyStack(runtime, names, ledger, report);
    }
    return { ...started, exitCode, warnings: [...warnings] };
  } catch (error) {
    await rollback(runtime, names, ledger, report);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// stopAgent / removeAgent / listAgents
// ---------------------------------------------------------------------------

/**
 * Stop the agent container, then its sidecar (the agent still needs the
 * sidecar while it shuts down). Only containers that are actually running are
 * stopped, and only ones carrying this agent's labels and AgentVault's names.
 * Idempotent: nothing running means `stopped` is empty.
 */
export async function stopAgent(
  runtime: ContainerRuntime,
  agent: string,
  options: { timeoutSec?: number } = {}
): Promise<{ stopped: string[] }> {
  assertAgentName(agent);
  const names = resourceNames(agent);
  const containers = await runtime.list({ agent, all: true });
  const stopped: string[] = [];
  for (const name of [names.container, names.proxy]) {
    const container = containers.find((c) => c.name === name);
    if (container === undefined || !isActive(container)) continue;
    try {
      await (options.timeoutSec === undefined ? runtime.stop(name) : runtime.stop(name, options.timeoutSec));
      stopped.push(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { stopped };
}

/**
 * Stop (gracefully, so the agent can flush to its volumes) and remove the
 * agent container and the sidecar, then the egress and internal networks.
 * Volumes are KEPT unless `removeVolumes === true`. Idempotent. Any error
 * other than "not found" is thrown as is, and nothing after it is attempted.
 */
export async function removeAgent(
  runtime: ContainerRuntime,
  agent: string,
  options: { removeVolumes?: boolean; timeoutSec?: number } = {}
): Promise<{ removed: string[]; keptVolumes: string[]; removedVolumes: string[] }> {
  assertAgentName(agent);
  const names = resourceNames(agent);
  const removed: string[] = [];

  const containers = await runtime.list({ agent, all: true });
  for (const name of [names.container, names.proxy]) {
    const container = containers.find((c) => c.name === name);
    if (container === undefined) continue;
    try {
      if (isActive(container)) {
        await (options.timeoutSec === undefined ? runtime.stop(name) : runtime.stop(name, options.timeoutSec));
      }
      await runtime.remove(name, { force: true });
      removed.push(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  for (const network of [names.egress, names.network]) {
    try {
      await runtime.removeNetwork(network);
      removed.push(network);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const volumes = (await runtime.listVolumes({ agent })).map((v) => v.name);
  if (options.removeVolumes !== true) {
    return { removed, keptVolumes: volumes, removedVolumes: [] };
  }
  const removedVolumes: string[] = [];
  for (const volume of volumes) {
    try {
      await runtime.removeVolume(volume);
      removedVolumes.push(volume);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { removed, keptVolumes: [], removedVolumes };
}

/**
 * One row per agent, built from the containers Docker holds (no host-side
 * registry). Default: running containers only. A sidecar whose agent container
 * is gone is still listed, with state "proxy-only": it holds credentials and
 * the user should be told it is there.
 */
export async function listAgents(runtime: ContainerRuntime, options: { all?: boolean } = {}): Promise<AgentSummary[]> {
  const containers = await runtime.list({ all: options.all === true });
  const byAgent = new Map<string, { agent?: ContainerInfo; proxy?: ContainerInfo }>();
  for (const container of containers) {
    // Labels are untrusted input to name building: require a valid agent and the exact container name.
    if (!AGENT_NAME_RE.test(container.agent)) continue;
    const names = resourceNames(container.agent);
    const slot = byAgent.get(container.agent) ?? {};
    if (container.role === 'agent' && container.name === names.container) slot.agent = container;
    else if (container.role === 'proxy' && container.name === names.proxy) slot.proxy = container;
    else continue;
    byAgent.set(container.agent, slot);
  }
  const rows: AgentSummary[] = [];
  for (const [agent, { agent: main, proxy }] of byAgent) {
    const primary = main ?? proxy;
    if (primary === undefined) continue;
    rows.push({
      agent,
      state: main !== undefined ? main.state : 'proxy-only',
      image: primary.image,
      hasProxy: proxy !== undefined,
      containerName: primary.name,
      createdAt: primary.createdAt,
    });
  }
  return rows.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}
