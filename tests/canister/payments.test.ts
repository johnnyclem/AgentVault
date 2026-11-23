import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Principal } from '@dfinity/principal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountIdentifier } from '../../src/canister/icp-account.js';
import {
  CanisterProvisioner,
  ProvisionError,
  ProvisionStore,
  type ProvisionRecord,
  type ProvisioningPorts,
} from '../../src/canister/provision.js';
import {
  ICP_FEE_E8S,
  ORDER_TTL_MS,
  OrderService,
  OrderStore,
  PaymentRefused,
  QUOTE_GRACE_MS,
  icpForCycles,
  orderSubaccount,
  orderView,
  parsePriceXdr,
  type MintOutcome,
  type OrderRecord,
  type OrderServiceOptions,
  type PaymentPorts,
} from '../../src/canister/payments.js';

const principal = (seed: number): string => Principal.fromUint8Array(Uint8Array.of(seed, seed, seed, seed)).toText();
const TREASURY = principal(1);
const OWNER = principal(2);
const OTHER = principal(3);
const PRICE = 2_000_000_000_000n; // 2 XDR
const RATE = 14_520n; // 1.452 XDR per ICP
const QUOTE_E8S = 137_741_047n + ICP_FEE_E8S; // ceil(2e12 / 14520), and the fee for the transfer that mints it
const T0 = Date.parse('2026-11-23T00:00:00.000Z');
const MINUTE = 60_000;

/**
 * The ICP ledger and the minting canister, with the rules that matter here: a transfer repeated with
 * the same creation time is the same transfer and moves nothing twice, and a call can fail after it
 * took effect, as a lost reply would.
 */
class FakeNetwork {
  rate = RATE;
  readonly balances = new Map<string, bigint>();
  readonly transfers: Array<{ from: string; e8s: bigint; createdAtTime: bigint; block: bigint }> = [];
  readonly sends: Array<{ from: string; e8s: bigint; createdAtTime: bigint }> = [];
  readonly mints: bigint[] = [];
  readonly mintScript: MintOutcome[] = [];
  balanceCalls = 0;
  /** Calls that throw once when reached; `send` throws after the transfer was made. */
  readonly failOnce = new Set<'send' | 'mint' | 'balance' | 'rate'>();
  private nextBlock = 40_000_000n;

  private fail(step: 'send' | 'mint' | 'balance' | 'rate'): void {
    if (this.failOnce.delete(step)) throw new Error(`${step}: the replica did not answer`);
  }

  ports(): PaymentPorts {
    return {
      rate: async () => {
        this.fail('rate');
        return { xdrPermyriadPerIcp: this.rate };
      },
      balance: async (subaccount) => {
        this.balanceCalls += 1;
        this.fail('balance');
        return this.balances.get(Buffer.from(subaccount).toString('hex')) ?? 0n;
      },
      sendForMinting: async ({ fromSubaccount, e8s, createdAtTime }) => {
        const from = Buffer.from(fromSubaccount).toString('hex');
        this.sends.push({ from, e8s, createdAtTime });
        let transfer = this.transfers.find((made) => made.from === from && made.createdAtTime === createdAtTime);
        if (!transfer) {
          const held = this.balances.get(from) ?? 0n;
          if (held < e8s + ICP_FEE_E8S) throw new PaymentRefused(`The deposit account holds ${held} e8s`);
          this.balances.set(from, held - e8s - ICP_FEE_E8S);
          transfer = { from, e8s, createdAtTime, block: this.nextBlock++ };
          this.transfers.push(transfer);
        }
        this.fail('send');
        return transfer.block;
      },
      mint: async (block) => {
        this.mints.push(block);
        this.fail('mint');
        const scripted = this.mintScript.shift();
        if (scripted) return scripted;
        const transfer = this.transfers.find((made) => made.block === block);
        return { status: 'minted', cycles: (transfer?.e8s ?? 0n) * this.rate };
      },
    };
  }
}

/** A provisioner that does what is asked and nothing more, so each order step can be looked at alone. */
class StubProvisioner {
  readonly records = new Map<string, ProvisionRecord>();
  readonly begun: Array<{ key: string; owner: string }> = [];
  limit = 10;
  beginError: Error | null = null;

  validate(key: string, owner: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new ProvisionError('invalid_key', 'bad key');
    if (owner === TREASURY || owner === '2vxsx-fae') throw new ProvisionError('invalid_owner', 'bad owner');
    try {
      Principal.fromText(owner);
    } catch {
      throw new ProvisionError('invalid_owner', 'bad owner');
    }
  }
  remaining(): number {
    return Math.max(0, this.limit - this.records.size);
  }
  get(key: string): ProvisionRecord | null {
    return this.records.get(key) ?? null;
  }
  begin(key: string, owner: string): ProvisionRecord {
    if (this.beginError) throw this.beginError;
    this.begun.push({ key, owner });
    const existing = this.records.get(key);
    const next = this.record(key, owner, 'pending', existing?.canisterId ?? null, null, existing?.updatedAt);
    if (!existing || existing.state === 'failed') this.records.set(key, next);
    return this.records.get(key)!;
  }
  record(key: string, owner: string, state: ProvisionRecord['state'], canisterId: string | null, error: string | null, updatedAt = new Date(T0).toISOString()): ProvisionRecord {
    return { key, owner, state, canisterId, createdAtTime: '1', moduleHash: null, error, createdAt: new Date(T0).toISOString(), updatedAt };
  }
  finish(key: string, canisterId: string): void {
    this.records.set(key, this.record(key, OWNER, 'ready', canisterId, null));
  }
  fail(key: string, error: string, updatedAt: number): void {
    this.records.set(key, this.record(key, OWNER, 'failed', null, error, new Date(updatedAt).toISOString()));
  }
}

let dir: string;
let clock: { t: number };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-orders-'));
  clock = { t: T0 };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(overrides: Partial<OrderServiceOptions> = {}) {
  const net = new FakeNetwork();
  const store = new OrderStore(dir);
  const provisioner = new StubProvisioner();
  const log: string[] = [];
  const build = (extra: Partial<OrderServiceOptions> = {}) =>
    new OrderService({
      ports: net.ports(),
      store,
      provisioner,
      treasury: TREASURY,
      priceCycles: PRICE,
      quoteMs: 30 * MINUTE,
      now: () => clock.t,
      log: (message) => log.push(message),
      ...overrides,
      ...extra,
    });
  return { net, store, provisioner, log, service: build(), build };
}

const pay = (net: FakeNetwork, order: OrderRecord, e8s: bigint): void => void net.balances.set(order.subaccount, e8s);

describe('prices', () => {
  it('reads a price in XDR as cycles, from a floor to a ceiling', () => {
    expect(parsePriceXdr('2', 1n)).toBe(2_000_000_000_000n);
    expect(parsePriceXdr('1.5', 1n)).toBe(1_500_000_000_000n);
    expect(parsePriceXdr(' 0.000001 ', 1n)).toBe(1_000_000n);
    expect(parsePriceXdr('1000', 1n)).toBe(1_000_000_000_000_000n);
    for (const bad of ['', 'two', '-1', '1e3', '1.1234567', '1001', '0.5', '.5', '1.']) {
      expect(() => parsePriceXdr(bad, 1_000_000_000_000n), bad).toThrow(/--order-price-xdr/);
    }
  });

  it('asks for the ICP that mints the price, rounded up, with the fee of the transfer that mints it', () => {
    expect(icpForCycles(PRICE, RATE)).toBe(QUOTE_E8S);
    // What that mints is never less than the price.
    expect((QUOTE_E8S - ICP_FEE_E8S) * RATE).toBeGreaterThanOrEqual(PRICE);
    expect(() => icpForCycles(PRICE, 0n)).toThrow(/no rate/);
  });

  it('gives each order its own deposit subaccount, the same one every time', () => {
    expect(orderSubaccount('order-1')).toEqual(orderSubaccount('order-1'));
    expect(orderSubaccount('order-1')).not.toEqual(orderSubaccount('order-2'));
    expect(orderSubaccount('order-1')).toHaveLength(32);
  });
});

describe('opening an order', () => {
  it('quotes the price and says where to pay', async () => {
    const { service } = setup();
    const order = await service.create('order-1', OWNER);
    expect(order).toMatchObject({ key: 'order-1', owner: OWNER, state: 'awaiting_payment', paidE8s: '0', quote: { e8s: QUOTE_E8S.toString(), xdrPermyriadPerIcp: '14520' } });
    expect(order.quote.expiresAt).toBe(new Date(T0 + 30 * MINUTE).toISOString());
    const view = orderView(order, TREASURY);
    expect(view.deposit).toEqual({
      owner: TREASURY,
      subaccount: Buffer.from(orderSubaccount('order-1')).toString('hex'),
      accountId: accountIdentifier(TREASURY, orderSubaccount('order-1')),
    });
    expect(view).toMatchObject({ price: { e8s: QUOTE_E8S.toString() }, shortfallE8s: QUOTE_E8S.toString(), canisterId: null, error: null });
  });

  it('is the same order when asked again, and says so to a different owner', async () => {
    const { service, store } = setup();
    const first = await service.create('order-1', OWNER);
    expect(await service.create('order-1', OWNER)).toEqual(first);
    expect(store.list()).toHaveLength(1);
    await expect(service.create('order-1', OTHER)).rejects.toMatchObject({ code: 'key_conflict' });
  });

  it('refuses a key or an owner no canister could be made for, before anything is paid', async () => {
    const { service, store } = setup();
    await expect(service.create('bad key!', OWNER)).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(service.create('order-1', 'not a principal')).rejects.toMatchObject({ code: 'invalid_owner' });
    await expect(service.create('order-1', TREASURY)).rejects.toMatchObject({ code: 'invalid_owner' });
    expect(store.list()).toEqual([]);
  });

  it('refuses a key already used to create a canister directly', async () => {
    const { service, provisioner } = setup();
    provisioner.records.set('order-1', provisioner.record('order-1', OWNER, 'ready', principal(9), null));
    await expect(service.create('order-1', OWNER)).rejects.toBeInstanceOf(ProvisionError);
  });

  it('sells no more canisters than the gateway may still create, counting those paid for but not yet made', async () => {
    const { service, provisioner, net } = setup();
    provisioner.limit = 2;
    const first = await service.create('order-1', OWNER);
    await service.create('order-2', OWNER);
    await expect(service.create('order-3', OWNER)).rejects.toMatchObject({ code: 'limit_reached' });

    // Once the first is paid and handed to the provisioner, it counts there instead, not twice.
    pay(net, first, QUOTE_E8S);
    await service.tick();
    expect(provisioner.remaining()).toBe(1);
    await expect(service.create('order-3', OWNER)).rejects.toMatchObject({ code: 'limit_reached' });
  });

  it('quotes again for an unpaid order whose quote ran out, and leaves a quote that holds', async () => {
    const { service, net } = setup();
    const first = await service.create('order-1', OWNER);
    clock.t += 10 * MINUTE;
    expect((await service.create('order-1', OWNER)).quote).toEqual(first.quote);
    clock.t += 30 * MINUTE;
    net.rate = 16_000n;
    const again = await service.create('order-1', OWNER);
    expect(again.quote.xdrPermyriadPerIcp).toBe('16000');
    expect(BigInt(again.quote.e8s)).toBe(icpForCycles(PRICE, 16_000n));
    expect(Date.parse(again.quote.expiresAt)).toBe(clock.t + 30 * MINUTE);
  });

  it('does not undo a payment that landed while it was fetching a new rate', async () => {
    const { service, net, store, provisioner } = setup();
    const order = await service.create('order-1', OWNER);
    clock.t += 31 * MINUTE; // the quote has run out, though its grace has not

    // A request for a new quote starts, and waits on a slow rate.
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const refreshing = new OrderService({
      ports: { ...net.ports(), rate: async () => (await slow, { xdrPermyriadPerIcp: RATE }) },
      store,
      provisioner,
      treasury: TREASURY,
      priceCycles: PRICE,
      quoteMs: 30 * MINUTE,
      now: () => clock.t,
    }).create('order-1', OWNER);

    // Meanwhile the order is paid, and moves on.
    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(store.get('order-1')?.state).toBe('provisioning');

    release();
    expect((await refreshing).state).toBe('provisioning');
    expect(store.get('order-1')?.state).toBe('provisioning');
    // A quote is not rewritten for an order that was paid at the old one.
    expect(store.get('order-1')?.quote).toEqual(order.quote);
  });

  it('keeps a new quote that was written while a payment was being looked at', async () => {
    const { service, net, store, provisioner } = setup();
    const order = await service.create('order-1', OWNER);
    clock.t += 31 * MINUTE; // the quote has run out, though its grace has not
    pay(net, order, QUOTE_E8S);

    // A pass reads the order, then waits on a slow balance.
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const ports = net.ports();
    const ticking = new OrderService({
      ports: { ...ports, balance: async (subaccount) => (await slow, ports.balance(subaccount)) },
      store,
      provisioner,
      treasury: TREASURY,
      priceCycles: PRICE,
      quoteMs: 30 * MINUTE,
      now: () => clock.t,
    }).tick();

    // Meanwhile the buyer asks again and is given a new quote.
    net.rate = 16_000n;
    const requoted = await service.create('order-1', OWNER);
    expect(requoted.quote.xdrPermyriadPerIcp).toBe('16000');

    release();
    await ticking;
    expect(store.get('order-1')).toMatchObject({ state: 'provisioning', quote: requoted.quote });
  });
});

describe('a paid order', () => {
  it('converts the deposit to cycles and has the canister made, once', async () => {
    const { service, net, provisioner, store } = setup();
    const order = await service.create('order-1', OWNER);
    await service.tick();
    expect(store.get('order-1')?.state).toBe('awaiting_payment');
    expect(net.sends).toEqual([]);

    pay(net, order, QUOTE_E8S);
    await service.tick();

    // The whole deposit less the transfer fee went to be minted, and what it minted covers the price.
    expect(net.sends).toHaveLength(1);
    expect(net.sends[0]).toMatchObject({ from: order.subaccount, e8s: QUOTE_E8S - ICP_FEE_E8S });
    expect(net.sends[0]!.createdAtTime).toBe(BigInt(T0) * 1_000_000n);
    expect(net.balances.get(order.subaccount)).toBe(0n);
    expect(net.mints).toEqual([net.transfers[0]!.block]);
    expect(provisioner.begun).toEqual([{ key: 'order-1', owner: OWNER }]);
    const now = store.get('order-1')!;
    expect(now).toMatchObject({ state: 'provisioning', paidE8s: QUOTE_E8S.toString(), mintBlock: net.transfers[0]!.block.toString() });
    expect(BigInt(now.mintedCycles!)).toBeGreaterThanOrEqual(PRICE);

    provisioner.finish('order-1', principal(50));
    await service.tick();
    expect(orderView(store.get('order-1')!, TREASURY)).toMatchObject({ state: 'ready', canisterId: principal(50), error: null });

    // Nothing more happens to a finished order.
    await service.tick();
    await service.tick();
    expect(net.sends).toHaveLength(1);
    expect(provisioner.begun).toHaveLength(1);
  });

  it('is not paid until enough has arrived, then says how short it is, and takes the rest when it comes', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S - 1n);
    await service.tick();
    const view = orderView(store.get('order-1')!, TREASURY);
    expect(view).toMatchObject({ state: 'awaiting_payment', paidE8s: (QUOTE_E8S - 1n).toString(), shortfallE8s: '1' });
    expect(net.sends).toEqual([]);

    pay(net, order, QUOTE_E8S + 1_000n);
    await service.tick();
    // An overpayment is converted whole: what was sent less the fee.
    expect(net.sends[0]!.e8s).toBe(QUOTE_E8S + 1_000n - ICP_FEE_E8S);
  });

  it('holds the quoted amount while its time lasts, even if the rate has moved against the buyer', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    net.rate = 10_000n; // ICP fell: the price now takes far more of it
    clock.t += 30 * MINUTE + QUOTE_GRACE_MS - 1;
    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(store.get('order-1')?.state).toBe('provisioning');
  });

  it('asks for the price at the rate of the day once the quote and its grace are over', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    net.rate = 10_000n;
    clock.t += 30 * MINUTE + QUOTE_GRACE_MS + 1;
    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(store.get('order-1')?.state).toBe('awaiting_payment');
    expect(net.sends).toEqual([]);

    pay(net, order, icpForCycles(PRICE, 10_000n));
    await service.tick();
    expect(store.get('order-1')?.state).toBe('provisioning');
  });

  it('takes less than the old quote after it ran out, when ICP has risen', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    net.rate = 20_000n;
    clock.t += 31 * MINUTE + QUOTE_GRACE_MS;
    pay(net, order, icpForCycles(PRICE, 20_000n));
    await service.tick();
    expect(store.get('order-1')?.state).toBe('provisioning');
  });

  it('looks at each order once however many passes overlap', async () => {
    const { service, net } = setup();
    await service.create('order-1', OWNER);
    await Promise.all([service.tick(), service.tick(), service.tick()]);
    expect(net.balanceCalls).toBe(1);
  });
});

describe('a restart or a lost answer at any step', () => {
  it('repeats the same transfer, which the ledger recognizes, when the answer to it was lost', async () => {
    const { service, net, store, build } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    net.failOnce.add('send'); // the transfer happens, and the reply never arrives

    await service.tick();
    expect(net.transfers).toHaveLength(1);
    expect(store.get('order-1')).toMatchObject({ state: 'converting', mintBlock: null });

    // The same transfer is asked for again after the wait, by a process that has just started.
    clock.t += 2 * MINUTE;
    await build().tick();
    expect(net.sends).toHaveLength(2);
    expect(net.sends[1]).toEqual(net.sends[0]);
    expect(net.transfers).toHaveLength(1);
    expect(net.balances.get(order.subaccount)).toBe(0n);
    expect(store.get('order-1')).toMatchObject({ state: 'provisioning', mintBlock: net.transfers[0]!.block.toString() });
  });

  it('does not send again once the block is known, when only minting needs repeating', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    net.failOnce.add('mint');
    await service.tick();
    expect(store.get('order-1')).toMatchObject({ state: 'converting', error: expect.stringContaining('mint') });

    // Not before the wait is up.
    await service.tick();
    expect(net.mints).toHaveLength(1);

    clock.t += 2 * MINUTE;
    await service.tick();
    expect(net.sends).toHaveLength(1);
    expect(net.mints).toHaveLength(2);
    expect(store.get('order-1')?.state).toBe('provisioning');
  });

  it('waits and asks again while the minting canister is still working on the payment', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    net.mintScript.push({ status: 'processing' });
    await service.tick();
    expect(store.get('order-1')?.state).toBe('converting');
    await service.tick();
    expect(net.mints).toHaveLength(2);
    expect(net.sends).toHaveLength(1);
    expect(store.get('order-1')?.state).toBe('provisioning');
  });

  it('carries on from where a stopped process left it, with nothing but what was written down', async () => {
    const { service, net, store, build } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    net.mintScript.push({ status: 'processing' });
    await service.tick();
    const written = store.get('order-1')!;
    expect(written).toMatchObject({ state: 'converting', transferTime: expect.any(String), convertedE8s: (QUOTE_E8S - ICP_FEE_E8S).toString() });

    const restarted = build();
    await restarted.tick();
    expect(restarted.get('order-1')?.state).toBe('provisioning');
    expect(net.sends).toHaveLength(1);
  });

  it('asks the provisioner again for a canister that was being made when the process stopped', async () => {
    const { service, net, provisioner, build } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(provisioner.records.get('order-1')?.state).toBe('pending');

    // After a restart nothing is running it; only being asked starts it again.
    await build().tick();
    expect(provisioner.begun).toHaveLength(2);
  });

  it('waits before starting a failed provisioning again, then does, and shows why it failed', async () => {
    const { service, net, provisioner, store } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    await service.tick();
    provisioner.fail('order-1', 'The cycles ledger is temporarily unavailable', clock.t);
    clock.t += MINUTE;
    await service.tick();
    expect(provisioner.begun).toHaveLength(1);
    expect(store.get('order-1')).toMatchObject({ state: 'provisioning', error: 'The cycles ledger is temporarily unavailable' });

    clock.t += 5 * MINUTE;
    await service.tick();
    expect(provisioner.begun).toHaveLength(2);
    expect(net.sends).toHaveLength(1);
  });
});

describe('what no retry will change', () => {
  it('fails the order, and says why, when the ledger refuses the payment', async () => {
    const funded = new FakeNetwork();
    const refusal = 'The ledger can no longer tell whether an earlier attempt already sent this payment (TxTooOld)';
    const { service, store, log } = setup({
      ports: {
        ...funded.ports(),
        sendForMinting: async () => {
          throw new PaymentRefused(refusal);
        },
      },
    });
    const order = await service.create('order-1', OWNER);
    pay(funded, order, QUOTE_E8S);
    await service.tick();
    expect(orderView(store.get('order-1')!, TREASURY)).toMatchObject({ state: 'failed', error: expect.stringContaining('TxTooOld') });
    expect(log.join('\n')).toMatch(/needs the operator/);

    // A failed order is left alone.
    await service.tick();
    expect(log.filter((line) => /needs the operator/.test(line))).toHaveLength(1);
  });

  it('fails the order when the minting canister refunds the payment', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    net.mintScript.push({ status: 'refused', reason: 'The minting canister refunded the payment: rate unavailable' });
    await service.tick();
    expect(orderView(store.get('order-1')!, TREASURY)).toMatchObject({ state: 'failed', error: expect.stringContaining('refunded') });
  });

  it('fails the order when the provisioner will never make the canister', async () => {
    const { service, net, store, provisioner } = setup();
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    provisioner.beginError = new ProvisionError('limit_reached', 'This gateway has created as many canisters as it is set to');
    await service.tick();
    expect(orderView(store.get('order-1')!, TREASURY)).toMatchObject({ state: 'failed', error: expect.stringContaining('as many canisters') });
  });

  it('shows no error until an order has failed', async () => {
    const { service, net, store } = setup();
    const order = await service.create('order-1', OWNER);
    net.failOnce.add('balance');
    await service.tick();
    expect(store.get('order-1')?.error).toContain('balance');
    expect(orderView(store.get('order-1')!, TREASURY).error).toBeNull();
    clock.t += 2 * MINUTE;
    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(store.get('order-1')?.error).toBeNull();
  });
});

describe('an order nobody pays', () => {
  it('stops being looked at after a week, and ICP that arrives later is not processed', async () => {
    const { service, net, store, log } = setup();
    const order = await service.create('order-1', OWNER);
    clock.t += ORDER_TTL_MS + 1;
    await service.tick();
    expect(store.get('order-1')?.state).toBe('expired');
    expect(log.join('\n')).toMatch(/expired unpaid/);

    pay(net, order, QUOTE_E8S);
    await service.tick();
    expect(net.sends).toEqual([]);
    expect(net.balanceCalls).toBe(0);
  });

  it('frees the canister it set aside', async () => {
    const { service, provisioner } = setup();
    provisioner.limit = 1;
    await service.create('order-1', OWNER);
    await expect(service.create('order-2', OWNER)).rejects.toMatchObject({ code: 'limit_reached' });
    clock.t += ORDER_TTL_MS + 1;
    await service.tick();
    await expect(service.create('order-2', OWNER)).resolves.toMatchObject({ key: 'order-2' });
  });
});

describe('with the real provisioner behind it', () => {
  it('takes an order from payment to a canister its owner holds', async () => {
    // A network with just the rules the provisioner leans on.
    const wasm = Uint8Array.from([0, 97, 115, 109]);
    const wasmHash = createHash('sha256').update(wasm).digest('hex');
    const canisters = new Map<string, { controllers: string[]; installed: boolean; owner: string }>();
    let next = 200;
    const ports: ProvisioningPorts = {
      createCanister: async ({ controllers }) => {
        const id = principal(next++);
        canisters.set(id, { controllers, installed: false, owner: '2vxsx-fae' });
        return id;
      },
      control: async (id) => ({ controllers: [...canisters.get(id)!.controllers], moduleHash: canisters.get(id)!.installed ? wasmHash : null }),
      installCode: async (id) => void (canisters.get(id)!.installed = true),
      setControllers: async (id, controllers) => void (canisters.get(id)!.controllers = controllers),
      repo: (id) => ({
        status: async () => ({ initialized: canisters.get(id)!.owner !== '2vxsx-fae', owner: canisters.get(id)!.owner }),
        init: async () => void (canisters.get(id)!.owner = TREASURY),
        authorize: async () => 'added',
        transferOwnership: async (newOwner) => void (canisters.get(id)!.owner = newOwner),
      }),
    };
    const provisioner = new CanisterProvisioner({ ports, store: new ProvisionStore(dir), treasury: TREASURY, wasm, cycles: 1_000_000_000_000n, limit: 5, writers: [TREASURY], now: () => clock.t });

    const { service, net, store } = setup({ provisioner });
    const order = await service.create('order-1', OWNER);
    pay(net, order, QUOTE_E8S);
    await service.tick();
    await provisioner.provision('order-1', OWNER); // waits for what the order started
    await service.tick();

    const done = store.get('order-1')!;
    expect(done.state).toBe('ready');
    expect(canisters.get(done.canisterId!)).toMatchObject({ controllers: [OWNER], owner: OWNER });
    expect(net.sends).toHaveLength(1);
  });
});
