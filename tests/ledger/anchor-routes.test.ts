import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { LedgerStore, createLedgerServer, type AnchoringOptions } from '../../src/ledger/index.js';
import { entry } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const WRITER = 'yzoj6-sgrt2-fa25n-xcseg-7gr7y-7nciu-cuqts-edigf-s5vts-cwigu-jae';

let dir: string;
let store: LedgerStore;
let server: http.Server | undefined;
let base: string;
let refused: Map<string, string>;

async function start(anchoring: AnchoringOptions | undefined): Promise<void> {
  server = createLedgerServer({ store, token: TOKEN, anchoring });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const configured = (defaultDestination?: string): AnchoringOptions => ({
  writer: WRITER,
  defaultDestination,
  validateDestination(destination) {
    if (!destination.startsWith('canister-')) throw new Error('Not a canister id');
  },
  error: (stream) => refused.get(stream) ?? null,
});

async function call(method: string, route: string, body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-anchor-routes-'));
  store = LedgerStore.open(dir);
  refused = new Map();
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('who the gateway anchors as', () => {
  it('tells a client with the token the principal an owner has to allow, and nobody else', async () => {
    await start(configured());
    expect(await call('GET', '/v1/identity')).toEqual({ status: 200, body: { principal: WRITER, provisioning: false } });
    expect((await call('GET', '/v1/identity', undefined, null)).status).toBe(401);
    expect((await call('POST', '/v1/identity', {})).status).toBe(405);
  });

  it('says it has none when it was started without a replica to anchor on', async () => {
    await start(undefined);
    expect(await call('GET', '/v1/identity')).toEqual({ status: 404, body: { error: 'anchoring_not_configured' } });
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const answer = await call(method, '/v1/streams/bot-1/anchor', method === 'PUT' ? { destination: 'canister-a' } : undefined);
      expect(answer.status, method).toBe(409);
      expect(answer.body.error).toBe('anchoring_not_configured');
    }
    expect(store.anchorTargets()).toEqual({});
  });
});

describe('naming where a stream is anchored', () => {
  beforeEach(async () => start(configured('canister-default')));

  it('names a place, keeps it, and clears it back to the default', async () => {
    const set = await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-a' });
    expect(set).toEqual({ status: 200, body: { destination: 'canister-a', named: true, anchoredSeq: 0, headSeq: 0, error: null } });
    expect(LedgerStore.open(dir).anchorTarget('bot-1')).toBe('canister-a');
    // Naming it again says the same thing.
    expect((await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-a' })).status).toBe(200);

    const cleared = await call('DELETE', '/v1/streams/bot-1/anchor');
    expect(cleared.body).toMatchObject({ destination: 'canister-default', named: false });
    expect(store.anchorTarget('bot-1')).toBeNull();
  });

  it('refuses a destination the anchor cannot use, and a request that is not one', async () => {
    for (const body of [{ destination: 'somewhere-else' }, { destination: '' }, { destination: 7 }, { destination: 'c'.repeat(129) }, {}, [], 'not json']) {
      const answer = await call('PUT', '/v1/streams/bot-1/anchor', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'somewhere-else' })).body.message).toBe('Not a canister id');
    expect(store.anchorTargets()).toEqual({});
    expect((await call('PUT', '/v1/streams/Bad Stream/anchor', { destination: 'canister-a' })).status).toBe(400);
  });

  it('needs the token, and takes no method it does not know', async () => {
    expect((await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-a' }, null)).status).toBe(401);
    expect((await call('DELETE', '/v1/streams/bot-1/anchor', undefined, null)).status).toBe(401);
    expect((await call('POST', '/v1/streams/bot-1/anchor', { destination: 'canister-a' })).status).toBe(405);
    expect(store.anchorTargets()).toEqual({});
  });
});

describe('how far a stream is anchored, and why not further', () => {
  beforeEach(async () => start(configured()));

  it('counts at the stream\'s own place, so moving it starts the count again', async () => {
    store.append('bot-1', [entry(1), entry(2), entry(3)]);
    await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-a' });
    store.recordAnchor({ stream: 'bot-1', from: 1, to: 2, head: 'h', anchoredAt: 'now', destination: 'canister-a', evidence: { kind: 'test' } });

    expect((await call('GET', '/v1/streams/bot-1/anchor')).body).toMatchObject({ destination: 'canister-a', anchoredSeq: 2, headSeq: 3 });
    expect((await call('GET', '/v1/streams/bot-1')).body.anchored).toEqual({ seq: 2 });
    expect(((await call('GET', '/v1/streams')).body.streams as Array<{ anchored: unknown }>)[0]!.anchored).toEqual({ seq: 2 });

    await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-b' });
    expect((await call('GET', '/v1/streams/bot-1/anchor')).body).toMatchObject({ destination: 'canister-b', anchoredSeq: 0, headSeq: 3 });
    expect((await call('GET', '/v1/streams/bot-1')).body.anchored).toEqual({ seq: 0 });
    // An append says how far it is anchored where it is going, too.
    expect((await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(4)] })).body.anchored).toEqual({ seq: 0 });
  });

  it('says why the last attempt failed, for the owner to act on', async () => {
    store.append('bot-1', [entry(1)]);
    await call('PUT', '/v1/streams/bot-1/anchor', { destination: 'canister-a' });
    refused.set('bot-1', 'yzoj6… is neither the repo owner nor an authorized principal');

    expect((await call('GET', '/v1/streams/bot-1/anchor')).body.error).toBe('yzoj6… is neither the repo owner nor an authorized principal');

    refused.delete('bot-1');
    expect((await call('GET', '/v1/streams/bot-1/anchor')).body.error).toBeNull();
  });

  it('answers for a stream that has no entries yet, as a host naming its place first needs', async () => {
    await call('PUT', '/v1/streams/bot-new/anchor', { destination: 'canister-a' });
    expect((await call('GET', '/v1/streams/bot-new/anchor')).body).toEqual({ destination: 'canister-a', named: true, anchoredSeq: 0, headSeq: 0, error: null });
    expect((await call('GET', '/v1/streams/bot-new')).status).toBe(404);
  });
});
