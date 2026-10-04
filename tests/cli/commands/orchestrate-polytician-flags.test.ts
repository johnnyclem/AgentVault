/**
 * `agentvault orchestrate` must honour --no-semantic-enrichment and
 * --no-save-concept, the opt-outs from sending the task to Polytician and
 * saving the session's result there, and show what Polytician did: progress
 * messages only pass through the spinner, which the next message overwrites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

async function run(...flags: string[]): Promise<Record<string, unknown>> {
  await orchestrateCmd().parseAsync(['--claude', '-t', 'Refactor the parser', '--polytician-entry', 'node polytician.js', ...flags], { from: 'user' });
  return orchestrateMock.mock.calls[0]![0];
}

let printed: string[];

beforeEach(() => {
  orchestrateMock.mockClear();
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('orchestrate – Polytician opt-outs', () => {
  it('enriches the task and saves the result by default', async () => {
    const options = await run();
    expect(options).toMatchObject({ enableSemanticEnrichment: true, saveResultAsConcept: true });
    expect(options.polyticianServer).toMatchObject({ entryPoint: 'node polytician.js' });
  });

  it('--no-semantic-enrichment and --no-save-concept turn both off', async () => {
    const options = await run('--no-semantic-enrichment', '--no-save-concept');
    expect(options).toMatchObject({ enableSemanticEnrichment: false, saveResultAsConcept: false });
  });
});

describe('orchestrate – what Polytician did', () => {
  const base = { success: true, sessionId: 'orch_test', taskDescription: 'task', filesChanged: [], testsPassed: true, durationMs: 1 };

  it('shows an enrichment failure the session went on without', async () => {
    orchestrateMock.mockResolvedValueOnce({
      ...base,
      semanticMemory: { conceptsUsed: [], enrichmentError: 'MCP server exited (code 1): Configuration error' },
    });
    await run();

    expect(printed.join('\n')).toMatch(/Polytician:\s+.*enrichment failed, continued without it: MCP server exited \(code 1\): Configuration error/);
  });

  it('lists the concepts used and the saved concept', async () => {
    orchestrateMock.mockResolvedValueOnce({
      ...base,
      semanticMemory: {
        conceptsUsed: [{ id: 'c-1', name: 'Streaming parser', relevanceScore: 0.8123 }],
        savedConceptId: 'c-2',
      },
    });
    await run();

    const output = printed.join('\n');
    expect(output).toMatch(/Polytician:\s+1 concept\(s\) added to the prompt/);
    expect(output).toContain('Streaming parser (c-1, score 0.812)');
    expect(output).toMatch(/Saved concept:\s+c-2/);
  });

  it('prints the prompt of a dry run', async () => {
    orchestrateMock.mockResolvedValueOnce({
      ...base,
      prompt: { system: 'SYSTEM-PROMPT-TEXT', user: '<semantic_memory>\nMEMORY\n</semantic_memory>\n\nTask: x' },
    });
    await run('--dry-run');

    const output = printed.join('\n');
    expect(output).toContain('SYSTEM-PROMPT-TEXT');
    expect(output).toContain('<semantic_memory>\nMEMORY\n</semantic_memory>');
  });
});
