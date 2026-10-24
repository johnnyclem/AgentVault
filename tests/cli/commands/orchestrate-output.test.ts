/**
 * `agentvault orchestrate` must not report tests as failed or passed when
 * none ran, and must not claim an approval request or gate exists: reviewers
 * are only recorded in the audit log.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { orchestrateMock } = vi.hoisted(() => ({
  orchestrateMock: vi.fn(async (_options: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    success: true,
    sessionId: 'orch_test',
    taskDescription: 'task',
    filesChanged: [],
    testsPassed: true,
    durationMs: 1,
  })),
}));

vi.mock('../../../src/orchestration/claude.js', () => ({
  ClaudeOrchestrator: class {
    orchestrate = orchestrateMock;
  },
}));

import { orchestrateCmd } from '../../../cli/commands/orchestrate.js';

const base = { success: true, sessionId: 'orch_test', taskDescription: 'task', filesChanged: [], durationMs: 1 };

let printed: string[];
let projectDir: string;

async function run(...flags: string[]): Promise<string> {
  await orchestrateCmd().parseAsync(['--claude', '-t', 'Refactor the parser', ...flags], { from: 'user' });
  return printed.join('\n');
}

beforeEach(() => {
  orchestrateMock.mockClear();
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  projectDir = mkdtempSync(join(tmpdir(), 'av-orchestrate-output-'));
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('orchestrate – test result label', () => {
  it('says skipped, not passed or failed, when the project has no package.json', async () => {
    orchestrateMock.mockResolvedValueOnce({ ...base, testsPassed: false, testsSkipped: true });
    const output = await run();

    expect(output).toMatch(/Tests:\s+skipped \(no package\.json\)/);
    expect(output).not.toMatch(/Tests:\s+(passed|failed)/);
  });

  it('says passed only when the tests passed', async () => {
    orchestrateMock.mockResolvedValueOnce({ ...base, testsPassed: true, testsSkipped: false });
    expect(await run()).toMatch(/Tests:\s+passed/);
  });
});

describe('orchestrate – reviewers', () => {
  it('records reviewers without claiming an approval request or gate', async () => {
    orchestrateMock.mockResolvedValueOnce({ ...base, testsPassed: true });
    const output = await run('--approve', '--reviewers', 'alice,bob');

    expect(output).toContain('alice, bob (recorded in the audit log; approval gating is not implemented)');
    expect(output).not.toMatch(/Approval ID|Approval required|approve sign/);
    expect(orchestrateMock.mock.calls[0]![0]).toMatchObject({ requireApproval: true, reviewers: ['alice', 'bob'] });
  });

  it('describes --approve as recording names, not multi-sig approval', () => {
    const approve = orchestrateCmd().options.find((o) => o.long === '--approve');
    expect(approve?.description).toBe('Record reviewer names in the audit log (approval gating is not implemented)');
    expect(approve?.description).not.toMatch(/multi-sig|before committing/i);
  });
});
