/**
 * Wallet encrypted-export round trip
 *
 * Exercises handleExport end to end and decrypts the result the way
 * wallet-import does, so the export format is verified against its only
 * consumer rather than against a reimplementation of the crypto.
 *
 * Regression: the encrypted export previously serialized the envelope and then
 * immediately overwrote it with `JSON.stringify({ encrypted })`, discarding the
 * PBKDF2 salt and GCM IV. Every encrypted backup was permanently undecryptable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const PASSWORD = 'test-password-123';

const WALLET = {
  id: 'wallet-1',
  agentId: 'test-agent',
  chain: 'cketh',
  address: '0x1234567890abcdef1234567890abcdef12345678',
  privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  creationMethod: 'private-key',
};

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      format: 'encrypted',
      confirm: true,
      password: PASSWORD,
    }),
  },
}));

vi.mock('../../src/wallet/index.js', () => ({
  listAgentWallets: vi.fn().mockReturnValue(['wallet-1']),
  getWallet: vi.fn().mockReturnValue(WALLET),
}));

const { handleExport } = await import('../../cli/commands/wallet-export.js');

/** Mirror of wallet-import.ts#decryptData. */
function decryptData(encryptedData: string, password: string, ivHex: string, saltHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  const [encrypted, authTagHex] = encryptedData.split('.');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(authTagHex ?? '', 'hex'));

  let decrypted = decipher.update(encrypted ?? '', 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

let tmpDir: string;
let originalCwd: string;

/** The most recently written file under ./backups. */
function readExportedBackup(): { file: string; parsed: Record<string, unknown> } {
  const backupDir = path.join(tmpDir, 'backups');
  const files = fs.readdirSync(backupDir);
  expect(files).toHaveLength(1);

  const file = path.join(backupDir, files[0]!);
  return { file, parsed: JSON.parse(fs.readFileSync(file, 'utf-8')) };
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-export-'));
  process.chdir(tmpDir);
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Encrypted wallet export round trip', () => {
  it('writes an envelope carrying the ciphertext, iv and salt', async () => {
    await handleExport('test-agent', { format: 'encrypted' });

    const { parsed } = readExportedBackup();

    expect(typeof parsed.encrypted).toBe('string');
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.salt).toBe('string');
    expect(parsed.format).toBe('encrypted');
    expect(parsed.agentId).toBe('test-agent');
  });

  it('decrypts back to the original wallet data', async () => {
    await handleExport('test-agent', { format: 'encrypted' });

    const { parsed } = readExportedBackup();

    const plaintext = decryptData(
      parsed.encrypted as string,
      PASSWORD,
      parsed.iv as string,
      parsed.salt as string,
    );
    const restored = JSON.parse(plaintext);

    expect(restored.wallets).toHaveLength(1);
    expect(restored.wallets[0].privateKey).toBe(WALLET.privateKey);
    expect(restored.wallets[0].address).toBe(WALLET.address);
  });

  it('does not leave the private key in plaintext in the file', async () => {
    await handleExport('test-agent', { format: 'encrypted' });

    const { file } = readExportedBackup();
    const raw = fs.readFileSync(file, 'utf-8');

    expect(raw).not.toContain(WALLET.privateKey);
    expect(raw).not.toContain(WALLET.address);
  });

  it('fails to decrypt with the wrong password', async () => {
    await handleExport('test-agent', { format: 'encrypted' });

    const { parsed } = readExportedBackup();

    expect(() =>
      decryptData(parsed.encrypted as string, 'wrong-password', parsed.iv as string, parsed.salt as string),
    ).toThrow();
  });

  it('writes the backup file owner-readable only', async () => {
    await handleExport('test-agent', { format: 'encrypted' });

    const { file } = readExportedBackup();

    // Private key material must not be world-readable.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
