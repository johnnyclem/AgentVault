/**
 * `agentvault mint agent` deploys no canister and uploads nothing to Arweave,
 * so its summary must call a generated canister ID a placeholder and the
 * birthday record local. --no-backup must really skip the record: Commander
 * stores that flag as `backup: false`, and reading `noBackup` ignored it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mintMock } = vi.hoisted(() => ({
  mintMock: vi.fn(async (options: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    success: true,
    agentName: options['agentName'],
    agentType: options['agentType'],
    agentDir: `${String(options['outputDir'])}/${String(options['agentName'])}`,
    canisterId: options['canisterId'] ?? 'abcde-fghij-klmno-pqrst-cai',
    birthdayArchiveId: options['skipBackup'] ? undefined : 'archive-1761300000000-1a2b3c4d',
    birthdayTimestamp: '2026-10-24T12:00:00.000Z',
    scaffoldFiles: [],
    durationMs: 1,
  })),
}));

vi.mock('../../../src/orchestration/google-adk.js', () => ({
  mintGoogleADKAgent: mintMock,
  checkGoogleADKAvailable: async () => ({ available: true, version: '1.0.0' }),
}));

import { mintCmd } from '../../../cli/commands/mint.js';

let outputDir: string;
let printed: string[];

async function mint(...flags: string[]): Promise<Record<string, unknown>> {
  await mintCmd().parseAsync(['agent', 'my-bot', '--google-adk-loop-agent', '-y', '-o', outputDir, ...flags], { from: 'user' });
  return mintMock.mock.calls[0]![0];
}

beforeEach(() => {
  mintMock.mockClear();
  outputDir = mkdtempSync(join(tmpdir(), 'av-mint-cli-'));
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  // ora writes its spinner to stderr
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(outputDir, { recursive: true, force: true });
});

describe('agentvault mint agent', () => {
  it('writes the birthday record by default', async () => {
    expect(await mint()).toMatchObject({ skipBackup: false });
  });

  it('skips the birthday record with --no-backup', async () => {
    expect(await mint('--no-backup')).toMatchObject({ skipBackup: true });
    expect(printed.join('\n')).toContain('Birthday record: skipped (--no-backup)');
  });

  it('calls a generated canister ID a placeholder and the record local', async () => {
    await mint();

    const output = printed.join('\n');
    expect(output).toContain('placeholder ID – no canister was deployed');
    expect(output).toContain('not uploaded to Arweave');
    expect(output).not.toMatch(/permanent|immutable|on-chain/i);
  });

  it('does not call a canister ID given with --canister-id a placeholder', async () => {
    await mint('--canister-id', 'rrkah-fqaaa-aaaaa-aaaaq-cai');

    expect(printed.join('\n')).not.toContain('placeholder');
  });
});
