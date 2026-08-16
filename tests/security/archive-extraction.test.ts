/**
 * Archive extraction safety — zip-slip and symlink escape
 *
 * restoreFromEncryptedZip extracts a backup and then copies the result over
 * ~/.agentvault. These tests build genuinely hostile archives with the `zip`
 * CLI and assert that extraction refuses them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { restoreFromEncryptedZip } from '../../src/backup/backup.js';

const PASSPHRASE = 'test-passphrase-for-archive-safety';

let workDir: string;
let toolsAvailable = true;

/**
 * Wrap a plain zip in the same envelope writeEncryptedFile produces
 * (JSON metadata + base64 AES-256-GCM ciphertext, PBKDF2-SHA256 @ 210k).
 */
function encryptZip(plainZipPath: string, outPath: string): void {
  const plaintext = fs.readFileSync(plainZipPath);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(PASSPHRASE, salt, 210000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        version: 'enc-v1',
        algorithm: 'aes-256-gcm',
        kdf: 'pbkdf2-sha256',
        iterations: 210000,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
      null,
      2,
    ),
    'utf8',
  );
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-archive-test-'));
  try {
    await execa('zip', ['-v']);
    await execa('unzip', ['-v']);
  } catch {
    toolsAvailable = false;
  }
});

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe('restoreFromEncryptedZip archive safety', () => {
  it('refuses an archive containing a path-traversal entry', async () => {
    expect(toolsAvailable).toBe(true);

    const stage = fs.mkdtempSync(path.join(workDir, 'traversal-'));
    fs.mkdirSync(path.join(stage, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'state', 'ok.txt'), 'benign');

    // `zip` refuses to store a literal ../ name, so store an equal-length
    // placeholder and patch the bytes. 'AA/evil.txt' and '../evil.txt' are both
    // 11 chars, so every stored length and offset stays valid.
    fs.mkdirSync(path.join(stage, 'AA'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'AA', 'evil.txt'), 'escaped');

    const plainZip = path.join(stage, 'payload.zip');
    await execa('zip', ['-q', '-r', plainZip, 'state', 'AA'], { cwd: stage });

    const patched = Buffer.from(
      fs.readFileSync(plainZip).toString('binary').replaceAll('AA/evil.txt', '../evil.txt'),
      'binary',
    );
    fs.writeFileSync(plainZip, patched);

    const encrypted = path.join(stage, 'backup.zip.enc');
    encryptZip(plainZip, encrypted);

    const result = await restoreFromEncryptedZip({
      zipPath: encrypted,
      passphrase: PASSPHRASE,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/traversal|absolute|Refusing/i);
  });

  it('refuses an archive containing a symlink that escapes the root', async () => {
    expect(toolsAvailable).toBe(true);

    const stage = fs.mkdtempSync(path.join(workDir, 'symlink-'));
    const stateDir = path.join(stage, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // A symlink pointing outside the extraction directory. Copying the
    // extracted tree over ~/.agentvault would otherwise plant this link.
    const sensitiveTarget = path.join(workDir, 'pretend-ssh');
    fs.mkdirSync(sensitiveTarget, { recursive: true });
    fs.symlinkSync(sensitiveTarget, path.join(stateDir, 'stolen'));
    fs.writeFileSync(path.join(stateDir, 'ok.txt'), 'benign');

    const plainZip = path.join(stage, 'payload.zip');
    // -y stores symlinks as links rather than following them.
    await execa('zip', ['-q', '-r', '-y', plainZip, 'state'], { cwd: stage });

    const encrypted = path.join(stage, 'backup.zip.enc');
    encryptZip(plainZip, encrypted);

    const result = await restoreFromEncryptedZip({
      zipPath: encrypted,
      passphrase: PASSPHRASE,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/symbolic link|Refusing/i);
  });

  it('reports a missing archive rather than throwing', async () => {
    const result = await restoreFromEncryptedZip({
      zipPath: path.join(workDir, 'does-not-exist.zip.enc'),
      passphrase: PASSPHRASE,
    });

    expect(result.success).toBe(false);
    expect(result.error ?? '').toMatch(/not found/i);
  });
});
