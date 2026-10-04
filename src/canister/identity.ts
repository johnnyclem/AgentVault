/**
 * Signing identities for memory_repo writes.
 *
 * The memory_repo canister refuses anonymous callers on every write: only
 * its owner (whoever called initRepo) and the principals the owner added
 * with addAuthorizedPrincipal may write. AgentVault therefore signs writes
 * with a key loaded from a PEM file as dfx (`dfx identity export <name>`)
 * or icp-cli export it: Ed25519 in PKCS#8 ("BEGIN PRIVATE KEY") or
 * secp256k1 in SEC1 ("BEGIN EC PRIVATE KEY") or PKCS#8. Encrypted PEMs are
 * refused; AgentVault never asks for or keeps a key passphrase.
 *
 * Where the key comes from:
 *   CLI:    --identity <pem>, else AGENTVAULT_ICP_IDENTITY_PEM_FILE, else
 *           dfx's selected identity (~/.config/dfx/identity.json "default"
 *           → ~/.config/dfx/identity/<name>/identity.pem) when it exists.
 *   Server: AGENTVAULT_ICP_IDENTITY_PEM_FILE (a path) or
 *           AGENTVAULT_ICP_IDENTITY_PEM (the PEM text, for hosts without a
 *           filesystem to mount keys on). Never the home directory.
 *
 * A key file other users can read or write still loads, with a warning
 * (SigningIdentity.warning) for the caller to show.
 *
 * Nothing here logs key material or puts it in an error message.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import type { SignIdentity } from '@dfinity/agent';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';
import { sanitizePathPart } from '../utils/path-validation.js';

export const IDENTITY_PEM_FILE_ENV = 'AGENTVAULT_ICP_IDENTITY_PEM_FILE';
export const IDENTITY_PEM_ENV = 'AGENTVAULT_ICP_IDENTITY_PEM';

export type SigningKeyType = 'ed25519' | 'secp256k1';

/** Where a signing identity was loaded from. */
export type IdentitySource =
  | { kind: 'flag'; path: string }
  | { kind: 'env-file'; path: string }
  | { kind: 'env-pem' }
  | { kind: 'dfx'; name: string; path: string };

export interface SigningIdentity {
  identity: SignIdentity;
  /** The principal the identity signs as, as text. */
  principal: string;
  keyType: SigningKeyType;
  source: IdentitySource;
  /** Set when the key file is readable or writable by users other than its owner. */
  warning?: string;
}

export type SigningIdentityErrorCode = 'SIGNING_IDENTITY_NOT_CONFIGURED' | 'SIGNING_IDENTITY_INVALID';

export class SigningIdentityError extends Error {
  constructor(
    message: string,
    readonly code: SigningIdentityErrorCode,
  ) {
    super(message);
    this.name = 'SigningIdentityError';
  }
}

type Env = Record<string, string | undefined>;

const AUTHORIZE_HINT =
  'The principal must be the repo owner (the identity that ran `agentvault memory init`) ' +
  'or one the owner added with `agentvault memory authorize <principal>`.';

/**
 * Where AgentVault suggests keeping an exported key: outside any project, so
 * `git add .` cannot pick it up.
 */
export function exportedKeyPath(name: string): string {
  return `~/.config/agentvault/${name}.pem`;
}

/**
 * The shell command that exports a dfx identity's key to exportedKeyPath,
 * created readable only by its owner (a plain redirect makes it 0644).
 */
export function exportKeyCommand(name: string): string {
  return `(umask 077; mkdir -p ~/.config/agentvault && dfx identity export ${name} > ${exportedKeyPath(name)})`;
}

/** What to do when a CLI write finds no signing identity. */
export const CLI_IDENTITY_GUIDANCE = [
  'memory_repo refuses anonymous writes, and no signing identity is configured. Use one of:',
  '  --identity <pem>                        a PEM key exported from dfx or icp-cli',
  `  ${IDENTITY_PEM_FILE_ENV}=<pem>  the same, from the environment`,
  "  dfx's selected identity                 `dfx identity use <name>` (read from ~/.config/dfx/identity/<name>/identity.pem)",
  `To export a dfx identity's key outside your project, readable only by you: ${exportKeyCommand('<name>')}`,
  AUTHORIZE_HINT,
].join('\n');

/** What to do when the webapp server has no signing identity. */
export const SERVER_IDENTITY_GUIDANCE =
  'memory_repo refuses anonymous writes, and this server has no signing identity. ' +
  `Set ${IDENTITY_PEM_FILE_ENV} to the path of a PEM key kept outside the app's directory and readable only by the server ` +
  `(e.g. exported with \`${exportKeyCommand('<name>')}\`) or ${IDENTITY_PEM_ENV} to the PEM text, then have the repo owner run ` +
  '`agentvault memory authorize <principal>` for its principal ' +
  '(`agentvault memory whoami --identity <pem>` prints it).';

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
const KEY_LABELS = new Set(['PRIVATE KEY', 'EC PRIVATE KEY']);

/**
 * Load a signing identity from PEM text.
 *
 * The private key block is picked out of the text (an "EC PARAMETERS" block
 * before it, as `openssl ecparam -genkey` writes, is skipped) and parsed by
 * node:crypto, which reads both PKCS#8 and SEC1 and either key type.
 *
 * @throws SigningIdentityError (SIGNING_IDENTITY_INVALID) for text with no
 *   private key, an encrypted key, a key that does not parse, or a key on
 *   another curve or algorithm
 */
export function identityFromPem(pem: string): { identity: SignIdentity; keyType: SigningKeyType } {
  const text = pem.replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(PEM_BLOCK)].map((m) => ({ label: m[1] ?? '', block: m[0] }));

  if (blocks.some((b) => b.label === 'ENCRYPTED PRIVATE KEY') || /Proc-Type:\s*4,ENCRYPTED/.test(text)) {
    throw invalid(
      'the PEM key is encrypted, and AgentVault does not decrypt keys. ' +
        `Export an unencrypted copy outside your project, readable only by you (\`${exportKeyCommand('<name>')}\`), and use that.`,
    );
  }

  const key = blocks.find((b) => KEY_LABELS.has(b.label));
  if (!key) {
    throw invalid('no private key found: expected a "BEGIN PRIVATE KEY" or "BEGIN EC PRIVATE KEY" PEM block');
  }

  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey({ key: key.block, format: 'pem' });
  } catch {
    // OpenSSL before 3.2 (Node 18 and 20) rejects the PKCS#8 v2 Ed25519 keys
    // older dfx releases wrote; rewrite that exact layout as PKCS#8 v1.
    const legacy = key.label === 'PRIVATE KEY' ? legacyDfxEd25519(key.block) : null;
    if (!legacy) {
      // The underlying error says nothing useful and is not passed on.
      throw invalid(`the "${key.label}" block could not be parsed as a private key`);
    }
    keyObject = legacy;
  }

  // Checked before the key is exported: node:crypto cannot export some
  // algorithms and curves (DSA, DH, brainpool) as JWK at all.
  const type = keyObject.asymmetricKeyType;
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  const keyType: SigningKeyType | null =
    type === 'ed25519' ? 'ed25519' : type === 'ec' && curve === 'secp256k1' ? 'secp256k1' : null;
  if (!keyType) {
    throw invalid(
      `unsupported key type ${type ?? 'unknown'}${curve ? ` (${curve})` : ''}: AgentVault signs with Ed25519 or secp256k1 keys`,
    );
  }

  try {
    const d = keyObject.export({ format: 'jwk' }).d;
    if (!d) throw new Error('no private scalar');
    const secret = new Uint8Array(Buffer.from(d, 'base64url'));
    const identity = keyType === 'ed25519' ? Ed25519KeyIdentity.fromSecretKey(secret) : Secp256k1KeyIdentity.fromSecretKey(secret);
    return { identity, keyType };
  } catch {
    // OpenSSL and the key libraries reject an out-of-range secp256k1 scalar
    // (0, or n and above) in their own terms; the cause is not passed on.
    throw invalid(`the ${keyType} key could not be used: its private key is not a valid ${keyType} key`);
  }
}

/**
 * The signing identity for a CLI command: --identity, else
 * AGENTVAULT_ICP_IDENTITY_PEM_FILE, else dfx's selected identity. Null when
 * none of them is set up (including dfx's built-in anonymous identity).
 *
 * A source that is set up but unusable (a missing file, an encrypted or
 * unsupported key, a dfx identity kept in the keyring) throws rather than
 * falling through to the next one.
 *
 * @param options.env - defaults to process.env
 * @param options.homeDir - defaults to os.homedir(); DFX_CONFIG_ROOT in env takes precedence, as in dfx
 */
export function resolveCliSigningIdentity(options: {
  identityPath?: string;
  env?: Env;
  homeDir?: string;
} = {}): SigningIdentity | null {
  const env = options.env ?? process.env;

  if (options.identityPath) {
    const file = expandHome(options.identityPath, options.homeDir);
    // dfx's own --identity takes an identity name; say so when that is what this looks like.
    if (!fs.existsSync(file) && /^[A-Za-z0-9_@-][A-Za-z0-9._@-]*$/.test(options.identityPath) && !options.identityPath.endsWith('.pem')) {
      const name = options.identityPath;
      throw invalid(
        `--identity takes the path of a PEM file, and there is no file '${name}'. ` +
          `For the dfx identity '${name}', select it with \`dfx identity use ${name}\` ` +
          `or export its key with \`${exportKeyCommand(name)}\` and pass --identity ${exportedKeyPath(name)}.`,
      );
    }
    return fromPemFile(file, { kind: 'flag', path: file });
  }

  const envFile = env[IDENTITY_PEM_FILE_ENV];
  if (envFile) {
    const file = expandHome(envFile, options.homeDir);
    return fromPemFile(file, { kind: 'env-file', path: file });
  }

  return fromDfx(path.join(env.DFX_CONFIG_ROOT || options.homeDir || os.homedir(), '.config', 'dfx'));
}

/** Like resolveCliSigningIdentity, but fails closed with guidance when there is none. */
export function requireCliSigningIdentity(options: Parameters<typeof resolveCliSigningIdentity>[0] = {}): SigningIdentity {
  const signer = resolveCliSigningIdentity(options);
  if (!signer) {
    throw new SigningIdentityError(CLI_IDENTITY_GUIDANCE, 'SIGNING_IDENTITY_NOT_CONFIGURED');
  }
  return signer;
}

/**
 * The webapp server's signing identity, from AGENTVAULT_ICP_IDENTITY_PEM_FILE
 * or AGENTVAULT_ICP_IDENTITY_PEM. Null when neither is set. Only the
 * environment is read: a server has no business with the home directory of
 * whoever runs it.
 *
 * PEM text with literal "\n" sequences and no line breaks, as some hosting
 * dashboards store multi-line values, is unescaped first.
 */
export function resolveServerSigningIdentity(env: Env = process.env): SigningIdentity | null {
  const file = env[IDENTITY_PEM_FILE_ENV];
  const text = env[IDENTITY_PEM_ENV];

  if (file && text) {
    throw invalid(`set only one of ${IDENTITY_PEM_FILE_ENV} and ${IDENTITY_PEM_ENV}`);
  }
  if (file) {
    return fromPemFile(file, { kind: 'env-file', path: file });
  }
  if (text) {
    const pem = !text.includes('\n') && text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
    return fromPem(pem, { kind: 'env-pem' });
  }
  return null;
}

/** Like resolveServerSigningIdentity, but fails closed with guidance when there is none. */
export function requireServerSigningIdentity(env: Env = process.env): SigningIdentity {
  const signer = resolveServerSigningIdentity(env);
  if (!signer) {
    throw new SigningIdentityError(SERVER_IDENTITY_GUIDANCE, 'SIGNING_IDENTITY_NOT_CONFIGURED');
  }
  return signer;
}

/** A short description of where an identity came from, for "Signing as ..." lines. */
export function describeIdentitySource(source: IdentitySource): string {
  switch (source.kind) {
    case 'flag':
      return `--identity ${source.path}`;
    case 'env-file':
      return `${IDENTITY_PEM_FILE_ENV}=${source.path}`;
    case 'env-pem':
      return IDENTITY_PEM_ENV;
    case 'dfx':
      return `dfx identity '${source.name}'`;
  }
}

// PKCS#8 v2 (RFC 5958) Ed25519 as older dfx releases wrote it: version 1, the
// Ed25519 algorithm, the 32-byte seed, then the public key in an explicit [1].
const DFX_V2_ED25519_PREFIX = Buffer.from('3053020101300506032b657004220420', 'hex');
const DFX_V2_ED25519_PUBLIC = Buffer.from('a123032100', 'hex');
const PKCS8_V1_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The key in a dfx PKCS#8 v2 Ed25519 block, or null when the block has any
 * other layout or its embedded public key does not belong to its seed.
 */
function legacyDfxEd25519(block: string): KeyObject | null {
  const base64 = block.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(base64, 'base64');
  const seedAt = DFX_V2_ED25519_PREFIX.length;
  const publicAt = seedAt + 32 + DFX_V2_ED25519_PUBLIC.length;
  if (
    der.length !== publicAt + 32 ||
    !der.subarray(0, seedAt).equals(DFX_V2_ED25519_PREFIX) ||
    !der.subarray(seedAt + 32, publicAt).equals(DFX_V2_ED25519_PUBLIC)
  ) {
    return null;
  }
  try {
    const keyObject = createPrivateKey({
      key: Buffer.concat([PKCS8_V1_ED25519_PREFIX, der.subarray(seedAt, seedAt + 32)]),
      format: 'der',
      type: 'pkcs8',
    });
    const x = keyObject.export({ format: 'jwk' }).x;
    return x && Buffer.from(x, 'base64url').equals(der.subarray(publicAt)) ? keyObject : null;
  } catch {
    return null;
  }
}

function invalid(message: string): SigningIdentityError {
  return new SigningIdentityError(message, 'SIGNING_IDENTITY_INVALID');
}

function fromPem(pem: string, source: IdentitySource): SigningIdentity {
  try {
    const { identity, keyType } = identityFromPem(pem);
    return { identity, principal: identity.getPrincipal().toText(), keyType, source };
  } catch (error) {
    if (error instanceof SigningIdentityError) {
      throw invalid(`${describeIdentitySource(source)}: ${error.message}`);
    }
    throw error;
  }
}

function fromPemFile(file: string, source: IdentitySource): SigningIdentity {
  let pem: string;
  try {
    pem = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : 'could not be read';
    throw invalid(`${describeIdentitySource(source)}: the file ${reason}`);
  }
  const signer = fromPem(pem, source);
  const warning = keyFileWarning(file);
  return warning ? { ...signer, warning } : signer;
}

/**
 * Why a key file is too open: readable or writable by its group or anyone
 * else. ssh refuses such a key; AgentVault loads it and says so, since a
 * mounted secret is often 0644 and refusing it would break a working setup.
 * Nothing on Windows, whose permissions are not POSIX mode bits.
 */
function keyFileWarning(file: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  let mode: number;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    return undefined;
  }
  if ((mode & 0o077) === 0) return undefined;
  return (
    `the key file ${file} is readable or writable by other users (mode ${(mode & 0o777).toString(8)}); ` +
    `restrict it with \`chmod 600 ${file}\``
  );
}

/**
 * dfx's selected identity, from its config directory: identity.json names it
 * ("default" when that file is missing) and identity/<name>/identity.pem holds
 * a plaintext key. Null when there is no such key file and nothing else in
 * the identity's directory says why (dfx not installed, or the anonymous
 * identity, which has no key).
 */
function fromDfx(dfxDir: string): SigningIdentity | null {
  let name = 'default';
  const configFile = path.join(dfxDir, 'identity.json');
  if (fs.existsSync(configFile)) {
    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    } catch {
      throw invalid(`dfx's ${configFile} is not valid JSON`);
    }
    const selected = (config as { default?: unknown } | null)?.default;
    if (typeof selected === 'string') name = selected;
  }

  if (name === 'anonymous') return null;

  try {
    sanitizePathPart(name);
  } catch {
    throw invalid(`dfx's ${configFile} selects an identity name AgentVault will not use as a path: ${JSON.stringify(name)}`);
  }

  const identityDir = path.join(dfxDir, 'identity', name);
  const pemFile = path.join(identityDir, 'identity.pem');
  const exportHint = `Export it with \`${exportKeyCommand(name)}\` and pass --identity ${exportedKeyPath(name)}.`;

  if (fs.existsSync(pemFile)) {
    return fromPemFile(pemFile, { kind: 'dfx', name, path: pemFile });
  }
  if (fs.existsSync(path.join(identityDir, 'identity.pem.encrypted'))) {
    throw invalid(`dfx identity '${name}' is password-protected, and AgentVault does not decrypt keys. ${exportHint}`);
  }
  if (fs.existsSync(path.join(identityDir, 'identity.json'))) {
    throw invalid(`dfx identity '${name}' keeps its key in the system keyring or a hardware module, which AgentVault cannot read. ${exportHint}`);
  }
  return null;
}

function expandHome(file: string, homeDir?: string): string {
  if (file === '~' || file.startsWith('~/')) {
    return path.join(homeDir || os.homedir(), file.slice(1));
  }
  return path.resolve(file);
}
