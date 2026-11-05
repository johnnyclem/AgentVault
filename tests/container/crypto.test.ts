/**
 * AVENC1 crypto: round trips, tamper detection on every region, downgrade
 * rejection BEFORE key derivation, no plaintext left behind on failure, and an
 * independent implementation of the spec built from node:crypto alone.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AVENC_MAGIC,
  KDF_ITERATIONS_DEFAULT,
  KDF_ITERATIONS_MAX,
  KDF_ITERATIONS_MIN,
  MAX_HEADER_BYTES,
  assertPassphrase,
  decryptBuffer,
  decryptFile,
  encryptBuffer,
  encryptFile,
  internals,
  validateHeader,
} from '../../src/container/crypto.js';
import { ContainerError } from '../../src/container/types.js';

const PASS = 'correct horse battery staple';
const INTEGRITY_MESSAGE = 'wrong passphrase or the file was modified';

let work: string;
let counter = 0;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-crypto-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function p(name: string): string {
  counter += 1;
  return path.join(work, `${counter}-${name}`);
}

function write(name: string, data: Buffer | string): string {
  const file = p(name);
  fs.writeFileSync(file, data);
  return file;
}

async function expectIntegrity(promise: Promise<unknown>): Promise<ContainerError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContainerError);
  const ce = err as ContainerError;
  expect(ce.code).toBe('INTEGRITY');
  expect(ce.message).toBe(INTEGRITY_MESSAGE);
  return ce;
}

interface Layout {
  headerLength: number;
  headerStart: number;
  ciphertextStart: number;
  tagStart: number;
  saltAt: number;
  ivAt: number;
}

function layoutOf(blob: Buffer): Layout {
  const headerLength = blob.readUInt32BE(7);
  const headerStart = 11;
  const header = JSON.parse(blob.subarray(headerStart, headerStart + headerLength).toString('utf8')) as {
    salt: string;
    iv: string;
  };
  return {
    headerLength,
    headerStart,
    ciphertextStart: headerStart + headerLength,
    tagStart: blob.length - 16,
    saltAt: blob.indexOf(Buffer.from(header.salt), headerStart) + 3,
    ivAt: blob.indexOf(Buffer.from(header.iv), headerStart) + 3,
  };
}

function flip(blob: Buffer, at: number): Buffer {
  const copy = Buffer.from(blob);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

/** Re-assemble a blob with a replacement header object, keeping the old ciphertext and tag. */
function withHeader(blob: Buffer, mutate: (h: Record<string, unknown>) => void): Buffer {
  const l = layoutOf(blob);
  const header = JSON.parse(blob.subarray(l.headerStart, l.ciphertextStart).toString('utf8')) as Record<string, unknown>;
  mutate(header);
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([AVENC_MAGIC, len, json, blob.subarray(l.ciphertextStart)]);
}

describe('assertPassphrase', () => {
  it('accepts 8+ characters', () => {
    expect(() => assertPassphrase('12345678')).not.toThrow();
  });

  it.each([['short'], [''], ['1234567']])('rejects %j', (value) => {
    expect(() => assertPassphrase(value)).toThrow(ContainerError);
  });

  it('rejects non-strings and never echoes the value', () => {
    expect(() => assertPassphrase(12345678)).toThrow(ContainerError);
    expect(() => assertPassphrase(undefined)).toThrow(ContainerError);
    try {
      assertPassphrase('hunter2');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});

describe('round trips', () => {
  const sizes: Array<[string, number]> = [
    ['empty', 0],
    ['1 byte', 1],
    ['5 MB', 5 * 1024 * 1024],
  ];

  it.each(sizes)('file: %s', async (_label, size) => {
    const plain = crypto.randomBytes(size);
    const src = write('plain', plain);
    const enc = p('enc');
    const dec = p('dec');

    const encrypted = await encryptFile(src, enc, PASS);
    const decrypted = await decryptFile(enc, dec, PASS);

    const sha = crypto.createHash('sha256').update(plain).digest('hex');
    expect(fs.readFileSync(dec).equals(plain)).toBe(true);
    expect(encrypted.plaintextSha256).toBe(sha);
    expect(encrypted.plaintextBytes).toBe(size);
    expect(decrypted.plaintextSha256).toBe(sha);
    expect(decrypted.plaintextBytes).toBe(size);

    const blob = fs.readFileSync(enc);
    expect(encrypted.ciphertextBytes).toBe(blob.length);
    expect(encrypted.ciphertextSha256).toBe(crypto.createHash('sha256').update(blob).digest('hex'));
    // prefix + same-length ciphertext + 16-byte tag
    expect(blob.length).toBe(layoutOf(blob).ciphertextStart + size + 16);
  });

  it.each(sizes.slice(0, 2))('buffer: %s', async (_label, size) => {
    const plain = crypto.randomBytes(size);
    const blob = await encryptBuffer(plain, PASS);
    expect((await decryptBuffer(blob, PASS)).equals(plain)).toBe(true);
  });

  it('buffer and file formats are interchangeable', async () => {
    const plain = Buffer.from('shared format');
    const enc = p('enc');
    fs.writeFileSync(enc, await encryptBuffer(plain, PASS));
    const dec = p('dec');
    await decryptFile(enc, dec, PASS);
    expect(fs.readFileSync(dec).equals(plain)).toBe(true);
  });

  it('writes the documented layout and does not contain the plaintext', async () => {
    const canary = 'CANARY-PLAINTEXT-d41d8cd98f00b204e9800998ecf8427e';
    const blob = await encryptBuffer(Buffer.from(canary), PASS);
    expect(blob.subarray(0, 7).toString('latin1')).toBe('AVENC1\n');
    expect(blob.includes(Buffer.from(canary))).toBe(false);
    const l = layoutOf(blob);
    const header = JSON.parse(blob.subarray(l.headerStart, l.ciphertextStart).toString('utf8')) as Record<string, unknown>;
    expect(header).toMatchObject({ v: 1, alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iter: KDF_ITERATIONS_DEFAULT });
    expect(Buffer.from(header['salt'] as string, 'base64')).toHaveLength(32);
    expect(Buffer.from(header['iv'] as string, 'base64')).toHaveLength(12);
  });

  it('two encryptions of the same input differ (fresh salt and IV)', async () => {
    const plain = Buffer.from('same input');
    const a = await encryptBuffer(plain, PASS);
    const b = await encryptBuffer(plain, PASS);
    expect(a.equals(b)).toBe(false);
    const la = layoutOf(a);
    const lb = layoutOf(b);
    const ha = JSON.parse(a.subarray(la.headerStart, la.ciphertextStart).toString()) as { salt: string; iv: string };
    const hb = JSON.parse(b.subarray(lb.headerStart, lb.ciphertextStart).toString()) as { salt: string; iv: string };
    expect(ha.salt).not.toBe(hb.salt);
    expect(ha.iv).not.toBe(hb.iv);

    const src = write('plain', plain);
    const e1 = p('e1');
    const e2 = p('e2');
    await encryptFile(src, e1, PASS);
    await encryptFile(src, e2, PASS);
    expect(fs.readFileSync(e1).equals(fs.readFileSync(e2))).toBe(false);
  });

  it.each([[0o000], [0o277]])('writes the ciphertext file with mode 0600 under umask %o', async (mask) => {
    const old = process.umask(mask);
    try {
      const src = write('plain', 'x');
      const enc = p('enc');
      await encryptFile(src, enc, PASS);
      expect(fs.statSync(enc).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  it.each([[0o000], [0o277]])('writes the decrypted spool with mode 0600 under umask %o', async (mask) => {
    const enc = p('enc');
    fs.writeFileSync(enc, await encryptBuffer(Buffer.from('secret-ish'), PASS));
    const dec = p('dec');
    const old = process.umask(mask);
    try {
      await decryptFile(enc, dec, PASS);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(dec).mode & 0o777).toBe(0o600);
  });
});

describe('tamper and truncation detection', () => {
  const plain = crypto.randomBytes(3000);
  let blob: Buffer;
  let l: Layout;

  beforeAll(async () => {
    blob = await encryptBuffer(plain, PASS);
    l = layoutOf(blob);
  });

  async function decryptBlob(data: Buffer): Promise<string> {
    const dec = p('dec');
    await decryptFile(write('enc', data), dec, PASS);
    return dec;
  }

  const regions: Array<[string, () => number]> = [
    ['magic', () => 2],
    ['header length field', () => 9],
    ['header json (iter digits)', () => l.headerStart + 40],
    ['salt', () => l.saltAt],
    ['iv', () => l.ivAt],
    ['ciphertext (first byte)', () => l.ciphertextStart],
    ['ciphertext (last byte)', () => l.tagStart - 1],
    ['auth tag (first byte)', () => l.tagStart],
    ['auth tag (last byte)', () => blob.length - 1],
  ];

  it.each(regions)('flipping one byte in the %s -> INTEGRITY (file)', async (_label, at) => {
    const enc = write('enc', flip(blob, at()));
    const dec = p('dec');
    await expectIntegrity(decryptFile(enc, dec, PASS));
    expect(fs.existsSync(dec)).toBe(false);
  });

  it.each(regions)('flipping one byte in the %s -> INTEGRITY (buffer)', async (_label, at) => {
    await expectIntegrity(decryptBuffer(flip(blob, at()), PASS));
  });

  it('the untouched blob still decrypts (control for the flips above)', async () => {
    const dec = await decryptBlob(blob);
    expect(fs.readFileSync(dec).equals(plain)).toBe(true);
  });

  const cuts: Array<[string, () => number]> = [
    ['0 bytes', () => 0],
    ['inside the magic', () => 4],
    ['inside the length field', () => 9],
    ['mid header', () => l.headerStart + 20],
    ['at the end of the header', () => l.ciphertextStart],
    ['one byte into the ciphertext', () => l.ciphertextStart + 1],
    ['mid ciphertext', () => l.ciphertextStart + 1500],
    ['tag removed entirely', () => l.tagStart],
    ['one byte short of the tag', () => blob.length - 1],
    ['one byte of tag left', () => l.tagStart + 1],
  ];

  it.each(cuts)('truncated %s -> INTEGRITY and no spool (file)', async (_label, at) => {
    const enc = write('enc', blob.subarray(0, at()));
    const dec = p('dec');
    await expectIntegrity(decryptFile(enc, dec, PASS));
    expect(fs.existsSync(dec)).toBe(false);
  });

  it.each(cuts)('truncated %s -> INTEGRITY (buffer)', async (_label, at) => {
    await expectIntegrity(decryptBuffer(blob.subarray(0, at()), PASS));
  });

  it('appended bytes are rejected (the tag is read from the end)', async () => {
    await expectIntegrity(decryptBuffer(Buffer.concat([blob, Buffer.from([0])]), PASS));
    const enc = write('enc', Buffer.concat([blob, Buffer.from([0])]));
    await expectIntegrity(decryptFile(enc, p('dec'), PASS));
  });

  it('a wrong passphrase gives the same error as tampering', async () => {
    const enc = write('enc', blob);
    const dec = p('dec');
    const fileErr = await expectIntegrity(decryptFile(enc, dec, 'a different passphrase'));
    const bufErr = await expectIntegrity(decryptBuffer(blob, 'a different passphrase'));
    expect(fs.existsSync(dec)).toBe(false);
    // not distinguishable: no `reason` that says "passphrase"
    expect(fileErr.details).toBeUndefined();
    expect(bufErr.details).toBeUndefined();
    const tamperErr = await expectIntegrity(decryptBuffer(flip(blob, l.tagStart), PASS));
    expect(tamperErr.message).toBe(fileErr.message);
    expect(tamperErr.details).toBeUndefined();
  });

  it('removes the already-written plaintext when only the final tag check fails (multi-chunk file)', async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const src = write('big', big);
    const enc = p('big-enc');
    await encryptFile(src, enc, PASS);
    const bytes = fs.readFileSync(enc);
    // Corrupt the LAST tag byte: every ciphertext chunk decrypts and is written
    // before the failure is known, which is exactly the audit C-1 hazard.
    fs.writeFileSync(enc, flip(bytes, bytes.length - 1));
    const dec = p('big-dec');
    await expectIntegrity(decryptFile(enc, dec, PASS));
    expect(fs.existsSync(dec)).toBe(false);
  });

  it('never deletes a pre-existing destination it did not create', async () => {
    const dec = write('precious', 'do not delete');
    const enc = write('enc', flip(blob, l.tagStart));
    const err = await decryptFile(enc, dec, PASS).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ContainerError);
    expect((err as ContainerError).code).toBe('INVALID_INPUT');
    expect(fs.readFileSync(dec, 'utf8')).toBe('do not delete');
  });

  it('refuses to follow a symlink planted at the destination', async () => {
    const target = write('victim', 'victim contents');
    const dec = p('link');
    fs.symlinkSync(target, dec);
    const enc = write('enc', blob);
    await expect(decryptFile(enc, dec, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fs.readFileSync(target, 'utf8')).toBe('victim contents');
  });
});

describe('hostile headers are rejected BEFORE key derivation', () => {
  let blob: Buffer;

  beforeAll(async () => {
    blob = await encryptBuffer(Buffer.from('payload'), PASS);
  });

  const hostile: Array<[string, (h: Record<string, unknown>) => void]> = [
    ['iterations downgraded to 1', (h) => (h['iter'] = 1)],
    ['iterations one below the minimum', (h) => (h['iter'] = KDF_ITERATIONS_MIN - 1)],
    ['iterations one above the maximum', (h) => (h['iter'] = KDF_ITERATIONS_MAX + 1)],
    ['iterations huge (DoS)', (h) => (h['iter'] = 4_000_000_000)],
    ['iterations beyond safe integer', (h) => (h['iter'] = 1e300)],
    ['iterations as a string', (h) => (h['iter'] = '210000')],
    ['iterations fractional', (h) => (h['iter'] = 210000.5)],
    ['iterations negative', (h) => (h['iter'] = -5)],
    ['algorithm changed', (h) => (h['alg'] = 'aes-128-cbc')],
    ['algorithm changed to gcm-128', (h) => (h['alg'] = 'aes-128-gcm')],
    ['kdf changed', (h) => (h['kdf'] = 'none')],
    ['kdf changed to scrypt', (h) => (h['kdf'] = 'scrypt')],
    ['version bumped', (h) => (h['v'] = 2)],
    ['version as a string', (h) => (h['v'] = '1')],
    ['unknown extra key', (h) => (h['extra'] = 1)],
    ['salt removed', (h) => delete h['salt']],
    ['salt too short', (h) => (h['salt'] = Buffer.alloc(16).toString('base64'))],
    ['salt not base64', (h) => (h['salt'] = '!!!not base64!!!')],
    // 32 zero bytes encode as "AAAA...A="; a trailing "B=" decodes to the same bytes but is not canonical
    ['salt non-canonical base64', (h) => (h['salt'] = `${Buffer.alloc(32).toString('base64').slice(0, -2)}B=`)],
    ['iv wrong length', (h) => (h['iv'] = Buffer.alloc(16).toString('base64'))],
    ['iv as a number', (h) => (h['iv'] = 7)],
  ];

  it.each(hostile)('%s', async (_label, mutate) => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const forged = withHeader(blob, mutate);
    await expectIntegrity(decryptBuffer(forged, PASS));
    await expectIntegrity(decryptFile(write('forged', forged), p('dec'), PASS));
    expect(spy).not.toHaveBeenCalled();
  });

  it('a header that is not JSON is rejected before derivation', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const json = Buffer.from('{"v":1,');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length, 0);
    const forged = Buffer.concat([AVENC_MAGIC, len, json, Buffer.alloc(40)]);
    await expectIntegrity(decryptBuffer(forged, PASS));
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['over the cap', MAX_HEADER_BYTES + 1],
    ['4 GiB - 1', 0xffffffff],
  ])('header length %s is rejected before derivation', async (_label, length) => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(length, 0);
    const forged = Buffer.concat([AVENC_MAGIC, len, Buffer.alloc(5000)]);
    await expectIntegrity(decryptBuffer(forged, PASS));
    await expectIntegrity(decryptFile(write('forged', forged), p('dec'), PASS));
    expect(spy).not.toHaveBeenCalled();
  });

  it('a header just over the 4 KiB cap is rejected before derivation, even if it is valid JSON', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const l = layoutOf(blob);
    const json = blob.subarray(l.headerStart, l.ciphertextStart).toString('utf8');
    const padded = (size: number): Buffer => {
      const body = Buffer.from(json + ' '.repeat(size - json.length), 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length, 0);
      return Buffer.concat([AVENC_MAGIC, len, body, blob.subarray(l.ciphertextStart)]);
    };
    await expectIntegrity(decryptBuffer(padded(MAX_HEADER_BYTES + 1), PASS));
    await expectIntegrity(decryptFile(write('big-header', padded(MAX_HEADER_BYTES + 1)), p('dec'), PASS));
    expect(spy).not.toHaveBeenCalled();
    // exactly at the cap it is structurally acceptable (and then fails authentication, because the AAD changed)
    await expectIntegrity(decryptBuffer(padded(MAX_HEADER_BYTES), PASS));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a wrong magic is rejected before derivation (buffer and file)', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const forged = Buffer.from(blob);
    forged[0] = 0x58; // "XVENC1\n"
    await expectIntegrity(decryptBuffer(forged, PASS));
    await expectIntegrity(decryptFile(write('bad-magic', forged), p('dec'), PASS));
    expect(spy).not.toHaveBeenCalled();
  });

  it('a file that is not AVENC1 at all is rejected before derivation', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    await expectIntegrity(decryptFile(write('plain', Buffer.alloc(200, 0x41)), p('dec'), PASS));
    expect(spy).not.toHaveBeenCalled();
  });

  it('control: a genuine file DOES derive a key (so the spy assertions above are meaningful)', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    await decryptBuffer(blob, PASS);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a header with iterations at the bounds is structurally valid', () => {
    const base = {
      v: 1,
      alg: 'aes-256-gcm',
      kdf: 'pbkdf2-sha256',
      iter: KDF_ITERATIONS_MIN,
      salt: Buffer.alloc(32).toString('base64'),
      iv: Buffer.alloc(12).toString('base64'),
    };
    expect(validateHeader(base).iterations).toBe(KDF_ITERATIONS_MIN);
    expect(validateHeader({ ...base, iter: KDF_ITERATIONS_MAX }).iterations).toBe(KDF_ITERATIONS_MAX);
    expect(() => validateHeader({ ...base, iter: KDF_ITERATIONS_MIN - 1 })).toThrow(ContainerError);
    expect(() => validateHeader({ ...base, iter: KDF_ITERATIONS_MAX + 1 })).toThrow(ContainerError);
    expect(() => validateHeader(null)).toThrow(ContainerError);
    expect(() => validateHeader([])).toThrow(ContainerError);
  });

  it('encryption refuses out-of-range iterations before derivation', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    await expect(encryptBuffer(Buffer.from('x'), PASS, { iterations: 1000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(encryptBuffer(Buffer.from('x'), PASS, { iterations: KDF_ITERATIONS_MAX + 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(encryptFile(write('plain', 'x'), p('enc'), PASS, { iterations: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a short passphrase is refused before derivation, without echoing it', async () => {
    const spy = vi.spyOn(internals, 'deriveKey');
    const err = await encryptBuffer(Buffer.from('x'), 'tiny').then(
      () => undefined,
      (e: unknown) => e as ContainerError
    );
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).not.toContain('tiny');
    await expect(decryptBuffer(blob, 'tiny')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('file edge cases', () => {
  it('leaves no stray temp file when the source is missing', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'clean-'));
    await expect(encryptFile(path.join(dir, 'missing'), path.join(dir, 'out.enc'), PASS)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses a directory as the source', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'dir-'));
    await expect(encryptFile(dir, p('enc'), PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses to encrypt a file onto itself', async () => {
    const f = write('self', 'x');
    await expect(encryptFile(f, f, PASS)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fs.readFileSync(f, 'utf8')).toBe('x');
  });

  it('only renames the ciphertext into place when it is complete', async () => {
    const dir = fs.mkdtempSync(path.join(work, 'atomic-'));
    const src = path.join(dir, 'plain');
    fs.writeFileSync(src, crypto.randomBytes(1024));
    await encryptFile(src, path.join(dir, 'out.enc'), PASS);
    expect(fs.readdirSync(dir).sort()).toEqual(['out.enc', 'plain']);
  });
});

describe('independent reference implementation (the format is implementable from the spec)', () => {
  function referenceEncrypt(plaintext: Buffer, passphrase: string): Buffer {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(passphrase, salt, 210000, 32, 'sha256');
    const header = Buffer.from(
      JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iter: 210000, salt: salt.toString('base64'), iv: iv.toString('base64') })
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const prefix = Buffer.concat([Buffer.from('AVENC1\n', 'latin1'), length, header]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(prefix);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([prefix, body, cipher.getAuthTag()]);
  }

  function referenceDecrypt(blob: Buffer, passphrase: string): Buffer {
    const headerLength = blob.readUInt32BE(7);
    const prefix = blob.subarray(0, 11 + headerLength);
    const header = JSON.parse(blob.subarray(11, 11 + headerLength).toString('utf8')) as {
      iter: number;
      salt: string;
      iv: string;
    };
    const key = crypto.pbkdf2Sync(passphrase, Buffer.from(header.salt, 'base64'), header.iter, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(prefix);
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([decipher.update(blob.subarray(prefix.length, blob.length - 16)), decipher.final()]);
  }

  it('decrypts a file built with node:crypto directly (buffer and file APIs)', async () => {
    const plain = crypto.randomBytes(100_000);
    const built = referenceEncrypt(plain, PASS);
    expect((await decryptBuffer(built, PASS)).equals(plain)).toBe(true);
    const dec = p('dec');
    const result = await decryptFile(write('ref.enc', built), dec, PASS);
    expect(fs.readFileSync(dec).equals(plain)).toBe(true);
    expect(result.plaintextSha256).toBe(crypto.createHash('sha256').update(plain).digest('hex'));
  });

  it('our output decrypts with node:crypto directly', async () => {
    const plain = crypto.randomBytes(70_000);
    const enc = p('enc');
    await encryptFile(write('plain', plain), enc, PASS);
    expect(referenceDecrypt(fs.readFileSync(enc), PASS).equals(plain)).toBe(true);
    expect(referenceDecrypt(await encryptBuffer(plain, PASS), PASS).equals(plain)).toBe(true);
  });

  it('a reference file with the wrong AAD (header not bound) is rejected', async () => {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(PASS, salt, 210000, 32, 'sha256');
    const header = Buffer.from(
      JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iter: 210000, salt: salt.toString('base64'), iv: iv.toString('base64') })
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const prefix = Buffer.concat([Buffer.from('AVENC1\n', 'latin1'), length, header]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); // no setAAD
    const body = Buffer.concat([cipher.update(Buffer.from('x')), cipher.final()]);
    const unbound = Buffer.concat([prefix, body, cipher.getAuthTag()]);
    await expectIntegrity(decryptBuffer(unbound, PASS));
  });
});
