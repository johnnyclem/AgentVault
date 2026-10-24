/**
 * The webapp's GET /api/vault/[id]/proof, which the Evidence page reads. It
 * used to invent a "proof" for any id: signatures marked verified, coverage,
 * a confirmed Arweave anchor and a compliance score. Now an unknown agent is
 * a 404, and a known agent gets only the Arweave receipts the archive index
 * holds for it, with no verdict of any kind: whether a transaction was mined
 * and holds the recorded bytes is checked in the browser.
 *
 * The agent store and archive index are replaced with fixed records; the
 * receipts mapper runs as it is. Next.js is not installed at the repository
 * root, so next/server is a stand-in.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const store = vi.hoisted(() => ({
  agents: {} as Record<string, { id: string; name: string }>,
  records: [] as Array<Record<string, unknown>>,
  listedFor: [] as Array<string | undefined>,
  failListing: false,
}));

const WEBAPP = vi.hoisted(() => '../../webapp/src');

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));
vi.mock('@/lib/server/agent-models', () => ({
  buildAgentModel: (id: string) => store.agents[id] ?? null,
}));
vi.mock('@/lib/server/archive-workflow', () => ({
  listAllArchiveRecords: (agentName?: string) => {
    store.listedFor.push(agentName);
    if (store.failListing) throw new Error('index.yaml is unreadable');
    return store.records.filter((record) => record['agentName'] === agentName);
  },
}));
vi.mock('@/lib/proof/receipts', async () => await import(/* @vite-ignore */ `${WEBAPP}/lib/proof/receipts`));

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

interface Body {
  success: boolean;
  data?: { agentId: string; agentName: string; receipts: Array<Record<string, unknown>>; generatedAt: string };
  error?: { message: string; code?: string };
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const ROUTE_DIR = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', 'api', 'vault', '[id]', 'proof');
let GET: Handler;

beforeAll(async () => {
  ({ GET } = (await import(join(ROUTE_DIR, 'route.ts'))) as { GET: Handler });
});

const TX_A = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';
const TX_B = 'tDHtC3A3H8mdz7OQh7gDs2LFKWr4vVQtnIjxs7WUaoQ';
const TX_C = '44_KYzKA_rIOXmxJpznHLw7o1oPcW2Y6pWhDxMyRtLg';
const CHECKSUM = 'a'.repeat(64);

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'archive-1761300000000-1a2b3c4d',
    agentName: 'research-agent',
    agentVersion: '1.0.0',
    timestamp: new Date('2026-10-22T10:00:00.000Z'),
    sizeBytes: 2048,
    checksum: CHECKSUM,
    tags: { canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai' },
    status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  store.listedFor = [];
  store.failListing = false;
  store.agents = {
    'research-agent': { id: 'research-agent', name: 'Research agent' },
    'support-agent': { id: 'support-agent', name: 'Support agent' },
  };
  store.records = [
    record({ id: 'archive-a', transactionId: TX_A, status: 'confirmed' }),
    record({ id: 'archive-b', transactionId: TX_B, status: 'pending', timestamp: '2026-10-23T09:30:00.000Z' }),
    record({ id: 'archive-staged', status: 'pending' }),
    record({ id: 'archive-failed-upload', status: 'failed', tags: { error: 'arweave is required' } }),
    record({ id: 'archive-support', agentName: 'support-agent', transactionId: TX_C, status: 'confirmed', blockHeight: 987_654 }),
  ];
});

async function evidence(id: string): Promise<{ status: number; body: Body }> {
  const response = await GET(new Request(`http://localhost/api/vault/${id}/proof`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as Body };
}

/** Every key anywhere in a JSON value, at any depth. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
  }
  return [];
}

describe('GET /api/vault/[id]/proof', () => {
  it('answers 404 with no data for an agent that does not exist, without reading the archive index', async () => {
    const { status, body } = await evidence('ghost-agent');

    expect(status).toBe(404);
    expect(body).toEqual({ success: false, error: { message: "No agent 'ghost-agent'", code: 'AGENT_NOT_FOUND' } });
    expect(store.listedFor).toEqual([]);
  });

  it('lists only the agent\'s archives that reached Arweave, each labelled submitted', async () => {
    const { status, body } = await evidence('research-agent');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(store.listedFor).toEqual(['research-agent']);
    expect(body.data?.agentId).toBe('research-agent');
    expect(body.data?.agentName).toBe('Research agent');
    expect(body.data?.receipts).toEqual([
      {
        archiveId: 'archive-a',
        txId: TX_A,
        checksum: CHECKSUM,
        sizeBytes: 2048,
        recordedAt: '2026-10-22T10:00:00.000Z',
        recordedStatus: 'submitted',
      },
      {
        archiveId: 'archive-b',
        txId: TX_B,
        checksum: CHECKSUM,
        sizeBytes: 2048,
        recordedAt: '2026-10-23T09:30:00.000Z',
        recordedStatus: 'submitted',
      },
    ]);
    expect(Number.isNaN(Date.parse(body.data?.generatedAt ?? ''))).toBe(false);
  });

  it('gives each agent its own receipts and nothing made up', async () => {
    const support = await evidence('support-agent');

    expect(support.body.data?.receipts.map((receipt) => receipt['txId'])).toEqual([TX_C]);

    store.records = [];
    const empty = await evidence('research-agent');

    expect(empty.status).toBe(200);
    expect(empty.body.data?.receipts).toEqual([]);
  });

  it('sends no verdict, score or server-side block data anywhere in the response', async () => {
    const { body } = await evidence('support-agent');
    const keys = allKeys(body);
    const text = JSON.stringify(body);

    expect(keys.filter((key) => /verif|confirm|complian|coverage|score|grade|vetkey|signature|block|share/i.test(key))).toEqual([]);
    // The index said 'confirmed' and held a block height for this record; neither reaches the page.
    expect(text).not.toMatch(/confirmed|987654/);
  });

  it('answers 500 with no data when the archive index cannot be read', async () => {
    store.failListing = true;

    const { status, body } = await evidence('research-agent');

    expect(status).toBe(500);
    // Says what failed, rather than repeating the page's "Couldn't load evidence." heading
    expect(body).toEqual({
      success: false,
      error: { message: 'The server could not read this agent or its archive records.' },
    });
  });

  it('no longer offers the unsigned share link', () => {
    expect(existsSync(join(ROUTE_DIR, 'share', 'route.ts'))).toBe(false);
  });
});
