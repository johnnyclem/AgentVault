/**
 * Shared plumbing for the container commands (container, snapshot, secrets,
 * package --target container): dependency injection, passphrase acquisition,
 * error rendering and a few output helpers.
 *
 * Why it exists: every container command needs the same four things (a runtime,
 * a way to get a passphrase, somewhere to print, a way to exit), and each of
 * them must be replaceable in a test so no unit test ever touches Docker or a
 * terminal.
 *
 * Security stance:
 *  - Passphrases come from an environment variable or an interactive prompt,
 *    NEVER from a command-line flag (AGENTS.md: argv is visible in `ps` and in
 *    shell history). With no variable and no terminal the command fails closed
 *    and names the variable; it never falls back to "no encryption".
 *  - Every passphrase and secret value this process obtains is remembered in
 *    `ctx.sensitive`, and renderError() scrubs those values from the text it
 *    prints, so an error built from untrusted pieces cannot echo one.
 *  - Errors are rendered as a message plus a one-line hint. No stack trace is
 *    ever printed.
 *  - Scratch space for decrypted snapshot data is a 0700 directory under the
 *    AgentVault home (disk-backed), never os.tmpdir(), which is often RAM.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { assertPassphrase } from '../../src/container/crypto.js';
import { DockerRuntime } from '../../src/container/docker.js';
import { LIVENESS_GRACE_MS, redactSecrets } from '../../src/container/lifecycle.js';
import { ContainerError } from '../../src/container/types.js';
import type { ContainerErrorCode, ContainerRuntime } from '../../src/container/types.js';
import { agentvaultHome, assertAgentName, resourceNames } from '../../src/container/validate.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type PassphrasePurpose = 'snapshot' | 'secrets';

export interface PassphraseRequest {
  purpose: PassphrasePurpose;
  /** Ask twice (a new passphrase that nothing can recover if mistyped). */
  confirm: boolean;
  /** The question for an interactive prompt. */
  message: string;
}

export type GetPassphrase = (request: PassphraseRequest) => Promise<string>;

/** The environment variable each purpose reads before it prompts. */
export const PASSPHRASE_ENV: Readonly<Record<PassphrasePurpose, string>> = {
  snapshot: 'AGENTVAULT_SNAPSHOT_PASSPHRASE',
  secrets: 'AGENTVAULT_SECRETS_PASSPHRASE',
};

/** What a test (or an embedding program) may replace. Everything is optional. */
export interface ContainerCliDeps {
  runtime?: ContainerRuntime;
  getPassphrase?: GetPassphrase;
  /** Replaces process.env entirely (host environment, AGENTVAULT_HOME, passphrase variables). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  /** stdout lines. Injecting it also silences the spinners. */
  log?: (line: string) => void;
  /** stderr lines (errors, warnings, notes). */
  err?: (line: string) => void;
  /** Called with a non-zero code when a command fails. Default: process.exit. */
  exit?: (code: number) => never;
  /** Yes/no question. Default: an inquirer prompt on a terminal, otherwise "no". */
  confirm?: (question: string) => Promise<boolean>;
  /** A hidden single-line prompt for a secret value. Default: inquirer password. */
  promptSecret?: (message: string) => Promise<string>;
  /** True when stdin is a terminal. Default: process.stdin.isTTY. */
  interactive?: boolean;
  /**
   * Called while a foreground agent runs so SIGINT/SIGTERM/SIGHUP can stop it
   * cleanly instead of killing this process before the sidecar is torn down.
   * Returns the function that uninstalls the handler.
   */
  installSignalHandler?: (handler: () => void) => () => void;
  /** How long a detached `run` watches for an immediate crash. Default LIVENESS_GRACE_MS; 0 skips the wait. */
  livenessGraceMs?: number;
}

export interface CliContext {
  runtime(): ContainerRuntime;
  getPassphrase: GetPassphrase;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => Date;
  log: (line: string) => void;
  err: (line: string) => void;
  exit: (code: number) => never;
  confirm: (question: string) => Promise<boolean>;
  promptSecret: (message: string) => Promise<string>;
  interactive: boolean;
  /** True when the caller injected its own output sink. */
  quiet: boolean;
  installSignalHandler: (handler: () => void) => () => void;
  livenessGraceMs: number;
  /** Passphrases and secret values obtained so far: scrubbed from rendered errors. */
  sensitive: Set<string>;
}

function defaultInstallSignalHandler(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

async function promptHidden(message: string, validate?: (value: string) => true | string): Promise<string> {
  const { default: inquirer } = await import('inquirer');
  const answers = await inquirer.prompt<{ value: string }>([
    { type: 'password', name: 'value', message, mask: '*', ...(validate !== undefined ? { validate } : {}) },
  ]);
  return answers.value;
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { default: inquirer } = await import('inquirer');
  const answers = await inquirer.prompt<{ ok: boolean }>([{ type: 'confirm', name: 'ok', message: question, default: false }]);
  return answers.ok;
}

/**
 * Passphrase from the purpose's environment variable, else (on a terminal) a
 * hidden prompt, else a hard failure naming the variable. Never "no passphrase".
 */
export function createPassphraseProvider(env: NodeJS.ProcessEnv, interactive: boolean): GetPassphrase {
  return async (request) => {
    const variable = PASSPHRASE_ENV[request.purpose];
    const fromEnv = env[variable];
    if (fromEnv !== undefined && fromEnv !== '') {
      try {
        assertPassphrase(fromEnv);
      } catch {
        throw new ContainerError('INVALID_INPUT', `${variable} must be at least 8 characters`);
      }
      return fromEnv;
    }
    if (!interactive) {
      throw new ContainerError(
        'INVALID_INPUT',
        `A passphrase is required: set ${variable}, or run in a terminal to be prompted. Passphrases are never accepted as command-line flags.`,
        { reason: 'passphrase_required' }
      );
    }
    const validate = (value: string): true | string => (value.length >= 8 ? true : 'Use at least 8 characters');
    const first = await promptHidden(request.message, validate);
    if (request.confirm) {
      const again = await promptHidden('Repeat the passphrase:');
      if (again !== first) throw new ContainerError('INVALID_INPUT', 'The passphrases do not match');
    }
    return first;
  };
}

/** Fill in every default. Called when a command RUNS, so environment and cwd are read at call time. */
export function resolveDeps(deps: ContainerCliDeps = {}): CliContext {
  const env = deps.env ?? process.env;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  const sensitive = new Set<string>();
  const remember = (value: string): string => {
    if (value.length > 0) sensitive.add(value);
    return value;
  };
  const provider = deps.getPassphrase ?? createPassphraseProvider(env, interactive);
  const promptSecret = deps.promptSecret ?? ((message: string): Promise<string> => promptHidden(message));
  let runtime = deps.runtime;
  return {
    runtime: () => (runtime ??= new DockerRuntime()),
    getPassphrase: async (request) => remember(await provider(request)),
    env,
    cwd: deps.cwd ?? process.cwd(),
    now: deps.now ?? ((): Date => new Date()),
    log: deps.log ?? ((line: string): void => console.log(line)),
    err: deps.err ?? ((line: string): void => console.error(line)),
    exit: deps.exit ?? ((code: number): never => process.exit(code)),
    confirm: deps.confirm ?? defaultConfirm,
    promptSecret: async (message) => remember(await promptSecret(message)),
    interactive,
    quiet: deps.log !== undefined,
    installSignalHandler: deps.installSignalHandler ?? defaultInstallSignalHandler,
    livenessGraceMs: deps.livenessGraceMs ?? LIVENESS_GRACE_MS,
    sensitive,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const HINTS: Readonly<Partial<Record<ContainerErrorCode, string>>> = {
  NOT_INSTALLED: 'Install Docker (https://docs.docker.com/get-docker/) and make sure the "docker" command is on your PATH.',
  DAEMON_UNREACHABLE: 'Start Docker (Docker Desktop, or "sudo systemctl start docker") and try again.',
  PERMISSION_DENIED: 'Add your user to the "docker" group and log in again, or fix the permissions of the Docker socket.',
  MISSING_SECRET:
    'Store each one with "agentvault secrets add <name> --from-env <VAR>", or pass --secrets-from-env to read the conventional environment variable.',
  NOT_FOUND: 'Check the name or path. "agentvault ps --all" lists the agents that exist.',
  TIMEOUT: 'Docker did not answer in time. Check that the daemon is healthy and try again.',
  INTEGRITY: 'A wrong passphrase looks the same as a damaged or modified file.',
  POLICY_VIOLATION: 'A security rule refused this request.',
  COMMAND_FAILED: 'Docker reported the failure above.',
};

export interface RenderedError {
  /** "Error: <message>" - secrets scrubbed, no stack trace. */
  message: string;
  hint?: string;
}

/**
 * Turn anything thrown into text for the terminal. `sensitive` values (the
 * passphrase and secret values this process holds) are replaced by [redacted]
 * in the message, whatever put them there.
 */
export function renderError(error: unknown, sensitive: Iterable<string> = []): RenderedError {
  const raw = error instanceof Error ? error.message : 'Unknown error';
  const message = redactSecrets(`Error: ${raw}`, sensitive);
  const hint = error instanceof ContainerError ? HINTS[error.code] : undefined;
  return hint !== undefined ? { message, hint } : { message };
}

export function printError(ctx: CliContext, error: unknown): void {
  const rendered = renderError(error, ctx.sensitive);
  ctx.err(chalk.red(rendered.message));
  if (rendered.hint !== undefined) ctx.err(chalk.gray(`  ${rendered.hint}`));
}

/**
 * Run a command body. A thrown error is printed (never with a stack) and the
 * process exits 1; a returned non-zero number is passed on as the exit code
 * (the exit code of a foreground agent, of `exec`). exit() is called OUTSIDE
 * the try block so an exit that throws (in a test) is not reported as an error.
 */
export async function runGuarded(ctx: CliContext, body: () => Promise<number | void>): Promise<void> {
  let code = 0;
  try {
    code = (await body()) ?? 0;
  } catch (error) {
    printError(ctx, error);
    code = 1;
  }
  if (code !== 0) ctx.exit(code);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function warnLine(ctx: CliContext, message: string): void {
  ctx.err(chalk.yellow(`  Warning: ${message}`));
}

export function noteLine(ctx: CliContext, message: string): void {
  ctx.err(chalk.gray(`  Note: ${message}`));
}

/** A spinner on stderr; silent when the caller injected its own output sink. */
export async function withSpinner<T>(ctx: CliContext, text: string, task: () => Promise<T>, done?: string): Promise<T> {
  const spinner = ora({ text, stream: process.stderr, isSilent: ctx.quiet }).start();
  try {
    const value = await task();
    if (done !== undefined) spinner.succeed(done);
    else spinner.stop();
    return value;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

/** Left-aligned columns, two spaces apart. Cells are plain text. */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length)))
      .join('  ')
      .trimEnd();
  return [render(headers), ...rows.map(render)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

/** commander collector for a repeatable option. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function parsePositiveInt(raw: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new ContainerError('INVALID_INPUT', `${flag} must be a whole number of at least 1${max < Number.MAX_SAFE_INTEGER ? ` (at most ${max})` : ''}`);
  }
  return Number(raw);
}

export function parseNonNegativeInt(raw: string, flag: string): number {
  if (!/^\d{1,15}$/.test(raw)) {
    throw new ContainerError('INVALID_INPUT', `${flag} must be a whole number (0 or more)`);
  }
  return Number(raw);
}

export function parsePositiveNumber(raw: string, flag: string): number {
  if (!/^\d+(\.\d{1,3})?$/.test(raw) || Number(raw) <= 0) {
    throw new ContainerError('INVALID_INPUT', `${flag} must be a positive number with at most 3 decimals`);
  }
  return Number(raw);
}

/** An existing agent's main container, or NOT_FOUND. Foreign containers named av-<agent> do not count. */
export async function requireAgentContainer(runtime: ContainerRuntime, agent: string): Promise<{ name: string; state: string; image: string }> {
  assertAgentName(agent);
  const names = resourceNames(agent);
  const found = (await runtime.list({ agent, all: true })).find((c) => c.name === names.container && c.role === 'agent');
  if (found === undefined) {
    throw new ContainerError('NOT_FOUND', `No AgentVault agent named "${agent}" exists`);
  }
  return { name: found.name, state: found.state, image: found.image };
}

// ---------------------------------------------------------------------------
// Private scratch directory
// ---------------------------------------------------------------------------

/**
 * Create `dir` (and any missing parents) and make sure the LAST level is a real
 * directory, owned by us, with no group/other access. Parents that did not
 * exist are created 0700 as well; ones that did are left alone.
 */
export function ensurePrivateDir(dir: string): string {
  const resolved = path.resolve(dir);
  const missing: string[] = [];
  for (let probe = resolved; !fs.existsSync(probe); probe = path.dirname(probe)) {
    missing.push(probe);
    if (path.dirname(probe) === probe) break;
  }
  for (const level of missing.reverse()) {
    try {
      fs.mkdirSync(level, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    fs.chmodSync(level, 0o700);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ContainerError('POLICY_VIOLATION', `${resolved} must be a real directory (not a symlink or a file): it holds decrypted snapshot data`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ContainerError('POLICY_VIOLATION', `${resolved} is owned by another user: refusing to put decrypted snapshot data in it`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(resolved, 0o700);
  return resolved;
}

/** <AgentVault home>/tmp: disk-backed scratch space for snapshot spools (os.tmpdir() is often RAM). */
export function snapshotScratchDir(env: NodeJS.ProcessEnv): string {
  return ensurePrivateDir(path.join(agentvaultHome(env), 'tmp'));
}

/** <AgentVault home>/snapshots: where `snapshot create` writes by default. */
export function defaultSnapshotsDir(env: NodeJS.ProcessEnv): string {
  return path.join(agentvaultHome(env), 'snapshots');
}
