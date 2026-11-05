/**
 * SecretStore and the resolvers. A CANARY value is used throughout: after
 * every failure the canary (and the passphrase) must be absent from error
 * messages, from JSON.stringify(error), from error.details and from the
 * store file bytes. Secret NAMES must be absent from the file too.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptBuffer } from '../../src/container/crypto.js';
import {
  SECRET_VALUE_MAX_BYTES,
  STORE_MAX_SECRETS,
  SecretStore,
  assertSecretValue,
  createChainResolver,
  createEnvResolver,
  createStoreResolver,
} from '../../src/container/secrets-store.js';
import { ContainerError } from '../../src/container/types.js';
import type { SecretResolver } from '../../src/container/types.js';

const PASS = 'store passphrase 12345';
const OTHER_PASS = 'some other passphrase';
const CANARY = 'sk-ant-CANARY-0b9f1c6d2a7e4f3891a5c0de77b2f46e';
const NAME = 'anthropic';

let work: string;
let counter = 0;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-secrets-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function freshDir(): string {
  counter += 1;
  return path.join(work, `s${counter}`);
}

function freshStore(): SecretStore {
  return new SecretStore({ file: path.join(freshDir(), 'secrets', 'store.avsec') });
}

/** Everything that could possibly be printed about an error. */
function everything(err: unknown): string {
  const e = err as ContainerError;
  return [e.message, e.stack ?? '', JSON.stringify(e), JSON.stringify({ ...e }), JSON.stringify(e.details ?? null), String(err)].join('\n');
}

async function failure(promise: Promise<unknown>): Promise<ContainerError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'expected a rejection').toBeInstanceOf(ContainerError);
  return err as ContainerError;
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(PASS);
  expect(text).not.toContain(OTHER_PASS);
}

describe('SecretStore location', () => {
  it('defaults to <home>/secrets/store.avsec', () => {
    const home = freshDir();
    expect(new SecretStore({ home }).file).toBe(path.join(home, 'secrets', 'store.avsec'));
  });

  it('defaults to AGENTVAULT_HOME when neither file nor home is given', () => {
    const home = freshDir();
    vi.stubEnv('AGENTVAULT_HOME', home);
    expect(new SecretStore().file).toBe(path.join(home, 'secrets', 'store.avsec'));
  });

  it('an explicit file wins over home', () => {
    const file = path.join(freshDir(), 'mine.avsec');
    expect(new SecretStore({ file, home: freshDir() }).file).toBe(file);
  });

  it('never touches the disk until the first set()', async () => {
    const store = freshStore();
    expect(await store.list(PASS)).toEqual([]);
    expect(await store.get(NAME, PASS)).toBeUndefined();
    expect(await store.delete(NAME, PASS)).toBe(false);
    expect(await store.getMany([NAME], PASS)).toEqual({});
    expect(fs.existsSync(path.dirname(store.file))).toBe(false);
  });
});

describe('SecretStore round trip', () => {
  it('sets, gets, lists (names only, sorted), overwrites and deletes', async () => {
    const store = freshStore();
    await store.set('zeta', 'z-value', PASS);
    await store.set(NAME, CANARY, PASS);
    await store.set('openai', 'o-value', PASS);

    expect(await store.get(NAME, PASS)).toBe(CANARY);
    expect(await store.list(PASS)).toEqual(['anthropic', 'openai', 'zeta']);
    expect(await store.getMany(['openai', 'missing', NAME], PASS)).toEqual({ openai: 'o-value', anthropic: CANARY });

    await store.set(NAME, 'replaced', PASS);
    expect(await store.get(NAME, PASS)).toBe('replaced');
    expect(await store.list(PASS)).toHaveLength(3);

    expect(await store.delete('openai', PASS)).toBe(true);
    expect(await store.delete('openai', PASS)).toBe(false);
    expect(await store.list(PASS)).toEqual(['anthropic', 'zeta']);
    expect(await store.get('openai', PASS)).toBeUndefined();
  });

  it('keeps unicode and awkward values intact', async () => {
    const store = freshStore();
    const value = 'pässwörd-日本語-🙂 with "quotes", \\backslash\nnewline\ttab';
    await store.set(NAME, value, PASS);
    expect(await store.get(NAME, PASS)).toBe(value);
  });

  it('accepts a value of exactly 64 KiB', async () => {
    const store = freshStore();
    const value = 'x'.repeat(SECRET_VALUE_MAX_BYTES);
    await store.set(NAME, value, PASS);
    expect(await store.get(NAME, PASS)).toBe(value);
  });

  it('a missing delete does not rewrite the file', async () => {
    const store = freshStore();
    await store.set(NAME, CANARY, PASS);
    const before = fs.readFileSync(store.file);
    expect(await store.delete('nothere', PASS)).toBe(false);
    expect(fs.readFileSync(store.file).equals(before)).toBe(true);
  });

  it('is prototype-safe: "constructor" is an ordinary name, missing until set', async () => {
    const store = freshStore();
    await store.set('other', 'x', PASS);
    // a plain-object lookup would return Object.prototype.constructor here
    expect(await store.get('constructor', PASS)).toBeUndefined();
    expect(await store.getMany(['constructor'], PASS)).toEqual({});
    await expect(createStoreResolver(store, PASS).resolve(['constructor'])).rejects.toMatchObject({ code: 'MISSING_SECRET' });
    await store.set('constructor', 'v', PASS);
    expect(await store.get('constructor', PASS)).toBe('v');
    expect(await store.getMany(['constructor'], PASS)).toEqual({ constructor: 'v' });
    expect(await store.list(PASS)).toEqual(['constructor', 'other']);
  });
});

describe('SecretStore on disk', () => {
  it.each([
    [0o000, 0o600],
    [0o022, 0o600],
    [0o277, 0o400],
  ])('creates the directory 0700 and a private file under umask %o', async (mask, fileMode) => {
    const old = process.umask(mask);
    try {
      const store = freshStore();
      await store.set(NAME, CANARY, PASS);
      // the directory must be usable and private whatever the umask says
      expect(fs.statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(store.file).mode & 0o777).toBe(fileMode);
      await store.set('second', 'value', PASS);
      expect(fs.statSync(store.file).mode & 0o077).toBe(0);
    } finally {
      process.umask(old);
    }
  });

  it('does not chmod a directory it did not create', async () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const store = new SecretStore({ file: path.join(dir, 'store.avsec') });
    await store.set(NAME, CANARY, PASS);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('writes atomically: no temp files are left behind', async () => {
    const store = freshStore();
    await store.set(NAME, CANARY, PASS);
    await store.set('other', 'x', PASS);
    await store.delete('other', PASS);
    expect(fs.readdirSync(path.dirname(store.file))).toEqual(['store.avsec']);
  });

  it('the file holds neither values, nor names, nor the passphrase', async () => {
    const store = freshStore();
    await store.set(NAME, CANARY, PASS);
    await store.set('openai-key', 'another-canary-value', PASS);
    const bytes = fs.readFileSync(store.file);
    for (const needle of [CANARY, 'another-canary-value', NAME, 'openai-key', PASS, 'anthropic']) {
      expect(bytes.includes(Buffer.from(needle)), `file bytes contain ${needle.length > 12 ? 'a secret' : needle}`).toBe(false);
    }
    expect(bytes.subarray(0, 7).toString('latin1')).toBe('AVENC1\n');
  });

  it('every write uses a fresh salt and IV', async () => {
    const store = freshStore();
    await store.set(NAME, CANARY, PASS);
    const first = fs.readFileSync(store.file);
    await store.set(NAME, CANARY, PASS);
    const second = fs.readFileSync(store.file);
    expect(first.equals(second)).toBe(false);
    const header = (b: Buffer): { salt: string; iv: string } => JSON.parse(b.subarray(11, 11 + b.readUInt32BE(7)).toString('utf8')) as { salt: string; iv: string };
    expect(header(first).salt).not.toBe(header(second).salt);
    expect(header(first).iv).not.toBe(header(second).iv);
  });
});

describe('wrong passphrase and damage', () => {
  async function seeded(): Promise<SecretStore> {
    const store = freshStore();
    await store.set(NAME, CANARY, PASS);
    return store;
  }

  it('every operation fails with INTEGRITY and says nothing about the contents', async () => {
    const store = await seeded();
    const attempts: Array<() => Promise<unknown>> = [
      () => store.get(NAME, OTHER_PASS),
      () => store.getMany([NAME], OTHER_PASS),
      () => store.list(OTHER_PASS),
      () => store.delete(NAME, OTHER_PASS),
      () => store.set('another', 'v', OTHER_PASS),
    ];
    for (const attempt of attempts) {
      const err = await failure(attempt());
      expect(err.code).toBe('INTEGRITY');
      expect(err.message).toBe('wrong passphrase or the file was modified');
      expectNoLeak(everything(err));
    }
  });

  it('a set() with the wrong passphrase does NOT replace the store', async () => {
    const store = await seeded();
    const before = fs.readFileSync(store.file);
    await failure(store.set('another', 'v', OTHER_PASS));
    expect(fs.readFileSync(store.file).equals(before)).toBe(true);
    expect(await store.get(NAME, PASS)).toBe(CANARY);
  });

  it('a tampered file is INTEGRITY, not a crash or a partial read', async () => {
    const store = await seeded();
    const good = fs.readFileSync(store.file);
    for (const at of [3, 12, good.length - 40, good.length - 1]) {
      const bad = Buffer.from(good);
      bad[at] = (bad[at] ?? 0) ^ 0x01;
      fs.writeFileSync(store.file, bad);
      const err = await failure(store.get(NAME, PASS));
      expect(err.code).toBe('INTEGRITY');
      expectNoLeak(everything(err));
    }
  });

  it('a truncated or garbage file is INTEGRITY', async () => {
    const store = await seeded();
    const good = fs.readFileSync(store.file);
    fs.writeFileSync(store.file, good.subarray(0, good.length - 1));
    expect((await failure(store.list(PASS))).code).toBe('INTEGRITY');
    fs.writeFileSync(store.file, 'this is not a secret store');
    expect((await failure(store.list(PASS))).code).toBe('INTEGRITY');
    fs.writeFileSync(store.file, '');
    expect((await failure(store.list(PASS))).code).toBe('INTEGRITY');
  });

  it('refuses a store file that is a symlink or a directory', async () => {
    const store = await seeded();
    const real = path.join(path.dirname(store.file), 'real.avsec');
    fs.renameSync(store.file, real);
    fs.symlinkSync(real, store.file);
    const err = await failure(store.get(NAME, PASS));
    expect(err.code).toBe('INTEGRITY');
    expect(err.message).toMatch(/not a regular file/);
    fs.rmSync(store.file);
    fs.mkdirSync(store.file);
    expect((await failure(store.get(NAME, PASS))).code).toBe('INTEGRITY');
  });

  it('a validly encrypted payload of the wrong shape is rejected without echoing it', async () => {
    const store = freshStore();
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    for (const payload of [
      JSON.stringify({ v: 2, secrets: {} }),
      JSON.stringify({ v: 1, secrets: { 'Bad Name': CANARY } }),
      JSON.stringify({ v: 1, secrets: { ok: 5 } }),
      JSON.stringify({ v: 1, secrets: {}, extra: CANARY }),
      `not json ${CANARY}`,
    ]) {
      fs.writeFileSync(store.file, await encryptBuffer(Buffer.from(payload), PASS));
      const err = await failure(store.list(PASS));
      expect(err.code).toBe('INTEGRITY');
      expectNoLeak(everything(err));
    }
  });
});

describe('input validation', () => {
  it.each([[''], ['Upper'], ['has space'], ['a_b'], ['../x'], ['a/b'], ['1abc'], ['-x'], ['x'.repeat(33)], ['__proto__']])(
    'rejects secret name %j',
    async (name) => {
      const store = freshStore();
      await expect(store.set(name, CANARY, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.get(name, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.delete(name, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(fs.existsSync(store.file)).toBe(false);
    }
  );

  it('rejects an empty value (it would match everywhere in a leak scan)', async () => {
    const store = freshStore();
    const err = await failure(store.set(NAME, '', PASS));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toMatch(/empty/);
    expect(fs.existsSync(store.file)).toBe(false);
  });

  it('rejects a value over 64 KiB, counting bytes not characters', async () => {
    const store = freshStore();
    await expect(store.set(NAME, 'x'.repeat(SECRET_VALUE_MAX_BYTES + 1), PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 21846 three-byte characters = 65538 bytes, only 21846 "characters"
    await expect(store.set(NAME, '日'.repeat(21_846), PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.set(NAME, '日'.repeat(21_845), PASS);
  });

  it('rejects NUL and non-string values without echoing them', async () => {
    const store = freshStore();
    const withNul = await failure(store.set(NAME, `${CANARY}\0tail`, PASS));
    expect(withNul.code).toBe('INVALID_INPUT');
    expectNoLeak(everything(withNul));
    await expect(store.set(NAME, 42 as unknown as string, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.set(NAME, undefined as unknown as string, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a short passphrase everywhere, without echoing it', async () => {
    const store = freshStore();
    for (const attempt of [
      () => store.set(NAME, CANARY, 'short'),
      () => store.get(NAME, 'short'),
      () => store.list('short'),
      () => store.delete(NAME, 'short'),
      () => store.getMany([NAME], 'short'),
    ]) {
      const err = await failure(attempt());
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.message).not.toContain('short');
      expectNoLeak(everything(err));
    }
    expect(fs.existsSync(store.file)).toBe(false);
  });

  it('enforces the secret count limit (and still allows replacing an existing one)', async () => {
    const store = freshStore();
    const secrets: Record<string, string> = {};
    for (let i = 0; i < STORE_MAX_SECRETS; i += 1) secrets[`s${i}`] = `value-${i}`;
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, await encryptBuffer(Buffer.from(JSON.stringify({ v: 1, secrets })), PASS));

    await expect(store.set('one-too-many', 'v', PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.set('s7', 'replaced', PASS);
    expect(await store.get('s7', PASS)).toBe('replaced');
    expect(await store.list(PASS)).toHaveLength(STORE_MAX_SECRETS);
  });

  it('assertSecretValue names the secret, never the value', () => {
    expect(() => assertSecretValue('', 'anthropic')).toThrow(/"anthropic"/);
    try {
      assertSecretValue(`${CANARY}\0`, 'anthropic');
      expect.unreachable();
    } catch (err) {
      expectNoLeak(everything(err));
    }
  });
});

describe('createStoreResolver', () => {
  it('resolves every requested name from the store', async () => {
    const store = freshStore();
    await store.set('anthropic', CANARY, PASS);
    await store.set('openai', 'o-value', PASS);
    const resolver = createStoreResolver(store, PASS);
    expect(await resolver.resolve(['anthropic', 'openai'])).toEqual({ anthropic: CANARY, openai: 'o-value' });
    expect(await resolver.resolve([])).toEqual({});
    expect(await resolver.resolve(['openai', 'openai'])).toEqual({ openai: 'o-value' });
  });

  it('fails closed with MISSING_SECRET naming only the names that are missing', async () => {
    const store = freshStore();
    await store.set('anthropic', CANARY, PASS);
    const resolver = createStoreResolver(store, PASS);
    const err = await failure(resolver.resolve(['anthropic', 'nope-a', 'nope-b']));
    expect(err.code).toBe('MISSING_SECRET');
    expect(err.message).toBe('missing secrets: nope-a, nope-b');
    expect(err.details).toEqual({ missing: ['nope-a', 'nope-b'] });
    expectNoLeak(everything(err));
  });

  it('a missing store means everything is missing', async () => {
    const err = await failure(createStoreResolver(freshStore(), PASS).resolve(['anthropic']));
    expect(err).toMatchObject({ code: 'MISSING_SECRET', message: 'missing secrets: anthropic' });
  });

  it('a wrong passphrase is INTEGRITY, not "missing" (and does not leak)', async () => {
    const store = freshStore();
    await store.set('anthropic', CANARY, PASS);
    const err = await failure(createStoreResolver(store, OTHER_PASS).resolve(['anthropic']));
    expect(err.code).toBe('INTEGRITY');
    expectNoLeak(everything(err));
  });

  it('validates names and the passphrase', async () => {
    const store = freshStore();
    await expect(createStoreResolver(store, PASS).resolve(['../x'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => createStoreResolver(store, 'short')).toThrow(ContainerError);
  });

  it('does not expose the passphrase through its own enumerable state', () => {
    const resolver = createStoreResolver(freshStore(), PASS);
    expect(JSON.stringify(resolver)).not.toContain(PASS);
    expect(Object.values(resolver).some((v) => v === PASS)).toBe(false);
  });
});

describe('createEnvResolver', () => {
  const env = { ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: 'o-value', EMPTY_ONE: '', HUGE: 'x'.repeat(SECRET_VALUE_MAX_BYTES + 1) };

  it('maps secret names to environment variables', async () => {
    const resolver = createEnvResolver({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }, env);
    expect(await resolver.resolve(['anthropic', 'openai'])).toEqual({ anthropic: CANARY, openai: 'o-value' });
  });

  it('only resolves names that are in the mapping, so an unmapped name is missing even if the variable exists', async () => {
    const resolver = createEnvResolver({ anthropic: 'ANTHROPIC_API_KEY' }, env);
    const err = await failure(resolver.resolve(['anthropic', 'openai']));
    expect(err).toMatchObject({ code: 'MISSING_SECRET', message: 'missing secrets: openai' });
  });

  it('treats unset and empty variables as missing and never echoes the variable name or value', async () => {
    const resolver = createEnvResolver({ anthropic: 'ANTHROPIC_API_KEY', gone: 'NOT_SET_ANYWHERE', blank: 'EMPTY_ONE' }, env);
    const err = await failure(resolver.resolve(['anthropic', 'gone', 'blank']));
    expect(err.message).toBe('missing secrets: gone, blank');
    expectNoLeak(everything(err));
    expect(everything(err)).not.toContain('NOT_SET_ANYWHERE');
  });

  it('rejects an oversized variable as INVALID_INPUT without echoing it', async () => {
    const resolver = createEnvResolver({ big: 'HUGE' }, env);
    const err = await failure(resolver.resolve(['big']));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).not.toContain('xxxxxxxxxx');
  });

  it('reads the environment at resolve time and defaults to process.env', async () => {
    const live: Record<string, string | undefined> = {};
    const resolver = createEnvResolver({ anthropic: 'ANTHROPIC_API_KEY' }, live);
    await expect(resolver.resolve(['anthropic'])).rejects.toMatchObject({ code: 'MISSING_SECRET' });
    live['ANTHROPIC_API_KEY'] = CANARY;
    expect(await resolver.resolve(['anthropic'])).toEqual({ anthropic: CANARY });

    vi.stubEnv('AVT_TEST_ONLY_KEY', 'from-process-env');
    expect(await createEnvResolver({ thing: 'AVT_TEST_ONLY_KEY' }).resolve(['thing'])).toEqual({ thing: 'from-process-env' });
  });

  it('validates the mapping up front', () => {
    expect(() => createEnvResolver({ 'Bad Name': 'X' })).toThrow(ContainerError);
    expect(() => createEnvResolver({ ok: '1BAD' })).toThrow(ContainerError);
    expect(() => createEnvResolver({ ok: 'HAS-DASH' })).toThrow(ContainerError);
  });
});

describe('createChainResolver', () => {
  function fixed(values: Record<string, string>): SecretResolver {
    return createEnvResolver(Object.fromEntries(Object.keys(values).map((k) => [k, `V_${k.toUpperCase()}`])), Object.fromEntries(Object.entries(values).map(([k, v]) => [`V_${k.toUpperCase()}`, v])));
  }

  it('the first resolver that has a name wins', async () => {
    const chain = createChainResolver(fixed({ anthropic: 'from-first' }), fixed({ anthropic: 'from-second', openai: 'from-second' }));
    expect(await chain.resolve(['anthropic', 'openai'])).toEqual({ anthropic: 'from-first', openai: 'from-second' });
  });

  it('falls back to the store for names the environment lacks, with one decryption for the store', async () => {
    const store = freshStore();
    await store.set('openai', 'from-store', PASS);
    const spy = vi.spyOn(store, 'getMany');
    const chain = createChainResolver(fixed({ anthropic: CANARY }), createStoreResolver(store, PASS));
    expect(await chain.resolve(['anthropic', 'openai'])).toEqual({ anthropic: CANARY, openai: 'from-store' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual(['openai']);
  });

  it('does not ask later resolvers for names that are already resolved', async () => {
    const store = freshStore();
    const spy = vi.spyOn(store, 'getMany');
    const chain = createChainResolver(fixed({ anthropic: CANARY }), createStoreResolver(store, PASS));
    await chain.resolve(['anthropic']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws MISSING_SECRET naming only what NO resolver had', async () => {
    const chain = createChainResolver(fixed({ anthropic: CANARY }), fixed({ openai: 'x' }));
    const err = await failure(chain.resolve(['anthropic', 'openai', 'nobody-has-this', 'nor-this']));
    expect(err).toMatchObject({ code: 'MISSING_SECRET', message: 'missing secrets: nobody-has-this, nor-this' });
    expectNoLeak(everything(err));
  });

  it('an empty chain resolves nothing and an empty request resolves nothing', async () => {
    await expect(createChainResolver().resolve(['anthropic'])).rejects.toMatchObject({ code: 'MISSING_SECRET', message: 'missing secrets: anthropic' });
    expect(await createChainResolver().resolve([])).toEqual({});
  });

  it('propagates errors that are not "missing" (a wrong store passphrase must not look like a missing secret)', async () => {
    const store = freshStore();
    await store.set('openai', 'v', PASS);
    const chain = createChainResolver(fixed({}), createStoreResolver(store, OTHER_PASS));
    const err = await failure(chain.resolve(['openai']));
    expect(err.code).toBe('INTEGRITY');
    expectNoLeak(everything(err));
  });

  it('works with plain resolvers that only implement resolve() (partial answers via details.missing)', async () => {
    const calls: string[][] = [];
    const plain: SecretResolver = {
      resolve(names) {
        calls.push([...names]);
        const have: Record<string, string> = { alpha: 'a-value' };
        const missing = names.filter((n) => !(n in have));
        if (missing.length > 0) return Promise.reject(new ContainerError('MISSING_SECRET', `missing secrets: ${missing.join(', ')}`, { missing }));
        return Promise.resolve(Object.fromEntries(names.map((n) => [n, have[n] ?? ''])));
      },
    };
    const chain = createChainResolver(plain, fixed({ beta: 'b-value' }));
    expect(await chain.resolve(['alpha', 'beta'])).toEqual({ alpha: 'a-value', beta: 'b-value' });
    expect(calls).toEqual([['alpha', 'beta'], ['alpha']]);
  });

  it('works with resolvers that report nothing about what is missing (asks one name at a time)', async () => {
    const opaque: SecretResolver = {
      resolve(names) {
        if (names.length === 1 && names[0] === 'alpha') return Promise.resolve({ alpha: 'a-value' });
        return Promise.reject(new ContainerError('MISSING_SECRET', 'something is missing'));
      },
    };
    expect(await createChainResolver(opaque).resolve(['alpha'])).toEqual({ alpha: 'a-value' });
    const chain = createChainResolver(opaque, fixed({ beta: 'b-value' }));
    expect(await chain.resolve(['alpha', 'beta'])).toEqual({ alpha: 'a-value', beta: 'b-value' });
  });

  it('ignores extra names a resolver returns that nobody asked for', async () => {
    const greedy: SecretResolver = { resolve: () => Promise.resolve({ anthropic: 'a', openai: 'LEAK-ME' }) };
    expect(await createChainResolver(greedy).resolve(['anthropic'])).toEqual({ anthropic: 'a' });
  });

  it('validates requested names', async () => {
    await expect(createChainResolver(fixed({})).resolve(['../x'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
