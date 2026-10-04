/**
 * `agentvault polytician` against Polytician 3.0.
 *
 * Runs the real CLI (through tsx) against the fake Polytician 3.0 server in
 * tests/fixtures/polytician-3.0/, which validates every tools/call against
 * the captured input schemas and answers with the recorded responses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI = join(ROOT, 'cli', 'index.ts');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'polytician-3.0');
const FAKE_SERVER = join(FIXTURE_DIR, 'fake-server.mjs');

interface RecordedCall {
  response: { result: { structuredContent?: Record<string, unknown> } };
}
const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contract.json'), 'utf8')) as {
  calls: Record<string, RecordedCall>;
};
const recordedResults = contract.calls['search_concepts']!.response.result.structuredContent!.results as Array<{ id: string }>;
const [ORCHESTRATION_ID, NOTES_ID] = recordedResults.map((r) => r.id) as [string, string];

interface CliRun {
  code: number;
  output: string;
  elapsedMs: number;
}

function runCli(args: string[]): Promise<CliRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`, elapsedMs: Date.now() - started });
      },
    );
  });
}

/** Like runCli, with stdout and stderr apart (ora writes to stderr). */
function runCliSplit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function loggedCalls(logFile: string, tool: string): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } })
    .filter((m) => m.method === 'tools/call' && m.params?.name === tool)
    .map((m) => m.params?.arguments ?? {});
}

// One directory for the file, each test with its own log file. The tests run
// one at a time: each starts the CLI under tsx, which is CPU-heavy.
let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'av-polytician-cli-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function entry(...flags: string[]): string {
  return [process.execPath, FAKE_SERVER, ...flags].join(' ');
}

describe('agentvault polytician against Polytician 3.0', () => {
  it('status reports health, version and counts, and exits without waiting on request timers', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'status']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Server:\s+healthy/);
    expect(run.output).toMatch(/Version:\s+polytician 3\.0\.0/);
    expect(run.output).toMatch(/Embedding:\s+Xenova\/all-MiniLM-L6-v2, 384 dimensions/);
    expect(run.output).toMatch(/Concepts:\s+2/);
    expect(run.output).toMatch(/Vectors:\s+2/);
    expect(run.output).toMatch(/AgentVault tools:\s+not configured/);
    // The 2.x client left a 30 s timer behind for every request.
    expect(run.elapsedMs).toBeLessThan(25_000);
  }, 90_000);

  it('search sends { query, k } and prints ids, scores and titles', async () => {
    const logFile = join(workDir, 'search.jsonl');
    const run = await runCli(['polytician', '-e', entry('--log', logFile), 'search', 'refactor the parser', '-l', '500']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(new RegExp(`${ORCHESTRATION_ID}\\s+0\\.731\\s+Orchestration Result: session-1`));
    expect(run.output).toMatch(new RegExp(`${NOTES_ID}\\s+0\\.471\\s+Deployment checklist`));
    expect(loggedCalls(logFile, 'search_concepts')).toEqual([{ query: 'refactor the parser', k: 100 }]);
  }, 90_000);

  it('search --json prints the 3.0 results array', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'search', 'refactor the parser', '--json']);

    expect(run.code, run.output).toBe(0);
    const json = run.output.slice(run.output.indexOf('['), run.output.lastIndexOf(']') + 1);
    expect(JSON.parse(json)).toEqual(recordedResults);
  }, 90_000);

  it('search --json prints [] when nothing matches', async () => {
    const run = await runCliSplit(['polytician', '-e', entry('--empty'), 'search', 'anything', '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  }, 90_000);

  it('search lists a hit deleted between the search and the title read, without a title', async () => {
    const run = await runCli(['polytician', '-e', entry('--forget', NOTES_ID), 'search', 'refactor the parser']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(new RegExp(`${ORCHESTRATION_ID}\\s+0\\.731\\s+Orchestration Result: session-1`));
    expect(run.output).toMatch(new RegExp(`${NOTES_ID}\\s+0\\.471\\s+\\[notes\\]`));
  }, 90_000);

  it('push-all explains that Polytician has no AgentVault configured', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'push-all']);

    expect(run.code).toBe(1);
    expect(run.output).toContain('vault_memory_push');
    expect(run.output).toContain('POLYTICIAN_AV_API_URL');
  }, 90_000);

  it('push-all pushes every concept with vault_memory_push', async () => {
    const logFile = join(workDir, 'push.jsonl');
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok', '--log', logFile), 'push-all']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('Pushed 2 of 2 concepts to memory_repo');
    expect(loggedCalls(logFile, 'vault_memory_push')).toEqual([{ conceptId: NOTES_ID }, { conceptId: ORCHESTRATION_ID }]);
  }, 90_000);

  it('archive calls vault_archive_concept and prints the Arweave receipt', async () => {
    const logFile = join(workDir, 'archive.jsonl');
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok', '--log', logFile), 'archive', ORCHESTRATION_ID]);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/TX ID:\s+fake-arweave-tx-1/);
    expect(loggedCalls(logFile, 'vault_archive_concept')).toEqual([{ conceptId: ORCHESTRATION_ID }]);
  }, 90_000);

  it('archive prints the Polytician error code when AgentVault is unreachable', async () => {
    const run = await runCli(['polytician', '-e', entry('--vault', 'unreachable'), 'archive', ORCHESTRATION_ID]);

    expect(run.code).toBe(1);
    expect(run.output).toContain('UPSTREAM_ERROR');
    expect(run.output).toContain('fetch failed');
  }, 90_000);

  it('pull calls vault_memory_pull and reports what was imported', async () => {
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok'), 'pull']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Pulled polytician-main @ commit_000001: 0 imported, 0 skipped/);
  }, 90_000);
});
