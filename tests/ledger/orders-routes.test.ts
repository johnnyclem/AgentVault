import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { orderView } from '../../src/canister/payments.js';
import { ProvisionError } from '../../src/canister/provision.js';
import { LedgerStore, createLedgerServer, type AnchoringOptions, type OrdersOptions } from '../../src/ledger/index.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const GATEWAY = '6ytnh-gibae-aqc';
const OWNER = 'vuxfy-i2pqn-4de5c-swdky-vff7j-6adn4-zdsyr-3i2xd-6sbyv-peol7-eqe';
const CANISTER = 'uzt4z-lp777-77774-qaabq-cai';

type View = ReturnType<typeof orderView>;

let dir: string;
let server: http.Server | undefined;
let base: string;
let seen: Array<{ key: string; owner: string }>;
let errors: unknown[];

const view = (changes: Partial<View> = {}): View => ({
  key: 'order-1',
  owner: OWNER,
  state: 'awaiting_payment',
  deposit: { owner: GATEWAY, subaccount: 'ab'.repeat(32), accountId: 'cd'.repeat(32) },
  price: { e8s: '137751047', expiresAt: '2026-11-23T00:30:00.000Z' },
  paidE8s: '0',
  shortfallE8s: '137751047',
  canisterId: null,
  error: null,
  ...changes,
});

async function start(orders: OrdersOptions | undefined, anchoring?: AnchoringOptions): Promise<void> {
  const store = LedgerStore.open(dir);
  server = createLedgerServer({ store, token: TOKEN, orders, anchoring, onError: (error) => errors.push(error) });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const orders = (create: (key: string, owner: string) => View | Promise<View>, get: OrdersOptions['get'] = () => null): OrdersOptions => ({
  create: async (key, owner) => {
    seen.push({ key, owner });
    return create(key, owner);
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-orders-routes-'));
  seen = [];
  errors = [];
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buying a canister', () => {
  it('opens an order and says where to pay and how much', async () => {
    await start(orders(() => view()));

    const answer = await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(view());
    expect(seen).toEqual([{ key: 'order-1', owner: OWNER }]);
  });

  it('passes on what the order service said, so asking again changes nothing', async () => {
    await start(orders(() => view({ state: 'ready', canisterId: CANISTER, shortfallE8s: '0', paidE8s: '137751047' })));
    const answer = await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER });
    expect(answer.body).toMatchObject({ state: 'ready', canisterId: CANISTER });
  });

  it.each([
    ['key_conflict', 409],
    ['limit_reached', 429],
    ['invalid_owner', 400],
    ['invalid_key', 400],
  ] as const)('says %s as %i, with the reason', async (code, status) => {
    await start(
      orders(() => {
        throw new ProvisionError(code, `reason for ${code}`);
      }),
    );
    const answer = await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER });
    expect(answer).toEqual({ status, body: { error: code, message: `reason for ${code}` } });
  });

  it('answers an error it does not know as a failure, without its details', async () => {
    await start(
      orders(() => {
        throw new Error('the replica said something with an internal address in it');
      }),
    );
    const answer = await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER });
    expect(answer).toEqual({ status: 500, body: { error: 'internal' } });
    expect(errors).toHaveLength(1);
  });

  it('refuses a request that is not an order', async () => {
    await start(orders(() => view()));
    expect((await call('POST', '/v1/orders', 'not json')).status).toBe(400);
    expect((await call('POST', '/v1/orders', { key: 'order-1' })).status).toBe(400);
    expect((await call('POST', '/v1/orders', { key: 1, owner: OWNER })).status).toBe(400);
    expect((await call('POST', '/v1/orders', [])).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe('asking after an order', () => {
  it('says where it has got to', async () => {
    await start(orders(() => view(), (key) => (key === 'order-1' ? view({ state: 'provisioning', paidE8s: '137751047', shortfallE8s: '0' }) : null)));
    expect(await call('GET', '/v1/orders/order-1')).toMatchObject({ status: 200, body: { state: 'provisioning' } });
    expect((await call('GET', '/v1/orders/order-2')).status).toBe(404);
  });

  it('reads a key that was written percent-encoded', async () => {
    await start(orders(() => view(), (key) => (key === 'a:b' ? view({ key }) : null)));
    expect(await call('GET', '/v1/orders/a%3Ab')).toMatchObject({ status: 200, body: { key: 'a:b' } });
    expect((await call('GET', '/v1/orders/%E0%A4%A')).status).toBe(404);
  });
});

describe('the route itself', () => {
  it('does not exist on a gateway that was not set up to sell', async () => {
    await start(undefined);
    expect(await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER })).toEqual({ status: 404, body: { error: 'orders_not_configured' } });
    expect(await call('GET', '/v1/orders/order-1')).toEqual({ status: 404, body: { error: 'orders_not_configured' } });
  });

  it('needs the token', async () => {
    await start(orders(() => view()));
    expect((await call('POST', '/v1/orders', { key: 'order-1', owner: OWNER }, null)).status).toBe(401);
    expect((await call('GET', '/v1/orders/order-1', undefined, 'wrong-token-0123456789abcdef0123456789abcdef')).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('takes only the methods it means to', async () => {
    await start(orders(() => view(), () => view()));
    expect((await call('GET', '/v1/orders')).status).toBe(405);
    expect((await call('DELETE', '/v1/orders')).status).toBe(405);
    expect((await call('POST', '/v1/orders/order-1', {})).status).toBe(405);
    expect((await call('PUT', '/v1/orders/order-1', {})).status).toBe(405);
  });

  it('says on its identity route whether it sells canisters, so a host need not guess', async () => {
    const anchoring: AnchoringOptions = { writer: GATEWAY, validateDestination: () => undefined, error: () => null };

    await start(orders(() => view()), anchoring);
    expect(await call('GET', '/v1/identity')).toEqual({ status: 200, body: { principal: GATEWAY, provisioning: false, orders: true } });
    await new Promise((resolve) => server!.close(resolve));

    await start(undefined, anchoring);
    expect(await call('GET', '/v1/identity')).toEqual({ status: 200, body: { principal: GATEWAY, provisioning: false, orders: false } });
  });
});
