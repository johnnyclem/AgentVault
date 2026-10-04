/**
 * Polytician namespaces and spawn settings, against the fake Polytician 3.0
 * server (tests/fixtures/polytician-3.0/fake-server.mjs).
 *
 * One agent's concepts live in one Polytician namespace whichever AgentVault
 * surface wrote them, so every call to a tool that takes a namespace must name
 * it. The fake keeps state per namespace and, with --require-namespace, refuses
 * a call that omits or changes it. It also records the arguments and the
 * POLYTICIAN_AV_* environment it was started with (--startup-log).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolyticianMCPClient, MCPToolError, type MCPServerConfig } from '../../src/orchestration/mcp-client.js';
import {
  callPolytician,
  NAMESPACED_POLYTICIAN_TOOLS,
  type PolyticianToolName,
} from '../../src/orchestration/polytician-tools.js';
import { enrichWithPolyticianContext, saveConceptFromOrchestration } from '../../src/orchestration/polytician-enricher.js';
import { polyticianServerConfig } from '../../src/orchestration/polytician-config.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'polytician-3.0');
const FAKE_SERVER = join(FIXTURE_DIR, 'fake-server.mjs');

interface ContractTool {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}
const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contract.json'), 'utf8')) as {
  toolsList: { tools: ContractTool[]; vaultTools: ContractTool[] };
  calls: Record<string, { response: { result: { structuredContent: Record<string, unknown> } } }>;
};
const ORCHESTRATION_ID = contract.calls['save_concept']!.response.result.structuredContent.id as string;

function entry(...flags: string[]): string {
  return [process.execPath, FAKE_SERVER, ...flags].join(' ');
}

let workDir: string;
let logFile: string;
let startupLog: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'av-polytician-ns-'));
  logFile = join(workDir, 'received.jsonl');
  startupLog = join(workDir, 'startup.jsonl');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function calls(): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { method?: string; params?: { name: string; arguments: Record<string, unknown> } })
    .filter((m) => m.method === 'tools/call')
    .map((m) => m.params!);
}

function startups(): Array<{ argv: string[]; env: Record<string, string> }> {
  return readFileSync(startupLog, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as never);
}

async function withClient<T>(config: MCPServerConfig, run: (client: PolyticianMCPClient) => Promise<T>): Promise<T> {
  const client = new PolyticianMCPClient(config);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.disconnect();
  }
}

describe('the Polytician namespace', () => {
  it('is sent to exactly the tools, of those AgentVault calls, whose input schema takes one', () => {
    const called = ['save_concept', 'read_concept', 'delete_concept', 'list_concepts', 'search_concepts', 'get_stats',
      'health_check', 'vault_memory_push', 'vault_memory_pull', 'vault_archive_concept', 'vault_memory_repo_log'];
    const schemas = new Map([...contract.toolsList.tools, ...contract.toolsList.vaultTools].map((tool) => [tool.name, tool.inputSchema]));
    const takeNamespace = called.filter((name) => 'namespace' in (schemas.get(name)!.properties ?? {}));

    expect([...NAMESPACED_POLYTICIAN_TOOLS].sort()).toEqual(takeNamespace.sort());
  });

  it('goes with every call to a tool that takes one, and not to one that does not', async () => {
    const config: MCPServerConfig = {
      namespace: 'polytician',
      entryPoint: entry('--vault', 'ok', '--seed-namespace', 'agent-a', '--require-namespace', 'agent-a', '--log', logFile),
      polyticianNamespace: 'agent-a',
    };

    await withClient(config, async (client) => {
      const stats = await callPolytician(client, 'get_stats', {});
      expect(stats.conceptCount).toBe(2);
      expect((await callPolytician(client, 'health_check', {})).database.conceptCount).toBe(2);
      const { results } = await callPolytician(client, 'search_concepts', { query: 'refactor the parser', k: 5 });
      expect(results.map((r) => r.namespace)).toEqual(['agent-a', 'agent-a']);
      expect((await callPolytician(client, 'list_concepts', { limit: 10 })).total).toBe(2);
      expect((await callPolytician(client, 'read_concept', { id: ORCHESTRATION_ID })).namespace).toBe('agent-a');
      expect((await callPolytician(client, 'save_concept', { markdown: '# A note' })).namespace).toBe('agent-a');
      await callPolytician(client, 'vault_memory_push', { conceptId: ORCHESTRATION_ID });
      await callPolytician(client, 'vault_memory_pull', {});
      await callPolytician(client, 'vault_archive_concept', { conceptId: ORCHESTRATION_ID });
      await callPolytician(client, 'vault_memory_repo_log', {});
      await callPolytician(client, 'delete_concept', { id: ORCHESTRATION_ID });
    });

    const sent = calls();
    const tools: PolyticianToolName[] = ['get_stats', 'health_check', 'search_concepts', 'list_concepts', 'read_concept',
      'save_concept', 'vault_memory_push', 'vault_memory_pull', 'vault_archive_concept', 'delete_concept'];
    for (const tool of tools) {
      expect(sent.find((call) => call.name === tool)?.arguments.namespace, tool).toBe('agent-a');
    }
    expect(sent.find((call) => call.name === 'vault_memory_repo_log')?.arguments).toEqual({});
  });

  it('keeps one namespace apart from another', async () => {
    const config = (namespace: string): MCPServerConfig => ({
      namespace: 'polytician',
      entryPoint: entry('--seed-namespace', 'agent-b'),
      polyticianNamespace: namespace,
    });

    await withClient(config('agent-a'), async (client) => {
      expect((await callPolytician(client, 'search_concepts', { query: 'refactor the parser' })).results).toEqual([]);
      expect((await callPolytician(client, 'get_stats', {})).conceptCount).toBe(0);
      await expect(callPolytician(client, 'read_concept', { id: ORCHESTRATION_ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    await withClient(config('agent-b'), async (client) => {
      expect((await callPolytician(client, 'search_concepts', { query: 'refactor the parser' })).results).toHaveLength(2);
    });
  });

  it('reaches enrichment and the orchestration save', async () => {
    const server: MCPServerConfig = {
      namespace: 'polytician',
      entryPoint: entry('--seed-namespace', 'agent-a', '--require-namespace', 'agent-a', '--log', logFile),
      polyticianNamespace: 'agent-a',
    };

    const enrichment = await enrichWithPolyticianContext('Refactor the parser to stream tokens', { mcpServer: server });
    expect(enrichment.conceptsUsed.map((c) => c.id)).toEqual([ORCHESTRATION_ID]);
    const saved = await saveConceptFromOrchestration('session-1', 'Refactor the parser', 'Done.', [], server);
    expect(saved).toBe(ORCHESTRATION_ID);

    expect(calls().map((call) => [call.name, call.arguments.namespace])).toEqual([
      ['search_concepts', 'agent-a'],
      ['read_concept', 'agent-a'],
      ['save_concept', 'agent-a'],
    ]);
  });

  it('is left to Polytician (its "default") when the config names none, as before', async () => {
    await withClient({ namespace: 'polytician', entryPoint: entry('--log', logFile) }, async (client) => {
      await callPolytician(client, 'get_stats', {});
    });
    expect(calls()[0]!.arguments).toEqual({});
  });

  it('reports NAMESPACE_DENIED with the namespace AgentVault asked for and how to allow it', async () => {
    const config: MCPServerConfig = {
      namespace: 'polytician',
      entryPoint: entry('--namespaces', 'agent-b,agent-c'),
      polyticianNamespace: 'agent-a',
    };

    const error = await withClient(config, (client) => callPolytician(client, 'search_concepts', { query: 'x' }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPToolError);
    expect(error).toMatchObject({ name: 'MCPToolError', code: 'NAMESPACE_DENIED', tool: 'search_concepts', namespace: 'agent-a' });
    expect((error as Error).message).toContain("Namespace 'agent-a' is not in this server's POLYTICIAN_NAMESPACES allowlist");
    expect((error as Error).message).toMatch(/add 'agent-a' to Polytician's POLYTICIAN_NAMESPACES/i);
  });
});

describe('spawning Polytician', () => {
  it('passes the config file as --config and the env map over AgentVault\'s own environment', async () => {
    const configFile = join(workDir, 'polytician.json');
    writeFileSync(configFile, JSON.stringify({ agentVault: { apiBaseUrl: 'https://vault.example.com' } }));
    const config: MCPServerConfig = {
      namespace: 'polytician',
      entryPoint: entry('--vault', 'auto', '--startup-log', startupLog),
      configPath: configFile,
      env: { POLYTICIAN_AV_API_TOKEN: 'from-the-env-map' },
    };

    const tools = await withClient(config, (client) => client.listTools());

    expect(tools.map((t) => t.name)).toContain('vault_memory_push');
    expect(tools.map((t) => t.name)).not.toContain('vault_archive_concept');
    const [startup] = startups();
    expect(startup!.argv.slice(-2)).toEqual(['--config', configFile]);
    expect(startup!.env).toEqual({ POLYTICIAN_AV_API_TOKEN: 'from-the-env-map', MCP_MODE: 'stdio' });
  });

  it('gives Polytician the AgentVault settings polyticianServerConfig injects, so it registers the vault_* tools', async () => {
    const config = polyticianServerConfig(
      { entryPoint: entry('--vault', 'auto', '--startup-log', startupLog), namespace: 'agent-a' },
      { AGENTVAULT_API_URL: 'http://localhost:3000', AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-token' },
    );

    const tools = await withClient(config, (client) => client.listTools());

    // vault_archive_concept also needs agentVault.archival enabled in Polytician's config file
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['vault_memory_push', 'vault_memory_pull', 'vault_memory_repo_log']));
    expect(tools.map((t) => t.name)).not.toContain('vault_archive_concept');
    expect(startups()[0]!.env).toMatchObject({ POLYTICIAN_AV_API_URL: 'http://localhost:3000', POLYTICIAN_AV_API_TOKEN: 'av-token' });
  });
});
