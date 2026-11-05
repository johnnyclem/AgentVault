/**
 * Default CommandRunner: spawn a binary with an argv array, never a shell.
 *
 * Why this exists: every Docker interaction goes through an injected
 * CommandRunner (types.ts) so it can be unit-tested with a recording fake.
 * This is the production implementation, built on execa with reject:false.
 *
 * Security stance:
 *  - No shell is ever involved, so argv elements cannot be re-interpreted.
 *  - Failure reasons are built from the binary name and the errno only. The
 *    argv is deliberately NOT echoed into stderr or error text (execa's own
 *    shortMessage includes the full command line).
 *  - stdoutFile is created 0600, truncating but never following a symlink, so
 *    a planted link cannot redirect a volume tar somewhere else.
 *  - File streams are handed to the child as raw file descriptors. Nothing is
 *    decoded, so invalid UTF-8 survives, and a multi-GB tar never sits in
 *    this process's memory.
 */

import * as fs from 'node:fs';
import { execa } from 'execa';
import { presetSecretEnvMapping } from './proxy/presets.js';
import type { CommandOptions, CommandResult, CommandRunner } from './types.js';

/** Cap for captured stdout/stderr in the non-file modes (execa's default is 100 MB). */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const EXIT_SPAWN_FAILED = 127;
const EXIT_TIMED_OUT = 124;

/** execa attaches errno fields to its result; the published types omit `code`. */
interface ExecaOutcome {
  exitCode?: number | undefined;
  stdout?: unknown;
  stderr?: unknown;
  timedOut?: boolean;
  signal?: string | undefined;
  code?: string | undefined;
  originalMessage?: string | undefined;
  failed?: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function failure(exitCode: number, stderr: string): CommandResult {
  return { exitCode, stdout: '', stderr, timedOut: false, spawnFailed: false };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function openForRead(file: string): number {
  return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
}

function openForWrite(file: string): number {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    // openSync's mode only applies to a newly created file and is masked by umask.
    fs.fchmodSync(fd, 0o600);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return fd;
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // already closed or invalid: nothing useful to do
  }
}

function assertOptionsConsistent(options: CommandOptions): void {
  const sources = [options.input !== undefined, options.stdinFile !== undefined, options.inheritStdio === true];
  if (sources.filter(Boolean).length > 1) {
    throw new Error('CommandOptions: input, stdinFile and inheritStdio are mutually exclusive');
  }
  if (options.inheritStdio === true && options.stdoutFile !== undefined) {
    throw new Error('CommandOptions: stdoutFile cannot be combined with inheritStdio');
  }
}

export const execaRunner: CommandRunner = async (file, args, options = {}) => {
  assertOptionsConsistent(options);

  if (options.cwd !== undefined) {
    // A missing cwd makes spawn report ENOENT, which would read as "binary not installed".
    let isDir = false;
    try {
      isDir = fs.statSync(options.cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return failure(1, `Working directory does not exist or is not a directory: ${options.cwd}`);
    }
  }

  let stdinFd: number | undefined;
  let stdoutFd: number | undefined;
  try {
    if (options.stdinFile !== undefined) {
      try {
        stdinFd = openForRead(options.stdinFile);
      } catch (err) {
        return failure(1, `Cannot open stdin file ${options.stdinFile}: ${reason(err)}`);
      }
    }
    if (options.stdoutFile !== undefined) {
      try {
        stdoutFd = openForWrite(options.stdoutFile);
      } catch (err) {
        return failure(1, `Cannot open stdout file ${options.stdoutFile}: ${reason(err)}`);
      }
    }

    // Without an explicit source the child gets /dev/null, not a pipe nobody closes.
    const stdin = options.inheritStdio ? 'inherit' : (stdinFd ?? (options.input !== undefined ? 'pipe' : 'ignore'));
    const stdout = options.inheritStdio ? 'inherit' : (stdoutFd ?? 'pipe');
    const stderr = options.inheritStdio ? 'inherit' : 'pipe';

    const outcome = (await execa(file, [...args], {
      reject: false,
      stdin,
      stdout,
      stderr,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: childEnv(options.env),
      extendEnv: false,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      maxBuffer: MAX_BUFFER_BYTES,
    })) as unknown as ExecaOutcome;

    return toResult(file, outcome, options.timeoutMs);
  } finally {
    closeQuietly(stdinFd);
    closeQuietly(stdoutFd);
  }
};

/** Prefixes of AgentVault's own variables: passphrases, key material, the sidecar's secrets and config. */
const WITHHELD_PREFIXES = ['AGENTVAULT_', 'AV_SECRET_', 'AV_PROXY_'];

/**
 * The environment a child gets: ours, minus AgentVault's own secrets, plus whatever the caller passes on purpose.
 * Every docker invocation (and the credential helpers and CLI plugins it may run) used to inherit the passphrases
 * and, with --secrets-from-env, the provider API keys sitting in this process's environment.
 */
function childEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const providerKeys = new Set(Object.values(presetSecretEnvMapping()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (WITHHELD_PREFIXES.some((prefix) => name.startsWith(prefix)) || providerKeys.has(name)) continue;
    env[name] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

function toResult(file: string, outcome: ExecaOutcome, timeoutMs: number | undefined): CommandResult {
  const stdout = text(outcome.stdout);
  let stderr = text(outcome.stderr);

  if (outcome.exitCode === undefined && (outcome.code === 'ENOENT' || outcome.code === 'EACCES')) {
    const detail = outcome.originalMessage ?? outcome.code;
    if (stderr.length === 0) {
      stderr = `Cannot execute "${file}": ${outcome.code} (${detail})`;
    }
    return { exitCode: EXIT_SPAWN_FAILED, stdout, stderr, timedOut: false, spawnFailed: true };
  }

  if (outcome.timedOut === true) {
    const note = `Command "${file}" timed out${timeoutMs !== undefined ? ` after ${timeoutMs}ms` : ''}`;
    stderr = stderr.length > 0 ? `${stderr}\n${note}` : note;
    return { exitCode: EXIT_TIMED_OUT, stdout, stderr, timedOut: true, spawnFailed: false };
  }

  if (outcome.exitCode === undefined) {
    // Killed by a signal, or maxBuffer exceeded: never leave the reason empty.
    const why = outcome.signal !== undefined ? `terminated by ${outcome.signal}` : (outcome.originalMessage ?? 'terminated abnormally');
    const note = `Command "${file}" ${why}`;
    stderr = stderr.length > 0 ? `${stderr}\n${note}` : note;
    return { exitCode: 1, stdout, stderr, timedOut: false, spawnFailed: false };
  }

  if (outcome.exitCode !== 0 && stderr.length === 0) {
    stderr = `Command "${file}" exited with code ${outcome.exitCode}`;
  }
  return { exitCode: outcome.exitCode, stdout, stderr, timedOut: false, spawnFailed: false };
}
