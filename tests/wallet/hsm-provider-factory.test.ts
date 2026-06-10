/**
 * createHsmProvider factory tests.
 *
 * Lives in its own file (separate from hsm-keygen.test.ts) because the
 * vi.mock of the HSM index module in that file is hoisted and would replace
 * the real createHsmProvider under test here.
 */

import { describe, it, expect } from 'vitest';
import type { HsmBackend } from '../../src/wallet/hsm/types.js';
import { HsmNotAvailableError } from '../../src/wallet/hsm/types.js';
import { createHsmProvider } from '../../src/wallet/hsm/index.js';

describe('createHsmProvider factory', () => {
  it('throws HsmNotAvailableError for unknown backend', async () => {
    await expect(
      createHsmProvider('tpm' as HsmBackend),
    ).rejects.toBeInstanceOf(HsmNotAvailableError);
  });

  it('throws HsmNotAvailableError for ledger when device absent', async () => {
    // @ledgerhq packages are not installed in CI → dynamic import fails → error
    // OR packages are installed but no device is connected → list() returns []
    // Either way HsmNotAvailableError should surface.
    await expect(createHsmProvider('ledger')).rejects.toBeInstanceOf(HsmNotAvailableError);
  });

  it('throws HsmNotAvailableError for sgx when AESM socket absent', async () => {
    await expect(
      createHsmProvider('sgx', { socketPath: '/nonexistent/aesm.socket' }),
    ).rejects.toBeInstanceOf(HsmNotAvailableError);
  });
});
