/**
 * Signing identities for memory_repo writes: PEM loading for the key types
 * dfx and icp-cli export, principal derivation, refusal of encrypted and
 * unsupported keys, and where the CLI and the webapp server look for a key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  identityFromPem,
  resolveCliSigningIdentity,
  requireCliSigningIdentity,
  resolveServerSigningIdentity,
  requireServerSigningIdentity,
  describeIdentitySource,
  SigningIdentityError,
  CLI_IDENTITY_GUIDANCE,
  SERVER_IDENTITY_GUIDANCE,
} from '../../src/canister/identity.js';
import { ed25519Key, secp256k1Key, principalText, writeDfxConfig } from '../fixtures/signing-identities.js';

/** The base64 body of a PEM, which must never appear in an error message. */
function pemBody(pem: string): string {
  return pem.split('\n').filter((line) => line && !line.startsWith('-----')).join('');
}

function expectIdentityError(fn: () => unknown, code: string, pattern: RegExp, pem?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SigningIdentityError);
  const error = caught as SigningIdentityError;
  expect(error.code).toBe(code);
  expect(error.message).toMatch(pattern);
  if (pem) {
    for (const chunk of pemBody(pem).match(/.{1,16}/g) ?? []) {
      expect(error.message).not.toContain(chunk);
    }
  }
}

describe('principal text (test helper)', () => {
  it('matches the spec examples', () => {
    expect(principalText(new Uint8Array([]))).toBe('aaaaa-aa');
    expect(principalText(new Uint8Array([0x04]))).toBe('2vxsx-fae');
  });
});

describe('identityFromPem', () => {
  it('loads an Ed25519 PKCS#8 key and signs as its self-authenticating principal', () => {
    const key = ed25519Key();
    const { identity, keyType } = identityFromPem(key.pem);
    expect(keyType).toBe('ed25519');
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('loads the PKCS#8 v2 Ed25519 keys older dfx releases wrote', () => {
    const key = ed25519Key({ legacyDfx: true });
    const { identity, keyType } = identityFromPem(key.pem);
    expect(keyType).toBe('ed25519');
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('refuses a dfx PKCS#8 v2 Ed25519 key whose embedded public key is not its own', () => {
    const key = ed25519Key({ legacyDfx: true });
    const other = ed25519Key({ legacyDfx: true });
    const der = Buffer.from(key.pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, ''), 'base64');
    const otherDer = Buffer.from(other.pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, ''), 'base64');
    const mixed = Buffer.concat([der.subarray(0, der.length - 32), otherDer.subarray(otherDer.length - 32)]);
    const pem = `-----BEGIN PRIVATE KEY-----\n${mixed.toString('base64')}\n-----END PRIVATE KEY-----\n`;
    let parsedByOpenSsl = true;
    try {
      createPrivateKey(pem);
    } catch {
      parsedByOpenSsl = false;
    }
    // OpenSSL 3.2+ (Node 22) accepts the block itself; older releases fall back to the seed-and-check path
    if (!parsedByOpenSsl) {
      expectIdentityError(() => identityFromPem(pem), 'SIGNING_IDENTITY_INVALID', /could not be parsed/i, pem);
    }
  });

  it('loads a secp256k1 SEC1 key ("BEGIN EC PRIVATE KEY")', () => {
    const key = secp256k1Key('sec1');
    expect(key.pem).toContain('BEGIN EC PRIVATE KEY');
    const { identity, keyType } = identityFromPem(key.pem);
    expect(keyType).toBe('secp256k1');
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('loads a secp256k1 key after an EC PARAMETERS block, as openssl ecparam -genkey writes', () => {
    const key = secp256k1Key('sec1');
    const params = '-----BEGIN EC PARAMETERS-----\nBgUrgQQACg==\n-----END EC PARAMETERS-----\n';
    const { identity } = identityFromPem(params + key.pem);
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('loads a secp256k1 PKCS#8 key', () => {
    const key = secp256k1Key('pkcs8');
    const { identity, keyType } = identityFromPem(key.pem);
    expect(keyType).toBe('secp256k1');
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('tolerates CRLF line endings and surrounding whitespace', () => {
    const key = ed25519Key();
    const { identity } = identityFromPem(`\n  ${key.pem.replace(/\n/g, '\r\n')}  \n`);
    expect(identity.getPrincipal().toText()).toBe(key.principal);
  });

  it('refuses an encrypted PKCS#8 key without echoing it', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).toString();
    expectIdentityError(() => identityFromPem(pem), 'SIGNING_IDENTITY_INVALID', /encrypted/i, pem);
  });

  it('refuses an encrypted SEC1 key (Proc-Type: 4,ENCRYPTED) without echoing it', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const pem = privateKey.export({ type: 'sec1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).toString();
    expect(pem).toContain('Proc-Type: 4,ENCRYPTED');
    expectIdentityError(() => identityFromPem(pem), 'SIGNING_IDENTITY_INVALID', /encrypted/i, pem);
  });

  it('refuses keys on other curves and algorithms', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    expectIdentityError(() => identityFromPem(p256), 'SIGNING_IDENTITY_INVALID', /Ed25519 or secp256k1/, p256);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expectIdentityError(() => identityFromPem(rsa), 'SIGNING_IDENTITY_INVALID', /Ed25519 or secp256k1/, rsa);
  });

  it('refuses text that holds no private key, and a corrupt key, without echoing it', () => {
    expectIdentityError(() => identityFromPem('not a pem'), 'SIGNING_IDENTITY_INVALID', /no private key/i);

    const publicPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expectIdentityError(() => identityFromPem(publicPem), 'SIGNING_IDENTITY_INVALID', /no private key/i);

    const corrupt = '-----BEGIN PRIVATE KEY-----\nTUlJQkFEQU5CZ2txaGtpRzl3MEJBUUVGQUFTQ0FUOEFNSUlCT2dJQkFBSkJBSzZh\n-----END PRIVATE KEY-----\n';
    expectIdentityError(() => identityFromPem(corrupt), 'SIGNING_IDENTITY_INVALID', /could not be parsed/i, corrupt);
  });
});

describe('resolveCliSigningIdentity', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-identity-'));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function pemFile(name: string, pem: string): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, pem, { mode: 0o600 });
    return file;
  }

  it('prefers --identity over the env var and dfx', () => {
    const flag = ed25519Key();
    const env = secp256k1Key();
    writeDfxConfig(home, 'default', { default: ed25519Key().pem });
    const flagFile = pemFile('flag.pem', flag.pem);

    const signer = resolveCliSigningIdentity({
      identityPath: flagFile,
      env: { AGENTVAULT_ICP_IDENTITY_PEM_FILE: pemFile('env.pem', env.pem) },
      homeDir: home,
    });

    expect(signer?.principal).toBe(flag.principal);
    expect(signer?.source).toEqual({ kind: 'flag', path: flagFile });
    expect(describeIdentitySource(signer!.source)).toBe(`--identity ${flagFile}`);
  });

  it('uses AGENTVAULT_ICP_IDENTITY_PEM_FILE over dfx', () => {
    const env = secp256k1Key();
    writeDfxConfig(home, 'default', { default: ed25519Key().pem });
    const envFile = pemFile('env.pem', env.pem);

    const signer = resolveCliSigningIdentity({ env: { AGENTVAULT_ICP_IDENTITY_PEM_FILE: envFile }, homeDir: home });

    expect(signer?.principal).toBe(env.principal);
    expect(signer?.keyType).toBe('secp256k1');
    expect(describeIdentitySource(signer!.source)).toBe(`AGENTVAULT_ICP_IDENTITY_PEM_FILE=${envFile}`);
  });

  it("falls back to dfx's selected identity", () => {
    const alice = secp256k1Key();
    writeDfxConfig(home, 'alice', { default: ed25519Key().pem, alice: alice.pem });

    const signer = resolveCliSigningIdentity({ env: {}, homeDir: home });

    expect(signer?.principal).toBe(alice.principal);
    expect(signer?.source).toMatchObject({ kind: 'dfx', name: 'alice' });
    expect(describeIdentitySource(signer!.source)).toBe("dfx identity 'alice'");
  });

  it("uses dfx's 'default' identity when identity.json is missing", () => {
    const key = ed25519Key();
    writeDfxConfig(home, undefined, { default: key.pem });

    expect(resolveCliSigningIdentity({ env: {}, homeDir: home })?.principal).toBe(key.principal);
  });

  it('honours DFX_CONFIG_ROOT', () => {
    const key = ed25519Key();
    const root = path.join(tmp, 'dfx-root');
    writeDfxConfig(root, 'default', { default: key.pem });

    expect(resolveCliSigningIdentity({ env: { DFX_CONFIG_ROOT: root }, homeDir: home })?.principal).toBe(key.principal);
  });

  it("returns null with nothing configured, and for dfx's anonymous identity", () => {
    expect(resolveCliSigningIdentity({ env: {}, homeDir: home })).toBeNull();

    writeDfxConfig(home, 'anonymous', {});
    expect(resolveCliSigningIdentity({ env: {}, homeDir: home })).toBeNull();
  });

  it('fails on a configured path that does not exist instead of falling through', () => {
    writeDfxConfig(home, 'default', { default: ed25519Key().pem });
    const missing = path.join(tmp, 'missing.pem');

    expectIdentityError(
      () => resolveCliSigningIdentity({ identityPath: missing, env: {}, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /--identity .*missing\.pem/,
    );
    expectIdentityError(
      () => resolveCliSigningIdentity({ env: { AGENTVAULT_ICP_IDENTITY_PEM_FILE: missing }, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /AGENTVAULT_ICP_IDENTITY_PEM_FILE/,
    );
  });

  it('explains that --identity takes a PEM path when given what looks like a dfx identity name', () => {
    expectIdentityError(
      () => resolveCliSigningIdentity({ identityPath: 'alice', env: {}, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /--identity takes the path of a PEM file[\s\S]*dfx identity use alice[\s\S]*dfx identity export alice/,
    );
  });

  it('explains a password-protected or keyring dfx identity', () => {
    const dfxDir = writeDfxConfig(home, 'locked', {});
    fs.mkdirSync(path.join(dfxDir, 'identity', 'locked'));
    fs.writeFileSync(path.join(dfxDir, 'identity', 'locked', 'identity.pem.encrypted'), 'ciphertext');
    expectIdentityError(
      () => resolveCliSigningIdentity({ env: {}, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /password-protected[\s\S]*dfx identity export locked/,
    );

    fs.writeFileSync(path.join(dfxDir, 'identity.json'), JSON.stringify({ default: 'kr' }));
    fs.mkdirSync(path.join(dfxDir, 'identity', 'kr'));
    fs.writeFileSync(path.join(dfxDir, 'identity', 'kr', 'identity.json'), JSON.stringify({ keyring_identity_suffix: 'kr' }));
    expectIdentityError(
      () => resolveCliSigningIdentity({ env: {}, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /keyring[\s\S]*dfx identity export kr/,
    );
  });

  it('refuses a dfx identity name that would leave the identity directory', () => {
    writeDfxConfig(home, '../../escape', {});
    expectIdentityError(
      () => resolveCliSigningIdentity({ env: {}, homeDir: home }),
      'SIGNING_IDENTITY_INVALID',
      /identity name/,
    );
  });

  it('requireCliSigningIdentity fails closed with guidance', () => {
    expectIdentityError(
      () => requireCliSigningIdentity({ env: {}, homeDir: home }),
      'SIGNING_IDENTITY_NOT_CONFIGURED',
      /anonymous[\s\S]*--identity[\s\S]*AGENTVAULT_ICP_IDENTITY_PEM_FILE[\s\S]*dfx identity use[\s\S]*agentvault memory authorize/,
    );
  });
});

describe('resolveServerSigningIdentity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-identity-server-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads AGENTVAULT_ICP_IDENTITY_PEM_FILE', () => {
    const key = secp256k1Key();
    const file = path.join(tmp, 'server.pem');
    fs.writeFileSync(file, key.pem);

    const signer = resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM_FILE: file });

    expect(signer?.principal).toBe(key.principal);
    expect(signer?.source).toEqual({ kind: 'env-file', path: file });
  });

  it('loads AGENTVAULT_ICP_IDENTITY_PEM text, including with escaped newlines', () => {
    const key = ed25519Key();
    expect(resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM: key.pem })?.principal).toBe(key.principal);

    const escaped = key.pem.trim().replace(/\n/g, '\\n');
    const signer = resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM: escaped });
    expect(signer?.principal).toBe(key.principal);
    expect(signer?.source).toEqual({ kind: 'env-pem' });
    expect(describeIdentitySource(signer!.source)).toBe('AGENTVAULT_ICP_IDENTITY_PEM');
  });

  it('refuses both variables at once', () => {
    const key = ed25519Key();
    const file = path.join(tmp, 'server.pem');
    fs.writeFileSync(file, key.pem);
    expectIdentityError(
      () => resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM_FILE: file, AGENTVAULT_ICP_IDENTITY_PEM: key.pem }),
      'SIGNING_IDENTITY_INVALID',
      /only one/,
    );
  });

  it('never reads the home directory or dfx', () => {
    const home = path.join(tmp, 'home');
    writeDfxConfig(home, 'default', { default: ed25519Key().pem });

    expect(resolveServerSigningIdentity({ HOME: home, DFX_CONFIG_ROOT: home })).toBeNull();
    expectIdentityError(
      () => requireServerSigningIdentity({ HOME: home }),
      'SIGNING_IDENTITY_NOT_CONFIGURED',
      /AGENTVAULT_ICP_IDENTITY_PEM_FILE[\s\S]*AGENTVAULT_ICP_IDENTITY_PEM[\s\S]*agentvault memory authorize/,
    );
  });

  it('refuses an encrypted PEM from the environment without echoing it', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }).toString();
    expectIdentityError(
      () => resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM: pem }),
      'SIGNING_IDENTITY_INVALID',
      /AGENTVAULT_ICP_IDENTITY_PEM[\s\S]*encrypted/i,
      pem,
    );
  });
});

describe('keys AgentVault cannot sign with', () => {
  /** A secp256k1 SEC1 key with the private scalar d, which may be outside [1, n-1]. */
  function secp256k1Scalar(d: bigint): string {
    const der = Buffer.concat([
      Buffer.from('302e0201010420', 'hex'),
      Buffer.from(d.toString(16).padStart(64, '0'), 'hex'),
      Buffer.from('a00706052b8104000a', 'hex'),
    ]);
    return `-----BEGIN EC PRIVATE KEY-----\n${der.toString('base64')}\n-----END EC PRIVATE KEY-----\n`;
  }
  const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

  it.each([
    ['an EC key on brainpoolP256r1', () => generateKeyPairSync('ec', { namedCurve: 'brainpoolP256r1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString()],
    ['an EC key on secp112r1', () => generateKeyPairSync('ec', { namedCurve: 'secp112r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    ['a DSA key', () => generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    // @types/node has no overload for 'dh', which node:crypto generates all the same
    ['a DH key', () => (generateKeyPairSync as unknown as (type: string, options: object) => { privateKey: KeyObject })('dh', { group: 'modp14' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
  ])('refuses %s as unsupported, without echoing it', (_name, makePem) => {
    const pem = makePem();
    expectIdentityError(() => identityFromPem(pem), 'SIGNING_IDENTITY_INVALID', /Ed25519 or secp256k1/, pem);
  });

  it.each([
    ['0', 0n],
    ['n', N],
    ['n + 1', N + 1n],
  ])('refuses a secp256k1 key whose scalar is %s, without echoing it', (_name, d) => {
    const pem = secp256k1Scalar(d);
    expectIdentityError(() => identityFromPem(pem), 'SIGNING_IDENTITY_INVALID', /could not be used/, pem);
  });

  it('accepts the smallest valid secp256k1 scalar', () => {
    expect(identityFromPem(secp256k1Scalar(1n)).keyType).toBe('secp256k1');
  });
});

describe.skipIf(process.platform === 'win32')('key files other users can read', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-identity-mode-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function keyFile(mode: number): string {
    const file = path.join(tmp, `key-${mode.toString(8)}.pem`);
    fs.writeFileSync(file, ed25519Key().pem);
    fs.chmodSync(file, mode);
    return file;
  }

  it('load, with a warning that names the file and says to chmod 600', () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      const file = keyFile(mode);
      const fromFlag = resolveCliSigningIdentity({ identityPath: file, env: {}, homeDir: tmp });
      expect(fromFlag?.warning, mode.toString(8)).toMatch(/readable or writable by other users/);
      expect(fromFlag?.warning).toContain(`chmod 600 ${file}`);

      const fromServerEnv = resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM_FILE: file });
      expect(fromServerEnv?.warning).toContain(`chmod 600 ${file}`);
    }
  });

  it('owner-only files, dfx identities and PEM text load without one', () => {
    expect(resolveCliSigningIdentity({ identityPath: keyFile(0o600), env: {}, homeDir: tmp })?.warning).toBeUndefined();
    expect(resolveCliSigningIdentity({ identityPath: keyFile(0o400), env: {}, homeDir: tmp })?.warning).toBeUndefined();
    writeDfxConfig(tmp, 'alice', { alice: ed25519Key().pem });
    expect(resolveCliSigningIdentity({ env: {}, homeDir: tmp })?.warning).toBeUndefined();
    expect(resolveServerSigningIdentity({ AGENTVAULT_ICP_IDENTITY_PEM: ed25519Key().pem })?.warning).toBeUndefined();
  });
});

describe('where AgentVault tells people to export a key', () => {
  it('is outside the working tree, created owner-only', () => {
    for (const guidance of [CLI_IDENTITY_GUIDANCE, SERVER_IDENTITY_GUIDANCE]) {
      expect(guidance).toContain('umask 077');
      expect(guidance).toContain('~/.config/agentvault/');
      expect(guidance).not.toMatch(/> ?[\w<>-]+\.pem/);
    }
  });

  it('in the hints for a dfx identity AgentVault cannot read', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-identity-hint-'));
      const dfxDir = writeDfxConfig(tmp, 'kr', {});
      fs.mkdirSync(path.join(dfxDir, 'identity', 'kr'));
      fs.writeFileSync(path.join(dfxDir, 'identity', 'kr', 'identity.json'), '{}');
      for (const attempt of [
        () => resolveCliSigningIdentity({ env: {}, homeDir: tmp }),
        () => resolveCliSigningIdentity({ identityPath: 'alice', env: {}, homeDir: tmp }),
      ]) {
        expectIdentityError(attempt, 'SIGNING_IDENTITY_INVALID', /umask 077[\s\S]*~\/\.config\/agentvault\//);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('and the repository and new projects ignore PEM files', () => {
    const ignored = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8').split('\n');
    expect(ignored).toContain('*.pem');
  });
});
