/**
 * ICP audit submission does not work yet (the canister has no
 * storeMfaAuditEntry method), so entries stay in the local retry queue. A
 * flush that stores nothing must say why, and `repo flush-queue` must report
 * that reason instead of blaming reachability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY = {
  id: 'evt-1',
  requestId: 'req-1',
  branchId: 'branch-1',
  event: 'approved' as const,
  timestamp: '2026-10-24T00:00:00.000Z',
};

describe('flushIcpAuditQueue', () => {
  let home: string;
  const saved = {
    HOME: process.env['HOME'],
    AGENTVAULT_CANISTER_ID: process.env['AGENTVAULT_CANISTER_ID'],
    CANISTER_ID_AGENT: process.env['CANISTER_ID_AGENT'],
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-icp-audit-'));
    process.env['HOME'] = home;
    delete process.env['AGENTVAULT_CANISTER_ID'];
    delete process.env['CANISTER_ID_AGENT'];
    // The queue path is resolved from the home directory when the module loads
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns the reason nothing was stored, and keeps the entry queued', async () => {
    const audit = await import('../../src/security/icp-audit.js');

    const submitted = await audit.submitIcpAuditEntry(ENTRY);
    expect(submitted).toEqual({ ok: false, queued: true, reason: 'icp-not-configured' });
    expect(audit.getIcpQueueDepth()).toBe(1);

    const result = await audit.flushIcpAuditQueue();
    expect(result).toEqual({ flushed: 0, lastError: 'no canister configured (set AGENTVAULT_CANISTER_ID)' });
    expect(audit.getIcpQueueDepth()).toBe(1);
  });

  it('reports nothing to do for an empty queue', async () => {
    const audit = await import('../../src/security/icp-audit.js');
    expect(await audit.flushIcpAuditQueue()).toEqual({ flushed: 0 });
  });
});

describe('repo flush-queue', () => {
  afterEach(() => {
    vi.doUnmock('../../src/security/icp-audit.js');
    vi.doUnmock('ora');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reports the actual failure reason instead of blaming reachability', async () => {
    vi.resetModules();
    const warned: string[] = [];
    vi.doMock('ora', () => ({
      default: () => {
        const spinner = {
          start: () => spinner,
          succeed: () => spinner,
          fail: () => spinner,
          warn: (text: string) => { warned.push(text); return spinner; },
        };
        return spinner;
      },
    }));
    vi.doMock('../../src/security/icp-audit.js', () => ({
      queryIcpAuditLog: vi.fn(async () => []),
      getIcpQueueDepth: vi.fn(() => 1),
      flushIcpAuditQueue: vi.fn(async () => ({
        flushed: 0,
        lastError: 'Canister has no update method storeMfaAuditEntry',
      })),
    }));
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(' ')); });

    const { repoCmd } = await import('../../cli/commands/repo.js');
    await repoCmd.parseAsync(['flush-queue'], { from: 'user' });

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('No entries flushed: Canister has no update method storeMfaAuditEntry');
    expect(warned[0]).not.toMatch(/unreachable/i);
    expect(printed.join('\n')).toContain('On-chain submission does not work yet');
  });
});
