/**
 * Throwaway signing keys for the memory_repo signing tests, generated with
 * node:crypto in the formats dfx and icp-cli export, and the principal each
 * key should sign as, computed here without @dfinity/* so the identity
 * module is checked against an independent derivation.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestKey {
  /** The private key as PEM text. */
  pem: string;
  /** The self-authenticating principal of the key, as text. */
  principal: string;
}

/**
 * An Ed25519 key in PKCS#8 ("BEGIN PRIVATE KEY"). `legacyDfx` writes the
 * PKCS#8 v2 form older dfx releases used, with the public key appended.
 */
export function ed25519Key(options: { legacyDfx?: boolean } = {}): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const principal = principalOfPublicKey(publicKey);
  if (!options.legacyDfx) {
    return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), principal };
  }
  const jwk = privateKey.export({ format: 'jwk' });
  const der = Buffer.concat([
    Buffer.from('3053020101300506032b657004220420', 'hex'),
    Buffer.from(jwk.d!, 'base64url'),
    Buffer.from('a123032100', 'hex'),
    Buffer.from(jwk.x!, 'base64url'),
  ]);
  return { pem: `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`, principal };
}

/**
 * A secp256k1 key in SEC1 ("BEGIN EC PRIVATE KEY"), the form dfx writes for
 * new identities, or in PKCS#8 ("BEGIN PRIVATE KEY").
 */
export function secp256k1Key(format: 'sec1' | 'pkcs8' = 'sec1'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return {
    pem: privateKey.export({ type: format, format: 'pem' }).toString(),
    principal: principalOfPublicKey(publicKey),
  };
}

/**
 * The self-authenticating principal of a public key, per the IC interface
 * spec: SHA-224 of the DER-encoded (SubjectPublicKeyInfo) key, then 0x02.
 */
export function principalOfPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const hash = createHash('sha224').update(der).digest();
  return principalText(new Uint8Array([...hash, 0x02]));
}

/**
 * The textual form of a principal: CRC-32 of the bytes (big-endian) followed
 * by the bytes, base32 (RFC 4648, lowercase, unpadded), in dash-separated
 * groups of five.
 */
export function principalText(bytes: Uint8Array): string {
  const crc = crc32(bytes);
  const data = new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff, ...bytes]);
  return base32(data).match(/.{1,5}/g)!.join('-');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Lay out a dfx config directory under `home`: identity.json selecting
 * `selected` (omitted when undefined) and identity/<name>/identity.pem for
 * each entry of `identities`.
 */
export function writeDfxConfig(
  home: string,
  selected: string | undefined,
  identities: Record<string, string>,
): string {
  const dfxDir = path.join(home, '.config', 'dfx');
  fs.mkdirSync(path.join(dfxDir, 'identity'), { recursive: true });
  if (selected !== undefined) {
    fs.writeFileSync(path.join(dfxDir, 'identity.json'), JSON.stringify({ default: selected }));
  }
  for (const [name, pem] of Object.entries(identities)) {
    const dir = path.join(dfxDir, 'identity', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.pem'), pem, { mode: 0o600 });
  }
  return dfxDir;
}
