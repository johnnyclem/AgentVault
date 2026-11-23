/**
 * Paying for a canister with ICP.
 *
 * An order is a promise that when enough ICP arrives at an address made for it, the gateway turns the
 * ICP into cycles and has a canister created for the buyer's owner (provision.ts). The buyer sends ICP
 * from any wallet to the order's deposit account; nothing in the order is a secret, and nobody but the
 * gateway can move what is sent to it.
 *
 *   awaiting_payment  the deposit account holds less than the order costs
 *   converting        the ICP is sent to the cycles minting canister, and cycles are minted from it
 *   provisioning      the canister is being created, installed and handed over
 *   ready             the canister is the owner's
 *   failed            something that cannot be retried went wrong; the operator has to look
 *   expired           nothing was paid in time; ICP that arrives later is not processed
 *
 * Each step first writes down what it is about to do, then does it, so a restart at any point repeats
 * the same request, which the ledger and the minting canister recognize, instead of making a new one.
 * The Internet Computer calls are behind PaymentPorts so the whole order can be run without it.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { accountIdentifier } from './icp-account.js';
import { ProvisionError, type CanisterProvisioner } from './provision.js';

/** The ICP ledger's fee for one transfer, in e8s (10^-8 ICP). */
export const ICP_FEE_E8S = 10_000n;
/** One trillion cycles is one XDR; the cycles minting canister mints `e8s * xdr_permyriad_per_icp` cycles. */
export const CYCLES_PER_XDR = 1_000_000_000_000n;
/** The dearest an order may be, in XDR: a typo must not turn into a price. */
export const MAX_PRICE_XDR = 1_000;
/** How long an order is looked at for a payment. */
export const ORDER_TTL_MS = 7 * 24 * 3_600_000;
/** After its quote runs out a payment is still taken at the quoted amount for this long, for the network's sake. */
export const QUOTE_GRACE_MS = 5 * 60_000;
export const DEFAULT_QUOTE_MINUTES = 30;
/** How long an order waits after a call failed before trying it again. */
const RETRY_MS = 60_000;
/** How long a provisioning that failed waits before it is started again. */
const PROVISION_RETRY_MS = 5 * 60_000;

/** What an order needs from the Internet Computer; the real calls, or a stand-in under test. */
export interface PaymentPorts {
  /** How many ten-thousandths of an XDR one ICP is worth, as the cycles minting canister states it. */
  rate(): Promise<{ xdrPermyriadPerIcp: bigint }>;
  /** The ICP, in e8s, held by this subaccount of the gateway's account. */
  balance(subaccount: Uint8Array): Promise<bigint>;
  /**
   * Sends `e8s` from the subaccount to the minting canister, paying the fee on top, and returns the
   * ledger block. A repeat with the same `createdAtTime` returns the block of the first. Throws
   * PaymentRefused for a refusal no retry will change; any other error means try again.
   */
  sendForMinting(args: { fromSubaccount: Uint8Array; e8s: bigint; createdAtTime: bigint }): Promise<bigint>;
  /** Asks the minting canister to mint cycles from the ledger block into the gateway's cycles account. */
  mint(block: bigint): Promise<MintOutcome>;
}

export type MintOutcome = { status: 'minted'; cycles: bigint } | { status: 'processing' } | { status: 'refused'; reason: string };

/** The ledger or the minting canister refused something that trying again will not change. */
export class PaymentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRefused';
  }
}

export type OrderState = 'awaiting_payment' | 'converting' | 'provisioning' | 'ready' | 'failed' | 'expired';
const OPEN: readonly OrderState[] = ['awaiting_payment', 'converting', 'provisioning'];

export interface OrderRecord {
  key: string;
  /** Who the canister is handed to. */
  owner: string;
  state: OrderState;
  /** The subaccount of the gateway's ICP account this order is paid to, as hex. */
  subaccount: string;
  quote: { e8s: string; xdrPermyriadPerIcp: string; expiresAt: string };
  /** What the deposit account last held. */
  paidE8s: string;
  /** Fixed when conversion starts, so a repeat of the transfer is recognized by the ledger. */
  transferTime: string | null;
  /** What is sent to the minting canister: the deposit, less the fee. */
  convertedE8s: string | null;
  mintBlock: string | null;
  mintedCycles: string | null;
  canisterId: string | null;
  /** The last thing that went wrong, in words safe to show once the order has failed. */
  error: string | null;
  /** Not before this does a call that failed run again. */
  retryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The cycles an order costs, as a decimal number of XDR: "2", "1.5". Between `minimumCycles` and the ceiling. */
export function parsePriceXdr(text: string, minimumCycles: bigint): bigint {
  const match = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(text.trim());
  const cycles = match ? BigInt(match[1]!) * CYCLES_PER_XDR + (BigInt((match[2] ?? '').padEnd(6, '0')) * CYCLES_PER_XDR) / 1_000_000n : null;
  if (cycles === null || cycles < minimumCycles || cycles > BigInt(MAX_PRICE_XDR) * CYCLES_PER_XDR) {
    throw new Error(
      `--order-price-xdr is a price in XDR (one trillion cycles each), at least what a canister costs to create ` +
        `(${Number(minimumCycles) / 1e12}) and at most ${MAX_PRICE_XDR}`,
    );
  }
  return cycles;
}

/** The ICP, in e8s and rounded up, that mints `cycles` at the rate, plus the fee for the transfer that mints it. */
export function icpForCycles(cycles: bigint, xdrPermyriadPerIcp: bigint): bigint {
  if (xdrPermyriadPerIcp <= 0n) throw new Error('The cycles minting canister reported no rate');
  return (cycles + xdrPermyriadPerIcp - 1n) / xdrPermyriadPerIcp + ICP_FEE_E8S;
}

/** The deposit subaccount of an order: not a secret, only one nobody else is sent to by accident. */
export function orderSubaccount(key: string): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(`agentvault-order/v1\0${key}`).digest());
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

const RECORD_FORMAT = 'agentvault-order/v1';

/** One JSON file per order, written atomically. */
export class OrderStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'orders');
  }

  private file(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  private read(file: string): OrderRecord {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { format?: string; record?: OrderRecord };
    if (parsed.format !== RECORD_FORMAT || !parsed.record) throw new Error(`${path.basename(file)} is not an order in a format this version reads`);
    return parsed.record;
  }

  get(key: string): OrderRecord | null {
    try {
      return this.read(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  put(record: OrderRecord): void {
    atomicWriteFileSync(this.file(record.key), JSON.stringify({ format: RECORD_FORMAT, record }, null, 2) + '\n');
  }

  /** Every order, skipping (and reporting) a file that cannot be read rather than stopping on it. */
  list(onUnreadable?: (file: string, error: unknown) => void): OrderRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: OrderRecord[] = [];
    for (const name of names) {
      try {
        records.push(this.read(path.join(this.dir, name)));
      } catch (error) {
        onUnreadable?.(name, error);
      }
    }
    return records;
  }
}

export interface OrderServiceOptions {
  ports: PaymentPorts;
  store: OrderStore;
  provisioner: Pick<CanisterProvisioner, 'begin' | 'get' | 'validate' | 'remaining'>;
  /** The gateway's principal: whose account the deposits are made to. */
  treasury: string;
  /** What an order costs, in cycles. */
  priceCycles: bigint;
  /** How long a quoted amount holds. */
  quoteMs: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** An order as a client sees it: where to pay, how much, and where it has got to. */
export function orderView(record: OrderRecord, treasury: string) {
  const subaccount = fromHex(record.subaccount);
  const paid = BigInt(record.paidE8s);
  const price = BigInt(record.quote.e8s);
  return {
    key: record.key,
    owner: record.owner,
    state: record.state,
    deposit: { owner: treasury, subaccount: record.subaccount, accountId: accountIdentifier(treasury, subaccount) },
    price: { e8s: record.quote.e8s, expiresAt: record.quote.expiresAt },
    paidE8s: record.paidE8s,
    shortfallE8s: record.state === 'awaiting_payment' && paid < price ? (price - paid).toString() : '0',
    canisterId: record.canisterId,
    error: record.state === 'failed' ? record.error : null,
  };
}

/** Takes orders, and moves each paid one on until its canister is the owner's. */
export class OrderService {
  private readonly now: () => number;
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: OrderServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): OrderRecord | null {
    return this.options.store.get(key);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Writes `changes` onto the newest stored copy of the order, not the copy a caller has been holding
   * across an await, so two things working on one order cannot overwrite each other's progress.
   */
  private update(record: OrderRecord, changes: Partial<OrderRecord>): OrderRecord {
    const next = { ...(this.options.store.get(record.key) ?? record), ...changes, updatedAt: this.iso() };
    this.options.store.put(next);
    return next;
  }

  private async quote(): Promise<OrderRecord['quote']> {
    const { xdrPermyriadPerIcp } = await this.options.ports.rate();
    return {
      e8s: icpForCycles(this.options.priceCycles, xdrPermyriadPerIcp).toString(),
      xdrPermyriadPerIcp: xdrPermyriadPerIcp.toString(),
      expiresAt: new Date(this.now() + this.options.quoteMs).toISOString(),
    };
  }

  /**
   * Opens an order for `owner`, or returns the one already open for `key`, with a fresh quote if it
   * is still unpaid and its quote has run out. Throws a ProvisionError for a request that cannot be served.
   */
  async create(key: string, owner: string): Promise<OrderRecord> {
    const { store, provisioner } = this.options;
    provisioner.validate(key, owner);
    const existing = store.get(key);
    if (existing) {
      if (existing.owner !== owner) throw new ProvisionError('key_conflict', 'That key was already used for another owner');
      if (existing.state === 'awaiting_payment' && Date.parse(existing.quote.expiresAt) <= this.now()) {
        const quote = await this.quote();
        // The order may have been paid and moved on while the rate was being fetched.
        const fresh = store.get(key) ?? existing;
        return fresh.state === 'awaiting_payment' ? this.update(fresh, { quote }) : fresh;
      }
      return existing;
    }
    if (provisioner.get(key)) throw new ProvisionError('key_conflict', 'That key was already used to create a canister');
    // A canister bought now must still be allowed to be made when it is paid for.
    const reserved = store.list().filter((order) => order.state === 'awaiting_payment' || order.state === 'converting').length;
    if (provisioner.remaining() - reserved <= 0) {
      throw new ProvisionError('limit_reached', 'This gateway has sold as many canisters as it is set to');
    }
    const at = this.iso();
    const created: OrderRecord = {
      key,
      owner,
      state: 'awaiting_payment',
      subaccount: toHex(orderSubaccount(key)),
      quote: await this.quote(),
      paidE8s: '0',
      transferTime: null,
      convertedE8s: null,
      mintBlock: null,
      mintedCycles: null,
      canisterId: null,
      error: null,
      retryAt: null,
      createdAt: at,
      updatedAt: at,
    };
    store.put(created);
    return created;
  }

  /** Looks at every open order once. Overlapping calls share one pass. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const { store, log } = this.options;
    for (const record of store.list((file, error) => log?.(`Skipped order file ${file}: ${error instanceof Error ? error.message : String(error)}`))) {
      if (!OPEN.includes(record.state)) continue;
      if (record.retryAt && Date.parse(record.retryAt) > this.now()) continue;
      try {
        await this.advance(record);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
        log?.(`Order ${record.key}: ${message}`);
        // Whatever the record says now, written again: this is only about when to look at it next.
        const current = store.get(record.key) ?? record;
        this.update(current, { error: message, retryAt: new Date(this.now() + RETRY_MS).toISOString() });
      }
    }
  }

  private async advance(start: OrderRecord): Promise<void> {
    const record = start.retryAt || start.error ? this.update(start, { retryAt: null, error: null }) : start;
    switch (record.state) {
      case 'awaiting_payment':
        return this.awaitPayment(record);
      case 'converting':
        return this.convert(record);
      case 'provisioning':
        return this.provision(record);
      default:
    }
  }

  private async awaitPayment(record: OrderRecord): Promise<void> {
    const { ports } = this.options;
    if (this.now() - Date.parse(record.createdAt) > ORDER_TTL_MS) {
      this.update(record, { state: 'expired' });
      this.options.log?.(`Order ${record.key} expired unpaid`);
      return;
    }
    const balance = await ports.balance(fromHex(record.subaccount));
    let current = balance.toString() === record.paidE8s ? record : this.update(record, { paidE8s: balance.toString() });
    // The quoted amount holds until its time (and a little more) is up; after that the price is the rate's now.
    const quoted = BigInt(current.quote.e8s);
    const holds = this.now() <= Date.parse(current.quote.expiresAt) + QUOTE_GRACE_MS;
    const required = holds ? quoted : icpForCycles(this.options.priceCycles, (await ports.rate()).xdrPermyriadPerIcp);
    if (balance < required) return;
    // Written down before anything is sent: a repeat after a restart sends the same transfer.
    current = this.update(current, {
      state: 'converting',
      transferTime: (BigInt(this.now()) * 1_000_000n).toString(),
      convertedE8s: (balance - ICP_FEE_E8S).toString(),
    });
    this.options.log?.(`Order ${record.key} paid: ${balance} e8s; converting ${current.convertedE8s}`);
    await this.convert(current);
  }

  private async convert(record: OrderRecord): Promise<void> {
    const { ports } = this.options;
    let current = record;
    if (!current.mintBlock) {
      try {
        const block = await ports.sendForMinting({
          fromSubaccount: fromHex(current.subaccount),
          e8s: BigInt(current.convertedE8s!),
          createdAtTime: BigInt(current.transferTime!),
        });
        current = this.update(current, { mintBlock: block.toString() });
      } catch (error) {
        if (error instanceof PaymentRefused) return this.fail(current, error.message);
        throw error;
      }
    }
    const outcome = await ports.mint(BigInt(current.mintBlock!));
    if (outcome.status === 'processing') return;
    if (outcome.status === 'refused') return this.fail(current, outcome.reason);
    current = this.update(current, { state: 'provisioning', mintedCycles: outcome.cycles.toString() });
    if (outcome.cycles < this.options.priceCycles) {
      this.options.log?.(`Order ${current.key} minted ${outcome.cycles} cycles, less than its ${this.options.priceCycles} price: the rate moved after the quote`);
    }
    this.options.log?.(`Order ${current.key}: minted ${outcome.cycles} cycles`);
    await this.provision(current);
  }

  private async provision(record: OrderRecord): Promise<void> {
    const { provisioner } = this.options;
    const made = provisioner.get(record.key);
    if (made?.state === 'ready') {
      this.update(record, { state: 'ready', canisterId: made.canisterId });
      this.options.log?.(`Order ${record.key} is ready: ${made.canisterId}`);
      return;
    }
    // `begin` leaves a canister that is being made alone, so a `pending` one is also asked about: after a
    // restart nothing is running it, and only asking starts it again. A failed one waits before it is retried.
    const failedRecently = made?.state === 'failed' && this.now() - Date.parse(made.updatedAt) < PROVISION_RETRY_MS;
    if (made?.state === 'failed' && record.error !== made.error) this.update(record, { error: made.error });
    if (failedRecently) return;
    try {
      provisioner.begin(record.key, record.owner);
    } catch (error) {
      if (error instanceof ProvisionError) return this.fail(record, error.message);
      throw error;
    }
  }

  private fail(record: OrderRecord, message: string): void {
    this.update(record, { state: 'failed', error: message.slice(0, 300) });
    this.options.log?.(`Order ${record.key} failed after payment, and needs the operator: ${message}`);
  }

  /** Starts looking at orders every `intervalMs`, and once now. */
  start(intervalMs: number): { stop(): void } {
    const run = () => {
      this.tick().catch((error: unknown) => this.options.log?.(`Order pass failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  }
}

