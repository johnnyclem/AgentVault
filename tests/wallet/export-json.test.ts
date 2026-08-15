/**
 * Wallet Export JSON Backup Tests (CLE-71)
 *
 * Tests for wallet export to plain JSON backup format.
 *
 * These run with the working directory pointed at a temp dir: handleExport
 * writes to `<cwd>/backups`, so running them in the repo root previously
 * rewrote the committed backups/test-backup.json on every `npm test`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const WALLET_PRIVATE_KEY =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      format: 'json',
      confirm: true,
    }),
  },
}));

vi.mock('../../src/wallet/index.js', () => ({
  listAgentWallets: vi.fn().mockReturnValue(['wallet-1', 'wallet-2']),
  getWallet: vi.fn().mockImplementation((_agentId: string, walletId: string) => ({
    id: walletId,
    agentId: 'test-agent',
    chain: 'cketh',
    address: WALLET_ADDRESS,
    privateKey: WALLET_PRIVATE_KEY,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    creationMethod: 'private-key',
  })),
}));

const { handleExport } = await import('../../cli/commands/wallet-export.js');

let tmpDir: string;
let originalCwd: string;

/** Read the single file written under <cwd>/backups. */
function readExport(): { file: string; parsed: Record<string, any> } {
  const backupDir = path.join(tmpDir, 'backups');
  const files = fs.readdirSync(backupDir);
  expect(files).toHaveLength(1);

  const file = path.join(backupDir, files[0]!);
  return { file, parsed: JSON.parse(fs.readFileSync(file, 'utf-8')) };
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-export-json-'));
  process.chdir(tmpDir);
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Wallet Export JSON Backup (CLE-71)', () => {
  describe('Export to JSON', () => {
    it('creates a backup file in the backups directory', async () => {
      await handleExport('test-agent', { format: 'json' });

      const { file } = readExport();
      expect(fs.existsSync(file)).toBe(true);
    });

    it('honours a custom output filename', async () => {
      await handleExport('test-agent', { format: 'json', output: 'custom-name.json' });

      const { file } = readExport();
      expect(path.basename(file)).toBe('custom-name.json');
    });

    it('writes the backup owner-readable only', async () => {
      await handleExport('test-agent', { format: 'json' });

      const { file } = readExport();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  describe('Backup structure', () => {
    it('records the expected metadata', async () => {
      await handleExport('test-agent', { format: 'json' });

      const { parsed } = readExport();

      expect(parsed.version).toBe('1.0');
      expect(parsed.agentId).toBe('test-agent');
      expect(parsed.format).toBe('json');
      expect(typeof parsed.exportedAt).toBe('number');
    });

    it('includes every wallet the agent owns', async () => {
      await handleExport('test-agent', { format: 'json' });

      const { parsed } = readExport();

      expect(parsed.wallets).toHaveLength(2);
      expect(parsed.wallets.map((w: { id: string }) => w.id)).toEqual([
        'wallet-1',
        'wallet-2',
      ]);
    });

    it('includes wallet addresses and private keys', async () => {
      await handleExport('test-agent', { format: 'json' });

      const { parsed } = readExport();

      for (const wallet of parsed.wallets) {
        expect(wallet.address).toBe(WALLET_ADDRESS);
        expect(wallet.privateKey).toBe(WALLET_PRIVATE_KEY);
      }
    });
  });
});
