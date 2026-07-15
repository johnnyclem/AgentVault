import { describe, it, expect } from 'vitest';
import { encryptJSON, decryptJSON } from '../../src/security/vetkeys.js';

// A valid BIP39 12-word mnemonic (test vector — not a real wallet).
const SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('vetkeys encryptJSON/decryptJSON (audit C-1)', () => {
  it('round-trips a JSON value with an authenticated tag', async () => {
    const data = { secret: 'value', count: 42, nested: { ok: true } };
    const encrypted = await encryptJSON(data, SEED);
    expect(encrypted.tag).toBeTruthy();
    expect(encrypted.algorithm).toBe('aes-256-gcm');
    const decrypted = await decryptJSON<typeof data>(encrypted, SEED);
    expect(decrypted).toEqual(data);
  });

  it('rejects ciphertext tampering (GCM auth tag now validated)', async () => {
    const encrypted = await encryptJSON({ secret: 'value' }, SEED);
    // Flip a byte in the ciphertext
    const bytes = Buffer.from(encrypted.ciphertext, 'hex');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...encrypted, ciphertext: bytes.toString('hex') };
    await expect(decryptJSON(tampered, SEED)).rejects.toThrow();
  });

  it('rejects a tampered auth tag', async () => {
    const encrypted = await encryptJSON({ secret: 'value' }, SEED);
    const tag = Buffer.from(encrypted.tag!, 'hex');
    tag[0] = tag[0]! ^ 0xff;
    await expect(decryptJSON({ ...encrypted, tag: tag.toString('hex') }, SEED)).rejects.toThrow();
  });

  it('refuses to decrypt a payload with no usable auth tag', async () => {
    const encrypted = await encryptJSON({ secret: 'value' }, SEED);
    // Strip the tag and keep the ciphertext short so no tag can be split off.
    const noTag = { ...encrypted, tag: undefined, ciphertext: '00' };
    await expect(decryptJSON(noTag, SEED)).rejects.toThrow(/authentication tag/i);
  });
});
