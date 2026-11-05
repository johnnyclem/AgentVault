/**
 * Local encrypted secret store and the resolvers that feed the credential
 * proxy sidecar.
 *
 * Why this exists: PRD-04 needs `agentvault secrets add anthropic
 * --from-env ANTHROPIC_API_KEY` to put the real key somewhere durable that is
 * not the agent and not plaintext on disk. There is no general at-rest secret
 * store in the repo (ApiKeyManager is Binance-shaped, the vault providers need
 * external services), so this is a deliberately small one on top of the shared
 * AVENC1 format in crypto.ts.
 *
 * Security stance:
 *  - The WHOLE content (names and values) is one encryptBuffer payload, so a
 *    secret's existence and name are unreadable without the passphrase.
 *  - The store directory is created 0700 and the file is written 0600 with
 *    atomicWriteFileSync, so a crash mid-write cannot corrupt an existing store.
 *  - Every method takes the passphrase explicitly. This module reads no
 *    environment variables except AGENTVAULT_HOME (through agentvaultHome(),
 *    only when no `file` or `home` is given). A passphrase or a value never
 *    appears in an error message, in `details`, or in a thrown object.
 *  - Empty values are refused: the repo's leak detector does
 *    `text.includes('')` / `replaceAll('', ...)`, which matches everywhere.
 *    Values are capped at 64 KiB and may not contain NUL.
 *  - Resolvers fail closed: a resolver that cannot supply every requested name
 *    throws ContainerError('MISSING_SECRET', 'missing secrets: a, b') naming
 *    NAMES only.
 *
 * Concurrency: set() and delete() are read-modify-write on one file and are
 * NOT safe against concurrent writers. Two processes writing at once can lose
 * one of the updates (the file itself is never torn: writes are atomic). Run
 * one writer at a time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { assertPassphrase, decryptBuffer, encryptBuffer } from './crypto.js';
import { ContainerError } from './types.js';
import type { SecretResolver } from './types.js';
import { SECRET_NAME_RE, agentvaultHome, assertEnvName, assertSecretName } from './validate.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const SECRET_VALUE_MAX_BYTES = 64 * 1024;
export const STORE_MAX_SECRETS = 256;
export const STORE_MAX_TOTAL_VALUE_BYTES = 4 * 1024 * 1024;
const STORE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const STORE_FILE_NAME = 'store.avsec';
const STORE_FORMAT_VERSION = 1 as const;

const storeContentSchema = z.strictObject({
  v: z.literal(STORE_FORMAT_VERSION),
  secrets: z.record(z.string().regex(SECRET_NAME_RE), z.string()),
});

function invalid(message: string): ContainerError {
  return new ContainerError('INVALID_INPUT', message);
}

/**
 * Throws INVALID_INPUT. The message names the secret, never the value.
 * Exported so the CLI can validate before it prompts for a passphrase.
 */
export function assertSecretValue(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw invalid(`The value for secret ${JSON.stringify(name)} must be a string`);
  if (value.length === 0) {
    throw invalid(`The value for secret ${JSON.stringify(name)} is empty: an empty secret would match everywhere in a leak scan`);
  }
  if (value.includes('\0')) throw invalid(`The value for secret ${JSON.stringify(name)} contains a NUL character`);
  if (Buffer.byteLength(value, 'utf8') > SECRET_VALUE_MAX_BYTES) {
    throw invalid(`The value for secret ${JSON.stringify(name)} is larger than ${SECRET_VALUE_MAX_BYTES} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SecretStoreOptions {
  /** Full path of the store file. Wins over `home`. */
  file?: string;
  /** Base directory instead of agentvaultHome(); the file is <home>/secrets/store.avsec. */
  home?: string;
}

export class SecretStore {
  readonly file: string;

  constructor(options: SecretStoreOptions = {}) {
    this.file = path.resolve(options.file ?? path.join(options.home ?? agentvaultHome(), 'secrets', STORE_FILE_NAME));
  }

  /** null when the store does not exist yet. Throws INTEGRITY for a wrong passphrase or a damaged file. */
  private async load(passphrase: string): Promise<Map<string, string> | null> {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!stat.isFile()) throw new ContainerError('INTEGRITY', 'The secret store is not a regular file (refusing to follow a symlink)');
    if (stat.size > STORE_MAX_FILE_BYTES) throw new ContainerError('INTEGRITY', 'The secret store file is implausibly large');

    const plaintext = await decryptBuffer(fs.readFileSync(this.file), passphrase);
    let parsed: z.infer<typeof storeContentSchema>;
    try {
      parsed = storeContentSchema.parse(JSON.parse(plaintext.toString('utf8')));
    } catch {
      // Authenticated but not ours: a future version or a bug. Say nothing about the content.
      throw new ContainerError('INTEGRITY', 'The secret store decrypted but its content is not in a supported format');
    } finally {
      plaintext.fill(0);
    }
    return new Map(Object.entries(parsed.secrets));
  }

  private async save(secrets: Map<string, string>, passphrase: string): Promise<void> {
    const record: Record<string, string> = {};
    for (const name of [...secrets.keys()].sort()) record[name] = secrets.get(name) ?? '';
    const plaintext = Buffer.from(JSON.stringify({ v: STORE_FORMAT_VERSION, secrets: record }), 'utf8');
    try {
      const blob = await encryptBuffer(plaintext, passphrase);
      this.ensureDirectory();
      atomicWriteFileSync(this.file, blob, { mode: 0o600 });
    } finally {
      plaintext.fill(0);
    }
  }

  private ensureDirectory(): void {
    // Create each missing level on its own and make it private straight away.
    // `mkdir -p` (recursive) would leave the intermediate levels at 0700 & ~umask,
    // and under a restrictive umask (0o277) such a level has no owner-write bit,
    // so creating the next level inside it fails with EACCES for any non-root
    // user. Only directories created here are chmod-ed; one that already exists
    // (the user chose to put the file there) is never touched.
    const missing: string[] = [];
    let probe = path.dirname(this.file);
    while (!fs.existsSync(probe)) {
      missing.push(probe);
      const parent = path.dirname(probe);
      if (parent === probe) break; // a root that does not exist: mkdir below reports the real error
      probe = parent;
    }
    for (const dir of missing.reverse()) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (err) {
        // another process created it between our check and now: theirs, so leave it alone
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      fs.chmodSync(dir, 0o700);
    }
  }

  /** Create or replace a secret. Creates the store (with this passphrase) if it does not exist. */
  async set(name: string, value: string, passphrase: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value, name);
    assertPassphrase(passphrase);
    const secrets = (await this.load(passphrase)) ?? new Map<string, string>();
    if (!secrets.has(name) && secrets.size >= STORE_MAX_SECRETS) {
      throw invalid(`The secret store is full (limit ${STORE_MAX_SECRETS} secrets)`);
    }
    let total = Buffer.byteLength(value, 'utf8');
    for (const [existing, v] of secrets) {
      if (existing !== name) total += Buffer.byteLength(v, 'utf8');
    }
    if (total > STORE_MAX_TOTAL_VALUE_BYTES) {
      throw invalid(`The secret store would exceed ${STORE_MAX_TOTAL_VALUE_BYTES} bytes of secret values`);
    }
    secrets.set(name, value);
    await this.save(secrets, passphrase);
  }

  /** The value, or undefined when there is no such secret (or no store). */
  async get(name: string, passphrase: string): Promise<string | undefined> {
    assertSecretName(name);
    assertPassphrase(passphrase);
    return (await this.load(passphrase))?.get(name);
  }

  /** Those of `names` that exist, as name -> value. One key derivation for the whole batch. */
  async getMany(names: readonly string[], passphrase: string): Promise<Record<string, string>> {
    for (const name of names) assertSecretName(name);
    assertPassphrase(passphrase);
    const secrets = await this.load(passphrase);
    const out: Record<string, string> = {};
    if (secrets === null) return out;
    for (const name of names) {
      const value = secrets.get(name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  /** Names only, sorted. */
  async list(passphrase: string): Promise<string[]> {
    assertPassphrase(passphrase);
    return [...((await this.load(passphrase))?.keys() ?? [])].sort();
  }

  /** True when the secret existed. A missing secret is not an error and does not rewrite the file. */
  async delete(name: string, passphrase: string): Promise<boolean> {
    assertSecretName(name);
    assertPassphrase(passphrase);
    const secrets = await this.load(passphrase);
    if (secrets === null || !secrets.delete(name)) return false;
    await this.save(secrets, passphrase);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * A SecretResolver that can also report what it has without failing for the
 * rest. createChainResolver uses `available` to avoid decrypting twice.
 */
export interface PartialSecretResolver extends SecretResolver {
  /** The requested names this resolver can supply (never throws MISSING_SECRET). */
  available(names: readonly string[]): Promise<Record<string, string>>;
}

function missingSecrets(missing: readonly string[]): ContainerError {
  // Names only. Every name here was validated against SECRET_NAME_RE.
  return new ContainerError('MISSING_SECRET', `missing secrets: ${missing.join(', ')}`, { missing: [...missing] });
}

function uniqueValidNames(names: readonly string[]): string[] {
  const unique = [...new Set(names)];
  for (const name of unique) assertSecretName(name);
  return unique;
}

function resolverFrom(available: (names: readonly string[]) => Promise<Record<string, string>>): PartialSecretResolver {
  return {
    available,
    async resolve(names: readonly string[]): Promise<Record<string, string>> {
      const unique = uniqueValidNames(names);
      const found = await available(unique);
      const missing = unique.filter((name) => !Object.hasOwn(found, name));
      if (missing.length > 0) throw missingSecrets(missing);
      return found;
    },
  };
}

/** Resolve from the encrypted store. The passphrase is held in the closure only. */
export function createStoreResolver(store: SecretStore, passphrase: string): PartialSecretResolver {
  assertPassphrase(passphrase);
  return resolverFrom((names) => store.getMany(uniqueValidNames(names), passphrase));
}

/**
 * Resolve from environment variables. `mapping` is secret name -> env var
 * name (for example { anthropic: 'ANTHROPIC_API_KEY' }). A variable that is
 * unset or empty counts as missing; an oversized one is INVALID_INPUT.
 * `env` is read at resolve time, not at construction.
 */
export function createEnvResolver(
  mapping: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): PartialSecretResolver {
  const table = new Map<string, string>();
  for (const [secret, variable] of Object.entries(mapping)) {
    table.set(assertSecretName(secret), assertEnvName(variable));
  }
  return resolverFrom((names) => {
    const out: Record<string, string> = {};
    for (const name of names) {
      const variable = table.get(name);
      const value = variable !== undefined ? env[variable] : undefined;
      if (value === undefined || value === '') continue;
      assertSecretValue(value, name);
      out[name] = value;
    }
    return Promise.resolve(out);
  });
}

async function availableFrom(resolver: SecretResolver, names: readonly string[]): Promise<Record<string, string>> {
  const partial = resolver as Partial<PartialSecretResolver>;
  if (typeof partial.available === 'function') return partial.available(names);
  try {
    return await resolver.resolve(names);
  } catch (err) {
    if (!(err instanceof ContainerError) || err.code !== 'MISSING_SECRET') throw err;
    const missing = err.details?.['missing'];
    if (Array.isArray(missing)) {
      const rest = names.filter((name) => !missing.includes(name));
      return rest.length > 0 ? resolver.resolve(rest) : {};
    }
    // A resolver that does not say what it lacks: ask one name at a time.
    const out: Record<string, string> = {};
    for (const name of names) {
      try {
        Object.assign(out, await resolver.resolve([name]));
      } catch (inner) {
        if (!(inner instanceof ContainerError) || inner.code !== 'MISSING_SECRET') throw inner;
      }
    }
    return out;
  }
}

/** Ask each resolver in turn; the first one that has a name wins. Unresolved names => MISSING_SECRET. */
export function createChainResolver(...resolvers: SecretResolver[]): SecretResolver {
  return {
    async resolve(names: readonly string[]): Promise<Record<string, string>> {
      const wanted = uniqueValidNames(names);
      const out: Record<string, string> = {};
      let remaining = wanted;
      for (const resolver of resolvers) {
        if (remaining.length === 0) break;
        const got = await availableFrom(resolver, remaining);
        for (const name of remaining) {
          if (Object.hasOwn(got, name)) out[name] = got[name] ?? '';
        }
        remaining = remaining.filter((name) => !Object.hasOwn(out, name));
      }
      if (remaining.length > 0) throw missingSecrets(remaining);
      return out;
    },
  };
}
