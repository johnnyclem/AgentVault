/**
 * `agentvault container ...` and the shortcuts `run`, `ps`, `stop`, `rm`:
 * start, observe and remove agents that run in locked-down containers.
 *
 * Why it exists: src/container/lifecycle.ts knows HOW to start an agent safely;
 * this layer turns command-line input into a StartAgentRequest, decides where
 * the credentials come from, and prints what happened. It adds no policy of its
 * own beyond refusing input that cannot be valid, so the guarantees stay in the
 * library where they are tested against a real daemon.
 *
 * Security stance:
 *  - Nothing secret is accepted as a flag. Credentials live in the encrypted
 *    store (or, with --secrets-from-env, in the conventional environment
 *    variable) and reach only the credential-proxy sidecar. The store's
 *    passphrase is asked for only when the store is actually needed.
 *  - `run` fails closed BEFORE any Docker resource exists when a declared
 *    credential cannot be resolved; the message names the secrets, never values.
 *  - `rm` keeps volumes unless --volumes is given, and --volumes asks for
 *    confirmation (or -y). Data loss is always an explicit act.
 *  - A foreground run installs signal handlers so Ctrl-C stops the agent and
 *    lets the lifecycle tear the sidecar down, instead of killing this process
 *    and leaving a container that holds credentials behind.
 *  - `inspect` prints environment VALUES as <redacted> even if the runtime
 *    returned them.
 *  - Bind mounts are validated by assertBindSource (never the Docker socket) and
 *    announced as a weakening of isolation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { manifestFromLabels, parseManifest } from '../../src/container/manifest.js';
import type { ContainerManifest } from '../../src/container/manifest.js';
import { listAgents, removeAgent, startAgent, stopAgent } from '../../src/container/lifecycle.js';
import type { StartAgentOptions } from '../../src/container/lifecycle.js';
import { getPreset, presetSecretEnvMapping } from '../../src/container/proxy/presets.js';
import { SecretStore, createChainResolver, createEnvResolver, createStoreResolver } from '../../src/container/secrets-store.js';
import type { PartialSecretResolver } from '../../src/container/secrets-store.js';
import { ContainerError, LABEL_AGENT, LABEL_VOLUME_KEY } from '../../src/container/types.js';
import type {
  ContainerMount,
  ContainerRuntime,
  NetworkMode,
  ProxyPlan,
  ResourceLimits,
  StartedAgent,
} from '../../src/container/types.js';
import {
  ENV_NAME_RE,
  agentvaultHome,
  assertAgentName,
  assertBindSource,
  assertContainerPath,
  assertImageRef,
  assertVolumeKey,
  resourceNames,
  volumeKeysForPaths,
} from '../../src/container/validate.js';
import { readImageRecord } from './container-package.js';
import {
  collect,
  formatTable,
  noteLine,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
  requireAgentContainer,
  resolveDeps,
  runGuarded,
  warnLine,
  withSpinner,
} from './cli-support.js';
import type { CliContext, ContainerCliDeps } from './cli-support.js';

const NETWORK_MODES: readonly NetworkMode[] = ['none', 'proxy', 'bridge'];
const RESTART_POLICIES = ['no', 'unless-stopped', 'on-failure'] as const;
const CREDENTIAL_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Where a packaged directory keeps its manifest, relative to the agent source directory. */
const PACKAGED_MANIFEST_PATHS: readonly string[] = [path.join('dist', 'container', 'agentvault.json'), 'agentvault.json'];

// ---------------------------------------------------------------------------
// run: target resolution
// ---------------------------------------------------------------------------

export interface RunTarget {
  image: string;
  /** Set when the target was a packaged directory. */
  directory?: string;
}

interface PackagedDirectory {
  manifest: ContainerManifest;
  /** The directory that holds agentvault.json (and the image record). */
  outputDir: string;
}

/** The container manifest of a packaged directory, or undefined when the directory was not packaged. */
function readPackagedDirectory(dir: string): PackagedDirectory | undefined {
  for (const relative of PACKAGED_MANIFEST_PATHS) {
    const file = path.join(dir, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    try {
      return { manifest: parseManifest(fs.readFileSync(file, 'utf8')), outputDir: path.dirname(file) };
    } catch (error) {
      // A top-level agentvault.json is also the name of a generic agent config: not ours, so "not packaged".
      // The one under dist/container/ is ours, and a problem with it must be reported.
      if (relative === 'agentvault.json') continue;
      throw error;
    }
  }
  return undefined;
}

/**
 * The positional argument of `run`: an image reference, or a directory that
 * `package --target container` has produced. A name that is both an existing
 * directory and a valid image reference is a directory only if it was packaged.
 */
export function resolveRunTarget(target: string, ctx: CliContext): RunTarget {
  const resolved = path.resolve(ctx.cwd, target);
  const pathLike = target.startsWith('.') || target.startsWith('/') || target.startsWith('~');
  const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
  if (isDirectory) {
    const packaged = readPackagedDirectory(resolved);
    if (packaged !== undefined) {
      const recorded = readImageRecord(packaged.outputDir);
      return { image: recorded?.image ?? `agentvault/${packaged.manifest.name}:${packaged.manifest.version}`, directory: resolved };
    }
    if (pathLike) {
      throw new ContainerError(
        'NOT_FOUND',
        `${resolved} has not been packaged as a container: run "agentvault package ${target} --target container" first`
      );
    }
  } else if (pathLike) {
    throw new ContainerError('NOT_FOUND', `Directory ${resolved} does not exist`);
  }
  return { image: assertImageRef(target) };
}

// ---------------------------------------------------------------------------
// run: option parsing
// ---------------------------------------------------------------------------

export interface RunOptions {
  name?: string;
  detach?: boolean;
  interactive?: boolean;
  network?: string;
  proxy?: boolean;
  service?: string[];
  secretsFromEnv?: boolean;
  yes?: boolean;
  cpus?: string;
  memory?: string;
  pidsLimit?: string;
  env?: string[];
  volume?: string[];
  writableRootfs?: boolean;
  restart?: string;
}

function parseNetworkOption(options: RunOptions): NetworkMode | undefined {
  const requested = options.network;
  if (requested !== undefined && !(NETWORK_MODES as readonly string[]).includes(requested)) {
    throw new ContainerError('INVALID_INPUT', '--network must be one of: none, proxy, bridge');
  }
  if (options.proxy === true) {
    if (requested !== undefined && requested !== 'proxy') {
      throw new ContainerError('INVALID_INPUT', `--proxy conflicts with --network ${requested}`);
    }
    return 'proxy';
  }
  return requested as NetworkMode | undefined;
}

function parseLimits(options: RunOptions): Partial<ResourceLimits> {
  const limits: Partial<ResourceLimits> = {};
  if (options.cpus !== undefined) limits.cpus = parsePositiveNumber(options.cpus, '--cpus');
  if (options.memory !== undefined) {
    if (!/^[1-9][0-9]{0,11}[bkmgBKMG]?$/.test(options.memory)) {
      throw new ContainerError('INVALID_INPUT', '--memory must be a number with an optional b, k, m or g suffix, for example 2g');
    }
    limits.memory = options.memory;
  }
  if (options.pidsLimit !== undefined) limits.pidsLimit = parsePositiveInt(options.pidsLimit, '--pids-limit', 4_194_304);
  return limits;
}

/**
 * `--env KEY=VALUE` (literal) or `--env KEY` (copied from the environment, so
 * the value never reaches the command line). Messages never echo the input: it
 * may be a credential typed into the wrong place.
 */
export function parseEnvFlags(entries: readonly string[], ctx: CliContext): Record<string, string> {
  const out: Record<string, string> = {};
  let literal = false;
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const name = eq === -1 ? entry : entry.slice(0, eq);
    if (!ENV_NAME_RE.test(name)) {
      throw new ContainerError('INVALID_INPUT', '--env expects KEY=VALUE or a variable NAME; the name must match [A-Za-z_][A-Za-z0-9_]*');
    }
    if (eq === -1) {
      const value = ctx.env[name];
      if (value === undefined || value === '') {
        throw new ContainerError('INVALID_INPUT', `--env ${name}: ${name} is not set in your environment`);
      }
      out[name] = value;
    } else {
      literal = true;
      out[name] = entry.slice(eq + 1);
    }
    if (CREDENTIAL_NAME_RE.test(name)) {
      warnLine(
        ctx,
        `${name} looks like a credential: the agent would hold its value. Let the credential proxy hold it instead (--service <name> and "agentvault secrets add").`
      );
    }
  }
  if (literal) {
    noteLine(ctx, 'values given as --env KEY=VALUE land in your shell history and the process list; --env KEY copies the value from your environment instead');
  }
  return out;
}

export interface ParsedVolume {
  mount: ContainerMount;
  /** Set for a named volume: the key under av-<agent>-<key>. */
  key?: string;
}

/**
 * `name:/path` is a named volume managed by AgentVault (av-<agent>-<name>);
 * `/host/path:/path[:ro]` (or ./relative) is a bind mount of a host directory.
 */
export function parseVolumeFlag(spec: string, agent: string, ctx: CliContext): ParsedVolume {
  const parts = spec.split(':');
  const [source = '', target = '', mode, ...rest] = parts;
  if (parts.length < 2 || parts.length > 3 || rest.length > 0 || source === '' || target === '' || (mode !== undefined && mode !== 'ro' && mode !== 'rw')) {
    throw new ContainerError('INVALID_INPUT', '--volume expects NAME:/container/path or /host/path:/container/path, optionally followed by :ro');
  }
  const readOnly = mode === 'ro';
  const containerPath = assertContainerPath(target);
  const bind = source.startsWith('/') || source.startsWith('./') || source.startsWith('../');
  if (bind) {
    const hostPath = assertBindSource(path.resolve(ctx.cwd, source));
    if (!fs.existsSync(hostPath)) {
      throw new ContainerError('NOT_FOUND', `Bind-mount source ${hostPath} does not exist`);
    }
    warnLine(
      ctx,
      `bind mount ${hostPath} -> ${containerPath}${readOnly ? ' (read-only)' : ''}: the agent can ${readOnly ? 'read' : 'read and change'} that host directory, which weakens isolation`
    );
    return { mount: { kind: 'bind', source: hostPath, target: containerPath, ...(readOnly ? { readOnly: true } : {}) } };
  }
  const key = assertVolumeKey(source);
  return {
    mount: { kind: 'volume', source: resourceNames(agent).volume(key), target: containerPath, ...(readOnly ? { readOnly: true } : {}) },
    key,
  };
}

// ---------------------------------------------------------------------------
// run: credentials
// ---------------------------------------------------------------------------

/** The encrypted store as a resolver that asks for the passphrase only when it is asked for a name. */
function lazyStoreResolver(ctx: CliContext): PartialSecretResolver {
  const store = new SecretStore({ home: agentvaultHome(ctx.env) });
  const available = async (names: readonly string[]): Promise<Record<string, string>> => {
    // No store, nothing to unlock: do not prompt for a passphrase that protects nothing.
    if (!fs.existsSync(store.file)) return {};
    const passphrase = await ctx.getPassphrase({ purpose: 'secrets', confirm: false, message: 'Passphrase for the AgentVault secret store:' });
    return createStoreResolver(store, passphrase).available(names);
  };
  return {
    available,
    async resolve(names) {
      const found = await available(names);
      const missing = names.filter((name) => !Object.hasOwn(found, name));
      if (missing.length > 0) throw new ContainerError('MISSING_SECRET', `missing secrets: ${missing.join(', ')}`, { missing });
      return found;
    },
  };
}

/** Names of the secrets the given proxy services inject (ollama injects none). */
export function secretsNeededBy(services: readonly string[]): string[] {
  const names = new Set<string>();
  for (const service of services) {
    for (const injection of getPreset(service).inject) names.add(injection.secret);
  }
  return [...names];
}

/**
 * Resolve every credential the services need, or throw MISSING_SECRET naming
 * the ones that are missing. Nothing has been created at this point.
 */
async function resolveCredentials(ctx: CliContext, needed: readonly string[], fromEnv: boolean): Promise<Record<string, string>> {
  if (needed.length === 0) return {};
  const resolvers = [
    ...(fromEnv ? [createEnvResolver(presetSecretEnvMapping(), ctx.env)] : []),
    lazyStoreResolver(ctx),
  ];
  try {
    const values = await createChainResolver(...resolvers).resolve(needed);
    for (const value of Object.values(values)) ctx.sensitive.add(value);
    return values;
  } catch (error) {
    if (error instanceof ContainerError && error.code === 'MISSING_SECRET') {
      const missing = error.details?.['missing'];
      const names = Array.isArray(missing) ? missing.join(', ') : needed.join(', ');
      throw new ContainerError('MISSING_SECRET', `The agent needs credentials that are not available: ${names}. Nothing was started.`, {
        missing: Array.isArray(missing) ? [...missing] : [...needed],
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function loadImageManifest(runtime: ContainerRuntime, image: string): Promise<ContainerManifest> {
  const info = await runtime.inspectImage(image);
  if (info === null) {
    throw new ContainerError('NOT_FOUND', `Image ${image} was not found. Build it with 'agentvault package --target container' or fetch it with 'docker pull ${image}'.`);
  }
  const manifest = manifestFromLabels(info.labels);
  if (manifest === null) {
    throw new ContainerError('INVALID_INPUT', `Image ${image} is not an AgentVault image (it has no agentvault.manifest label). Build one with 'agentvault package --target container'.`);
  }
  return manifest;
}

function printStarted(ctx: CliContext, started: StartedAgent): void {
  ctx.log('');
  ctx.log(`${chalk.green('✓')} Started agent ${chalk.bold(started.agent)}`);
  ctx.log('');
  ctx.log(`  Container: ${started.containerName}${started.containerId !== undefined ? ` (${started.containerId.slice(0, 12)})` : ''}`);
  ctx.log(`  Network:   ${started.network}${started.proxyContainerName !== undefined ? ` (credential proxy: ${started.proxyContainerName})` : ''}`);
  ctx.log(`  Volumes:   ${started.volumes.length > 0 ? started.volumes.join(', ') : '(none)'}`);
  ctx.log('');
  ctx.log(chalk.cyan('Next steps:'));
  ctx.log('  agentvault ps');
  ctx.log(`  agentvault container logs ${started.agent} --follow`);
  ctx.log(`  agentvault stop ${started.agent}`);
}

/** What a shell exit status usually means for a container that died right after starting. */
function earlyExitHint(exitCode: number): string {
  switch (exitCode) {
    case 127:
      return ' (command not found: check the image entrypoint, or pass the command explicitly)';
    case 126:
      return ' (the entrypoint is not executable)';
    case 137:
      return ' (killed, often out of memory: try --memory)';
    default:
      return '';
  }
}

function printEarlyExit(ctx: CliContext, started: StartedAgent): void {
  if (started.earlyExit === undefined) return;
  const { exitCode, state } = started.earlyExit;
  ctx.log('');
  warnLine(
    ctx,
    `the agent ${state === 'restarting' ? 'is crash-looping' : 'exited immediately'} with code ${exitCode}${earlyExitHint(exitCode)}. ` +
      `The container was kept so you can read its output: agentvault container logs ${started.agent}`
  );
}

/** `registry:5000/ns/name:tag@sha256:...` -> `registry:5000/ns/name`: what stays the same across versions of one image. */
export function imageRepository(ref: string): string {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.indexOf(':', lastSlash + 1);
  return (colon === -1 ? withoutDigest : withoutDigest.slice(0, colon)).toLowerCase();
}

/**
 * The agent name defaults to the one in the image's manifest, which is written by whoever built the image. Without
 * this, an image that merely CLAIMS the name of a stopped agent replaces its container and mounts its data volumes
 * (and prints only "Started agent"). A new version of the same image repository is the normal rebuild-and-rerun
 * loop and needs nothing; anything else needs the user to say --name.
 */
async function assertNotAnotherImagesAgent(runtime: ContainerRuntime, agent: string, image: string): Promise<void> {
  const containerName = resourceNames(agent).container;
  const existing = (await runtime.list({ agent, all: true })).find((c) => c.name === containerName && c.role === 'agent');
  if (existing === undefined) return;
  let ref: unknown;
  try {
    ref = ((await runtime.inspect(containerName)) as { Config?: { Image?: unknown } } | null)?.Config?.Image;
  } catch (error) {
    if (error instanceof ContainerError && error.code === 'NOT_FOUND') return;
    throw error;
  }
  if (typeof ref !== 'string' || imageRepository(ref) === imageRepository(image)) return;
  throw new ContainerError(
    'POLICY_VIOLATION',
    `An agent named "${agent}" already exists from image ${ref}, and ${image} would take over its container and its data volumes. ` +
      `If that is what you want, say so with --name ${agent}; otherwise choose another name with --name <agent>.`
  );
}

/**
 * Credentials the IMAGE asks for (rather than the user naming them with --service) are a request, not a grant: the
 * agent never sees the keys, but through the proxy it can spend them. Asked for on a terminal, otherwise refused
 * with the exact flags. A service that opens a path to the user's own machine is never enabled by an image.
 */
async function approveRequestedServices(ctx: CliContext, requested: readonly string[], named: readonly string[], yes: boolean): Promise<void> {
  const asked = requested.filter((service) => !named.includes(service));
  if (asked.length === 0) return;
  const hostReaching = asked.filter((service) => (getPreset(service).addHosts ?? []).length > 0);
  if (hostReaching.length > 0) {
    throw new ContainerError(
      'POLICY_VIOLATION',
      `This image asks for ${hostReaching.join(', ')}, which gives the agent a path to services running on your computer. ` +
        `An image cannot enable that for itself; if you want it, pass ${hostReaching.map((service) => `--service ${service}`).join(' ')}.`
    );
  }
  if (yes) return;
  const list = asked.join(', ');
  if (ctx.interactive && (await ctx.confirm(`This image asks to use your stored credentials: ${list}. It never sees the keys, but it can spend them. Allow?`))) return;
  throw new ContainerError(
    'POLICY_VIOLATION',
    ctx.interactive
      ? `Not approved: this image asks to use credentials (${list}). Nothing was started.`
      : `This image asks to use credentials (${list}). Approve them with ${asked.map((service) => `--service ${service}`).join(' ')}, or approve everything it asks for with --yes.`
  );
}

export async function executeRun(target: string, command: readonly string[], options: RunOptions, ctx: CliContext): Promise<number | void> {
  const runtime = ctx.runtime();
  const { image } = resolveRunTarget(target, ctx);
  // inspectImage reports an unusable daemon with the same precise error codes as ensureAvailable would.
  const manifest = await loadImageManifest(runtime, image);

  const agent = assertAgentName(options.name ?? manifest.name);
  if (options.name === undefined) await assertNotAnotherImagesAgent(runtime, agent, image);
  const detach = options.detach === true;
  const explicitNetwork = parseNetworkOption(options);
  const extraServices = options.service ?? [];
  // The manifest is written by whoever built the image: it may narrow isolation, never widen it.
  if (explicitNetwork === undefined && manifest.isolation.network === 'bridge') {
    throw new ContainerError(
      'POLICY_VIOLATION',
      'This image asks for unrestricted network access (bridge). An image cannot choose that for itself; if you trust it, pass --network bridge.'
    );
  }
  const network: NetworkMode = explicitNetwork ?? (extraServices.length > 0 ? 'proxy' : manifest.isolation.network);
  const services = [...new Set([...manifest.secrets, ...extraServices])];

  if (network !== 'proxy' && extraServices.length > 0) {
    throw new ContainerError('INVALID_INPUT', `--service needs the credential proxy, but the network is "${network}"; use --network proxy`);
  }
  if (network === 'proxy' && services.length === 0) {
    throw new ContainerError(
      'INVALID_INPUT',
      'Network "proxy" needs at least one service to proxy: pass --service <name> (for example --service anthropic), or declare services when packaging with --secret.'
    );
  }

  const limits = parseLimits(options);
  const explicitEnv = parseEnvFlags(options.env ?? [], ctx);
  // The image's list of variables it reads is documentation, not an instruction: the user's shell is not searched for
  // them. Only what the user typed with --env reaches the agent.
  const unprovided = manifest.env.filter((name) => !Object.hasOwn(explicitEnv, name));
  if (unprovided.length > 0) {
    noteLine(
      ctx,
      `This image reads ${unprovided.join(', ')}. None is copied from your shell unless you name it: ` +
        `--env ${unprovided[0]} copies it, --env ${unprovided[0]}=<value> sets it.`
    );
  }
  if (options.restart !== undefined && !(RESTART_POLICIES as readonly string[]).includes(options.restart)) {
    throw new ContainerError('INVALID_INPUT', '--restart must be one of: no, unless-stopped, on-failure');
  }
  const manifestKeys = new Set(volumeKeysForPaths(manifest.volumes).map(({ key }) => key));
  const parsedVolumes = (options.volume ?? []).map((spec) => parseVolumeFlag(spec, agent, ctx));
  for (const { key } of parsedVolumes) {
    if (key !== undefined && manifestKeys.has(key)) {
      throw new ContainerError('INVALID_INPUT', `Volume name "${key}" is already the agent's own volume for one of its declared paths; pick another name`);
    }
  }

  // Credentials: approved, then resolved (and the passphrase asked for), before anything is created.
  let proxyPlan: ProxyPlan | undefined;
  if (network === 'proxy') {
    await approveRequestedServices(ctx, manifest.secrets, extraServices, options.yes === true);
    const secrets = await resolveCredentials(ctx, secretsNeededBy(services), options.secretsFromEnv === true);
    const { planProxy } = await import('../../src/container/proxy/plan.js');
    proxyPlan = await planProxy({ services, secrets });
  }

  // Named volumes are created labelled, so snapshot and rm can find them.
  const namedVolumes = parsedVolumes.flatMap(({ mount, key }) => (key === undefined ? [] : [{ name: mount.source, key }]));
  const createdVolumes: string[] = [];
  if (namedVolumes.length > 0) {
    const managedBefore = new Set((await runtime.listVolumes({ agent })).map((volume) => volume.name));
    for (const { name, key } of namedVolumes) {
      await runtime.ensureVolume(name, { [LABEL_AGENT]: agent, [LABEL_VOLUME_KEY]: key });
    }
    // A volume that is managed now but was not before is one THIS call made. (A pre-existing volume of that name that
    // was not ours keeps its own labels, so it never shows up here and is never removed.)
    const managedAfter = new Set((await runtime.listVolumes({ agent })).map((volume) => volume.name));
    createdVolumes.push(...namedVolumes.map(({ name }) => name).filter((name) => managedAfter.has(name) && !managedBefore.has(name)));
  }

  // Warnings: a detached start shows a spinner, so they wait until it is gone; a foreground run shows them at once.
  const pendingWarnings: string[] = [];
  const request: StartAgentOptions = {
    runtime,
    agent,
    image,
    network,
    detach,
    explicitEnv,
    onWarning: (message: string): void => {
      if (detach) pendingWarnings.push(message);
      else warnLine(ctx, message);
    },
    ...(command.length > 0 ? { command: [...command] } : {}),
    ...(proxyPlan !== undefined ? { proxyPlan } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    ...(parsedVolumes.length > 0 ? { extraMounts: parsedVolumes.map(({ mount }) => mount) } : {}),
    ...(options.writableRootfs === true ? { writableRootfs: true } : {}),
    ...(options.restart !== undefined ? { restart: options.restart as (typeof RESTART_POLICIES)[number] } : {}),
    ...(options.interactive === true && !detach ? { interactive: true } : {}),
  };
  if (options.interactive === true && detach) noteLine(ctx, '-i has no effect on a detached run (there is no terminal to read from)');

  let uninstall: (() => void) | undefined;
  if (!detach) {
    let stopping = false;
    uninstall = ctx.installSignalHandler(() => {
      if (stopping) return;
      stopping = true;
      void stopAgent(runtime, agent).catch(() => undefined);
    });
  }
  let started: StartedAgent;
  try {
    started = await (detach
      ? withSpinner(ctx, 'Starting the agent...', () => startAgent({ ...request, livenessGraceMs: ctx.livenessGraceMs }))
      : startAgent(request));
  } catch (error) {
    // A detached start that failed never ran the agent, so the volumes made for it are empty: take them away again.
    // (After a foreground run they could hold data, so they stay.)
    if (detach) {
      for (const volume of createdVolumes) {
        await runtime.removeVolume(volume).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    uninstall?.();
    for (const message of pendingWarnings) warnLine(ctx, message);
  }

  if (detach) {
    printStarted(ctx, started);
    printEarlyExit(ctx, started);
    return;
  }
  return started.exitCode ?? 0;
}

export function runCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('run')
    .description('Run an agent image in a locked-down container (no network, non-root, read-only root, no capabilities by default)')
    .argument('<target>', 'image reference, or a directory packaged with "package --target container"')
    .argument('[command...]', 'command to run instead of the image default (put it after --)')
    .option('--name <agent>', 'agent name (default: the name in the image manifest)')
    .option('-d, --detach', 'run in the background')
    .option('-i, --interactive', 'keep stdin open (foreground runs only)')
    .option('--network <mode>', 'none | proxy | bridge (default: the image manifest)')
    .option('--proxy', 'shorthand for --network proxy')
    .option('--service <name>', 'credential-proxy service to enable, for example anthropic or ollama (repeatable)', collect)
    .option('-y, --yes', 'approve the credential services the image asks for, instead of being asked (a service named with --service never needs this)')
    .option('--secrets-from-env', 'resolve credentials from their conventional environment variable (ANTHROPIC_API_KEY, ...) instead of the encrypted store')
    .option('--cpus <n>', 'CPU limit (default 2)')
    .option('--memory <size>', 'memory limit, for example 2g (default 2g)')
    .option('--pids-limit <n>', 'maximum number of processes (default 512)')
    .option('--env <KEY=VALUE>', 'environment variable for the agent (repeatable; KEY alone copies it from your environment)', collect)
    .option('--volume <spec>', 'NAME:/container/path (managed volume) or /host/path:/container/path[:ro] (bind mount) (repeatable)', collect)
    .option('--writable-rootfs', 'allow the agent to write to its root filesystem (weakens isolation)')
    .option('--restart <policy>', 'no | unless-stopped | on-failure')
    .action(async (target: string, command: string[], options: RunOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeRun(target, command, options, ctx));
    });
}

// ---------------------------------------------------------------------------
// ps / logs / stop / rm / stats / inspect / exec
// ---------------------------------------------------------------------------

export async function executePs(options: { all?: boolean; json?: boolean }, ctx: CliContext): Promise<void> {
  const rows = await listAgents(ctx.runtime(), { all: options.all === true });
  if (options.json === true) {
    ctx.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    ctx.log(options.all === true ? 'No agents.' : 'No running agents. Use --all to include stopped ones.');
    return;
  }
  for (const line of formatTable(
    ['AGENT', 'STATE', 'IMAGE', 'PROXY', 'CREATED'],
    rows.map((row) => [row.agent, row.state, row.image, row.hasProxy ? 'yes' : 'no', row.createdAt])
  )) {
    ctx.log(line);
  }
  if (rows.some((row) => row.state === 'proxy-only')) {
    noteLine(ctx, 'a proxy-only agent has a credential sidecar but no agent container; "agentvault rm <agent>" removes it');
  }
}

export function psCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('ps')
    .description('List agents (running by default)')
    .option('-a, --all', 'include stopped agents')
    .option('-j, --json', 'machine-readable output')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executePs(options, ctx));
    });
}

export async function executeLogs(agent: string, options: { follow?: boolean; tail?: string }, ctx: CliContext): Promise<number | void> {
  const runtime = ctx.runtime();
  const { name } = await requireAgentContainer(runtime, agent);
  const tail = options.tail !== undefined ? parseNonNegativeInt(options.tail, '--tail') : undefined;
  const result = await runtime.logs(name, {
    ...(tail !== undefined ? { tail } : {}),
    ...(options.follow === true ? { follow: true } : {}),
  });
  // Followed output already streamed to the terminal.
  if (options.follow !== true) {
    if (result.stdout.length > 0) ctx.log(result.stdout);
    if (result.stderr.length > 0) ctx.err(result.stderr);
  }
  return result.exitCode;
}

export function containerLogsCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('logs')
    .description("Show an agent's logs")
    .argument('<agent>', 'agent name')
    .option('-f, --follow', 'stream new output')
    .option('--tail <n>', 'show only the last n lines')
    .action(async (agent: string, options: { follow?: boolean; tail?: string }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeLogs(agent, options, ctx));
    });
}

export async function executeStop(agent: string, options: { time?: string }, ctx: CliContext): Promise<void> {
  assertAgentName(agent);
  const timeoutSec = options.time !== undefined ? parseNonNegativeInt(options.time, '--time') : undefined;
  const { stopped } = await stopAgent(ctx.runtime(), agent, timeoutSec !== undefined ? { timeoutSec } : {});
  if (stopped.length === 0) {
    ctx.log(`Agent "${agent}" is not running.`);
    return;
  }
  ctx.log(`${chalk.green('✓')} Stopped ${stopped.join(', ')}`);
  ctx.log(chalk.gray(`  Its data is kept. Start it again with "agentvault run", or remove it with "agentvault rm ${agent}".`));
}

export function stopCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('stop')
    .description('Stop an agent and its credential proxy (data is kept)')
    .argument('<agent>', 'agent name')
    .option('-t, --time <seconds>', 'seconds to wait before the agent is killed (default 10)')
    .action(async (agent: string, options: { time?: string }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeStop(agent, options, ctx));
    });
}

export async function executeRm(agent: string, options: { volumes?: boolean; yes?: boolean }, ctx: CliContext): Promise<void> {
  assertAgentName(agent);
  const runtime = ctx.runtime();
  const removeVolumes = options.volumes === true;
  if (removeVolumes && options.yes !== true) {
    const volumes = (await runtime.listVolumes({ agent })).map((volume) => volume.name);
    if (volumes.length > 0) {
      const confirmed = await ctx.confirm(`Permanently delete the data in ${volumes.join(', ')}? This cannot be undone.`);
      if (!confirmed) {
        ctx.log('Aborted. Nothing was removed. Pass -y to delete the volumes without this question.');
        return;
      }
    }
  }
  const result = await removeAgent(runtime, agent, removeVolumes ? { removeVolumes: true } : {});
  if (result.removed.length === 0 && result.removedVolumes.length === 0 && result.keptVolumes.length === 0) {
    ctx.log(`Nothing to remove for agent "${agent}".`);
    return;
  }
  if (result.removed.length > 0) ctx.log(`${chalk.green('✓')} Removed ${result.removed.join(', ')}`);
  if (result.removedVolumes.length > 0) ctx.log(`${chalk.green('✓')} Deleted volumes ${result.removedVolumes.join(', ')}`);
  if (result.keptVolumes.length > 0) {
    ctx.log(chalk.gray(`  Kept volumes ${result.keptVolumes.join(', ')}. "agentvault rm ${agent} --volumes" deletes the data too.`));
  }
}

export function rmCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('rm')
    .description("Remove an agent and its credential proxy; its volumes are kept unless --volumes is given")
    .argument('<agent>', 'agent name')
    .option('--volumes', "also DELETE the agent's data volumes (asks for confirmation)")
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (agent: string, options: { volumes?: boolean; yes?: boolean }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeRm(agent, options, ctx));
    });
}

export async function executeStats(agent: string, ctx: CliContext): Promise<void> {
  const runtime = ctx.runtime();
  const { name } = await requireAgentContainer(runtime, agent);
  const result = await runtime.stats(name);
  ctx.log(result.stdout);
}

export function containerStatsCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('stats')
    .description("Show an agent's CPU, memory and process usage")
    .argument('<agent>', 'agent name')
    .action(async (agent: string) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeStats(agent, ctx));
    });
}

/** Replace every `NAME=value` in Config.Env with `NAME=<redacted>`, whatever the runtime did before us. */
export function redactInspectOutput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const copy = structuredClone(value) as { Config?: { Env?: unknown } };
  if (copy.Config !== undefined && copy.Config !== null && Array.isArray(copy.Config.Env)) {
    copy.Config.Env = copy.Config.Env.map((entry: unknown) => {
      if (typeof entry !== 'string') return '<redacted>';
      const eq = entry.indexOf('=');
      return eq === -1 ? entry : `${entry.slice(0, eq)}=<redacted>`;
    });
  }
  return copy;
}

export async function executeInspect(agent: string, ctx: CliContext): Promise<void> {
  const runtime = ctx.runtime();
  const { name } = await requireAgentContainer(runtime, agent);
  ctx.log(JSON.stringify(redactInspectOutput(await runtime.inspect(name)), null, 2));
}

export function containerInspectCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('inspect')
    .description("Show a container's low-level details (environment values are redacted)")
    .argument('<agent>', 'agent name')
    .action(async (agent: string) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeInspect(agent, ctx));
    });
}

export async function executeExec(agent: string, command: readonly string[], options: { interactive?: boolean }, ctx: CliContext): Promise<number | void> {
  const runtime = ctx.runtime();
  const { name, state } = await requireAgentContainer(runtime, agent);
  if (state !== 'running') {
    throw new ContainerError('INVALID_INPUT', `Agent "${agent}" is not running (state: ${state}); start it with "agentvault run" first`);
  }
  const interactive = options.interactive === true;
  const result = await runtime.exec(name, [...command], { interactive });
  // Interactive output already went straight to the terminal.
  if (!interactive) {
    if (result.stdout.length > 0) ctx.log(result.stdout);
    if (result.stderr.length > 0) ctx.err(result.stderr);
  }
  return result.exitCode;
}

export function containerExecCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('exec')
    .description('Run a command inside a running agent container (put the command after --)')
    .argument('<agent>', 'agent name')
    .argument('<command...>', 'command and arguments')
    .option('-i, --interactive', 'keep stdin open and allocate a terminal when there is one')
    .action(async (agent: string, command: string[], options: { interactive?: boolean }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeExec(agent, command, options, ctx));
    });
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export function containerCommand(deps: ContainerCliDeps = {}): Command {
  return new Command('container')
    .description('Run agents in locked-down containers: run, ps, logs, stop, rm, stats, inspect, exec')
    .addCommand(runCommand(deps))
    .addCommand(psCommand(deps))
    .addCommand(containerLogsCommand(deps))
    .addCommand(stopCommand(deps))
    .addCommand(rmCommand(deps))
    .addCommand(containerStatsCommand(deps))
    .addCommand(containerInspectCommand(deps))
    .addCommand(containerExecCommand(deps));
}
