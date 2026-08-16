/**
 * Wallet Export Command
 *
 * Export all wallets for an agent to a backup file.
 */

import { listAgentWallets, getWallet } from '../../src/wallet/index.js';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Export format options
 */
type ExportFormat = 'json' | 'encrypted';

/**
 * Export backup structure
 */
interface WalletBackup {
  version: string;
  agentId: string;
  exportedAt: number;
  format: ExportFormat;
  wallets: any[];
}

/**
 * On-disk shape of an encrypted export.
 *
 * `encrypted` holds the ciphertext (`<hex>.<authTagHex>`), not a flag — this is
 * the shape wallet-import's decryptData reads.
 */
interface EncryptedWalletBackup {
  version: string;
  agentId: string;
  exportedAt: number;
  format: 'encrypted';
  encrypted: string;
  iv: string;
  salt: string;
}

/**
 * Create backup directory
 */
function ensureBackupDir(): string {
  const backupDir = path.join(process.cwd(), 'backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  return backupDir;
}

/**
 * Generate backup filename
 */
function generateBackupFilename(agentId: string, format: ExportFormat): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = format === 'encrypted' ? 'backup' : 'json';
  return `agentvault-backup-${agentId}-${timestamp}.${ext}`;
}

/**
 * Display wallet summary
 */
function displayWalletSummary(wallets: any[]): void {
  console.log();
  console.log(chalk.cyan('Wallets to export:'));

  for (const wallet of wallets) {
    console.log(`  - ${wallet.chain.toUpperCase()}: ${wallet.address}`);
  }

  console.log(`  Total: ${wallets.length} wallet(s)`);
}

/**
 * Encrypt data with password
 */
function encryptData(data: string, password: string): { encrypted: string; iv: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();
  const encryptedWithAuth = `${encrypted}.${authTag.toString('hex')}`;

  return {
    encrypted: encryptedWithAuth,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
  };
}

/**
 * Handle wallet export command
 */
export async function handleExport(agentId: string, options: { format?: string; output?: string } = {}): Promise<void> {
  console.log(chalk.bold('\n📦 Export Wallets\n'));

  const walletIds = listAgentWallets(agentId);

  if (walletIds.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const wallets = walletIds.map(id => getWallet(agentId, id)).filter(Boolean);

  displayWalletSummary(wallets);

  const { format } = await inquirer.prompt<{ format: ExportFormat }>([
    {
      type: 'list',
      name: 'format',
      message: 'Select export format:',
      choices: [
        { name: 'JSON (plain text, easy to read)', value: 'json' },
        { name: 'Encrypted (password-protected)', value: 'encrypted' },
      ],
      default: options.format || 'json',
    },
  ]);

  const backupDir = ensureBackupDir();
  const filename = options.output || generateBackupFilename(agentId, format);
  const filepath = path.join(backupDir, filename);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Export ${wallets.length} wallet(s) to ${filepath}?`,
      default: true,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nExport cancelled'));
    return;
  }

  const spinner = ora('Exporting wallets...').start();

  try {
    const backup: WalletBackup = {
      version: '1.0',
      agentId,
      exportedAt: Date.now(),
      format,
      wallets,
    };

    let data = JSON.stringify(backup, null, 2);

    if (format === 'encrypted') {
      const { password } = await inquirer.prompt<{ password: string }>([
        {
          type: 'password',
          name: 'password',
          message: 'Enter encryption password:',
          validate: (input: string) => input.length >= 8,
        },
      ]);

      const { encrypted, iv, salt } = encryptData(data, password);

      // Emit the envelope wallet-import expects: metadata plus the ciphertext
      // in `encrypted`, alongside the iv and salt needed to derive the key.
      // Note that the plaintext wallets are deliberately not carried over —
      // `data` above already holds them, and `encrypted` is their ciphertext.
      const envelope: EncryptedWalletBackup = {
        version: backup.version,
        agentId: backup.agentId,
        exportedAt: backup.exportedAt,
        format: 'encrypted',
        encrypted,
        iv,
        salt,
      };

      data = JSON.stringify(envelope, null, 2);
    }

    // Contains private keys in both formats: plaintext for json, and the
    // ciphertext plus its KDF parameters for encrypted.
    fs.writeFileSync(filepath, data, { encoding: 'utf-8', mode: 0o600 });

    spinner.succeed('Wallets exported successfully');

    console.log();
    console.log(chalk.green('✓'), `Export saved to: ${filepath}`);
    console.log(`  Size: ${(data.length / 1024).toFixed(2)} KB`);

    console.log();
    if (format === 'json') {
      console.log(chalk.yellow('⚠'), 'This file contains unencrypted private keys - keep it secure!');
    } else {
      console.log(
        chalk.yellow('⚠'),
        'This file contains your encrypted private keys - the password cannot be recovered.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to export wallets: ${message}`);
    // Exit non-zero so callers and CI can detect the failure; previously this
    // returned normally and the command exited 0 on error.
    process.exitCode = 1;
  }
}
