/**
 * `agentvault hypervault verify` checks the manifest signature against the
 * key embedded in the bundle unless --public-key is given, so without it the
 * success line must say the bundle is self-consistent and name that key, not
 * claim it is verified. With --public-key, a bundle signed by another key
 * fails.
 *
 * Bundles are built and signed for real in a temp directory; only the
 * spinner is faked so its lines can be read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, writeSnapshot } from '../../../src/hypervault/snapshot.js';
import { sampleManifest, sampleRecords } from '../../hypervault/fixtures.js';

const spinnerLines = vi.hoisted(() => ({ succeed: [] as string[], fail: [] as string[] }));

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      start: () => spinner,
      stop: () => spinner,
      succeed: (text: string) => { spinnerLines.succeed.push(text); return spinner; },
      fail: (text: string) => { spinnerLines.fail.push(text); return spinner; },
    };
    return spinner;
  },
}));

import { hypervaultCmd } from '../../../cli/commands/hypervault.js';

let tmp: string;
let bundle: string;
let bundleKey: string;
let printed: string[];

async function verify(...args: string[]): Promise<void> {
  await hypervaultCmd.parseAsync(['verify', bundle, ...args], { from: 'user' });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cli-verify-'));
  const snapshot = await buildSnapshot(sampleRecords(), sampleManifest(), { signingKeyPath: path.join(tmp, 'signing.key') });
  bundleKey = snapshot.publicKey;
  bundle = path.join(tmp, 'bundle.hypervault-snapshot.json.gz');
  await writeSnapshot(snapshot, bundle);

  // The command is a module-level singleton and commander 12 keeps option
  // values between parses, so clear them for each test
  const verifyCmd = hypervaultCmd.commands.find((c) => c.name() === 'verify')!;
  verifyCmd.setOptionValue('publicKey', undefined);
  verifyCmd.setOptionValue('passphrase', undefined);

  spinnerLines.succeed = [];
  spinnerLines.fail = [];
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hypervault verify', () => {
  it('calls a valid bundle self-consistent and names the key taken from it', async () => {
    await verify();

    expect(spinnerLines.succeed).toEqual(['Bundle is self-consistent — signature, checksums and Merkle root pass']);
    expect(spinnerLines.succeed.join('\n')).not.toMatch(/verified/i);
    expect(printed.join('\n')).toContain(`Signed by key ${bundleKey}, taken from the bundle itself`);
  });

  it('says verified when the bundle is signed by the key given with --public-key', async () => {
    await verify('--public-key', bundleKey.toUpperCase());

    expect(spinnerLines.succeed).toEqual([
      `Bundle verified — signed by the expected key ${bundleKey}; checksums and Merkle root pass`,
    ]);
  });

  it('fails when the bundle is signed by a different key than --public-key', async () => {
    await expect(verify('--public-key', 'ab'.repeat(32))).rejects.toThrow('process.exit(1)');

    expect(spinnerLines.succeed).toEqual([]);
    // The faked process.exit throws, so the command's catch adds a second line
    expect(spinnerLines.fail[0]).toBe('Verification FAILED');
    expect(printed.join('\n')).toContain('Snapshot public key does not match the expected key');
  });

  it('rejects a malformed --public-key', async () => {
    await expect(verify('--public-key', 'not-a-key')).rejects.toThrow('process.exit(1)');

    expect(spinnerLines.succeed).toEqual([]);
    expect(spinnerLines.fail).toEqual(['--public-key must be a 32-byte ed25519 public key in hex (64 characters)']);
  });
});
