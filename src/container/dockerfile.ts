/**
 * Dockerfile generation for packaged agents (PRD-02 §3.3).
 *
 * Why a pure string renderer: the Dockerfile is the one place where
 * attacker-influenced text (agent.json, package.json, CLI flags) meets a
 * language with its own parser, so every interpolation is guarded here and
 * covered by golden + injection tests, with no filesystem or Docker involved.
 *
 * Security stance:
 *  - Every manifest string is rejected if it contains a control character or a
 *    newline BEFORE rendering, so no value can start a new instruction.
 *  - CMD / HEALTHCHECK are exec form built with JSON.stringify: no shell ever
 *    sees an agent-supplied value.
 *  - LABEL values are JSON strings with `$` escaped (the Dockerfile parser
 *    expands `$VAR` inside double quotes, which would silently corrupt the
 *    manifest label).
 *  - ENV holds fixed constants only. No ARG, and no ENV/LABEL ever carries a
 *    user-supplied value other than the manifest label.
 *  - The image runs as the manifest's numeric non-root user; uid/gid 0 are
 *    refused.
 */

import { ContainerError, LABEL_MANIFEST, LABEL_SOURCE_HASH } from './types.js';
import { assertContainerPath, assertImageRef, parseUser } from './validate.js';
import { manifestToLabel, parseManifest, type ContainerManifest } from './manifest.js';

export type RuntimeKind = ContainerManifest['runtime'];

/** How dependencies are installed; chosen by detectContainerRuntime(). */
export type InstallPlan = 'npm-ci' | 'npm-install' | 'pip-requirements' | 'pip-project' | 'none';

export const LABEL_BASE = 'agentvault.base';
export const DEFAULT_BASE_IMAGES: Readonly<Record<RuntimeKind, string>> = {
  node: 'node:22-slim',
  python: 'python:3.12-slim',
};

export const AGENT_HOME = '/home/agent';
export const AGENT_WORKDIR = '/app';

/** Refuse absurd manifests rather than baking a multi-megabyte label. */
const MAX_LABEL_BYTES = 64 * 1024;

/** True for C0/C1 controls (including newline, tab, NUL) and U+2028/2029. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      return true;
    }
  }
  return false;
}

/** Make an untrusted string safe to print in a message or log line. */
export function printable(value: string, maxLength = 200): string {
  let out = '';
  for (let i = 0; i < value.length && out.length < maxLength; i++) {
    out += hasControlChars(value.charAt(i)) ? '?' : value.charAt(i);
  }
  return out.length < value.length ? `${out}...` : out;
}

function invalid(message: string): never {
  throw new ContainerError('INVALID_INPUT', message);
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/**
 * Quote a value for a Dockerfile instruction that takes a shell-style word
 * (LABEL). JSON escapes `"` and `\` the way the Dockerfile lexer unescapes
 * them; `$` is not escaped by JSON but IS expanded by the lexer, so do it here.
 */
export function dockerQuote(value: string): string {
  return JSON.stringify(value).replace(/\$/g, '\\$');
}

/** Exec-form (JSON array) argv. No variable expansion applies to exec form. */
function execForm(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

export interface DockerfileInput {
  /** Validated again here; the label and CMD are derived from it. */
  manifest: ContainerManifest;
  /** Base image reference (validated with assertImageRef). */
  base: string;
  install: InstallPlan;
}

interface InstallSteps {
  /** Files copied before the rest of the source, for layer caching. */
  early: string[];
  /** RUN command (constant text) executed right after the early COPY. */
  run?: string;
  /** RUN command executed after the whole source is copied. */
  late?: string;
}

const NODE_CLEAN = 'npm cache clean --force';

function installSteps(runtime: RuntimeKind, install: InstallPlan): InstallSteps {
  const nodeOnly = install === 'npm-ci' || install === 'npm-install';
  const pythonOnly = install === 'pip-requirements' || install === 'pip-project';
  if ((runtime === 'node' && pythonOnly) || (runtime === 'python' && nodeOnly)) {
    invalid(`Install plan ${JSON.stringify(install)} does not match runtime ${JSON.stringify(runtime)}`);
  }
  switch (install) {
    case 'npm-ci':
      return {
        early: ['package.json', 'package-lock.json'],
        run: `npm ci --omit=dev --ignore-scripts --no-audit --no-fund && ${NODE_CLEAN}`,
      };
    case 'npm-install':
      return {
        early: ['package.json'],
        run: `npm install --omit=dev --ignore-scripts --no-audit --no-fund && ${NODE_CLEAN}`,
      };
    case 'pip-requirements':
      return { early: ['requirements.txt'], run: 'pip install --no-cache-dir -r requirements.txt' };
    case 'pip-project':
      // `pip install .` needs the project sources, so it runs after the full COPY.
      return { early: [], late: 'pip install --no-cache-dir .' };
    case 'none':
      return { early: [] };
    default:
      return invalid(`Unknown install plan ${JSON.stringify(install satisfies never)}`);
  }
}

/** Fixed, non-user-supplied environment. Adding a user value here is a bug. */
function constantEnv(runtime: RuntimeKind): Array<[string, string]> {
  const env: Array<[string, string]> =
    runtime === 'node'
      ? [['NODE_ENV', 'production']]
      : [
          ['PYTHONUNBUFFERED', '1'],
          ['PYTHONDONTWRITEBYTECODE', '1'],
        ];
  env.push(['HOME', AGENT_HOME]);
  return env;
}

function healthcheckLine(health: NonNullable<ContainerManifest['healthcheck']>): string {
  let argv = [...health.test];
  const marker = argv[0];
  if (marker === 'CMD-SHELL' || marker === 'NONE') {
    invalid(`Healthcheck test ${JSON.stringify(marker)} is not allowed: use exec form (no shell)`);
  }
  if (marker === 'CMD') argv = argv.slice(1);
  if (argv.length === 0) invalid('Healthcheck test is empty');

  const flags: string[] = [];
  const seconds = (flag: string, value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0) invalid(`Healthcheck ${flag} must be a non-negative integer`);
    flags.push(`--${flag}=${value}s`);
  };
  seconds('interval', health.intervalSec);
  seconds('timeout', health.timeoutSec);
  seconds('start-period', health.startPeriodSec);
  if (health.retries !== undefined) {
    if (!Number.isInteger(health.retries) || health.retries < 1) invalid('Healthcheck retries must be a positive integer');
    flags.push(`--retries=${health.retries}`);
  }
  return `HEALTHCHECK ${[...flags, 'CMD', execForm(argv)].join(' ')}`;
}

/**
 * Render the Dockerfile for a manifest. Pure and deterministic: the same input
 * always yields the same text (the manifest carries the source content hash).
 */
export function renderDockerfile(input: DockerfileInput): string {
  const manifest = parseManifest(input.manifest);
  const base = assertImageRef(input.base);

  for (const text of collectStrings(manifest)) {
    if (hasControlChars(text)) {
      invalid(`Refusing to render a Dockerfile: a manifest value contains a control character or newline (${JSON.stringify(printable(text, 60))})`);
    }
  }
  if (hasControlChars(base)) invalid('Refusing to render a Dockerfile: base image contains a control character');

  const { uid, gid } = parseUser(manifest.isolation.user);
  if (uid === 0 || gid === 0) {
    throw new ContainerError('POLICY_VIOLATION', 'Refusing to render a Dockerfile for uid/gid 0; agents must run as non-root');
  }

  const volumes = [...new Set(manifest.volumes.map((v) => assertContainerPath(v)))];
  const label = manifestToLabel(manifest);
  if (Buffer.byteLength(label, 'utf8') > MAX_LABEL_BYTES) {
    invalid(`Manifest label exceeds ${MAX_LABEL_BYTES} bytes`);
  }

  const steps = installSteps(manifest.runtime, input.install);
  const owned = [AGENT_HOME, ...volumes.filter((v) => v !== AGENT_HOME)];

  const lines: string[] = [
    '# Generated by AgentVault. Do not edit: regenerate with `agentvault package`.',
    `FROM ${base}`,
    ...constantEnv(manifest.runtime).map(([k, v]) => `ENV ${k}=${v}`),
    `RUN groupadd --gid ${gid} agent && useradd --uid ${uid} --gid ${gid} --home-dir ${AGENT_HOME} --no-create-home --shell /usr/sbin/nologin agent`,
    `RUN mkdir -p -- ${owned.join(' ')} && chown ${uid}:${gid} -- ${owned.join(' ')}`,
    `WORKDIR ${AGENT_WORKDIR}`,
  ];
  if (steps.early.length > 0) lines.push(`COPY ${steps.early.join(' ')} ./`);
  if (steps.run) lines.push(`RUN ${steps.run}`);
  lines.push(`COPY . ${AGENT_WORKDIR}`);
  if (steps.late) lines.push(`RUN ${steps.late}`);
  lines.push(
    `LABEL ${LABEL_MANIFEST}=${dockerQuote(label)}`,
    `LABEL ${LABEL_SOURCE_HASH}=${dockerQuote(manifest.source.contentHash)}`,
    `LABEL ${LABEL_BASE}=${dockerQuote(base)}`,
    `USER ${uid}:${gid}`
  );
  if (manifest.healthcheck) lines.push(healthcheckLine(manifest.healthcheck));
  lines.push(`CMD ${execForm(manifest.entrypoint)}`);
  return `${lines.join('\n')}\n`;
}

const HEALTH_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1):([1-9][0-9]{0,4})(\/[A-Za-z0-9._~/-]{0,200})?$/;

/**
 * A healthcheck argv that needs no curl (slim images do not ship it). The URL
 * must be loopback http so a check can never be turned into an outbound request.
 */
export function healthcheckForUrl(runtime: RuntimeKind, url: string): string[] {
  const m = typeof url === 'string' ? HEALTH_URL_RE.exec(url) : null;
  const port = m ? Number(m[2]) : 0;
  if (!m || port > 65535 || (m[3] ?? '').split('/').includes('..')) {
    invalid(`Invalid health URL ${JSON.stringify(printable(String(url), 80))}: expected http://localhost:<port>/<path> or http://127.0.0.1:<port>/<path>`);
  }
  const target = `http://${m[1]}:${port}${m[3] ?? '/'}`;
  if (runtime === 'node') {
    return ['node', '-e', `fetch(${JSON.stringify(target)},{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`];
  }
  return ['python', '-c', `import sys,urllib.request;sys.exit(0 if urllib.request.urlopen(${JSON.stringify(target)},timeout=4).status<400 else 1)`];
}
