/**
 * Polytician 3.0 contract tests.
 *
 * Drives AgentVault's MCP client, the Polytician enricher, the orchestration
 * save path and the orchestrator's prompt against a fake stdio MCP server
 * (tests/fixtures/polytician-3.0/fake-server.mjs). The fake validates every
 * tools/call against Polytician 3.0's captured input schemas (unknown keys
 * rejected, required keys enforced) and answers with the responses recorded
 * from the real server in contract.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PolyticianMCPClient,
  MCPToolError,
  MCPTimeoutError,
  type MCPServerConfig,
  type MCPToolCallResult,
} from '../../src/orchestration/mcp-client.js';
import { callPolytician } from '../../src/orchestration/polytician-tools.js';
import {
  enrichWithPolyticianContext,
  saveConceptFromOrchestration,
} from '../../src/orchestration/polytician-enricher.js';
import { ClaudeOrchestrator } from '../../src/orchestration/claude.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface RecordedExchange {
  note?: string;
  request: { params: { name: string; arguments: Record<string, unknown> } };
  response: { result: MCPToolCallResult };
}

interface Contract {
  calls: Record<string, RecordedExchange>;
  errors: Record<string, RecordedExchange>;
  removedTools: Record<string, RecordedExchange>;
  vaultToolsWithoutAgentVault: Record<string, RecordedExchange>;
  vaultToolsWithUnreachableAgentVault: { calls: Record<string, RecordedExchange> };
}

interface LoggedMessage {
  id?: number | string;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
    clientInfo?: { name?: string };
  };
  result?: unknown;
}

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'polytician-3.0');
const FAKE_SERVER = join(FIXTURE_DIR, 'fake-server.mjs');
const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contract.json'), 'utf8')) as Contract;

const structuredOf = (key: string) => contract.calls[key]!.response.result.structuredContent as Record<string, unknown>;
const ORCHESTRATION_CONCEPT_ID = structuredOf('save_concept').id as string;
const NOTES_CONCEPT_ID = structuredOf('save_concept.second').id as string;
const RELATED_SCORE = (structuredOf('search_concepts').results as Array<{ score: number }>)[0]!.score;

function fakeServer(...flags: string[]): MCPServerConfig {
  return { namespace: 'polytician', entryPoint: [process.execPath, FAKE_SERVER, ...flags].join(' ') };
}

function readLog(file: string): LoggedMessage[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LoggedMessage);
}

function toolArguments(file: string, tool: string): Array<Record<string, unknown> | undefined> {
  return readLog(file)
    .filter((m) => m.method === 'tools/call' && m.params?.name === tool)
    .map((m) => m.params?.arguments);
}

/** Run a module (as source text) in a fresh Node process with tsx, from the repository root. */
function runModule(source: string): Promise<{ code: number; output: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: ROOT, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`, elapsedMs: Date.now() - started });
      },
    );
  });
}

let workDir: string;
let logFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'av-polytician-contract-'));
  logFile = join(workDir, 'received.jsonl');
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fake server itself
// ---------------------------------------------------------------------------

describe('fake Polytician 3.0 server', () => {
  async function replay(config: MCPServerConfig, exchanges: Array<[string, RecordedExchange]>): Promise<void> {
    const client = new PolyticianMCPClient(config);
    await client.connect();
    try {
      for (const [key, exchange] of exchanges) {
        const { name, arguments: args } = exchange.request.params;
        const result = await client.callTool(name, args);
        expect(result, key).toEqual(exchange.response.result);
      }
    } finally {
      await client.disconnect();
    }
  }

  it('answers the recorded calls, errors and removed tools exactly as Polytician 3.0 did', async () => {
    const calls = Object.entries(contract.calls).filter(([key]) => key !== 'health_check.cold');
    await replay(fakeServer(), [
      ...calls,
      ...Object.entries(contract.errors),
      ...Object.entries(contract.removedTools),
      ...Object.entries(contract.vaultToolsWithoutAgentVault),
    ]);
  });

  it('answers the recorded vault_* calls against an unreachable AgentVault', async () => {
    // The fake does not model archival tags, so the notTagged refusal is not replayed.
    const vaultCalls = Object.entries(contract.vaultToolsWithUnreachableAgentVault.calls)
      .filter(([key]) => key !== 'vault_archive_concept.notTagged');
    await replay(fakeServer('--vault', 'unreachable'), vaultCalls);
  });
});

// ---------------------------------------------------------------------------
// PolyticianMCPClient
// ---------------------------------------------------------------------------

describe('PolyticianMCPClient against Polytician 3.0', () => {
  it('sends initialize, then notifications/initialized before any other request', async () => {
    const client = new PolyticianMCPClient(fakeServer('--log', logFile));
    await client.connect();
    const tools = await client.listTools();
    await client.disconnect();

    expect(tools.map((t) => t.name)).toHaveLength(14);
    const [initialize, initialized, next] = readLog(logFile);
    expect(initialize?.method).toBe('initialize');
    expect(initialize?.params?.protocolVersion).toBe('2025-06-18');
    expect(initialize?.params?.clientInfo?.name).toBe('agentvault');
    expect(initialized).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(next?.method).toBe('tools/list');
  });

  it('keeps the server name and version from initialize, since health_check has no version', async () => {
    const client = new PolyticianMCPClient(fakeServer());
    await client.connect();
    await client.disconnect();

    expect(client.getServerInfo()).toEqual({ name: 'polytician', version: '3.0.0' });
    expect(client.getProtocolVersion()).toBe('2025-06-18');
  });

  it('refuses a protocol version it does not support', async () => {
    const client = new PolyticianMCPClient(fakeServer('--protocol', '1999-01-01'));
    await expect(client.connect()).rejects.toThrow(/protocol version 1999-01-01/);
    expect(client.isConnected()).toBe(false);
  });

  it('fails as soon as the server exits without answering, with its exit code and stderr', async () => {
    const client = new PolyticianMCPClient(fakeServer('--exit-on-start'));
    const started = Date.now();
    await expect(client.connect()).rejects.toThrow(/code 1.*Configuration error/s);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('rejects a command that cannot be started instead of crashing', async () => {
    const client = new PolyticianMCPClient({ namespace: 'polytician', entryPoint: join(workDir, 'no-such-server') });
    await expect(client.connect()).rejects.toThrow(/ENOENT/);
  });

  it('clears its request timers, so a process using it exits as soon as its work is done', async () => {
    // The 2.x client left a 30 s timer behind for every request it sent.
    const run = await runModule(`
      import { PolyticianMCPClient } from './src/orchestration/mcp-client.ts';
      const client = new PolyticianMCPClient(${JSON.stringify(fakeServer())});
      await client.connect();
      await client.callTool('get_stats', {});
      await client.disconnect();
      console.log('done');
    `);
    expect(run.output).toContain('done');
    expect(run.code).toBe(0);
    expect(run.elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it('answers a server ping instead of taking it for the response to its own request', async () => {
    const client = new PolyticianMCPClient(fakeServer('--ping', '--log', logFile));
    await client.connect();
    const stats = await client.callToolResult('get_stats', {});
    await client.disconnect();

    expect(stats).toEqual(structuredOf('get_stats'));
    expect(readLog(logFile)).toContainEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('keeps a multi-byte character that a pipe read splits in two', async () => {
    // A response over one pipe read (64 KiB) can end in the middle of a character.
    const markdown = '# 认证 JWT 过期\n\n认证中间件必须拒绝过期的令牌 — JWT 过期检查 ✓ 🔐';
    const client = new PolyticianMCPClient(fakeServer('--split-utf8'));
    await client.connect();
    try {
      const saved = await callPolytician(client, 'save_concept', { markdown });
      expect(saved.markdown).toBe(markdown);
    } finally {
      await client.disconnect();
    }
  });

  it('starts one server when connect() is called again during the handshake', async () => {
    const client = new PolyticianMCPClient(fakeServer('--log', logFile));
    await Promise.all([client.connect(), client.connect()]);
    await client.disconnect();

    expect(readLog(logFile).filter((m) => m.method === 'initialize')).toHaveLength(1);
  });

  it('times out a call after the time the caller gives, with MCPTimeoutError', async () => {
    const client = new PolyticianMCPClient(fakeServer('--hang', 'get_stats'));
    await client.connect();
    try {
      const started = Date.now();
      const error = await client.callTool('get_stats', {}, { timeoutMs: 300 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MCPTimeoutError);
      expect(error).toMatchObject({ method: 'tools/call', tool: 'get_stats', timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await client.disconnect();
    }
  });

  it('returns structuredContent from callToolResult', async () => {
    const client = new PolyticianMCPClient(fakeServer());
    await client.connect();
    try {
      expect(await client.callToolResult('health_check', {})).toEqual(structuredOf('health_check'));
    } finally {
      await client.disconnect();
    }
  });

  it('throws MCPToolError carrying the server code for isError results', async () => {
    const client = new PolyticianMCPClient(fakeServer());
    await client.connect();
    try {
      const v2Search = await client.callToolResult('search_concepts', { query: 'x', limit: 5, min_score: 0.3 })
        .catch((error: unknown) => error);
      expect(v2Search).toBeInstanceOf(MCPToolError);
      expect(v2Search).toMatchObject({ tool: 'search_concepts', code: 'VALIDATION_ERROR' });
      expect((v2Search as Error).message).toContain("Unrecognized key(s) in object: 'limit', 'min_score'");

      await expect(client.callToolResult('read_concept', { id: '00000000-0000-4000-8000-000000000000' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(client.callToolResult('archive_concept', { id: ORCHESTRATION_CONCEPT_ID }))
        .rejects.toThrow('Tool archive_concept not found');
    } finally {
      await client.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

describe('enrichWithPolyticianContext against Polytician 3.0', () => {
  const task = 'Refactor the parser to stream tokens';

  it('searches with { query, k }, keeps relevant hits and reads only their markdown', async () => {
    const result = await enrichWithPolyticianContext(task, { mcpServer: fakeServer('--log', logFile), topK: 5 });

    expect(result.conceptsUsed).toEqual([
      { id: ORCHESTRATION_CONCEPT_ID, name: 'Orchestration Result: session-1', relevanceScore: RELATED_SCORE },
    ]);
    expect(result.enrichedPrompt).toContain('Replaced the recursive descent loop with a streaming tokenizer.');
    expect(result.enrichedPrompt).not.toContain('Rotate the canister controller keys');
    expect(result.enrichedPrompt.endsWith(`## Task\n\n${task}`)).toBe(true);
    expect(result.context.startsWith(`### Orchestration Result: session-1\nID: ${ORCHESTRATION_CONCEPT_ID}\n`)).toBe(true);
    expect(result.enrichedPrompt).toContain(result.context);

    expect(toolArguments(logFile, 'search_concepts')).toEqual([{ query: task, k: 5 }]);
    expect(toolArguments(logFile, 'read_concept')).toEqual([
      { id: ORCHESTRATION_CONCEPT_ID, representations: ['markdown'] },
    ]);
  });

  it('filters by minRelevanceScore on the client', async () => {
    const result = await enrichWithPolyticianContext(task, {
      mcpServer: fakeServer(),
      topK: 5,
      minRelevanceScore: 0.4,
    });
    expect(result.conceptsUsed.map((c) => [c.id, c.name])).toEqual([
      [ORCHESTRATION_CONCEPT_ID, 'Orchestration Result: session-1'],
      [NOTES_CONCEPT_ID, 'Deployment checklist'],
    ]);
  });

  it('keeps k and the query within the tool limits', async () => {
    const longTask = 'parser '.repeat(20_000);
    await enrichWithPolyticianContext(longTask, { mcpServer: fakeServer('--log', logFile), topK: 500 });

    const [args] = toolArguments(logFile, 'search_concepts');
    expect(args?.k).toBe(100);
    expect((args?.query as string).length).toBe(100_000);
  });

  it('throws when Polytician reports an error, so the orchestrator reports it', async () => {
    await expect(enrichWithPolyticianContext(task, { mcpServer: fakeServer('--fail', 'search_concepts') }))
      .rejects.toMatchObject({ name: 'MCPToolError', tool: 'search_concepts', code: 'INTERNAL_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Save path
// ---------------------------------------------------------------------------

describe('saveConceptFromOrchestration against Polytician 3.0', () => {
  it('saves markdown and tags and returns the stored concept id', async () => {
    const id = await saveConceptFromOrchestration(
      'session-1',
      'Refactor the parser to stream tokens',
      'Replaced the recursive descent loop with a streaming tokenizer.',
      ['src/parser.ts', 'tests/parser.test.ts'],
      fakeServer('--log', logFile),
    );

    expect(id).toBe(ORCHESTRATION_CONCEPT_ID);
    const [args] = toolArguments(logFile, 'save_concept');
    expect(args?.tags).toEqual(['orchestration', 'session:session-1']);
    const markdown = args?.markdown as string;
    // The title (what search and enrichment show) is the task; the session is in the body and the tag
    expect(markdown.startsWith('# Refactor the parser to stream tokens\n\nOrchestration session session-1, saved at ')).toBe(true);
    expect(markdown).toContain('## Task\nRefactor the parser to stream tokens');
    expect(markdown).toContain('- src/parser.ts\n- tests/parser.test.ts');
    expect(markdown).toContain('Replaced the recursive descent loop with a streaming tokenizer.');
  });

  it('rejects with the server error instead of returning null', async () => {
    await expect(saveConceptFromOrchestration('session-1', 'task', 'result', [], fakeServer('--fail', 'save_concept')))
      .rejects.toMatchObject({ name: 'MCPToolError', tool: 'save_concept', code: 'INTERNAL_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

describe('ClaudeOrchestrator with Polytician 3.0', () => {
  it('sends the Polytician context to Claude in the user message and reports the saved concept', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'msg_test',
      content: [{ type: 'text', text: '{"done":true,"summary":"ok"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const progress: string[] = [];
    const orchestrator = new ClaudeOrchestrator(workDir);
    const result = await orchestrator.orchestrate({
      task: 'Refactor the parser to stream tokens',
      apiKey: 'test-key',
      polyticianServer: fakeServer(),
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      system: string;
      messages: Array<{ content: string }>;
    };
    expect(body.system).not.toContain('Replaced the recursive descent loop');
    expect(body.messages[0]!.content).toContain('<semantic_memory>');
    expect(body.messages[0]!.content).toContain('Replaced the recursive descent loop with a streaming tokenizer.');
    expect(result.semanticMemory).toEqual({
      conceptsUsed: [{ id: ORCHESTRATION_CONCEPT_ID, name: 'Orchestration Result: session-1', relevanceScore: RELATED_SCORE }],
      savedConceptId: ORCHESTRATION_CONCEPT_ID,
    });
    expect(progress).toContain('Enriched with 1 relevant concepts');
    expect(progress).toContain(`Saved concept: ${ORCHESTRATION_CONCEPT_ID}`);
  });
});
