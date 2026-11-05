/**
 * execaRunner against REAL child processes (node, sh, cat). No mocks: the
 * point of the runner is how it maps real spawn/exit/timeout behaviour onto
 * CommandResult, which a mock cannot tell us.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execaRunner } from '../../src/container/runner.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-a-runner-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function allBytes(): Buffer {
  return Buffer.from(Array.from({ length: 256 }, (_, i) => i));
}

/** Deterministic pseudo-random bytes (not compressible, covers every byte value). */
function bigBuffer(size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

describe('execaRunner: exit, output and failure mapping', () => {
  it('captures stdout and stderr and reports exit 0', async () => {
    const r = await execaRunner('node', ['-e', 'console.log("out"); console.error("err")']);
    expect(r).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false, spawnFailed: false });
  });

  it('returns the real non-zero exit code without throwing', async () => {
    const r = await execaRunner('sh', ['-c', 'echo partial; echo boom >&2; exit 3']);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe('partial');
    expect(r.stderr).toBe('boom');
    expect(r.timedOut).toBe(false);
    expect(r.spawnFailed).toBe(false);
  });

  it('never leaves stderr empty on a silent non-zero exit', async () => {
    const r = await execaRunner('sh', ['-c', 'exit 9']);
    expect(r.exitCode).toBe(9);
    expect(r.stderr).toContain('exited with code 9');
  });

  it('maps a missing binary to exit 127 / spawnFailed with a readable reason', async () => {
    const r = await execaRunner('/nonexistent/avt-a-docker', ['version']);
    expect(r.exitCode).toBe(127);
    expect(r.spawnFailed).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain('/nonexistent/avt-a-docker');
    expect(r.stderr).toContain('ENOENT');
  });

  it('maps a non-executable file to exit 127 / spawnFailed (EACCES)', async () => {
    const f = path.join(dir, 'not-executable');
    fs.writeFileSync(f, '#!/bin/sh\necho hi\n', { mode: 0o644 });
    const r = await execaRunner(f, []);
    expect(r.exitCode).toBe(127);
    expect(r.spawnFailed).toBe(true);
    expect(r.stderr).toContain('EACCES');
  });

  it('maps a timeout to exit 124 / timedOut and returns promptly', async () => {
    const started = Date.now();
    const r = await execaRunner('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    expect(r.exitCode).toBe(124);
    expect(r.timedOut).toBe(true);
    expect(r.spawnFailed).toBe(false);
    expect(r.stderr).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reports death by signal as a failure with a reason', async () => {
    const r = await execaRunner('sh', ['-c', 'kill -9 $$']);
    expect(r.exitCode).toBe(1);
    expect(r.spawnFailed).toBe(false);
    expect(r.stderr).toContain('SIGKILL');
  });

  it('does not mistake a missing cwd for a missing binary', async () => {
    const r = await execaRunner('node', ['-e', '0'], { cwd: path.join(dir, 'no-such-dir') });
    expect(r.spawnFailed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Working directory');
  });

  it('runs in the requested cwd', async () => {
    const r = await execaRunner('node', ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
    expect(fs.realpathSync(r.stdout)).toBe(fs.realpathSync(dir));
  });

  it('bounds buffered output instead of growing without limit', async () => {
    const r = await execaRunner('node', ['-e', 'const b = Buffer.alloc(1 << 20, 97); for (let i = 0; i < 40; i++) process.stdout.write(b);']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(r.stderr).toContain('maxBuffer');
  });
});

describe('execaRunner: argv is never interpreted by a shell', () => {
  it('passes metacharacters through literally', async () => {
    const marker = path.join(dir, 'pwned');
    const hostile = [`; touch ${marker}`, '$(echo injected)', '`echo injected`', '| cat', '&& echo injected', '"quoted" \'single\'', '*'];
    const r = await execaRunner('node', ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile]);
    expect(JSON.parse(r.stdout)).toEqual(hostile);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('execaRunner: env', () => {
  it('merges env over process.env', async () => {
    const r = await execaRunner('node', [
      '-e',
      'process.stdout.write(JSON.stringify({ hasPath: Boolean(process.env.PATH), foo: process.env.AVT_A_FOO, home: process.env.HOME }))',
    ], { env: { AVT_A_FOO: 'bar' } });
    const seen = JSON.parse(r.stdout) as { hasPath: boolean; foo: string; home?: string };
    expect(seen.foo).toBe('bar');
    expect(seen.hasPath).toBe(true);
    expect(seen.home).toBe(process.env['HOME']);
  });

  it('lets the caller override an inherited variable', async () => {
    process.env['AVT_A_INHERITED'] = 'from-parent';
    try {
      const r = await execaRunner('node', ['-e', 'process.stdout.write(process.env.AVT_A_INHERITED ?? "")'], {
        env: { AVT_A_INHERITED: 'from-caller' },
      });
      expect(r.stdout).toBe('from-caller');
    } finally {
      delete process.env['AVT_A_INHERITED'];
    }
  });
});

describe('execaRunner: AgentVault\'s own secrets are not handed to the child', () => {
  // Every docker invocation (and the credential helpers and CLI plugins it may run) inherited the whole environment,
  // including the passphrases and, with --secrets-from-env, the provider API keys.
  const withheld: Record<string, string> = {
    AGENTVAULT_SNAPSHOT_PASSPHRASE: 'p1',
    AGENTVAULT_SECRETS_PASSPHRASE: 'p2',
    AGENTVAULT_PRIVATE_KEY: 'p3',
    AV_SECRET_ANTHROPIC: 'k0',
    AV_PROXY_CONFIG: 'k00',
    ANTHROPIC_API_KEY: 'k1',
    OPENAI_API_KEY: 'k2',
    VENICE_API_KEY: 'k3',
  };
  const kept: Record<string, string> = { DOCKER_HOST: 'unix:///x.sock', DOCKER_CONFIG: '/tmp/dc', HTTPS_PROXY: 'http://p:1', AVT_A_OTHER: 'keep' };

  afterEach(() => {
    for (const name of [...Object.keys(withheld), ...Object.keys(kept)]) delete process.env[name];
  });

  const seen = async (env?: Record<string, string>): Promise<Record<string, string | undefined>> => {
    const names = [...Object.keys(withheld), ...Object.keys(kept), 'PATH'];
    const r = await execaRunner(process.execPath, ['-e', `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n]]))))`], env ? { env } : {});
    return JSON.parse(r.stdout) as Record<string, string | undefined>;
  };

  it('drops them from the inherited environment, and keeps everything docker legitimately needs', async () => {
    Object.assign(process.env, withheld, kept);
    const env = await seen();
    for (const name of Object.keys(withheld)) expect(env[name], name).toBeUndefined();
    for (const [name, value] of Object.entries(kept)) expect(env[name], name).toBe(value);
    expect(env['PATH']).toBeTruthy();
  });

  it('a caller that passes one explicitly still can (that is deliberate, not inherited)', async () => {
    Object.assign(process.env, withheld);
    const env = await seen({ AGENTVAULT_SNAPSHOT_PASSPHRASE: 'on purpose' });
    expect(env['AGENTVAULT_SNAPSHOT_PASSPHRASE']).toBe('on purpose');
    expect(env['AGENTVAULT_SECRETS_PASSPHRASE']).toBeUndefined();
  });

  it('matches prefixes and names case-sensitively like the environment does, without touching lookalikes', async () => {
    process.env['MY_AGENTVAULT_THING'] = 'x';
    process.env['AVT_A_OTHER'] = 'keep';
    try {
      const r = await execaRunner(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.MY_AGENTVAULT_THING, process.env.AVT_A_OTHER]))']);
      expect(JSON.parse(r.stdout)).toEqual(['x', 'keep']);
    } finally {
      delete process.env['MY_AGENTVAULT_THING'];
    }
  });
});

describe('execaRunner: stdin', () => {
  it('feeds string input to stdin', async () => {
    const r = await execaRunner('cat', [], { input: 'hello stdin' });
    expect(r.stdout).toBe('hello stdin');
  });

  it('feeds Buffer input to stdin', async () => {
    const r = await execaRunner('cat', [], { input: Buffer.from('buffer in') });
    expect(r.stdout).toBe('buffer in');
  });

  it('gives a child that reads stdin an immediate EOF when no input is supplied', async () => {
    const r = await execaRunner('cat', [], { timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('streams stdinFile to the child byte for byte', async () => {
    const input = path.join(dir, 'in.bin');
    const output = path.join(dir, 'out.bin');
    fs.writeFileSync(input, allBytes());
    const r = await execaRunner('cat', [], { stdinFile: input, stdoutFile: output });
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(output).equals(allBytes())).toBe(true);
  });

  it('streams a 5 MB stdinFile through to a file intact', async () => {
    const input = path.join(dir, 'in.bin');
    const output = path.join(dir, 'out.bin');
    const data = bigBuffer(5 * 1024 * 1024);
    fs.writeFileSync(input, data);
    const r = await execaRunner('cat', [], { stdinFile: input, stdoutFile: output, timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(sha256(fs.readFileSync(output))).toBe(sha256(data));
  });

  it('fails cleanly (no throw, not spawnFailed) when stdinFile is missing', async () => {
    const r = await execaRunner('cat', [], { stdinFile: path.join(dir, 'missing.bin') });
    expect(r.exitCode).toBe(1);
    expect(r.spawnFailed).toBe(false);
    expect(r.stderr).toContain('stdin file');
  });

  it('refuses to follow a symlink for stdinFile', async () => {
    const real = path.join(dir, 'real.bin');
    const link = path.join(dir, 'link.bin');
    fs.writeFileSync(real, 'secret');
    fs.symlinkSync(real, link);
    const r = await execaRunner('cat', [], { stdinFile: link });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
  });
});

describe('execaRunner: stdoutFile', () => {
  it('round-trips all 256 byte values, including invalid UTF-8', async () => {
    const out = path.join(dir, 'bytes.bin');
    const r = await execaRunner('node', [
      '-e',
      'process.stdout.write(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))',
    ], { stdoutFile: out });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    const written = fs.readFileSync(out);
    expect(written.length).toBe(256);
    expect(written.equals(allBytes())).toBe(true);
  });

  it('creates the file with mode 0600', async () => {
    const out = path.join(dir, 'private.bin');
    await execaRunner('node', ['-e', 'process.stdout.write("x")'], { stdoutFile: out });
    expect(modeOf(out)).toBe(0o600);
  });

  it('tightens the mode of a pre-existing world-readable file to 0600', async () => {
    const out = path.join(dir, 'existing.bin');
    fs.writeFileSync(out, 'old contents that must be truncated', { mode: 0o644 });
    fs.chmodSync(out, 0o644);
    await execaRunner('node', ['-e', 'process.stdout.write("new")'], { stdoutFile: out });
    expect(modeOf(out)).toBe(0o600);
    expect(fs.readFileSync(out, 'utf8')).toBe('new');
  });

  it('streams 5 MB to a file without returning it in memory', async () => {
    const out = path.join(dir, 'big.bin');
    const expected = bigBuffer(5 * 1024 * 1024);
    const script = [
      'let x = 0x2545f491;',
      'const out = Buffer.alloc(5 * 1024 * 1024);',
      'for (let i = 0; i < out.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }',
      'process.stdout.write(out);',
    ].join('\n');
    const r = await execaRunner('node', ['-e', script], { stdoutFile: out, timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.statSync(out).size).toBe(expected.length);
    expect(sha256(fs.readFileSync(out))).toBe(sha256(expected));
  });

  it('is fully written by the time the promise resolves', async () => {
    const out = path.join(dir, 'flushed.bin');
    const r = await execaRunner('node', ['-e', 'process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 7))'], { stdoutFile: out });
    expect(r.exitCode).toBe(0);
    expect(fs.statSync(out).size).toBe(2 * 1024 * 1024);
  });

  it('leaves the partial file in place and reports the failure when the command fails', async () => {
    const out = path.join(dir, 'partial.bin');
    const r = await execaRunner('sh', ['-c', 'printf partial-data; echo "cannot open file" >&2; exit 2'], { stdoutFile: out });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('cannot open file');
    expect(fs.readFileSync(out, 'utf8')).toBe('partial-data');
  });

  it('reports a timeout and leaves the partial file', async () => {
    const out = path.join(dir, 'timeout.bin');
    const r = await execaRunner(
      'node',
      ['-e', 'process.stdout.write("head"); setTimeout(() => {}, 30000)'],
      { stdoutFile: out, timeoutMs: 400 }
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(fs.readFileSync(out, 'utf8')).toBe('head');
  });

  it('leaves an empty file behind when the binary cannot be started', async () => {
    const out = path.join(dir, 'spawnfail.bin');
    const r = await execaRunner('/nonexistent/avt-a-docker', [], { stdoutFile: out });
    expect(r.spawnFailed).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBe(0);
  });

  it('refuses to write through a symlink and leaves the target untouched', async () => {
    const target = path.join(dir, 'victim.txt');
    const link = path.join(dir, 'planted-link');
    fs.writeFileSync(target, 'precious');
    fs.symlinkSync(target, link);
    const r = await execaRunner('node', ['-e', 'process.stdout.write("overwritten")'], { stdoutFile: link });
    expect(r.exitCode).toBe(1);
    expect(r.spawnFailed).toBe(false);
    expect(r.stderr).toContain('stdout file');
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
  });

  it('fails cleanly when the destination directory does not exist', async () => {
    const r = await execaRunner('node', ['-e', '0'], { stdoutFile: path.join(dir, 'no', 'such', 'dir', 'out.bin') });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('stdout file');
  });

  it.skipIf(!fs.existsSync('/proc/self/fd'))('does not leak file descriptors across many calls', async () => {
    const before = fs.readdirSync('/proc/self/fd').length;
    const out = path.join(dir, 'fd.bin');
    const input = path.join(dir, 'fd-in.bin');
    fs.writeFileSync(input, 'abc');
    for (let i = 0; i < 20; i++) {
      await execaRunner('cat', [], { stdinFile: input, stdoutFile: out });
    }
    await execaRunner('/nonexistent/avt-a-docker', [], { stdinFile: input, stdoutFile: out });
    const after = fs.readdirSync('/proc/self/fd').length;
    expect(after).toBeLessThanOrEqual(before + 2);
  });
});

describe('execaRunner: inheritStdio and option consistency', () => {
  it('runs with inherited stdio and returns the exit code with empty captured output', async () => {
    const r = await execaRunner('node', ['-e', 'process.exit(5)'], { inheritStdio: true });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
  });

  it.each([
    ['input + stdinFile', (_never: string) => ({ input: 'x', stdinFile: '/dev/null' })],
    ['input + inheritStdio', (_never: string) => ({ input: 'x', inheritStdio: true })],
    ['stdinFile + inheritStdio', (_never: string) => ({ stdinFile: '/dev/null', inheritStdio: true })],
    ['stdoutFile + inheritStdio', (never: string) => ({ stdoutFile: never, inheritStdio: true })],
  ])('rejects contradictory options (%s) as a programmer error', async (_label, makeOptions) => {
    const never = path.join(dir, 'never-created');
    await expect(execaRunner('node', ['-e', '0'], makeOptions(never))).rejects.toThrow(/mutually exclusive|cannot be combined/);
    expect(fs.existsSync(never)).toBe(false);
  });
});
