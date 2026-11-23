import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProvisionError, type ProvisionRecord } from '../../src/canister/provision.js';
import { LedgerStore, createLedgerServer, type AnchoringOptions, type ProvisioningOptions } from '../../src/ledger/index.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const OWNER = 'vuxfy-i2pqn-4de5c-swdky-vff7j-6adn4-zdsyr-3i2xd-6sbyv-peol7-eqe';
const CANISTER = 'uzt4z-lp777-77774-qaabq-cai';

let dir: string;
let server: http.Server | undefined;
let base: string;
let seen: Array<{ key: string; owner: string }>;
let errors: unknown[];

const record = (changes: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  key: 'order-1',
  owner: OWNER,
  state: 'pending',
  canisterId: null,
  createdAtTime: '1794900000000000000',
  moduleHash: null,
  error: null,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:01.000Z',
  ...changes,
});

async function start(provisioning: ProvisioningOptions | undefined, anchoring?: AnchoringOptions): Promise<void> {
  const store = LedgerStore.open(dir);
  server = createLedgerServer({ store, token: TOKEN, provisioning, anchoring, onError: (error) => errors.push(error) });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const provisioning = (begin: ProvisioningOptions['begin'], get: ProvisioningOptions['get'] = () => null): ProvisioningOptions => ({
  begin: (key, owner) => {
    seen.push({ key, owner });
    return begin(key, owner);
  },
  get,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-provision-routes-'));
  seen = [];
  errors = [];
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('asking for a canister', () => {
  it('starts one for the owner and says it is being made', async () => {
    await start(provisioning(() => record()));

    const answer = await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER });

    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ key: 'order-1', owner: OWNER, state: 'pending', canisterId: null, moduleHash: null, error: null });
    expect(seen).toEqual([{ key: 'order-1', owner: OWNER }]);
  });

  it('says 200, with the canister, once it is the owner’s', async () => {
    await start(provisioning(() => record({ state: 'ready', canisterId: CANISTER, moduleHash: 'ab'.repeat(32) })));

    const answer = await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ state: 'ready', canisterId: CANISTER, moduleHash: 'ab'.repeat(32) });
  });

  it('keeps the gateway’s own bookkeeping to itself', async () => {
    await start(provisioning(() => record({ state: 'ready', canisterId: CANISTER })));

    const { body } = await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER });

    expect(Object.keys(body).sort()).toEqual(['canisterId', 'error', 'key', 'moduleHash', 'owner', 'state']);
  });

  it('asks nothing of the request but who and which order: how much to spend is not its to say', async () => {
    await start(provisioning(() => record()));

    await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER, cycles: '9999999999999999', controllers: ['x'] });

    expect(seen).toEqual([{ key: 'order-1', owner: OWNER }]);
  });

  it.each([
    ['invalid_key', 400],
    ['invalid_owner', 400],
    ['key_conflict', 409],
    ['limit_reached', 429],
  ] as const)('answers %s with %i and the reason', async (code, status) => {
    await start(provisioning(() => {
      throw new ProvisionError(code, `because ${code}`);
    }));

    const answer = await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER });

    expect(answer).toEqual({ status, body: { error: code, message: `because ${code}` } });
    expect(errors).toEqual([]);
  });

  it('reports anything else as a server error, without its details', async () => {
    await start(provisioning(() => {
      throw new Error('disk on fire /secret/path');
    }));

    const answer = await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER });

    expect(answer).toEqual({ status: 500, body: { error: 'internal' } });
    expect(errors).toHaveLength(1);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a list', []],
    ['no owner', { key: 'order-1' }],
    ['no key', { owner: OWNER }],
    ['a number for the owner', { key: 'order-1', owner: 7 }],
    ['nothing', {}],
  ])('refuses a body that is %s, before asking the provisioner', async (_label, body) => {
    await start(provisioning(() => record()));

    const answer = await call('POST', '/v1/canisters', body);

    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid');
    expect(seen).toEqual([]);
  });
});

describe('asking where it has got to', () => {
  it('describes the canister for a key', async () => {
    await start(provisioning(() => record(), (key) => (key === 'a:1' ? record({ key: 'a:1', state: 'failed', canisterId: CANISTER, error: 'install was cut short' }) : null)));

    expect(await call('GET', '/v1/canisters/a%3A1')).toEqual({
      status: 200,
      body: { key: 'a:1', owner: OWNER, state: 'failed', canisterId: CANISTER, moduleHash: null, error: 'install was cut short' },
    });
    expect((await call('GET', '/v1/canisters/other')).status).toBe(404);
    expect((await call('GET', '/v1/canisters/%E0%A4%A')).status).toBe(404);
  });

  it('refuses the wrong method on either route', async () => {
    await start(provisioning(() => record()));

    expect((await call('GET', '/v1/canisters')).status).toBe(405);
    expect((await call('DELETE', '/v1/canisters')).status).toBe(405);
    expect((await call('POST', '/v1/canisters/order-1', {})).status).toBe(405);
    expect((await call('DELETE', '/v1/canisters/order-1')).status).toBe(405);
  });
});

describe('who may ask', () => {
  it('needs the host’s token for both routes', async () => {
    await start(provisioning(() => record(), () => record()));

    expect((await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER }, null)).status).toBe(401);
    expect((await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER }, 'wrong-token-0123456789abcdef0123456789')).status).toBe(401);
    expect((await call('GET', '/v1/canisters/order-1', undefined, null)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('says on its identity route whether it can create canisters, so a host need not guess', async () => {
    const anchoring: AnchoringOptions = { writer: OWNER, validateDestination: () => undefined, error: () => null };

    await start(provisioning(() => record()), anchoring);
    expect(await call('GET', '/v1/identity')).toEqual({ status: 200, body: { principal: OWNER, provisioning: true, orders: false } });
    await new Promise((resolve) => server!.close(resolve));

    await start(undefined, anchoring);
    expect(await call('GET', '/v1/identity')).toEqual({ status: 200, body: { principal: OWNER, provisioning: false, orders: false } });
  });

  it('is not there unless the gateway was told it may create canisters', async () => {
    await start(undefined);

    expect(await call('POST', '/v1/canisters', { key: 'order-1', owner: OWNER })).toEqual({ status: 404, body: { error: 'provisioning_not_configured' } });
    expect((await call('GET', '/v1/canisters/order-1')).status).toBe(404);
  });
});
