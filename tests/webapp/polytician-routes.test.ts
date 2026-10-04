/**
 * The webapp's /api/polytician/[agentId]/* routes, run against the fake
 * Polytician 3.0 server (tests/fixtures/polytician-3.0/fake-server.mjs).
 *
 * The agentId in the path is the agent's name (the webapp keys agents by it),
 * and it is the Polytician namespace the route works in, so one agent's
 * concepts stay in one namespace whichever surface wrote them. An agentId that
 * cannot be a namespace is answered 400 without starting Polytician.
 *
 * Next.js is not installed at the repository root: next/server and the
 * webapp's @/ imports are mapped to stand-ins and to the real modules.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));
// The routes check the token themselves too; middleware.ts does it first in the app
vi.mock('@/lib/server/auth', () => ({
  validateAuthToken: () => ({ authorized: true }),
  unauthorizedResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/server/polytician', () => vi.importActual('../../webapp/src/lib/server/polytician.ts'));
vi.mock('@/orchestration/mcp-client', () => vi.importActual('../../src/orchestration/mcp-client.ts'));
vi.mock('@/orchestration/polytician-tools', () => vi.importActual('../../src/orchestration/polytician-tools.ts'));
vi.mock('@/orchestration/polytician-config', () => vi.importActual('../../src/orchestration/polytician-config.ts'));

const ROOT = join(import.meta.dirname, '..', '..');
const ROUTES_DIR = join(ROOT, 'webapp', 'src', 'app', 'api', 'polytician', '[agentId]');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'polytician-3.0');
const FAKE_SERVER = join(FIXTURE_DIR, 'fake-server.mjs');
const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contract.json'), 'utf8')) as {
  calls: Record<string, { response: { result: { structuredContent: Record<string, unknown> } } }>;
};
const CONCEPT_ID = contract.calls['save_concept']!.response.result.structuredContent.id as string;

type Handler = (request: never, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'DELETE', Handler>>;

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const load = (route: string) => import(join(ROUTES_DIR, route, 'route.ts')) as Promise<RouteModule>;
let stats: RouteModule;
let search: RouteModule;
let concepts: RouteModule;
let concept: RouteModule;
let archive: RouteModule;

beforeAll(async () => {
  [stats, search, concepts, concept, archive] = await Promise.all([
    load('stats'), load('search'), load('concepts'), load('concepts/[id]'), load('archive'),
  ]);
});

async function call(handler: Handler, url: string, params: Record<string, string>, init?: RequestInit) {
  const response = await handler(new Request(`http://localhost${url}`, init) as never, { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } };
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** Every route, for an agent. */
function routes(agentId: string) {
  return [
    () => call(stats.GET!, `/api/polytician/${agentId}/stats`, { agentId }),
    () => call(search.GET!, `/api/polytician/${agentId}/search?q=parser`, { agentId }),
    () => call(concepts.GET!, `/api/polytician/${agentId}/concepts`, { agentId }),
    () => call(concepts.POST!, `/api/polytician/${agentId}/concepts`, { agentId }, json({ markdown: '# Note' })),
    () => call(concept.GET!, `/api/polytician/${agentId}/concepts/${CONCEPT_ID}`, { agentId, id: CONCEPT_ID }),
    () => call(concept.DELETE!, `/api/polytician/${agentId}/concepts/${CONCEPT_ID}`, { agentId, id: CONCEPT_ID }, { method: 'DELETE' }),
    () => call(archive.POST!, `/api/polytician/${agentId}/archive`, { agentId }, json({ conceptId: CONCEPT_ID })),
  ];
}

let workDir: string;
let logFile: string;
let startupLog: string;
const savedEnv = { ...process.env };

function useFake(...flags: string[]): void {
  process.env['POLYTICIAN_ENTRY_POINT'] = [process.execPath, FAKE_SERVER, '--log', logFile, '--startup-log', startupLog, ...flags].join(' ');
}

function startups(): Array<{ argv: string[]; env: Record<string, string> }> {
  if (!existsSync(startupLog)) return [];
  return readFileSync(startupLog, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as never);
}

function sentNamespaces(): Array<[string, unknown]> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { method?: string; params?: { name: string; arguments: Record<string, unknown> } })
    .filter((m) => m.method === 'tools/call')
    .map((m) => [m.params!.name, m.params!.arguments.namespace]);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'av-webapp-polytician-'));
  logFile = join(workDir, 'received.jsonl');
  startupLog = join(workDir, 'startup.jsonl');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENTVAULT_') || key.startsWith('POLYTICIAN_')) delete process.env[key];
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  rmSync(workDir, { recursive: true, force: true });
});

describe('webapp Polytician routes: agentId is the namespace', () => {
  it('works in the agent\'s namespace on every route, and the agent sees only its own concepts', async () => {
    useFake('--vault', 'ok', '--seed-namespace', 'agent-a', '--require-namespace', 'agent-a');

    const [statsRoute, searchRoute, listRoute, saveRoute, readRoute, deleteRoute, archiveRoute] = routes('agent-a');
    const statsAnswer = await statsRoute!();
    expect(statsAnswer.status, JSON.stringify(statsAnswer.body)).toBe(200);
    expect(statsAnswer.body.data).toMatchObject({ agentId: 'agent-a', namespace: 'agent-a', stats: { conceptCount: 2 } });
    expect((await searchRoute!()).body.data?.results).toHaveLength(2);
    expect((await listRoute!()).body.data?.total).toBe(2);
    expect((await readRoute!()).body.data?.namespace).toBe('agent-a');
    expect((await archiveRoute!()).status).toBe(200);
    expect((await saveRoute!()).body.data?.namespace).toBe('agent-a');
    expect((await deleteRoute!()).status).toBe(200);

    const sent = sentNamespaces();
    expect(sent.map(([tool]) => tool)).toEqual(expect.arrayContaining(['get_stats', 'health_check', 'search_concepts', 'list_concepts',
      'read_concept', 'save_concept', 'delete_concept', 'vault_archive_concept']));
    expect(sent.filter(([, namespace]) => namespace !== 'agent-a')).toEqual([]);
  }, 60_000);

  it("does not show another agent's concepts", async () => {
    useFake('--seed-namespace', 'agent-a');
    const [statsRoute, searchRoute, listRoute, , readRoute] = routes('agent-b');

    expect((await statsRoute!()).body.data).toMatchObject({ stats: { conceptCount: 0 } });
    expect((await searchRoute!()).body.data?.results).toEqual([]);
    expect((await listRoute!()).body.data?.total).toBe(0);
    expect((await readRoute!()).status).toBe(404);
  }, 60_000);

  it.each(['my agent', '-agent', 'agent/../other', 'x'.repeat(65), 'agënt'])('answers 400 for agentId %j without starting Polytician', async (agentId) => {
    useFake();
    for (const route of routes(agentId)) {
      const answer = await route();
      expect(answer.status).toBe(400);
      expect(answer.body.error).toMatchObject({ code: 'INVALID_AGENT_ID' });
      expect(answer.body.error?.message).toMatch(/namespace/);
    }
    expect(existsSync(startupLog)).toBe(false);
  });

  it('answers 403 with the namespace and how to allow it when Polytician denies it', async () => {
    useFake('--namespaces', 'agent-b');
    const answer = await routes('agent-a')[0]!();

    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('NAMESPACE_DENIED');
    expect(answer.body.error?.message).toContain("Namespace 'agent-a' is not in this server's POLYTICIAN_NAMESPACES allowlist");
  }, 30_000);
});

describe("webapp Polytician routes: Polytician's AgentVault settings", () => {
  it('passes AGENTVAULT_API_URL and the API token on to Polytician when both are set', async () => {
    useFake('--seed-namespace', 'agent-a');
    process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] = 'webapp-token';
    expect((await routes('agent-a')[0]!()).status).toBe(200);
    process.env['AGENTVAULT_API_URL'] = 'https://vault.example.com';
    expect((await routes('agent-a')[0]!()).status).toBe(200);

    const [without, withUrl] = startups();
    expect(without!.env).toEqual({ MCP_MODE: 'stdio' });
    expect(withUrl!.env).toEqual({ POLYTICIAN_AV_API_URL: 'https://vault.example.com', POLYTICIAN_AV_API_TOKEN: 'webapp-token', MCP_MODE: 'stdio' });
  }, 60_000);

  it("archives in the agent's namespace once Polytician has archival configured, and says what is missing before", async () => {
    process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] = 'webapp-token';
    process.env['AGENTVAULT_API_URL'] = 'https://vault.example.com';
    useFake('--vault', 'auto', '--seed-namespace', 'agent-a', '--require-namespace', 'agent-a');
    const notConfigured = await routes('agent-a')[6]!();
    expect(notConfigured.status).toBe(503);
    expect(notConfigured.body.error).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(notConfigured.body.error?.message).toContain('agentVault.archival');

    const configFile = join(workDir, 'polytician.json');
    writeFileSync(configFile, JSON.stringify({ agentVault: { apiBaseUrl: 'https://vault.example.com', archival: { enabled: true, tagFilter: ['archive'] } } }));
    useFake('--vault', 'auto', '--seed-namespace', 'agent-a', '--require-namespace', 'agent-a', '--config', configFile);
    const archived = await routes('agent-a')[6]!();
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.data).toMatchObject({ archived: true });
  }, 60_000);

  it('answers 503 POLYTICIAN_CONFIG_ERROR, without the token, when AGENTVAULT_API_URL is one Polytician would refuse', async () => {
    useFake();
    process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] = 'webapp-token';
    process.env['AGENTVAULT_API_URL'] = 'http://vault.example.com';

    const answer = await routes('agent-a')[0]!();

    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe('POLYTICIAN_CONFIG_ERROR');
    expect(answer.body.error?.message).toContain('AGENTVAULT_API_URL');
    expect(JSON.stringify(answer.body)).not.toContain('webapp-token');
    expect(existsSync(startupLog)).toBe(false);
  });
});
