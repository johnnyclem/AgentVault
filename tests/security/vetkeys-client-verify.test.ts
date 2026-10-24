/**
 * VetKeysClient.verifyEncryption has no way to show who created encrypted
 * data, so it must not report any data as verified.
 */

import { describe, it, expect } from 'vitest';
import { VetKeysClient } from '../../src/security/index.js';

describe('VetKeysClient.verifyEncryption', () => {
  it('refuses instead of reporting unchecked data as verified', async () => {
    const client = new VetKeysClient();
    const forged = {
      encryptedData: 'not really ciphertext',
      iv: '00',
      salt: '00',
      algorithm: 'aes-256-gcm' as const,
      timestamp: new Date(),
    };

    await expect(client.verifyEncryption(forged as never)).rejects.toThrow(
      'VetKeysClient.verifyEncryption is not implemented; decrypt the data to authenticate it',
    );
  });
});
