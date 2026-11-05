/**
 * Decide how an agent directory runs in a container: node or python, how its
 * dependencies are installed, and the exec-form entrypoint argv.
 *
 * Why not reuse detectAgent() alone: it cannot tell node from python, ignores
 * a config's own entryPoint, prefers .ts files, and returns name/version
 * verbatim. It is still called (for the agent type, name and version) but
 * everything it returns is treated as untrusted here.
 *
 * Security stance: agent.json / package.json / the CLI are untrusted. Names
 * and versions are re-sanitised; every entrypoint path must be relative,
 * normalised, free of control characters, free of `..`, and resolve (after
 * realpath) to a regular file INSIDE the source directory with no symlink on
 * the way, because staging never copies symlinks and a path that crosses one
 * could otherwise read a host file such as /etc/passwd into the image.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectAgent } from '../packaging/detector.js';
import type { AgentConfig } from '../packaging/types.js';
import { sanitizePathPart } from '../utils/path-validation.js';
import { ContainerError } from './types.js';
import { AGENT_NAME_RE, assertImageRef } from './validate.js';
import { DEFAULT_BASE_IMAGES, hasControlChars, printable, type InstallPlan, type RuntimeKind } from './dockerfile.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'pip' | 'poetry' | 'uv' | 'none';

export interface DetectOptions {
  /** Force node or python instead of detecting it (the `--runtime` flag). */
  runtimeKind?: RuntimeKind;
  /** Full exec-form argv, for example ['node', 'server.js', '--port', '3000']. */
  entrypoint?: string[];
  /** Base image override; validated with assertImageRef. */
  base?: string;
  /** Agent name override (slugified like a detected name). */
  name?: string;
}

export interface ContainerRuntimeDetection {
  /** realpath of the source directory. */
  sourceDir: string;
  /** Matches AGENT_NAME_RE. */
  name: string;
  /** Only [A-Za-z0-9._-], 1-64 chars. */
  version: string;
  /** detectAgent()'s type, for example "generic" or "goose". */
  agentType: string;
  runtime: RuntimeKind;
  packageManager: PackageManager;
  /** Lockfile that will be honoured, if any. */
  lockfile?: string;
  install: InstallPlan;
  /** Exec-form argv, never a shell string. */
  entrypoint: string[];
  /** Source-relative POSIX path of the script the entrypoint runs, if it runs one. */
  entryFile?: string;
  base: string;
  warnings: string[];
}

export const PYTHON_ENTRY_CANDIDATES: readonly string[] = ['main.py', 'app.py', 'agent.py', '__main__.py'];
export const NODE_ENTRY_FALLBACKS: readonly string[] = ['index.js', 'main.js', 'agent.js', 'src/index.js', 'src/main.js'];

const MAX_CONFIG_BYTES = 1024 * 1024;
const TYPESCRIPT_RE = /\.(ts|tsx|mts|cts)$/i;

// ---------------------------------------------------------------------------
// Names that are never copied into an image. Shared with staging so that an
// entrypoint can never point at a file the build context will not contain.
// ---------------------------------------------------------------------------

const EXCLUDED_NAMES = new Set([
  '.git', 'node_modules', '.agentvault', '.venv', 'venv', '__pycache__',
  '.ssh', '.aws', '.gnupg', '.docker', '.kube',
  '.npmrc', '.pypirc', '.netrc', '.ds_store', '.git-credentials', '.pgpass', '.dockerignore',
  '.htpasswd', '.vault-token', '.boto', '.s3cfg', '.dockercfg', 'kubeconfig', 'credentials.json',
  '.bash_history', '.zsh_history',
]);
const EXCLUDED_SUFFIXES = [
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.log',
  '.p8', '.ppk', '.kdbx', '.gpg', '.kubeconfig',
  '.tfstate', '.tfstate.backup', '.tfvars', '.tfvars.json',
];
/** Data files that are credentials by convention. Whole-name patterns, so `secrets_manager.js` and `serviceaccount.js` stay. */
const EXCLUDED_NAME_PATTERNS = [/^secrets(\..*)?$/, /service[-_]?account.*\.json$/];
/** `id_rsa`, `my_id_rsa`, `deploy-id_ed25519`, but not `valid_rsa_key.js`: the key type must start a word. */
const SSH_KEY_RE = /(^|[^a-z0-9])id_(rsa|ed25519|ecdsa|dsa)/;
/** Added by editors and backup tools. `.env~` and `server.key.bak` are as sensitive as the originals. */
const BACKUP_SUFFIXES = ['~', '.bak', '.old', '.orig', '.swp', '.tmp'];

function withoutBackupSuffix(name: string): string {
  let current = name;
  for (;;) {
    const suffix = BACKUP_SUFFIXES.find((s) => current.length > s.length && current.endsWith(s));
    if (suffix === undefined) return current;
    current = current.slice(0, -suffix.length);
  }
}

/**
 * Why a directory entry (matched on its base name, case-insensitively) is never
 * copied into the build context, or undefined when it may be.
 *
 * Every rule is judged on the name with backup suffixes removed, so decorating a
 * secret's name does not smuggle it in. Deliberately NOT excluded: `env`, `env.py`,
 * `env.js` and `environment.js`, which are ordinary source files. Only a name that
 * STARTS with `.env` or ENDS with `.env` is treated as an environment file.
 */
export function exclusionReason(baseName: string): string | undefined {
  const n = withoutBackupSuffix(baseName.toLowerCase());
  if (n.startsWith('.env') || n.endsWith('.env')) return 'environment file (may hold secrets)';
  if (EXCLUDED_NAMES.has(n) || EXCLUDED_NAME_PATTERNS.some((re) => re.test(n))) return 'excluded name (secrets, VCS data or local environments)';
  if (EXCLUDED_SUFFIXES.some((s) => n.endsWith(s))) return 'excluded file type (key material or log)';
  if (SSH_KEY_RE.test(n)) return 'SSH private key';
  return undefined;
}

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------

/** Lowercase, invalid chars -> '-', trimmed to AGENT_NAME_RE, fallback 'agent'. */
export function slugifyAgentName(raw: unknown): string {
  const source = typeof raw === 'string' ? raw : '';
  let slug = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40)
    .replace(/[-_]+$/, '');
  if (!AGENT_NAME_RE.test(slug)) slug = 'agent';
  return slug;
}

/** Keep [A-Za-z0-9._-]; usable as an image tag. Fallback '0.0.0'. */
export function sanitizeVersion(raw: unknown): string {
  if (typeof raw !== 'string') return '0.0.0';
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[^A-Za-z0-9]+$/, '');
  return cleaned.length > 0 ? cleaned : '0.0.0';
}

// ---------------------------------------------------------------------------
// Entrypoint path checks
// ---------------------------------------------------------------------------

const TS_MESSAGE =
  'AgentVault does not compile TypeScript in Phase 1. Build it to JavaScript first (for example with tsc into dist/), then set package.json "main" or pass --entrypoint with the compiled file';

type EntryCheck =
  | { kind: 'ok'; rel: string }
  | { kind: 'typescript'; rel: string }
  | { kind: 'excluded'; rel: string; reason: string }
  | { kind: 'missing'; rel: string }
  | { kind: 'not-file'; rel: string }
  | { kind: 'unsupported'; rel: string; why: string };

function invalid(message: string): never {
  throw new ContainerError('INVALID_INPUT', message);
}

/**
 * Validate one source-relative entrypoint path. Unsafe paths (control
 * characters, absolute, "..", symlink escapes) throw. Paths that are merely
 * unusable (missing, TypeScript, excluded, a directory, unsupported
 * characters) are returned so derived candidates can fall through to the next
 * one while an explicit --entrypoint turns them into errors.
 */
function checkEntryPath(realSource: string, raw: unknown): EntryCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    invalid('Invalid entrypoint path: expected a non-empty string of at most 512 characters');
  }
  const shown = JSON.stringify(printable(raw, 80));
  if (hasControlChars(raw)) invalid(`Invalid entrypoint path ${shown}: contains a control character or newline`);
  if (raw.includes('\\')) invalid(`Invalid entrypoint path ${shown}: use "/" separators`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) invalid(`Invalid entrypoint path ${shown}: must be relative to the source directory`);
  if (raw.split('/').includes('..')) invalid(`Invalid entrypoint path ${shown}: ".." is not allowed`);

  const rel = path.posix.normalize(raw);
  if (rel === '.' || rel.endsWith('/')) return { kind: 'not-file', rel };
  if (rel.startsWith('-')) return { kind: 'unsupported', rel, why: 'must not start with "-"' };
  const segments = rel.split('/');
  for (const segment of segments) {
    try {
      sanitizePathPart(segment);
    } catch {
      return { kind: 'unsupported', rel, why: 'each path segment must be 1-128 characters of [A-Za-z0-9._-]' };
    }
  }
  if (TYPESCRIPT_RE.test(rel)) return { kind: 'typescript', rel };
  for (const segment of segments) {
    const reason = exclusionReason(segment);
    if (reason !== undefined) return { kind: 'excluded', rel, reason: `"${segment}" is never copied into the image (${reason})` };
  }

  const abs = path.join(realSource, ...segments);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { kind: 'missing', rel };
  }
  const fromSource = path.relative(realSource, real);
  if (fromSource === '..' || fromSource.startsWith(`..${path.sep}`) || path.isAbsolute(fromSource)) {
    throw new ContainerError('POLICY_VIOLATION', `Entrypoint ${shown} resolves outside the source directory (symbolic link?); refusing`);
  }
  if (real !== abs) {
    throw new ContainerError('POLICY_VIOLATION', `Entrypoint ${shown} passes through a symbolic link; symbolic links are never copied into the image`);
  }
  if (!fs.lstatSync(real).isFile()) return { kind: 'not-file', rel };
  return { kind: 'ok', rel };
}

function describeUnusable(check: Exclude<EntryCheck, { kind: 'ok' }>): string {
  switch (check.kind) {
    case 'typescript':
      return `"${check.rel}" is TypeScript`;
    case 'excluded':
      return `"${check.rel}": ${check.reason}`;
    case 'missing':
      return `"${check.rel}" does not exist`;
    case 'not-file':
      return `"${check.rel}" is not a regular file`;
    case 'unsupported':
      return `"${check.rel}": ${check.why}`;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint override (--entrypoint)
// ---------------------------------------------------------------------------

const INTERPRETERS: Record<RuntimeKind, readonly string[]> = { node: ['node'], python: ['python', 'python3'] };
/** Interpreter flags that consume the next argv element. */
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-W']);
/** Interpreter flags after which the next element is code or a module, not a file. */
const INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-m']);
const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function acceptFile(check: EntryCheck, what: string): string {
  switch (check.kind) {
    case 'ok':
      return check.rel;
    case 'typescript':
      return invalid(`${what} "${check.rel}" is TypeScript. ${TS_MESSAGE}`);
    default:
      return invalid(`${what} ${describeUnusable(check)}`);
  }
}

function validateOverride(runtime: RuntimeKind, argv: unknown, realSource: string): { entrypoint: string[]; entryFile?: string } {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
    invalid('Invalid entrypoint: expected 1-64 arguments in exec form (for example ["node", "server.js"])');
  }
  const out: string[] = [];
  for (const arg of argv as unknown[]) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 4096) invalid('Invalid entrypoint: every argument must be a non-empty string of at most 4096 characters');
    if (hasControlChars(arg)) invalid(`Invalid entrypoint argument ${JSON.stringify(printable(arg, 60))}: contains a control character or newline`);
    out.push(arg);
  }
  let entryFile: string | undefined;

  const head = out[0] as string;
  if (!BARE_COMMAND_RE.test(head)) {
    // A path to an executable inside the source tree. It must stay path-like:
    // a bare "run.sh" would be looked up on PATH, and the node base image's
    // entrypoint script would even prepend "node" to it.
    entryFile = acceptFile(checkEntryPath(realSource, head), 'Entrypoint');
    out[0] = `./${entryFile}`;
  } else if (INTERPRETERS[runtime].includes(head)) {
    let i = 1;
    while (i < out.length && (out[i] as string).startsWith('-')) {
      const flag = out[i] as string;
      if (INLINE_FLAGS.has(flag)) {
        i = out.length;
        break;
      }
      i += VALUE_FLAGS.has(flag) ? 2 : 1;
    }
    if (i < out.length) {
      entryFile = acceptFile(checkEntryPath(realSource, out[i]), 'Entrypoint script');
      out[i] = entryFile;
    }
  }
  for (const arg of out) {
    if (TYPESCRIPT_RE.test(arg)) invalid(`Entrypoint argument "${printable(arg, 80)}" is TypeScript. ${TS_MESSAGE}`);
  }
  return entryFile === undefined ? { entrypoint: out } : { entrypoint: out, entryFile };
}

// ---------------------------------------------------------------------------
// Project probing
// ---------------------------------------------------------------------------

type Probe = 'file' | 'symlink' | 'other' | 'absent';

function probe(realSource: string, name: string): Probe {
  try {
    const st = fs.lstatSync(path.join(realSource, name));
    if (st.isSymbolicLink()) return 'symlink';
    return st.isFile() ? 'file' : 'other';
  } catch {
    return 'absent';
  }
}

function readText(realSource: string, name: string): string {
  const abs = path.join(realSource, name);
  if (fs.lstatSync(abs).size > MAX_CONFIG_BYTES) invalid(`${name} is larger than ${MAX_CONFIG_BYTES} bytes`);
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Every file detectAgent() reads as the agent's own config (its AGENT_PATTERNS,
 * which it does not export). It follows symlinks and reads without a size cap,
 * so a link to a file outside the tree would choose the image's name and version.
 */
const AGENT_CONFIG_FILES: readonly string[] = [
  'clawdbot.json', 'clawdbot.config.json', '.clawdbot',
  'goose.yaml', 'goose.yml', 'goose.config.yaml', '.gooserc',
  'cline.json', 'cline.config.json', '.cline',
  'polytician.json', '.polytician.json',
  'nemoclaw.json', 'nemoclaw.config.json', '.nemoclaw.json',
  'agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json',
];

/**
 * detectAgent() for a source tree whose config files are all regular files; a
 * symlinked one is reported and detectAgent() is not asked, so nothing is read
 * through the link. The name then falls back to the directory name and the
 * version to package.json.
 */
function detectAgentIgnoringLinks(realSource: string, absolute: string, warnings: string[]): AgentConfig {
  const linked = AGENT_CONFIG_FILES.filter((name) => probe(realSource, name) === 'symlink');
  if (linked.length === 0) return detectAgent(absolute);
  for (const name of linked) {
    warnings.push(`${name} is a symbolic link and is ignored: symbolic links are never copied into the image, and the agent name and version are not read through one`);
  }
  return { name: path.basename(absolute), type: 'generic', sourcePath: absolute };
}

// ---------------------------------------------------------------------------
// pip build-time risks
// ---------------------------------------------------------------------------

/** Options that change WHERE pip gets code from, or install a source tree. */
const PIP_SOURCE_OPTIONS = new Set(['-i', '--index-url', '--extra-index-url', '--trusted-host', '-f', '--find-links', '-e', '--editable']);
/** Options that pull in another requirements file; harmless while it stays inside the tree. */
const PIP_NESTED_FILE_OPTIONS = new Set(['-r', '--requirement', '-c', '--constraint']);
const LONG_OPTION_RE = /^(--[A-Za-z][A-Za-z0-9-]*)(?:[=\s]\s*(.*))?$/;
const SHORT_OPTION_RE = /^(-[A-Za-z])\s*(.*)$/;
const MAX_LISTED_FINDINGS = 5;
/** The build backends `pip install .` is routinely used with. Anything else is worth a second look. */
const KNOWN_BUILD_BACKENDS = new Set([
  'setuptools.build_meta', 'setuptools.build_meta:__legacy__', 'hatchling.build', 'flit_core.buildapi', 'flit.buildapi',
  'poetry.core.masonry.api', 'pdm.backend', 'pdm.pep517.api', 'maturin', 'mesonpy', 'scikit_build_core.build', 'sipbuild.api',
]);
const PIP_RISK_NOTE = 'The image build runs pip as root with network access, and installing a package can run its build code, so only use sources you trust';

function pointsOutsideTree(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value) || value.includes('://') || value.split(/[\\/]/).includes('..');
}

/** requirements.txt as pip reads it: continuation lines joined, comments dropped. Line numbers are the first physical line. */
function logicalRequirementLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let pending: { line: number; text: string } | undefined;
  text.split(/\r?\n/).forEach((physical, index) => {
    const continues = physical.endsWith('\\');
    const piece = (continues ? physical.slice(0, -1) : physical).replace(/(^|\s)#.*$/, '');
    pending = pending ? { line: pending.line, text: `${pending.text} ${piece}` } : { line: index + 1, text: piece };
    if (!continues) {
      out.push({ line: pending.line, text: pending.text.trim() });
      pending = undefined;
    }
  });
  if (pending) out.push({ line: pending.line, text: pending.text.trim() });
  return out.filter((l) => l.text.length > 0);
}

/** What a requirements line does that deserves a warning, named without echoing its value (it may hold credentials). */
function requirementFinding(logical: string): string | undefined {
  if (!logical.startsWith('-')) return logical.includes('://') ? 'URL' : undefined;
  const m = LONG_OPTION_RE.exec(logical) ?? SHORT_OPTION_RE.exec(logical);
  if (!m) return undefined;
  const option = m[1] as string;
  if (PIP_SOURCE_OPTIONS.has(option)) return option;
  if (PIP_NESTED_FILE_OPTIONS.has(option) && pointsOutsideTree((m[2] ?? '').trim())) return `${option} outside the source tree`;
  return undefined;
}

function pipRequirementsWarnings(realSource: string): string[] {
  let text: string;
  try {
    text = readText(realSource, 'requirements.txt');
  } catch {
    return [];
  }
  const findings = logicalRequirementLines(text).flatMap(({ line, text: logical }) => {
    const finding = requirementFinding(logical);
    return finding === undefined ? [] : [`line ${line} (${finding})`];
  });
  if (findings.length === 0) return [];
  const listed = findings.slice(0, MAX_LISTED_FINDINGS).join(', ');
  const more = findings.length > MAX_LISTED_FINDINGS ? `, and ${findings.length - MAX_LISTED_FINDINGS} more` : '';
  const effect = findings.length === 1 ? 'this changes' : 'these change';
  return [`requirements.txt ${listed}${more}: ${effect} where pip gets code from. ${PIP_RISK_NOTE}`];
}

/**
 * The text of the PEP 517 [build-system] table (also in its inline-table and
 * dotted-key forms). Not a TOML parser: it is advice for the person packaging,
 * not a security boundary, because the build runs in a container either way.
 */
function buildSystemText(toml: string): string {
  const parts: string[] = [];
  let inTable = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (/^\[\[?[^\]]*\]\]?$/.test(line)) {
      inTable = line === '[build-system]';
    } else if (inTable || /^build-system[.\s=]/.test(line)) {
      parts.push(line);
    }
  }
  return parts.join('\n');
}

function pyprojectWarnings(realSource: string): string[] {
  let text: string;
  try {
    text = readText(realSource, 'pyproject.toml');
  } catch {
    return [];
  }
  const buildSystem = buildSystemText(text);
  const warnings: string[] = [];
  if (/\bbackend-path\s*=/.test(buildSystem)) {
    warnings.push(`pyproject.toml declares backend-path, so its build backend is loaded from this source tree and runs during "pip install .". ${PIP_RISK_NOTE}`);
  }
  const backend = /\bbuild-backend\s*=\s*(["'])(.*?)\1/.exec(buildSystem)?.[2];
  if (backend !== undefined && !KNOWN_BUILD_BACKENDS.has(backend)) {
    warnings.push(`pyproject.toml build-backend ${JSON.stringify(printable(backend, 80))} is not a well-known build backend and runs during "pip install .". ${PIP_RISK_NOTE}`);
  }
  return warnings;
}

interface PackageJsonInfo {
  name?: string;
  version?: string;
  main?: string;
  bin?: string;
  start?: string;
}

function readPackageJson(realSource: string): PackageJsonInfo {
  let data: unknown;
  try {
    data = JSON.parse(readText(realSource, 'package.json'));
  } catch (err) {
    if (err instanceof ContainerError) throw err;
    return invalid('package.json is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) invalid('package.json must contain a JSON object');
  const pkg = data as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const info: PackageJsonInfo = {};
  const name = str(pkg['name']);
  if (name !== undefined) info.name = name;
  const version = str(pkg['version']);
  if (version !== undefined) info.version = version;
  const main = str(pkg['main']);
  if (main !== undefined) info.main = main;

  const bin = pkg['bin'];
  if (typeof bin === 'string') {
    info.bin = bin;
  } else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    const entries = Object.entries(bin as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
    const own = entries.find(([k]) => k === name?.replace(/^@[^/]+\//, ''));
    const chosen = own ?? entries[0];
    if (chosen) info.bin = chosen[1];
  }
  const scripts = pkg['scripts'];
  if (typeof scripts === 'object' && scripts !== null) {
    const start = str((scripts as Record<string, unknown>)['start']);
    if (start !== undefined) info.start = start;
  }
  return info;
}

function pythonProjectIsInstallable(realSource: string): boolean {
  try {
    return /^\s*\[(project|build-system|tool\.poetry)\]/m.test(readText(realSource, 'pyproject.toml'));
  } catch {
    return false;
  }
}

function hasTopLevelPython(realSource: string): boolean {
  try {
    return fs.readdirSync(realSource).some((n) => n.endsWith('.py') && probe(realSource, n) === 'file');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint derivation
// ---------------------------------------------------------------------------

interface Derived {
  entrypoint: string[];
  entryFile: string;
}

function resolveDerivedEntry(
  runtime: RuntimeKind,
  realSource: string,
  candidates: Array<{ raw: string; origin: string; warnOnSkip: boolean }>,
  warnings: string[]
): Derived {
  const tried: string[] = [];
  let typescript: string | undefined;
  for (const candidate of candidates) {
    const check = checkEntryPath(realSource, candidate.raw);
    if (check.kind === 'ok') {
      return { entrypoint: [runtime === 'node' ? 'node' : 'python', check.rel], entryFile: check.rel };
    }
    if (check.kind === 'typescript' && typescript === undefined) typescript = check.rel;
    const why = `${candidate.origin} ${describeUnusable(check)}`;
    tried.push(why);
    if (candidate.warnOnSkip) warnings.push(`Ignoring ${why}`);
  }
  if (typescript !== undefined) {
    invalid(`Found TypeScript entrypoint "${typescript}". ${TS_MESSAGE}`);
  }
  const looked = tried.length > 0 ? ` Tried: ${tried.join('; ')}.` : '';
  return invalid(`No ${runtime} entrypoint found in the source directory.${looked} Pass --entrypoint (for example ["${runtime === 'node' ? 'node' : 'python'}", "app.${runtime === 'node' ? 'js' : 'py'}"])`);
}

const SIMPLE_NODE_START_RE = /^node\s+([^\s'"`$;&|<>(){}*?\\]+)$/;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function detectContainerRuntime(sourceDir: string, options: DetectOptions = {}): ContainerRuntimeDetection {
  const absolute = path.resolve(sourceDir);
  let realSource: string;
  try {
    realSource = fs.realpathSync(absolute);
  } catch {
    throw new ContainerError('NOT_FOUND', `Source path does not exist: ${absolute}`);
  }
  if (!fs.statSync(realSource).isDirectory()) invalid(`Source path is not a directory: ${absolute}`);

  const warnings: string[] = [];
  for (const name of ['package.json', 'requirements.txt', 'pyproject.toml', 'package-lock.json']) {
    if (probe(realSource, name) === 'symlink') {
      warnings.push(`${name} is a symbolic link and is ignored: symbolic links are never copied into the image`);
    }
  }

  const agent = detectAgentIgnoringLinks(realSource, absolute, warnings);
  const hasPackageJson = probe(realSource, 'package.json') === 'file';
  const pyStrong = [
    ...['requirements.txt', 'pyproject.toml'].filter((f) => probe(realSource, f) === 'file'),
    ...PYTHON_ENTRY_CANDIDATES.filter((f) => probe(realSource, f) === 'file'),
  ];
  // Without a package.json, a plain JavaScript entry file is still a node signal.
  const nodeSignals = hasPackageJson ? ['package.json'] : NODE_ENTRY_FALLBACKS.filter((f) => probe(realSource, f) === 'file');

  let runtime: RuntimeKind;
  if (options.runtimeKind !== undefined) {
    if (options.runtimeKind !== 'node' && options.runtimeKind !== 'python') invalid(`Invalid runtime ${JSON.stringify(String(options.runtimeKind))}: expected "node" or "python"`);
    runtime = options.runtimeKind;
  } else if (nodeSignals.length > 0 && pyStrong.length > 0) {
    return invalid(`Cannot tell whether this is a node or python agent: found ${nodeSignals.join(', ')} and ${pyStrong.join(', ')}. Pass --runtime node or --runtime python`);
  } else if (nodeSignals.length > 0) {
    runtime = 'node';
  } else if (pyStrong.length > 0 || hasTopLevelPython(realSource)) {
    runtime = 'python';
  } else {
    return invalid('Cannot detect a runtime: found no package.json, requirements.txt, pyproject.toml, Python file or index.js/main.js. Pass --runtime node or --runtime python');
  }

  const pkg = hasPackageJson && runtime === 'node' ? readPackageJson(realSource) : {};

  // Dependencies
  let install: InstallPlan = 'none';
  let packageManager: PackageManager = 'none';
  let lockfile: string | undefined;
  if (runtime === 'node') {
    if (hasPackageJson) {
      packageManager = 'npm';
      if (probe(realSource, 'package-lock.json') === 'file') {
        install = 'npm-ci';
        lockfile = 'package-lock.json';
      } else {
        install = 'npm-install';
        const foreign: Array<[string, PackageManager]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];
        const found = foreign.find(([f]) => probe(realSource, f) === 'file');
        if (found) {
          packageManager = found[1];
          warnings.push(`${found[0]} found but only npm is supported in Phase 1: installing with "npm install" and ignoring the lockfile (the build is not reproducible)`);
        } else {
          warnings.push('No package-lock.json: dependencies are installed with "npm install" and the build is not reproducible');
        }
      }
    }
  } else if (probe(realSource, 'requirements.txt') === 'file') {
    install = 'pip-requirements';
    packageManager = 'pip';
    lockfile = 'requirements.txt';
    warnings.push(...pipRequirementsWarnings(realSource));
  } else if (probe(realSource, 'pyproject.toml') === 'file') {
    packageManager = probe(realSource, 'uv.lock') === 'file' ? 'uv' : probe(realSource, 'poetry.lock') === 'file' ? 'poetry' : 'pip';
    if (pythonProjectIsInstallable(realSource)) {
      install = 'pip-project';
      warnings.push(...pyprojectWarnings(realSource));
      if (packageManager !== 'pip') warnings.push(`${packageManager === 'uv' ? 'uv.lock' : 'poetry.lock'} found but only pip is supported in Phase 1: installing with "pip install ." and ignoring the lockfile`);
    } else {
      warnings.push('pyproject.toml has no [project], [build-system] or [tool.poetry] table: not installing anything');
    }
  }

  // Entrypoint
  let derived: { entrypoint: string[]; entryFile?: string };
  if (options.entrypoint !== undefined) {
    derived = validateOverride(runtime, options.entrypoint, realSource);
  } else if (runtime === 'python') {
    derived = resolveDerivedEntry('python', realSource, PYTHON_ENTRY_CANDIDATES.map((raw) => ({ raw, origin: 'default', warnOnSkip: false })), warnings);
  } else {
    const candidates: Array<{ raw: string; origin: string; warnOnSkip: boolean }> = [];
    if (pkg.start !== undefined) {
      const m = SIMPLE_NODE_START_RE.exec(pkg.start.trim());
      if (m?.[1]) {
        candidates.push({ raw: m[1], origin: 'package.json scripts.start', warnOnSkip: true });
      } else {
        warnings.push('package.json scripts.start is not a plain "node <file>" command and is ignored; pass --entrypoint to run it');
      }
    }
    if (pkg.main !== undefined) candidates.push({ raw: pkg.main, origin: 'package.json main', warnOnSkip: true });
    if (pkg.bin !== undefined) candidates.push({ raw: pkg.bin, origin: 'package.json bin', warnOnSkip: true });
    if (agent.entryPoint !== undefined) candidates.push({ raw: agent.entryPoint, origin: 'detected', warnOnSkip: false });
    for (const raw of NODE_ENTRY_FALLBACKS) candidates.push({ raw, origin: 'default', warnOnSkip: false });
    derived = resolveDerivedEntry('node', realSource, candidates, warnings);
  }

  const base = assertImageRef(options.base ?? DEFAULT_BASE_IMAGES[runtime]);
  const detection: ContainerRuntimeDetection = {
    sourceDir: realSource,
    name: slugifyAgentName(options.name ?? agent.name),
    // detectAgent() only casts the version, so a config can make it a number or object.
    version: sanitizeVersion(typeof agent.version === 'string' && agent.version.length > 0 ? agent.version : pkg.version),
    agentType: agent.type,
    runtime,
    packageManager,
    install,
    entrypoint: derived.entrypoint,
    base,
    warnings,
  };
  if (lockfile !== undefined) detection.lockfile = lockfile;
  if (derived.entryFile !== undefined) detection.entryFile = derived.entryFile;
  return detection;
}
