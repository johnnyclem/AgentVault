/**
 * Receipts for the memory_repo writes the webapp's routes sign, end to end:
 * POST /api/memory-repo/commits and /tombstone capture a receipt for each
 * {ok} write and store it, and GET /api/memory-repo/receipts serves them,
 * newest first, to the Signed memory writes page.
 *
 * The routes, the signed actor, the capture code and the store all run as
 * they are. Writes reach a local server standing in for a replica that
 * certifies its replies (tests/memory-repo/certifying-replica.ts) through
 * the real agent; only the routes' queries (getBranches, getCommit) go to a
 * fake canister, since answering signed queries is beyond the stand-in.
 * Capture must never change a write: a receipt that cannot be built or
 * stored is logged, and the route answers exactly as it would without one.
 *
 * Next.js is not installed at the repository root, so next/server is a
 * stand-in, and webapp modules are imported through variables so the root
 * typecheck does not follow their `@/` imports.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestIdOf } from '@dfinity/agent';
import type { Commit } from '../../src/canister/memory-repo-actor.js';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';
import { ed25519Key, secp256k1Key, type TestKey } from '../fixtures/signing-identities.js';
import { startCertifyingReplica, type CertifyingReplica } from '../memory-repo/certifying-replica.js';

const canister = vi.hoisted(() => ({ actor: {} as Record<string, ReturnType<typeof vi.fn>> }));
// When set, the capture step reports this failure instead of its receipt
const capture = vi.hoisted(() => ({ failure: null as string | null }));
const WEBAPP = vi.hoisted(() => '../../webapp/src');

vi.mock('next/server', () => {
  class NextResponse extends Response {
    static json(body: unknown, init?: ResponseInit): NextResponse {
      const headers = new Headers(init?.headers);
      headers.set('content-type', 'application/json');
      return new NextResponse(JSON.stringify(body), { ...init, headers });
    }
    static next(): NextResponse {
      return new NextResponse(null, { headers: { 'x-middleware-next': '1' } });
    }
  }
  class NextRequest extends Request {
    readonly nextUrl: URL;
    constructor(input: Request | string, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(this.url);
    }
  }
  return { NextResponse, NextRequest };
});

vi.mock('@/lib/server/auth', async () => await import(/* @vite-ignore */ `${WEBAPP}/lib/server/auth`));
vi.mock('@/lib/server/polytician-client', async () => await import(/* @vite-ignore */ `${WEBAPP}/lib/server/polytician-client`));
vi.mock('@/lib/server/memory-write-receipts', async () => await import(/* @vite-ignore */ `${WEBAPP}/lib/server/memory-write-receipts`));
vi.mock('@/canister/identity', async () => await import('../../src/canister/identity.js'));
vi.mock('@/canister/memory-repo-actor', async () => ({
  ...(await import('../../src/canister/memory-repo-actor.js')),
  createMemoryRepoActor: () => canister.actor,
}));
vi.mock('@/canister/memory-repo-receipts', async () => {
  const actual = await import('../../src/canister/memory-repo-receipts.js');
  return {
    ...actual,
    callWithReceipt: async (...args: Parameters<typeof actual.callWithReceipt>) => {
      const captured = await actual.callWithReceipt(...args);
      return capture.failure ? { ...captured, receipt: null, captureError: capture.failure } : captured;
    },
  };
});

type Handler = (request: Request) => Promise<Response>;

async function route(name: string): Promise<Record<'GET' | 'POST', Handler>> {
  return (await import(/* @vite-ignore */ `${WEBAPP}/app/api/${name}/route`)) as Record<'GET' | 'POST', Handler>;
}

const { POST: postCommit } = await route('memory-repo/commits');
const { POST: postTombstone } = await route('memory-repo/tombstone');
const { GET: getReceipts } = await route('memory-repo/receipts');
const { middleware } = (await import(/* @vite-ignore */ `${WEBAPP}/middleware`)) as { middleware: (request: Request) => Response };
const NEXT_SERVER = 'next/server';
const { NextRequest } = (await import(/* @vite-ignore */ NEXT_SERVER)) as { NextRequest: new (request: Request) => Request };

const TOKEN = 'test-token';
const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const COMMIT_TIME = 1_700_000_000_000_000_000n;
const commitBody = {
  branch: 'polytician-main',
  message: 'push concept c1',
  entries: [{ key: 'concepts/c1', data: '{"title":"t"}', tags: ['polytician'] }],
};

interface ReceiptsBody {
  success: boolean;
  data?: {
    receipts: IcpWriteReceipt[];
    nextCursor: string | null;
    skippedLines: number;
    oldestKept: string | null;
    writesConfigured: boolean;
    canisterId: string | null;
  };
  error?: { message: string; code: string };
}

let replica: CertifyingReplica;
let dir: string;
let key: TestKey;

beforeAll(async () => {
  replica = await startCertifyingReplica();
});

afterAll(async () => {
  await replica.close();
});

beforeEach(() => {
  replica.mode = 'v3';
  replica.answer = () => ({ ok: 'commit-1' });
  replica.calls.length = 0;
  capture.failure = null;
  canister.actor = {
    getBranches: vi.fn().mockResolvedValue([['main', 'commit-0'], ['polytician-main', 'commit-0']]),
    getCommit: vi.fn().mockResolvedValue([commit()]),
  };
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'av-receipt-routes-')), 'receipts');
  key = ed25519Key();
  vi.stubEnv('AGENTVAULT_POLYTICIAN_API_TOKEN', TOKEN);
  vi.stubEnv('MEMORY_REPO_CANISTER_ID', CANISTER_ID);
  vi.stubEnv('ICP_LOCAL_URL', replica.host);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', key.pem);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', undefined);
  vi.stubEnv('AGENTVAULT_RECEIPTS_DIR', dir);
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function commit(overrides: Partial<Commit> = {}): Commit {
  return {
    id: 'commit-1',
    timestamp: COMMIT_TIME,
    message: commitBody.message,
    diff: JSON.stringify(commitBody.entries),
    tags: ['polytician'],
    parent: [],
    branch: 'polytician-main',
    ...overrides,
  };
}

function request(urlPath: string, body?: unknown, token: string | null = TOKEN): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function receipts(query = ''): Promise<{ status: number; headers: Headers; body: ReceiptsBody }> {
  const res = await getReceipts(request(`/api/memory-repo/receipts${query}`));
  return { status: res.status, headers: res.headers, body: (await res.json()) as ReceiptsBody };
}

function storedLines(): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean));
}

function postedRequestId(index: number): string {
  return Buffer.from(requestIdOf(replica.calls[index]!.envelope.content)).toString('hex');
}

describe('memory_repo writes through the webapp leave receipts', () => {
  it('stores a receipt for a commit, served by GET /api/memory-repo/receipts, and answers the push as before', async () => {
    const res = await postCommit(request('/api/memory-repo/commits', commitBody));
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        sha: 'commit-1',
        branch: 'polytician-main',
        author: key.principal,
        timestamp: new Date(Number(COMMIT_TIME / 1_000_000n)).toISOString(),
        message: commitBody.message,
        entries: [{ key: 'concepts/c1' }],
      },
    });

    const { status, headers, body: page } = await receipts();
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(page.data!.receipts).toHaveLength(1);
    expect(page.data!.receipts[0]).toMatchObject({
      id: postedRequestId(0),
      network: 'local',
      request: { canisterId: CANISTER_ID, methodName: 'commitToBranch', sender: key.principal },
      result: { ok: 'commit-1' },
      summary: { kind: 'commit', branch: 'polytician-main', message: commitBody.message, entryKeys: ['concepts/c1'] },
    });
    expect(page.data).toMatchObject({ nextCursor: null, skippedLines: 0, writesConfigured: true });
  });

  it('stores a branch receipt, then the commit receipt, for a push that creates its branch', async () => {
    canister.actor.getBranches = vi.fn().mockResolvedValueOnce([['main', 'commit-0']]).mockResolvedValue([['main', 'commit-0'], ['polytician-main', 'commit-0']]);
    replica.answer = (method) => (method === 'createBranchFrom' ? { ok: "Branch 'polytician-main' created" } : { ok: 'commit-1' });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(200);
    const served = (await receipts()).body.data!.receipts;
    expect(served.map((r) => [r.summary.kind, r.result.ok])).toEqual([
      ['commit', 'commit-1'],
      ['branch', "Branch 'polytician-main' created"],
    ]);
    expect(served[1]!.summary).toEqual({ kind: 'branch', branch: 'polytician-main', baseBranch: 'main' });
  });

  it('stores a tombstone receipt, through the v2 call path, and answers 204 as before', async () => {
    replica.mode = 'v2';
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', secp256k1Key().pem);

    const res = await postTombstone(request('/api/memory-repo/tombstone', { branch: 'polytician-main', key: 'concepts/c1' }));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const [stored] = (await receipts()).body.data!.receipts;
    expect(stored!.summary).toMatchObject({ kind: 'tombstone', message: 'tombstone: concepts/c1', entryKeys: ['concepts/c1'] });
    expect(stored!.id).toBe(postedRequestId(0));
  });

  it('stores nothing for an {err} reply, which wrote nothing, and answers 400 as before', async () => {
    replica.answer = () => ({ err: 'Too many tags (maximum 20)' });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('COMMIT_ERROR: Commit failed: Too many tags (maximum 20)');
    expect(storedLines()).toEqual([]);
  });

  it('stores nothing when the canister refuses the signer, and answers 403 as before', async () => {
    replica.answer = () => ({ reject: "Canister called `ic0.trap` with message: 'caller principal is not authorized'" });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('SIGNER_NOT_AUTHORIZED');
    expect(storedLines()).toEqual([]);
  });

  it('answers the push as before when the receipt cannot be stored, and logs why without the memory content', async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'a file where the receipt directory should be');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { sha: string } }).data.sha).toBe('commit-1');
    const logged = consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain(`memory_repo write receipt not stored for commit on branch polytician-main (request ${postedRequestId(0)}, result commit-1)`);
    expect(logged).not.toContain('{"title":"t"}');
    expect(logged).not.toContain(commitBody.message);
  });

  it('answers the push within a second when the disk will not take the receipt, and logs what became of it', { timeout: 15_000 }, async () => {
    let release!: (error: Error) => void;
    const stuck = new Promise<never>((_, reject) => (release = reject));
    const open = vi.spyOn(fs.promises, 'open').mockImplementationOnce(() => stuck);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logged = () => consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = Date.now();
      const res = await Promise.race([
        postCommit(request('/api/memory-repo/commits', commitBody)),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 5_000))),
      ]);
      const elapsed = Date.now() - started;

      expect(res, 'the push was still waiting on its receipt after 5 s').not.toBeNull();
      expect(res!.status).toBe(200);
      expect(((await res!.json()) as { data: { sha: string } }).data.sha).toBe('commit-1');
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3_000);
      expect(open).toHaveBeenCalledTimes(1);
      expect(storedLines()).toEqual([]);
      expect(logged()).toContain(
        `memory_repo write receipt still being stored for commit on branch polytician-main (request ${postedRequestId(0)}, ` +
          'result commit-1) after 1000 ms; answering the write without it',
      );
    } finally {
      clearTimeout(timer);
      release(new Error('the disk came back with an error'));
    }

    // The append goes on after the answer, and reports how it ended
    await vi.waitFor(() =>
      expect(logged()).toContain(
        `memory_repo write receipt not stored for commit on branch polytician-main (request ${postedRequestId(0)}, ` +
          'result commit-1): the disk came back with an error',
      ),
    );
    expect(logged()).not.toContain(commitBody.message);
  });

  it('answers the push as before when no receipt could be built, and logs why', async () => {
    capture.failure = 'the certificate answered no recorded call';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postTombstone(request('/api/memory-repo/tombstone', { branch: 'polytician-main', key: 'concepts/c1' }));

    expect(res.status).toBe(204);
    expect(storedLines()).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      'memory_repo write receipt not captured for tombstone on branch polytician-main: the certificate answered no recorded call',
    );
  });

  it('touches neither the canister nor the store without a signing identity', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(503);
    expect(replica.calls).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

/** A stored receipt line; the store and this route never check signatures, so the evidence fields are placeholders. */
function storedReceipt(n: number, recordedAt = '2026-10-24T12:00:00.000Z'): IcpWriteReceipt {
  return {
    version: 1,
    id: createHash('sha256').update(String(n)).digest('hex'),
    recordedAt,
    network: 'ic',
    request: {
      canisterId: CANISTER_ID,
      methodName: 'commitToBranch',
      arg: '4449444c',
      sender: '2vxsx-fae',
      ingressExpiry: '1800000000000000000',
      nonce: null,
    },
    senderPubkey: 'aa',
    senderSig: 'bb',
    certificate: 'cc',
    result: { ok: `commit-${n}` },
    summary: { kind: 'commit', branch: 'polytician-main' },
  };
}

function seed(count: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => `${JSON.stringify(storedReceipt(i + 1))}\n`).join('');
  fs.writeFileSync(path.join(dir, 'memory-repo-writes-2026-10-24.jsonl'), lines);
}

describe('GET /api/memory-repo/receipts', () => {
  it('answers 401 without the API token, from the route and from the middleware, in the webapp error shape', async () => {
    for (const token of [null, 'wrong-token']) {
      const fromRoute = await getReceipts(request('/api/memory-repo/receipts', undefined, token));
      expect(fromRoute.status).toBe(401);
      expect(((await fromRoute.json()) as ReceiptsBody).error?.code).toBe('UNAUTHORIZED');

      const fromMiddleware = middleware(new NextRequest(request('/api/memory-repo/receipts', undefined, token)));
      expect(fromMiddleware.status).toBe(401);
      expect(((await fromMiddleware.json()) as ReceiptsBody).error?.code).toBe('UNAUTHORIZED');
    }
    expect(middleware(new NextRequest(request('/api/memory-repo/receipts'))).headers.get('x-middleware-next')).toBe('1');
  });

  it('answers an empty page when nothing has been recorded', async () => {
    expect((await receipts()).body).toEqual({
      success: true,
      data: { receipts: [], nextCursor: null, skippedLines: 0, oldestKept: null, writesConfigured: true, canisterId: CANISTER_ID },
    });
  });

  it('names the memory_repo canister this server writes to, so the page can require every receipt to name it', async () => {
    seed(1);
    expect((await receipts()).body.data!.canisterId).toBe(CANISTER_ID);

    // Without a signing identity the server writes nothing new, but its receipts are still for this canister
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);
    expect((await receipts()).body.data).toMatchObject({ writesConfigured: false, canisterId: CANISTER_ID });

    for (const unset of [undefined, '']) {
      vi.stubEnv('MEMORY_REPO_CANISTER_ID', unset);
      const { status, body } = await receipts();
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ writesConfigured: false, canisterId: null });
      expect(body.data!.receipts).toHaveLength(1);
    }
  });

  it('says whether this server makes signed writes at all, from its configuration alone', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);
    expect((await receipts()).body.data!.writesConfigured).toBe(false);

    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', '/etc/agentvault/webapp.pem');
    expect((await receipts()).body.data!.writesConfigured).toBe(true);

    vi.stubEnv('MEMORY_REPO_CANISTER_ID', undefined);
    expect((await receipts()).body.data!.writesConfigured).toBe(false);
  });

  it('pages newest first, 10 at a time unless asked for up to 50, with a cursor for the rest', async () => {
    seed(12);

    const first = (await receipts()).body.data!;
    expect(first.receipts.map((r) => r.result.ok)).toEqual(
      Array.from({ length: 10 }, (_, i) => `commit-${12 - i}`),
    );
    expect(first.receipts[0]).toEqual(storedReceipt(12));
    expect(first.oldestKept).toBe('2026-10-24');

    const rest = (await receipts(`?limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`)).body.data!;
    expect(rest.receipts.map((r) => r.result.ok)).toEqual(['commit-2', 'commit-1']);
    expect(rest.nextCursor).toBeNull();

    expect((await receipts('?limit=50')).body.data!.receipts).toHaveLength(12);
    expect((await receipts('?limit=1')).body.data!.receipts).toHaveLength(1);
  });

  it('answers 400 INVALID_LIMIT for a limit that is not a whole number from 1 to 50', async () => {
    for (const limit of ['0', '51', '100', 'abc', '1.5', '-1', '', '1e1']) {
      const { status, body } = await receipts(`?limit=${encodeURIComponent(limit)}`);
      expect(status, limit).toBe(400);
      expect(body, limit).toEqual({
        success: false,
        error: { message: 'limit must be a whole number from 1 to 50.', code: 'INVALID_LIMIT' },
      });
    }
  });

  it('answers 400 INVALID_CURSOR for a cursor the server did not issue, or one for receipts no longer kept', async () => {
    seed(1);
    const traversal = Buffer.from(JSON.stringify({ s: '../archives/index.yaml', l: null })).toString('base64url');
    // Well formed, but the operator has since pruned that day
    const pruned = Buffer.from(JSON.stringify({ s: 'memory-repo-writes-2026-10-01.jsonl', l: null })).toString('base64url');

    for (const cursor of [traversal, 'garbage', pruned]) {
      const { status, body } = await receipts(`?cursor=${cursor}`);
      expect(status).toBe(400);
      expect(body.error).toEqual({
        message: 'The cursor is not one this server issued, or the receipts it points to are no longer kept. Reload to start from the newest.',
        code: 'INVALID_CURSOR',
      });
    }
  });

  it('answers 500 RECEIPTS_UNREADABLE when the store cannot be read, with the detail in the log only', async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = await receipts();

    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { message: 'The server could not read its memory write receipts.', code: 'RECEIPTS_UNREADABLE' },
    });
    expect(consoleError.mock.calls.join(' ')).toContain(dir);
  });

  it('sends no verdict: nothing in the answer says verified, valid or trusted', async () => {
    seed(3);
    const text = await (await getReceipts(request('/api/memory-repo/receipts'))).text();

    expect(text).not.toMatch(/"(verified|valid|trusted|confirmed)"/i);
  });
});
