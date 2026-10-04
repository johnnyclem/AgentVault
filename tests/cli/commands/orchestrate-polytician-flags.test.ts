/**
 * `agentvault orchestrate` must honour --no-semantic-enrichment and
 * --no-save-concept, the opt-outs from sending the task to Polytician and
 * saving the session's result there, and show what Polytician did: progress
 * messages only pass through the spinner, which the next message overwrites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function run(...flags: string[]): Promise<Record<string, unknown>> {
  await orchestrateCmd().parseAsync(['--claude', '-t', 'Refactor the parser', '--polytician-entry', 'node polytician.js', ...flags], { from: 'user' });
  return orchestrateMock.mock.calls[0]![0];
}

let printed: string[];
let projectDir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  orchestrateMock.mockClear();
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  // The default namespace comes from the project's agent name; other tests leave an agent.json in the repository root
  projectDir = mkdtempSync(join(tmpdir(), 'av-orchestrate-flags-'));
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENTVAULT_') || key.startsWith('POLYTICIAN_')) delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  rmSync(projectDir, { recursive: true, force: true });
});

/** process.exit, made to throw so the command stops where it would have exited. */
function exitThrows(): { errors: string[] } {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  return { errors };
}

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

describe('orchestrate – the Polytician namespace and settings', () => {
  it("sends concepts to the namespace named after the project's agent, which is the webapp's agentId for it", async () => {
    writeFileSync(join(projectDir, 'agent.json'), JSON.stringify({ name: 'agent-a' }));
    const options = await run();
    expect(options.polyticianServer).toMatchObject({ namespace: 'polytician', polyticianNamespace: 'agent-a' });
    expect(printed.join('\n')).toMatch(/Polytician namespace:\s+agent-a/);
  });

  it('finds the agent name when run from a subdirectory of the project', async () => {
    writeFileSync(join(projectDir, 'agent.json'), JSON.stringify({ name: 'agent-a' }));
    const nested = join(projectDir, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(nested);

    expect((await run()).polyticianServer).toMatchObject({ polyticianNamespace: 'agent-a' });
  });

  it('reads the agent name from .agentvault/config/agent.config.json too, and defaults to "default" without one', async () => {
    mkdirSync(join(projectDir, '.agentvault', 'config'), { recursive: true });
    writeFileSync(join(projectDir, '.agentvault', 'config', 'agent.config.json'), JSON.stringify({ name: 'agent-b' }));
    expect((await run()).polyticianServer).toMatchObject({ polyticianNamespace: 'agent-b' });

    rmSync(join(projectDir, '.agentvault'), { recursive: true });
    orchestrateMock.mockClear();
    expect((await run()).polyticianServer).toMatchObject({ polyticianNamespace: 'default' });
  });

  it('--polytician-namespace sets it, and --polytician-config passes the config file', async () => {
    writeFileSync(join(projectDir, 'agent.json'), JSON.stringify({ name: 'agent-a' }));
    const options = await run('--polytician-namespace', 'team.shared', '--polytician-config', 'poly.json');
    expect(options.polyticianServer).toMatchObject({
      namespace: 'polytician',
      polyticianNamespace: 'team.shared',
      configPath: join(projectDir, 'poly.json'),
    });
  });

  it("passes AgentVault's URL and token on to Polytician", async () => {
    process.env['AGENTVAULT_API_URL'] = 'https://vault.example.com';
    process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] = 'av-token';
    const options = await run();
    expect(options.polyticianServer).toMatchObject({
      env: { POLYTICIAN_AV_API_URL: 'https://vault.example.com', POLYTICIAN_AV_API_TOKEN: 'av-token' },
    });
  });

  it('refuses an invalid namespace or AgentVault URL before the session starts', async () => {
    const { errors } = exitThrows();
    await expect(run('--polytician-namespace', 'not valid')).rejects.toThrow('process.exit(1)');
    expect(errors.join('\n')).toMatch(/--polytician-namespace "not valid" is not a valid Polytician namespace/);

    process.env['AGENTVAULT_API_URL'] = 'http://vault.example.com';
    process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] = 'av-token';
    await expect(run()).rejects.toThrow('process.exit(1)');
    expect(errors.join('\n')).toMatch(/AGENTVAULT_API_URL/);
    expect(orchestrateMock).not.toHaveBeenCalled();
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
