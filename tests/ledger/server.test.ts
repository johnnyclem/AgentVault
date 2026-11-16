import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LEDGER_FORMAT,
  LedgerStore,
  MAX_BODY_BYTES,
  createLedgerServer,
  startAnchorSchedule,
  type LedgerAnchor,
} from '../../src/ledger/index.js';
import { entry } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

let dir: string;
let store: LedgerStore;
let server: http.Server;
let base: string;
let errors: unknown[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-server-'));
  store = LedgerStore.open(dir);
  errors = [];
  server = createLedgerServer({ store, token: TOKEN, onError: (error) => errors.push(error) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, route: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('ledger gateway', () => {
  it('reports health and its limits without a token', async () => {
    const { status, body } = await call('GET', '/v1/health', undefined, null);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, format: LEDGER_FORMAT, limits: { maxBodyBytes: MAX_BODY_BYTES } });
  });

  it('refuses every other route without the token', async () => {
    for (const token of [null, 'wrong-token-0123456789abcdef0123456789abcdef', TOKEN.slice(0, -1)]) {
      expect((await call('GET', '/v1/streams/bot-1', undefined, token)).status).toBe(401);
      expect((await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(1)] }, token)).status).toBe(401);
    }
    expect(store.streams()).toEqual([]);
  });

  it('appends, reports the head, and reads entries back', async () => {
    const appended = await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(1), entry(2)] });
    expect(appended.status).toBe(200);
    expect(appended.body).toMatchObject({ appended: 2, head: { seq: 2 }, anchored: { seq: 0 } });
    expect(appended.body.head).toEqual(store.head('bot-1'));

    expect((await call('GET', '/v1/streams/bot-1')).body).toEqual({ head: store.head('bot-1'), anchored: { seq: 0 } });
    expect((await call('GET', '/v1/streams/bot-2')).status).toBe(404);

    const read = await call('GET', '/v1/streams/bot-1/entries?after=1&limit=5');
    expect(read.status).toBe(200);
    expect(read.body.entries).toEqual(store.read('bot-1', { after: 1 }));
    expect((read.body.entries as unknown[])[0]).toMatchObject({ seq: 2, payload: entry(2).payload });
  });

  it('answers a repeated append the same way, and a conflicting one with 409', async () => {
    await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(1), entry(2)] });
    const again = await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(1), entry(2)] });
    expect(again).toMatchObject({ status: 200, body: { appended: 0, head: store.head('bot-1') } });

    const conflict = await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(2, 'rewritten')] });
    expect(conflict).toMatchObject({ status: 409, body: { error: 'conflict', head: store.head('bot-1') } });

    const gap = await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(5)] });
    expect(gap).toMatchObject({ status: 409, body: { error: 'gap', head: store.head('bot-1') } });
    expect(store.read('bot-1')).toHaveLength(2);
  });

  it('rejects malformed requests without storing anything', async () => {
    const bad: Array<[string, unknown]> = [
      ['/v1/streams/bot-1/entries', '{not json'],
      ['/v1/streams/bot-1/entries', { entries: [] }],
      ['/v1/streams/bot-1/entries', { entries: [{ ...entry(1), payload: 'not base64url!' }] }],
      ['/v1/streams/bot-1/entries', { entries: [{ ...entry(1), at: '2026-01-01' }] }],
      ['/v1/streams/bot-1/entries', { entries: [{ ...entry(1), hash: 'f'.repeat(64) }] }],
      ['/v1/streams/Bot-1/entries', { entries: [entry(1)] }],
      ['/v1/streams/..%2Fescape/entries', { entries: [entry(1)] }],
    ];
    for (const [route, body] of bad) {
      const response = await call('POST', route, body);
      expect(response.status, `${route} ${JSON.stringify(body)}`).toBe(400);
      expect(response.body.error).toBe('invalid');
    }
    expect((await call('GET', '/v1/streams/bot-1/entries?limit=0')).status).toBe(400);
    expect((await call('GET', '/v1/nope')).status).toBe(404);
    expect((await call('DELETE', '/v1/streams/bot-1/entries')).status).toBe(405);
    expect(store.streams()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('refuses a body over the limit', async () => {
    const response = await call('POST', '/v1/streams/bot-1/entries', 'x'.repeat(MAX_BODY_BYTES + 1));
    expect(response).toMatchObject({ status: 413, body: { error: 'too_large' } });
  });

  it('hides internal failures from the client and reports them to the operator', async () => {
    store.append('bot-1', [entry(1)]);
    fs.appendFileSync(path.join(dir, 'streams', 'bot-1.jsonl'), 'written by something else\n');
    const response = await call('POST', '/v1/streams/bot-1/entries', { entries: [entry(2)] });
    expect(response).toEqual({ status: 500, body: { error: 'internal' } });
    expect(String(errors[0])).toMatch(/one writer/);
  });

  it('lists streams a page at a time, with their heads and anchored marks', async () => {
    expect((await call('GET', '/v1/streams')).body).toEqual({ streams: [], next: null });
    for (const stream of ['bot-b', 'bot-a', 'space-1']) {
      await call('POST', `/v1/streams/${stream}/entries`, { entries: [entry(1), entry(2)] });
    }
    const all = await call('GET', '/v1/streams');
    expect(all.status).toBe(200);
    expect(all.body).toEqual({
      streams: ['bot-a', 'bot-b', 'space-1'].map((stream) => ({ stream, head: store.head(stream), anchored: { seq: 0 } })),
      next: null,
    });

    const first = await call('GET', '/v1/streams?limit=2');
    expect((first.body.streams as Array<{ stream: string }>).map((item) => item.stream)).toEqual(['bot-a', 'bot-b']);
    expect(first.body.next).toBe('bot-b');
    const second = await call('GET', '/v1/streams?limit=2&after=bot-b');
    expect((second.body.streams as Array<{ stream: string }>).map((item) => item.stream)).toEqual(['space-1']);
    expect(second.body.next).toBeNull();
    // A page that ends exactly at the last stream has no next.
    expect((await call('GET', '/v1/streams?limit=3')).body.next).toBeNull();
  });

  it('lists a damaged stream as corrupt without losing the healthy ones', async () => {
    await call('POST', '/v1/streams/bot-a/entries', { entries: [entry(1)] });
    await call('POST', '/v1/streams/bot-b/entries', { entries: [entry(1), entry(2)] });
    // Reopened, so the gateway reads the damaged file from disk as a restart would.
    fs.writeFileSync(path.join(dir, 'streams', 'bot-b.jsonl'), 'not a ledger entry\n');
    await new Promise((resolve) => server.close(resolve));
    store = LedgerStore.open(dir);
    server = createLedgerServer({ store, token: TOKEN, onError: (error) => errors.push(error) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const listed = await call('GET', '/v1/streams');
    expect(listed.status).toBe(200);
    expect(listed.body.streams).toEqual([
      { stream: 'bot-a', head: store.head('bot-a'), anchored: { seq: 0 } },
      { stream: 'bot-b', head: null, corrupt: true },
    ]);
    expect(errors).toEqual([]);
  });

  it('refuses a bad list request, and the list without the token', async () => {
    expect((await call('GET', '/v1/streams', undefined, null)).status).toBe(401);
    for (const query of ['limit=0', 'limit=501', 'limit=x', 'after=../x', 'after=Bot']) {
      expect((await call('GET', `/v1/streams?${query}`)).status, query).toBe(400);
    }
    expect((await call('POST', '/v1/streams', { entries: [entry(1)] })).status).toBe(405);
  });

  it('refuses to start with a short token', () => {
    expect(() => createLedgerServer({ store, token: 'short' })).toThrow(/at least 32 characters/);
  });
});

describe('anchor schedule', () => {
  it('anchors on demand and reports failures instead of throwing', async () => {
    store.append('bot-1', [entry(1)]);
    let fail = true;
    const anchor: LedgerAnchor = {
      kind: 'test',
      maxCheckpointBytes: 900_000,
      async anchor() {
        if (fail) throw new Error('canister unreachable');
        return { kind: 'test' };
      },
    };
    const anchored: string[] = [];
    const failures: unknown[] = [];
    const schedule = startAnchorSchedule(store, anchor, {
      intervalMs: 3_600_000,
      onAnchored: (records) => anchored.push(...records.map((record) => `${record.stream} ${record.from}-${record.to}`)),
      onError: (error) => failures.push(error),
    });

    await schedule.run();
    expect(failures).toHaveLength(1);
    expect(store.anchoredSeq('bot-1')).toBe(0);

    fail = false;
    await schedule.run();
    expect(anchored).toEqual(['bot-1 1-1']);
    expect(store.anchoredSeq('bot-1')).toBe(1);
    await schedule.stop();
  });
});
