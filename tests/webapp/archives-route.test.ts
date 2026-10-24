/**
 * The webapp's GET /api/archives, which the Archives page and the Vault list
 * read. Each record carries the archived agent's name (the Vault titles its
 * archive rows with it) next to the fields the Archives page already used,
 * with the archive store's statuses mapped to the page's.
 *
 * The archive store is replaced with fixed records; Next.js is not installed
 * at the repository root, so next/server is a stand-in.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { join } from 'node:path';

const store = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
  listedFor: [] as Array<string | undefined>,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
  },
}));
vi.mock('@/archival/archive-manager.js', () => ({ deleteArchive: () => false }));
vi.mock('@/lib/server/archive-workflow', () => ({
  listAllArchiveRecords: (agentName?: string) => {
    store.listedFor.push(agentName);
    return agentName ? store.records.filter((record) => record['agentName'] === agentName) : store.records;
  },
}));

type Handler = (request: Request) => Promise<Response>;

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const ROUTE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', 'api', 'archives', 'route.ts');
let GET: Handler;

beforeAll(async () => {
  ({ GET } = (await import(ROUTE)) as { GET: Handler });
});

beforeEach(() => {
  store.listedFor = [];
  store.records = [
    {
      id: 'archive-1761300000000-1a2b3c4d',
      agentName: 'research-agent',
      agentVersion: '1.0.0',
      transactionId: 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U',
      timestamp: new Date('2026-10-22T10:00:00.000Z'),
      sizeBytes: 2048,
      checksum: 'abc123',
      tags: { canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', cost: '0.25' },
      status: 'confirmed',
    },
    {
      id: 'archive-1761400000000-5e6f7a8b',
      agentName: 'support-agent',
      agentVersion: '2.1.0',
      timestamp: new Date('2026-10-23T10:00:00.000Z'),
      sizeBytes: 512,
      checksum: 'def456',
      tags: {},
      status: 'pending',
    },
  ];
});

async function list(query = ''): Promise<{ status: number; body: { success: boolean; data?: Array<Record<string, unknown>> } }> {
  const response = await GET(new Request(`http://localhost/api/archives${query}`));
  return { status: response.status, body: (await response.json()) as { success: boolean; data?: Array<Record<string, unknown>> } };
}

describe('GET /api/archives', () => {
  it('returns each archive with its agent name', async () => {
    const { status, body } = await list();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([
      {
        id: 'archive-1761300000000-1a2b3c4d',
        agentName: 'research-agent',
        status: 'completed',
        canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
        timestamp: '2026-10-22T10:00:00.000Z',
        size: 2048,
        checksum: 'abc123',
        arweaveTxId: 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U',
        cost: 0.25,
      },
      {
        id: 'archive-1761400000000-5e6f7a8b',
        agentName: 'support-agent',
        status: 'prepared',
        canisterId: '',
        timestamp: '2026-10-23T10:00:00.000Z',
        size: 512,
        checksum: 'def456',
      },
    ]);
  });

  it('narrows to one agent with ?agent=', async () => {
    const { body } = await list('?agent=support-agent');

    expect(store.listedFor).toEqual(['support-agent']);
    expect(body.data?.map((archive) => archive['agentName'])).toEqual(['support-agent']);
  });
});
