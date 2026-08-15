/**
 * VetKeys Bundle Encryption — Round-trip and secret-based key tests
 *
 * Acceptance criteria:
 *   1. Round-trip encrypt → decrypt on a sample bundle returns the original
 *   2. Encryption requires a secret; the bundle cannot be decrypted without it
 *   3. The principal is bound in as context (different principals ≠ same key)
 *   4. isVetKeysEncryptedBundle correctly detects encrypted vs. plaintext
 *   5. decryptBundle rejects principal mismatch when enforced
 *   6. Legacy v1 bundles remain decryptable so old data can be recovered
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import {
  encryptBundleWithVetKeys,
  decryptBundle,
  isVetKeysEncryptedBundle,
  BUNDLE_SECRET_ENV_VAR,
} from '../../src/security/vetkeys.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const OTHER_PRINCIPAL = 'aaaaa-aa';

const SECRET = 'correct horse battery staple';
const OTHER_SECRET = 'a different secret entirely';

const SAMPLE_BUNDLE = Buffer.from(
  JSON.stringify({
    $schema: 'https://agentvault.dev/schemas/agent-state-v1.0.0.json',
    version: '1.0.0',
    agent: { name: 'test-agent', type: 'generic' },
    metadata: { createdAt: '2025-01-01T00:00:00.000Z', sourcePath: '/tmp/test', encrypted: true },
    state: {
      initialized: true,
      data: {
        memories: [{ id: 'm1', type: 'fact', content: 'hello world', timestamp: 1, importance: 1 }],
        tasks: [],
        context: {},
      },
    },
  }),
);

/**
 * Build a legacy v1 bundle the way pre-fix releases did: magic `VKEB`, with the
 * key derived from nothing but the (public) principal and the stored salt.
 */
function makeLegacyV1Bundle(plaintext: Buffer, principalId: string): Buffer {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(
    principalId,
    Buffer.concat([salt, Buffer.from('agentvault-vetkeys-bundle-v1')]),
    210_000,
    32,
    'sha256',
  );

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const principalBuf = Buffer.from(principalId, 'utf-8');
  const principalLenBuf = Buffer.alloc(4);
  principalLenBuf.writeUInt32BE(principalBuf.length, 0);

  return Buffer.concat([
    Buffer.from('VKEB'),
    salt,
    iv,
    authTag,
    principalLenBuf,
    principalBuf,
    ciphertext,
  ]);
}

afterEach(() => {
  delete process.env[BUNDLE_SECRET_ENV_VAR];
  vi.restoreAllMocks();
});

// ─── Scenario 1: Round-trip encrypt / decrypt ─────────────────────────────────

describe('Round-trip encrypt / decrypt', () => {
  it('returns the original plaintext after encrypt → decrypt', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    const decrypted = await decryptBundle(encrypted, undefined, SECRET);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });

  it('works with an empty buffer', async () => {
    const empty = Buffer.alloc(0);
    const encrypted = await encryptBundleWithVetKeys(empty, SAMPLE_PRINCIPAL, SECRET);
    const decrypted = await decryptBundle(encrypted, undefined, SECRET);

    expect(decrypted.length).toBe(0);
  });

  it('works with a large buffer (1 MB random data)', async () => {
    const large = crypto.randomBytes(1024 * 1024);
    const encrypted = await encryptBundleWithVetKeys(large, SAMPLE_PRINCIPAL, SECRET);
    const decrypted = await decryptBundle(encrypted, undefined, SECRET);

    expect(decrypted.equals(large)).toBe(true);
  });

  it('produces different ciphertexts for the same plaintext (random IV/salt)', async () => {
    const a = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    const b = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    // Both decrypt to the same thing
    expect((await decryptBundle(a, undefined, SECRET)).equals(SAMPLE_BUNDLE)).toBe(true);
    expect((await decryptBundle(b, undefined, SECRET)).equals(SAMPLE_BUNDLE)).toBe(true);

    // But the encrypted representations differ
    expect(a.equals(b)).toBe(false);
  });

  it('reads the secret from the environment when none is passed', async () => {
    process.env[BUNDLE_SECRET_ENV_VAR] = SECRET;

    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    const decrypted = await decryptBundle(encrypted);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });
});

// ─── Scenario 2: The secret is what actually protects the bundle ──────────────

describe('Secret-based confidentiality', () => {
  it('cannot be decrypted with the wrong secret', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    await expect(decryptBundle(encrypted, undefined, OTHER_SECRET)).rejects.toThrow();
  });

  it('cannot be decrypted by someone holding only the bundle', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    // No secret supplied and none in the environment: the principal embedded in
    // the header must not be sufficient to reconstruct the key.
    await expect(decryptBundle(encrypted)).rejects.toThrow(/bundle secret is required/);
  });

  it('refuses to encrypt when no secret is available', async () => {
    await expect(
      encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL),
    ).rejects.toThrow(/bundle secret is required/);
  });
});

// ─── Scenario 3: Principal binding ────────────────────────────────────────────

describe('Principal binding', () => {
  it('decrypts successfully when the correct principal is supplied', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    const decrypted = await decryptBundle(encrypted, SAMPLE_PRINCIPAL, SECRET);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });

  it('throws on principal mismatch when an explicit principal is given', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    await expect(decryptBundle(encrypted, OTHER_PRINCIPAL, SECRET)).rejects.toThrow(
      /Principal mismatch/,
    );
  });

  it('a bundle encrypted for principal A cannot be decrypted by tampering the header to principal B', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    // Tamper: overwrite the principal field in the header with OTHER_PRINCIPAL.
    // The principal is bound into the KDF, so the derived key differs and GCM
    // authentication fails.
    const otherBuf = Buffer.from(OTHER_PRINCIPAL, 'utf-8');
    const principalLenOffset = 4 + 32 + 12 + 16; // magic + salt + iv + tag
    const tampered = Buffer.from(encrypted);

    tampered.writeUInt32BE(otherBuf.length, principalLenOffset);
    otherBuf.copy(tampered, principalLenOffset + 4);

    await expect(decryptBundle(tampered, undefined, SECRET)).rejects.toThrow();
  });
});

// ─── Scenario 4: Magic-header detection ───────────────────────────────────────

describe('isVetKeysEncryptedBundle', () => {
  it('returns true for an encrypted bundle', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    expect(isVetKeysEncryptedBundle(encrypted)).toBe(true);
  });

  it('returns true for a legacy v1 bundle', () => {
    expect(isVetKeysEncryptedBundle(makeLegacyV1Bundle(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL))).toBe(true);
  });

  it('returns false for a plain JSON buffer', () => {
    expect(isVetKeysEncryptedBundle(SAMPLE_BUNDLE)).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isVetKeysEncryptedBundle(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for random bytes that do not start with a known magic', () => {
    const random = crypto.randomBytes(128);
    random[0] = 0x00;
    expect(isVetKeysEncryptedBundle(random)).toBe(false);
  });
});

// ─── Scenario 5: Legacy v1 compatibility ──────────────────────────────────────

describe('Legacy v1 bundles', () => {
  it('still decrypts so historical data can be recovered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = makeLegacyV1Bundle(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);

    const decrypted = await decryptBundle(legacy);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });

  it('warns that v1 encryption is not confidential', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = makeLegacyV1Bundle(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);

    await decryptBundle(legacy);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not confidential/));
  });

  it('is never produced by the current encrypt path', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);

    expect(encrypted.subarray(0, 4).toString()).toBe('VKE2');
  });
});

// ─── Scenario 6: Error handling ───────────────────────────────────────────────

describe('Error handling', () => {
  it('throws when principalId is empty', async () => {
    await expect(
      encryptBundleWithVetKeys(SAMPLE_BUNDLE, '', SECRET),
    ).rejects.toThrow(/principalId is required/);
  });

  it('throws when decrypting a non-encrypted buffer', async () => {
    await expect(decryptBundle(SAMPLE_BUNDLE, undefined, SECRET)).rejects.toThrow(
      /missing magic header/,
    );
  });

  it('throws when the encrypted buffer is truncated', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    const truncated = encrypted.subarray(0, 20);

    await expect(decryptBundle(truncated, undefined, SECRET)).rejects.toThrow();
  });

  it('throws when ciphertext is tampered (GCM auth failure)', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL, SECRET);
    const tampered = Buffer.from(encrypted);
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;

    await expect(decryptBundle(tampered, undefined, SECRET)).rejects.toThrow();
  });
});
