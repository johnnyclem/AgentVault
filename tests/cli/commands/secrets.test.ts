/**
 * `secrets add|list|rm` against the real encrypted store in a temporary
 * AgentVault home (the real AVENC1 crypto, a real file), with the passphrase and
 * the terminal injected. The properties pinned here: a value is never a flag,
 * never printed, never accepted from a non-terminal source other than the named
 * environment variable, and the passphrase is only asked for when it can
 * unlock something.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretsCommand } from '../../../cli/commands/secrets.js';
import type { ContainerCliDeps, PassphraseRequest } from '../../../cli/commands/cli-support.js';
import { SecretStore } from '../../../src/container/secrets-store.js';

const KEY = 'sk-ant-api03-CANARY-5f4dcc3b5aa765d61d8327deb882cf99';
const PASS = 'correct horse battery staple';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

let cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

interface Harness {
  deps: ContainerCliDeps;
  home: string;
  store: SecretStore;
  out: string[];
  err: string[];
  passphrases: PassphraseRequest[];
  prompts: string[];
  all(): string;
  stdout(): string;
  stderr(): string;
}

function harness(over: Partial<ContainerCliDeps> = {}, env: Record<string, string> = {}): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-k-secrets-'));
  cleanup.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const passphrases: PassphraseRequest[] = [];
  const prompts: string[] = [];
  const deps: ContainerCliDeps = {
    env: { AGENTVAULT_HOME: home, ...env },
    interactive: false,
    log: (line) => out.push(plain(line)),
    err: (line) => err.push(plain(line)),
    exit: (code) => {
      throw new ExitSignal(code);
    },
    getPassphrase: (request) => {
      passphrases.push(request);
      return Promise.resolve(PASS);
    },
    promptSecret: (message) => {
      prompts.push(message);
      return Promise.resolve(KEY);
    },
    ...over,
  };
  return {
    deps,
    home,
    store: new SecretStore({ home }),
    out,
    err,
    passphrases,
    prompts,
    all: () => [...out, ...err].join('\n'),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

async function run(command: Command, args: string[]): Promise<number> {
  try {
    await command.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof ExitSignal) return error.code;
    throw error;
  }
}

describe('secrets add', () => {
  it('reads the value from the named environment variable and stores it encrypted', async () => {
    const h = harness({}, { ANTHROPIC_API_KEY: KEY });
    expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(0);

    expect(await h.store.get('anthropic', PASS)).toBe(KEY);
    expect(h.stdout()).toContain('Stored secret anthropic');
    expect(fs.statSync(h.store.file).mode & 0o777).toBe(0o600);
    // The file is not plaintext: neither the name nor the value is readable without the passphrase.
    const raw = fs.readFileSync(h.store.file, 'latin1');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('anthropic');
  });

  describe('property (d): the value is never echoed', () => {
    it('prints neither the value nor the passphrase, on success', async () => {
      const h = harness({}, { ANTHROPIC_API_KEY: KEY });
      await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY']);
      expect(h.all()).not.toContain(KEY);
      expect(h.all()).not.toContain(KEY.slice(0, 20));
      expect(h.all()).not.toContain(PASS);
    });

    it('prints neither when a prompted value is stored', async () => {
      const h = harness({ interactive: true });
      await run(secretsCommand(h.deps), ['add', 'anthropic']);
      expect(h.prompts).toEqual(['Value for secret "anthropic":']);
      expect(await h.store.get('anthropic', PASS)).toBe(KEY);
      expect(h.all()).not.toContain(KEY);
    });

    it('prints neither when storing fails, even if the underlying error mentions them', async () => {
      const h = harness({}, { ANTHROPIC_API_KEY: KEY });
      vi.spyOn(SecretStore.prototype, 'set').mockRejectedValueOnce(new Error(`disk said no while writing ${KEY} under ${PASS}`));
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(1);
      expect(h.stderr()).toContain('disk said no while writing [redacted] under [redacted]');
      expect(h.all()).not.toContain(KEY);
      expect(h.all()).not.toContain(PASS);
    });

    it('prints neither when the value is rejected as unusable', async () => {
      const bad = `${KEY}\n`;
      const h = harness({}, { ANTHROPIC_API_KEY: bad });
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(1);
      expect(h.stderr()).toContain('Error: The value for secret "anthropic" cannot be injected');
      expect(h.all()).not.toContain(KEY);
    });
  });

  it('asks for a confirmed passphrase when it creates the store, and an unconfirmed one afterwards', async () => {
    const h = harness({}, { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: 'sk-openai-0123456789abcdef' });
    await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY']);
    await run(secretsCommand(h.deps), ['add', 'openai', '--from-env', 'OPENAI_API_KEY']);
    expect(h.passphrases.map((p) => [p.purpose, p.confirm])).toEqual([
      ['secrets', true],
      ['secrets', false],
    ]);
    expect(await h.store.list(PASS)).toEqual(['anthropic', 'openai']);
  });

  it('says Updated when it replaces an existing secret', async () => {
    const h = harness({}, { ANTHROPIC_API_KEY: KEY });
    await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY']);
    h.out.length = 0;
    await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY']);
    expect(h.stdout()).toContain('Updated secret anthropic');
  });

  it('uses AGENTVAULT_SECRETS_PASSPHRASE when no provider is injected', async () => {
    const h = harness({}, { ANTHROPIC_API_KEY: KEY, AGENTVAULT_SECRETS_PASSPHRASE: PASS });
    delete h.deps.getPassphrase;
    expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(0);
    expect(await h.store.get('anthropic', PASS)).toBe(KEY);
  });

  describe('fail closed', () => {
    it('with the variable unset and no terminal: names the variable, creates no store, asks for no passphrase', async () => {
      const h = harness();
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(1);
      expect(h.stderr()).toContain('Environment variable ANTHROPIC_API_KEY is not set');
      expect(h.passphrases).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(fs.existsSync(h.store.file)).toBe(false);
    });

    it('treats an empty variable as unset', async () => {
      const h = harness({}, { ANTHROPIC_API_KEY: '' });
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(1);
      expect(h.stderr()).toContain('ANTHROPIC_API_KEY is not set');
    });

    it('with the variable unset on a terminal: prompts for the value, hidden', async () => {
      const h = harness({ interactive: true });
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(0);
      expect(h.prompts).toHaveLength(1);
      expect(await h.store.get('anthropic', PASS)).toBe(KEY);
    });

    it('without --from-env and without a terminal there is no way to supply a value, and the error says so', async () => {
      const h = harness();
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic'])).toBe(1);
      expect(h.stderr()).toContain('--from-env <VAR>');
      expect(h.stderr()).toContain('never taken from a command-line flag');
      expect(fs.existsSync(h.store.file)).toBe(false);
    });

    it('an env var that is plainly the key itself pasted after --from-env is not echoed back', async () => {
      const h = harness();
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', KEY])).toBe(1);
      expect(h.stderr()).toContain('takes the NAME of an environment variable');
      expect(h.all()).not.toContain(KEY);
    });

    it('checks the value before it asks for a passphrase', async () => {
      const h = harness({}, { BAD: 'has a trailing space ' });
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'BAD'])).toBe(1);
      expect(h.passphrases).toEqual([]);
    });

    it.each([
      ['', 'an empty value'],
      ['café-key-0123456789', 'non-ASCII'],
      ['two\nlines', 'a newline'],
      [' leading', 'a leading space'],
    ])('refuses %j (%s) because the proxy could not inject it', async (value) => {
      const h = harness({ interactive: true, promptSecret: () => Promise.resolve(value) });
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic'])).toBe(1);
      expect(fs.existsSync(h.store.file)).toBe(false);
    });

    it('rejects a secret name that is not a service name', async () => {
      const h = harness({}, { X: KEY });
      expect(await run(secretsCommand(h.deps), ['add', '../../etc/passwd', '--from-env', 'X'])).toBe(1);
      expect(h.stderr()).toContain('Invalid secret name');
      expect(fs.existsSync(h.store.file)).toBe(false);
    });

    it('a wrong passphrase for an existing store changes nothing', async () => {
      const h = harness({ getPassphrase: () => Promise.resolve('not the passphrase') }, { ANTHROPIC_API_KEY: KEY });
      await h.store.set('openai', 'sk-openai-0123456789abcdef', PASS);
      const before = fs.readFileSync(h.store.file);
      expect(await run(secretsCommand(h.deps), ['add', 'anthropic', '--from-env', 'ANTHROPIC_API_KEY'])).toBe(1);
      expect(h.stderr()).toContain('wrong passphrase');
      expect(h.stderr()).not.toContain('not the passphrase');
      expect(fs.readFileSync(h.store.file).equals(before)).toBe(true);
    });
  });

  it('has no flag that could carry a value or a passphrase', () => {
    const add = secretsCommand().commands.find((c) => c.name() === 'add');
    expect(add?.options.map((o) => o.long)).toEqual(['--from-env']);
  });
});

describe('secrets list', () => {
  it('prints names only, sorted', async () => {
    const h = harness();
    await h.store.set('openai', 'sk-openai-0123456789abcdef', PASS);
    await h.store.set('anthropic', KEY, PASS);
    expect(await run(secretsCommand(h.deps), ['list'])).toBe(0);
    expect(h.out).toEqual(['anthropic', 'openai']);
    expect(h.all()).not.toContain(KEY);
    expect(h.all()).not.toContain('sk-openai');
  });

  it('--json is an array of names', async () => {
    const h = harness();
    await h.store.set('anthropic', KEY, PASS);
    await run(secretsCommand(h.deps), ['list', '--json']);
    expect(JSON.parse(h.stdout())).toEqual(['anthropic']);
  });

  it('with no store says so and does not ask for a passphrase that protects nothing', async () => {
    const h = harness();
    expect(await run(secretsCommand(h.deps), ['list'])).toBe(0);
    expect(h.stdout()).toContain('No secrets stored');
    expect(h.passphrases).toEqual([]);
  });

  it('a wrong passphrase is an error, not an empty list', async () => {
    const h = harness({ getPassphrase: () => Promise.resolve('not the passphrase') });
    await h.store.set('anthropic', KEY, PASS);
    expect(await run(secretsCommand(h.deps), ['list'])).toBe(1);
    expect(h.stderr()).toContain('wrong passphrase');
  });
});

describe('secrets rm', () => {
  it('removes one secret and keeps the others', async () => {
    const h = harness();
    await h.store.set('anthropic', KEY, PASS);
    await h.store.set('openai', 'sk-openai-0123456789abcdef', PASS);
    expect(await run(secretsCommand(h.deps), ['rm', 'anthropic'])).toBe(0);
    expect(await h.store.list(PASS)).toEqual(['openai']);
    expect(h.stdout()).toContain('Removed secret anthropic');
  });

  it('a name that is not stored is an error, not a silent success', async () => {
    const h = harness();
    await h.store.set('openai', 'sk-openai-0123456789abcdef', PASS);
    expect(await run(secretsCommand(h.deps), ['rm', 'anthropic'])).toBe(1);
    expect(h.stderr()).toContain('No secret named "anthropic" in the store');
    expect(await h.store.list(PASS)).toEqual(['openai']);
  });

  it('with no store at all says so without asking for a passphrase', async () => {
    const h = harness();
    expect(await run(secretsCommand(h.deps), ['rm', 'anthropic'])).toBe(1);
    expect(h.stderr()).toContain('does not exist yet');
    expect(h.passphrases).toEqual([]);
  });
});
