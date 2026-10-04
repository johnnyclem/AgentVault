/**
 * The webapp's memory_repo routes, which Polytician's vault_memory_push and
 * vault_memory_pull call. Writes (POST /api/memory-repo/commits and
 * /tombstone) sign with the server's identity and fail closed with a 503
 * when it has none: the canister refuses anonymous writes. They commit with
 * the canister's branch-addressed calls (commitToBranch, createBranchFrom),
 * so concurrent pushes to different branches cannot land on each other's
 * branch. The branch read stays anonymous.
 *
 * Every error body has the shape Polytician's AgentVault client reads
 * ({ code, error: <message> }): it keeps only `error` as the message, so an
 * object there reached Polytician users as "[object Object]".
 *
 * The routes run as they are; only their `@/` imports are mapped (the
 * webapp's tsconfig aliases) and createMemoryRepoActor is wrapped to hand
 * back a fake canister while recording the agent the route built. Webapp
 * modules are imported through variables so the root typecheck, which does
 * not know the webapp's aliases, does not follow them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HttpAgent } from '@dfinity/agent';
import type { Commit } from '../../src/canister/memory-repo-actor.js';
import { ed25519Key, secp256k1Key } from '../fixtures/signing-identities.js';

const canister = vi.hoisted(() => ({
  created: [] as Array<{ canisterId: string; agent: HttpAgent }>,
  actor: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

const WEBAPP = vi.hoisted(() => '../../webapp/src');

// Next.js is not installed at the repository root (CI installs only the root
// dependencies), so next/server is a stand-in with what these routes and the
// middleware use: NextResponse as a Response subclass with json() and next(),
// and NextRequest with nextUrl.
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
vi.mock('@/canister/identity', async () => await import('../../src/canister/identity.js'));
vi.mock('@/canister/memory-repo-branch-state', async () => await import('../../src/canister/memory-repo-branch-state.js'));
vi.mock('@/canister/memory-repo-actor', async () => {
  const actual = await import('../../src/canister/memory-repo-actor.js');
  return {
    ...actual,
    createMemoryRepoActor: (canisterId: string, agent: HttpAgent) => {
      canister.created.push({ canisterId, agent });
      return canister.actor;
    },
  };
});
vi.mock('@/archival/arweave-client', () => ({
  ArweaveClient: class {
    async uploadData(): Promise<{ success: boolean; error: string }> {
      return { success: false, error: 'gateway timeout' };
    }
  },
}));

type RouteHandler = (request: Request, context?: unknown) => Promise<Response>;

interface ResponseBody {
  success: boolean;
  code?: string;
  error?: unknown;
  data?: Record<string, unknown>;
}

async function route(name: string): Promise<Record<'GET' | 'POST', RouteHandler>> {
  return (await import(/* @vite-ignore */ `${WEBAPP}/app/api/${name}/route`)) as Record<'GET' | 'POST', RouteHandler>;
}

const { POST: postCommit } = await route('memory-repo/commits');
const { POST: postTombstone } = await route('memory-repo/tombstone');
const { GET: getBranch } = await route('memory-repo/branches/[branch]');
const { POST: postUpload } = await route('archival/upload');
const { middleware } = (await import(/* @vite-ignore */ `${WEBAPP}/middleware`)) as { middleware: (request: Request) => Response };
// The middleware reads request.nextUrl, which only a NextRequest has
// Imported through a variable, like the webapp modules, so the root typecheck does not resolve it
const NEXT_SERVER = 'next/server';
const { NextRequest } = (await import(/* @vite-ignore */ NEXT_SERVER)) as {
  NextRequest: new (request: Request) => Request;
};

const TOKEN = 'test-token';
const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const COMMIT_TIME = 1_700_000_000_000_000_000n;

function request(urlPath: string, body?: unknown, token = TOKEN): Request {
  return new Request(`http://localhost${urlPath}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const commitBody = {
  branch: 'polytician',
  message: 'push concept c1',
  entries: [{ key: 'concepts/c1', data: '{"title":"t"}', tags: ['polytician'] }],
};

function commit(overrides: Partial<Commit> = {}): Commit {
  return {
    id: 'commit-1',
    timestamp: COMMIT_TIME,
    message: commitBody.message,
    diff: JSON.stringify(commitBody.entries),
    tags: ['polytician'],
    parent: [],
    branch: 'polytician',
    ...overrides,
  };
}

/**
 * What a Polytician user sees for an error response: Polytician's AVHttpClient
 * reads the body as AVErrorResponse { error: string; code: string }, throws
 * new AVHttpError(status, body.code, body.error), and vault tools keep only
 * the error's message.
 */
async function asPolyticianSees(res: Response): Promise<string> {
  const body = (await res.json()) as { error: string; code: string };
  return new Error(body.error).message;
}

beforeEach(() => {
  canister.created.length = 0;
  canister.actor = {
    getBranches: vi.fn().mockResolvedValue([['main', 'commit-0'], ['polytician', 'commit-0']]),
    createBranchFrom: vi.fn().mockResolvedValue({ ok: "Branch 'polytician' created" }),
    commitToBranch: vi.fn().mockResolvedValue({ ok: 'commit-1' }),
    getCommit: vi.fn().mockResolvedValue([commit()]),
    log: vi.fn().mockResolvedValue([commit()]),
    // The current-branch calls race with other writers; the routes must not use them
    switchBranch: vi.fn().mockResolvedValue({ ok: 'switched' }),
    createBranch: vi.fn().mockResolvedValue({ ok: 'created' }),
    commit: vi.fn().mockResolvedValue({ ok: 'commit-1' }),
  };
  vi.stubEnv('AGENTVAULT_POLYTICIAN_API_TOKEN', TOKEN);
  vi.stubEnv('MEMORY_REPO_CANISTER_ID', CANISTER_ID);
  // A mainnet host: the agent keeps the IC root key and makes no request.
  vi.stubEnv('ICP_LOCAL_URL', 'https://ic0.app');
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function signerPrincipal(): Promise<string> {
  expect(canister.created).toHaveLength(1);
  expect(canister.created[0]!.canisterId).toBe(CANISTER_ID);
  return (await canister.created[0]!.agent.getPrincipal()).toText();
}

function expectNoCurrentBranchCalls(): void {
  expect(canister.actor.switchBranch).not.toHaveBeenCalled();
  expect(canister.actor.createBranch).not.toHaveBeenCalled();
  expect(canister.actor.commit).not.toHaveBeenCalled();
}

describe('POST /api/memory-repo/commits', () => {
  it('answers 503 SIGNING_IDENTITY_NOT_CONFIGURED without a signing identity, before calling the canister', async () => {
    const res = await postCommit(request('/api/memory-repo/commits', commitBody));
    const body = (await res.clone().json()) as ResponseBody;

    expect(res.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SIGNING_IDENTITY_NOT_CONFIGURED');
    expect(await asPolyticianSees(res)).toMatch(
      /^SIGNING_IDENTITY_NOT_CONFIGURED: .*AGENTVAULT_ICP_IDENTITY_PEM_FILE[\s\S]*AGENTVAULT_ICP_IDENTITY_PEM[\s\S]*agentvault memory authorize/,
    );
    expect(canister.created).toHaveLength(0);
  });

  it('signs with AGENTVAULT_ICP_IDENTITY_PEM, commits onto the named branch in one call, and reports the signer and the commit time', async () => {
    const key = ed25519Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', key.pem);
    // The newest commit on the branch is someone else's; the response describes this one
    canister.actor.log = vi.fn().mockResolvedValue([commit({ id: 'commit-9', timestamp: 5n })]);

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));
    const body = (await res.json()) as ResponseBody;

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(await signerPrincipal()).toBe(key.principal);
    expect(canister.actor.commitToBranch).toHaveBeenCalledWith(
      'polytician',
      commitBody.message,
      JSON.stringify(commitBody.entries),
      ['polytician'],
    );
    expect(canister.actor.getCommit).toHaveBeenCalledWith('commit-1');
    expect(body.data).toMatchObject({
      sha: 'commit-1',
      branch: 'polytician',
      author: key.principal,
      timestamp: new Date(Number(COMMIT_TIME / 1_000_000n)).toISOString(),
    });
    expect(canister.actor.createBranchFrom).not.toHaveBeenCalled();
    expectNoCurrentBranchCalls();
  });

  it('signs with AGENTVAULT_ICP_IDENTITY_PEM_FILE', async () => {
    const key = secp256k1Key();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-route-'));
    try {
      const file = path.join(dir, 'server.pem');
      fs.writeFileSync(file, key.pem, { mode: 0o600 });
      vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', file);

      const res = await postCommit(request('/api/memory-repo/commits', commitBody));

      expect(res.status).toBe(200);
      expect(await signerPrincipal()).toBe(key.principal);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('logs a warning, and still signs, when the key file is readable by other users', async () => {
    const key = ed25519Key();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-route-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const file = path.join(dir, 'server.pem');
      fs.writeFileSync(file, key.pem);
      fs.chmodSync(file, 0o644);
      vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', file);

      const res = await postCommit(request('/api/memory-repo/commits', commitBody));

      expect(res.status).toBe(200);
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain(file);
      expect(logged).toMatch(/chmod 600/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a branch that does not exist from main, not from whichever branch is current, then commits onto it", async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.getBranches = vi.fn().mockResolvedValue([['main', 'commit-0'], ['b1', 'commit-5']]);
    const order: string[] = [];
    canister.actor.createBranchFrom = vi.fn(async () => { order.push('create'); return { ok: 'created' }; });
    canister.actor.commitToBranch = vi.fn(async () => { order.push('commit'); return { ok: 'commit-1' }; });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(200);
    expect(order).toEqual(['create', 'commit']);
    expect(canister.actor.createBranchFrom).toHaveBeenCalledWith('polytician', 'main');
    expectNoCurrentBranchCalls();
  });

  it('accepts a branch another push created in the meantime', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.getBranches = vi.fn()
      .mockResolvedValueOnce([['main', 'commit-0']])
      .mockResolvedValue([['main', 'commit-0'], ['polytician', 'commit-0']]);
    canister.actor.createBranchFrom = vi.fn().mockResolvedValue({ err: "Branch 'polytician' already exists" });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(200);
    expect(canister.actor.commitToBranch).toHaveBeenCalledOnce();
  });

  it('answers 400 BRANCH_ERROR when the branch cannot be created', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.getBranches = vi.fn().mockResolvedValue([['main', 'commit-0']]);
    canister.actor.createBranchFrom = vi.fn().mockResolvedValue({ err: 'Branch limit reached (100)' });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(400);
    expect(await asPolyticianSees(res)).toBe('BRANCH_ERROR: Failed to create branch: Branch limit reached (100)');
    expect(canister.actor.commitToBranch).not.toHaveBeenCalled();
  });

  it('keeps concurrent pushes to different branches on their own branches', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    // A canister with one shared current branch, as memory_repo has, whose
    // calls yield between messages as calls to a canister do
    const state = { current: 'main', heads: new Map([['main', 'c0']]), commits: new Map<string, Commit>(), seq: 0 };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const append = (branch: string, message: string, diff: string, tags: string[]) => {
      const id = `c${++state.seq}`;
      state.commits.set(id, commit({ id, branch, message, diff, tags, timestamp: BigInt(state.seq) * 1_000_000_000n }));
      state.heads.set(branch, id);
      return { ok: id };
    };
    canister.actor = {
      getBranches: vi.fn(async () => { await tick(); return [...state.heads.entries()]; }),
      createBranchFrom: vi.fn(async (name: string, base: string) => {
        await tick();
        if (state.heads.has(name)) return { err: `Branch '${name}' already exists` };
        state.heads.set(name, state.heads.get(base)!);
        return { ok: 'created' };
      }),
      createBranch: vi.fn(async (name: string) => {
        await tick();
        if (state.heads.has(name)) return { err: `Branch '${name}' already exists` };
        state.heads.set(name, state.heads.get(state.current)!);
        return { ok: 'created' };
      }),
      switchBranch: vi.fn(async (name: string) => {
        await tick();
        if (!state.heads.has(name)) return { err: `Branch '${name}' does not exist` };
        state.current = name;
        return { ok: 'switched' };
      }),
      commit: vi.fn(async (message: string, diff: string, tags: string[]) => { await tick(); return append(state.current, message, diff, tags); }),
      commitToBranch: vi.fn(async (branch: string, message: string, diff: string, tags: string[]) => {
        await tick();
        if (!state.heads.has(branch)) return { err: `Branch '${branch}' does not exist` };
        return append(branch, message, diff, tags);
      }),
      getCommit: vi.fn(async (id: string) => { await tick(); const c = state.commits.get(id); return c ? [c] : []; }),
      log: vi.fn(async () => []),
    };

    const pushes = ['race-x', 'race-y'].flatMap((branch) =>
      [1, 2, 3].map((n) => ({ branch, message: `for ${branch} #${n}`, entries: [{ key: `concepts/${branch}-${n}`, data: '{}' }] })),
    );
    const responses = await Promise.all(pushes.map((push) => postCommit(request('/api/memory-repo/commits', push))));

    for (const [index, res] of responses.entries()) {
      const body = (await res.json()) as ResponseBody;
      expect(res.status, JSON.stringify(body)).toBe(200);
      const recorded = state.commits.get(body.data!.sha as string)!;
      expect(recorded.branch).toBe(pushes[index]!.branch);
      expect(recorded.message).toBe(pushes[index]!.message);
    }
    expect([...state.commits.values()].every((c) => c.message.startsWith(`for ${c.branch} `))).toBe(true);
    expect(state.current).toBe('main');
  });

  it('answers 403 SIGNER_NOT_AUTHORIZED, naming the principal, when the canister refuses the signer', async () => {
    const key = ed25519Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', key.pem);
    canister.actor.commitToBranch = vi.fn().mockRejectedValue(
      new Error("Reject text: Canister called `ic0.trap` with message: 'caller principal is not authorized'"),
    );

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(403);
    expect(((await res.clone().json()) as ResponseBody).code).toBe('SIGNER_NOT_AUTHORIZED');
    expect(await asPolyticianSees(res)).toContain(`agentvault memory authorize ${key.principal}`);
  });

  it('answers 502 MEMORY_REPO_OUTDATED when the canister predates commitToBranch', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.commitToBranch = vi.fn().mockRejectedValue(new Error(
      'The replica returned a rejection error:\n  Request ID: 91e9\n  Reject code: 5\n' +
        "  Reject text: Error from Canister uzt4z-lp777-77774-qaabq-cai: Canister has no update method 'commitToBranch'..\n" +
        '  Error code: IC0536\n\nCall context:\n  HTTP details: {"body":{"certificate":{"0":217}}}',
    ));

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));
    const seen = await asPolyticianSees(res);

    expect(res.status).toBe(502);
    expect(seen).toMatch(/^MEMORY_REPO_OUTDATED: .*commitToBranch.*dfx deploy memory_repo/s);
    expect(seen).not.toContain('certificate');
  });

  it('answers 500 with only the reject text of an unexpected canister error', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.commitToBranch = vi.fn().mockRejectedValue(new Error(
      'The replica returned a rejection error:\n  Reject code: 5\n  Reject text: something broke\n  Error code: IC0503\n\nCall context:\n  HTTP details: {"body":{"certificate":{"0":217}}}',
    ));

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(500);
    expect(await asPolyticianSees(res)).toBe('INTERNAL_ERROR: something broke');
  });

  it('answers 503 SIGNING_IDENTITY_INVALID for an unusable key, without echoing it', async () => {
    const pem = generateKeyPairSync('ed25519').privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' })
      .toString();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', pem);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));
    const text = await res.text();

    expect(res.status).toBe(503);
    expect((JSON.parse(text) as ResponseBody).code).toBe('SIGNING_IDENTITY_INVALID');
    expect((JSON.parse(text) as { error: string }).error).toMatch(/^SIGNING_IDENTITY_INVALID: .*server log/);
    const keyBody = pem.split('\n').filter((l) => l && !l.startsWith('-----') && !l.includes(':')).join('');
    expect(text).not.toContain(keyBody.slice(0, 24));
    expect(canister.created).toHaveLength(0);
    for (const call of consoleError.mock.calls) {
      expect(call.join(' ')).not.toContain(keyBody.slice(0, 24));
    }
  });

  it.each([
    ['brainpoolP256r1', () => generateKeyPairSync('ec', { namedCurve: 'brainpoolP256r1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString()],
    ['DSA', () => generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
  ])('answers 503 SIGNING_IDENTITY_INVALID, not 500, for a %s key', async (_name, makePem) => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', makePem());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(503);
    expect(((await res.json()) as ResponseBody).code).toBe('SIGNING_IDENTITY_INVALID');
    expect(canister.created).toHaveLength(0);
  });

  it('answers 400 BAD_REQUEST for a body that is not JSON or misses fields', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);

    const notJson = await postCommit(new Request('http://localhost/api/memory-repo/commits', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{ not json',
    }));
    expect(notJson.status).toBe(400);
    expect(await asPolyticianSees(notJson)).toMatch(/^BAD_REQUEST: /);

    const missing = await postCommit(request('/api/memory-repo/commits', { branch: 'polytician' }));
    expect(missing.status).toBe(400);
    expect(await asPolyticianSees(missing)).toBe('BAD_REQUEST: Missing required fields: branch, message, entries');
  });

  it('answers 400 COMMIT_ERROR with the canister reason', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.commitToBranch = vi.fn().mockResolvedValue({ err: 'Too many tags (maximum 20)' });

    const res = await postCommit(request('/api/memory-repo/commits', commitBody));

    expect(res.status).toBe(400);
    expect(await asPolyticianSees(res)).toBe('COMMIT_ERROR: Commit failed: Too many tags (maximum 20)');
  });
});

describe('POST /api/memory-repo/tombstone', () => {
  it('answers 503 SIGNING_IDENTITY_NOT_CONFIGURED without a signing identity', async () => {
    const res = await postTombstone(request('/api/memory-repo/tombstone', { branch: 'polytician', key: 'concepts/c1' }));

    expect(res.status).toBe(503);
    expect(await asPolyticianSees(res)).toMatch(/^SIGNING_IDENTITY_NOT_CONFIGURED: /);
    expect(canister.created).toHaveLength(0);
  });

  it('signs the tombstone commit and commits it onto the named branch in one call', async () => {
    const key = secp256k1Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', key.pem);

    const res = await postTombstone(request('/api/memory-repo/tombstone', { branch: 'polytician', key: 'concepts/c1' }));

    expect(res.status).toBe(204);
    expect(await signerPrincipal()).toBe(key.principal);
    expect(canister.actor.commitToBranch).toHaveBeenCalledWith(
      'polytician',
      'tombstone: concepts/c1',
      JSON.stringify({ deleted: 'concepts/c1' }),
      ['tombstone'],
    );
    expectNoCurrentBranchCalls();
  });

  it('answers 404 BRANCH_NOT_FOUND for a branch that does not exist', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', ed25519Key().pem);
    canister.actor.getBranches = vi.fn().mockResolvedValue([['main', 'commit-0']]);

    const res = await postTombstone(request('/api/memory-repo/tombstone', { branch: 'polytician', key: 'concepts/c1' }));

    expect(res.status).toBe(404);
    expect(await asPolyticianSees(res)).toBe('BRANCH_NOT_FOUND: Branch not found: polytician');
    expect(canister.actor.commitToBranch).not.toHaveBeenCalled();
  });
});

describe('GET /api/memory-repo/branches/:branch', () => {
  it('reads anonymously, with or without a signing identity', async () => {
    const res = await getBranch(request('/api/memory-repo/branches/polytician'), {
      params: Promise.resolve({ branch: 'polytician' }),
    });

    expect(res.status).toBe(200);
    expect(await signerPrincipal()).toBe('2vxsx-fae');
  });

  it('answers 404 BRANCH_NOT_FOUND in the shape Polytician reads', async () => {
    const res = await getBranch(request('/api/memory-repo/branches/nope'), { params: Promise.resolve({ branch: 'nope' }) });

    expect(res.status).toBe(404);
    expect(await asPolyticianSees(res)).toBe("BRANCH_NOT_FOUND: Branch 'nope' does not exist");
  });
});

describe('the routes Polytician calls answer every error in the shape it reads', () => {
  it('a wrong token gets 401 UNAUTHORIZED from the route and from the middleware', async () => {
    const fromRoute = await postCommit(request('/api/memory-repo/commits', commitBody, 'wrong-token'));
    expect(fromRoute.status).toBe(401);
    expect(await asPolyticianSees(fromRoute)).toBe('UNAUTHORIZED: Invalid API token');

    for (const urlPath of ['/api/memory-repo/commits', '/api/memory-repo/tombstone', '/api/memory-repo/branches/polytician', '/api/archival/upload', '/api/inference', '/api/secrets/x']) {
      const res = middleware(new NextRequest(request(urlPath, undefined, 'wrong-token')));
      expect(res.status, urlPath).toBe(401);
      expect(await asPolyticianSees(res), urlPath).toBe('UNAUTHORIZED: Invalid API token');
    }
  });

  it('the webapp UI routes keep their { message, code } error object', async () => {
    const res = middleware(new NextRequest(request('/api/agents', undefined, 'wrong-token')));
    expect(res.status).toBe(401);
    expect(((await res.json()) as ResponseBody).error).toEqual({ message: 'Invalid API token', code: 'UNAUTHORIZED' });
  });

  it('POST /api/archival/upload', async () => {
    const missingWallet = await postUpload(request('/api/archival/upload', { data: 'x' }));
    expect(missingWallet.status).toBe(400);
    expect(await asPolyticianSees(missingWallet)).toBe('BAD_REQUEST: Missing required field: jwk (Arweave wallet)');

    const failed = await postUpload(request('/api/archival/upload', { data: 'x', jwk: { kty: 'RSA', n: 'n', e: 'AQAB', d: 'd' } }));
    expect(failed.status).toBe(502);
    expect(await asPolyticianSees(failed)).toBe('UPLOAD_FAILED: gateway timeout');
  });
});
