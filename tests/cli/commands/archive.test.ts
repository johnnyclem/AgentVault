/**
 * `agentvault archive` reads the local archive index and never talks to
 * Arweave, so it must not call anything confirmed or verified on Arweave.
 * Earlier versions stored 'confirmed' straight after an upload was accepted,
 * without checking it was mined; list and stats show those, and uploaded
 * records still 'pending', as submitted and not checked. verify re-hashes the
 * local copy only and says so.
 *
 * Each test gets its own HOME and fresh module instances, because the archive
 * store reads HOME when it is first imported.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Manager = typeof import('../../../src/archival/archive-manager.js');

const TX = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';

let home: string;
let output: string[];
let manager: Manager;

function seed(status: 'prepared' | 'submitted' | 'legacy-confirmed' | 'failed'): string {
  const { archiveId } = manager.prepareArchive('agent-1', '1.0.0', { agentId: 'agent-1' });
  if (status === 'submitted' || status === 'legacy-confirmed') {
    manager.updateArchiveTransaction(archiveId!, TX);
  }
  if (status === 'legacy-confirmed') {
    manager.confirmArchive(archiveId!);
  }
  if (status === 'failed') {
    manager.failArchive(archiveId!, 'Upload failed');
  }
  return archiveId!;
}

async function archive(...args: string[]): Promise<string> {
  const { archiveCmd } = await import('../../../cli/commands/archive.js');
  await archiveCmd.parseAsync(args, { from: 'user' });
  return output.join('\n');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'av-archive-cli-'));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  manager = await import('../../../src/archival/archive-manager.js');

  output = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  // ora writes its spinner and its final line to stderr
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('agentvault archive list', () => {
  it('shows a legacy confirmed record as submitted and not checked', async () => {
    seed('legacy-confirmed');

    const text = await archive('list');

    expect(text).toContain('submitted (not checked on Arweave)');
    expect(text).not.toMatch(/confirmed/i);
    expect(text).toContain(`Transaction: ${TX}`);
  });

  it('tells an uploaded record from one that was never uploaded', async () => {
    seed('submitted');
    seed('prepared');

    const text = await archive('list');

    expect(text).toContain('submitted (not checked on Arweave)');
    expect(text).toContain('pending (not uploaded)');
  });

  it('filters by the status it shows', async () => {
    const submitted = seed('legacy-confirmed');
    const prepared = seed('prepared');

    const text = await archive('list', '--status', 'submitted');

    expect(text).toContain(submitted);
    expect(text).not.toContain(prepared);
  });
});

describe('agentvault archive stats', () => {
  it('counts uploaded and legacy confirmed records as submitted, not confirmed', async () => {
    seed('legacy-confirmed');
    seed('submitted');
    seed('prepared');
    seed('failed');

    const text = await archive('stats');

    expect(text).not.toMatch(/confirmed/i);
    expect(text).toContain('Submitted (not checked on Arweave): 2');
    expect(text).toContain('Pending (not uploaded): 1');
    expect(text).toContain('Failed: 1');
  });
});

describe('agentvault archive verify', () => {
  it('says it checked the local copy only, and that Arweave was not checked', async () => {
    const id = seed('submitted');

    const text = await archive('verify', id);

    expect(text).toContain(`Local copy matches recorded checksum: ${id} (Arweave not checked)`);
    expect(text).toContain(`Arweave tx ${TX}: not checked by this command`);
    expect(text).not.toMatch(/archive verified/i);
  });

  it('fails when the local copy no longer matches its checksum', async () => {
    const id = seed('submitted');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(manager.getArchivePath(id), '{"agentId":"tampered"}');

    await expect(archive('verify', id)).rejects.toThrow('process.exit(1)');
    expect(output.join('\n')).toContain('Local copy is missing or does not match its recorded checksum');
  });
});

describe('listPendingArchives', () => {
  it('leaves out records that were already uploaded', () => {
    const prepared = seed('prepared');
    seed('submitted');

    expect(manager.listPendingArchives().map((a) => a.id)).toEqual([prepared]);
  });
});
