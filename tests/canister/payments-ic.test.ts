import type { HttpAgent } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { describe, expect, it } from 'vitest';
import { accountIdentifier, crc32, mintSubaccount } from '../../src/canister/icp-account.js';
import { ICP_FEE_E8S, PaymentRefused } from '../../src/canister/payments.js';
import {
  CYCLES_MINTING_ID,
  ICP_LEDGER_ID,
  MEMO_MINT_CYCLES,
  blockOfTransfer,
  cyclesMintingIdl,
  icPaymentPorts,
  icpLedgerIdl,
  outcomeOfMint,
  type CyclesMinting,
  type IcpLedger,
  type LedgerTransferResult,
  type MintCyclesResult,
} from '../../src/canister/payments-ic.js';

// A made-up gateway, and the accounts it works out to. The expected values were computed by a separate
// implementation (Python's sha224 and zlib.crc32 over the layout the ledger documents), not by this code.
const GATEWAY = Principal.fromUint8Array(Uint8Array.of(1, 1, 1, 1)).toText();
const GATEWAY_ACCOUNT = '2d79da289f587db8296b0596504ec690fc6bf419b92d1001cf90ee6398d180d5';
const COUNTING_ACCOUNT = 'bbc7fd502161604f37862f85280e53a210e79a67944f352e245cb8e004c6e429';
const MINT_ACCOUNT = 'c37450e36860ed65658f091992f00a6b6f9e42b5e26f6efcb4c82626de6e5ef4';

type Service = { _fields: Array<[string, { argTypes: IDL.Type[]; retTypes: IDL.Type[] }]> };
const method = (factory: IDL.InterfaceFactory, name: string) => {
  const found = (factory({ IDL }) as unknown as Service)._fields.find(([field]) => field === name);
  if (!found) throw new Error(`no method ${name}`);
  return found[1];
};
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('where ICP is sent', () => {
  it('checks bytes the way the ledger does', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('derives the accounts an independent implementation does', () => {
    expect(accountIdentifier(GATEWAY)).toBe(GATEWAY_ACCOUNT);
    expect(accountIdentifier(GATEWAY, Uint8Array.from({ length: 32 }, (_, index) => index))).toBe(COUNTING_ACCOUNT);
    expect(accountIdentifier(CYCLES_MINTING_ID, mintSubaccount(GATEWAY))).toBe(MINT_ACCOUNT);
    expect(hex(mintSubaccount(GATEWAY))).toBe('0401010101' + '00'.repeat(27));
  });

  it('names the asker in the minting subaccount: its length, its bytes, then zeros', () => {
    const subaccount = mintSubaccount(GATEWAY);
    const principal = Principal.fromText(GATEWAY).toUint8Array();
    expect(subaccount).toHaveLength(32);
    expect(subaccount[0]).toBe(principal.length);
    expect(subaccount.slice(1, 1 + principal.length)).toEqual(principal);
    expect(subaccount.slice(1 + principal.length).every((byte) => byte === 0)).toBe(true);
  });

  it('gives a different account for a different subaccount, and refuses one of the wrong size', () => {
    expect(accountIdentifier(GATEWAY, new Uint8Array(32).fill(1))).not.toBe(GATEWAY_ACCOUNT);
    expect(() => accountIdentifier(GATEWAY, new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('what the ledger says about a transfer', () => {
  // The reply type as the ledger publishes it (ryjl3-tyaaa-aaaaa-aaaba-cai, `transfer`).
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const published = IDL.Variant({
    Ok: IDL.Nat64,
    Err: IDL.Variant({
      BadFee: IDL.Record({ expected_fee: Tokens }),
      InsufficientFunds: IDL.Record({ balance: Tokens }),
      TxTooOld: IDL.Record({ allowed_window_nanos: IDL.Nat64 }),
      TxCreatedInFuture: IDL.Null,
      TxDuplicate: IDL.Record({ duplicate_of: IDL.Nat64 }),
    }),
  });
  /** Each reply, encoded as the ledger sends it, then decoded through the type the gateway uses. */
  const received = (value: unknown): LedgerTransferResult => {
    const { retTypes } = method(icpLedgerIdl, 'transfer');
    return IDL.decode(retTypes, (IDL.encode([published], [value])))[0] as unknown as LedgerTransferResult;
  };

  it('answers with the block when it made the transfer', () => {
    expect(blockOfTransfer(received({ Ok: 3_000_001n }))).toBe(3_000_001n);
  });

  it('answers with the block of the transfer already made, so a retry after a crash finds it', () => {
    expect(blockOfTransfer(received({ Err: { TxDuplicate: { duplicate_of: 3_000_002n } } }))).toBe(3_000_002n);
  });

  it('refuses, in words that say what to do, what no retry will change', () => {
    expect(() => blockOfTransfer(received({ Err: { BadFee: { expected_fee: { e8s: 20_000n } } } }))).toThrow(/20000 e8s/);
    expect(() => blockOfTransfer(received({ Err: { InsufficientFunds: { balance: { e8s: 5n } } } }))).toThrow(/holds 5 e8s/);
    expect(() => blockOfTransfer(received({ Err: { TxTooOld: { allowed_window_nanos: 86_400_000_000_000n } } }))).toThrow(PaymentRefused);
    expect(() => blockOfTransfer(received({ Err: { TxTooOld: { allowed_window_nanos: 1n } } }))).toThrow(/TxTooOld/);
  });

  it('asks to be tried again when the clock is ahead, which is no refusal', () => {
    let thrown: unknown;
    try {
      blockOfTransfer(received({ Err: { TxCreatedInFuture: null } }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PaymentRefused);
  });

  it('reads the balance of an account as a number', () => {
    const { retTypes } = method(icpLedgerIdl, 'icrc1_balance_of');
    expect(IDL.decode(retTypes, (IDL.encode([IDL.Nat], [137_751_047n])))[0]).toBe(137_751_047n);
  });
});

describe('what the minting canister says', () => {
  // As published (rkp4c-7iaaa-aaaaa-aaaca-cai): the rate comes with its certification, which is not read here.
  const publishedRate = IDL.Record({
    data: IDL.Record({ timestamp_seconds: IDL.Nat64, xdr_permyriad_per_icp: IDL.Nat64 }),
    hash_tree: IDL.Vec(IDL.Nat8),
    certificate: IDL.Vec(IDL.Nat8),
  });
  const publishedMint = IDL.Variant({
    Ok: IDL.Record({ block_index: IDL.Nat, minted: IDL.Nat, balance: IDL.Nat }),
    Err: IDL.Variant({
      Refunded: IDL.Record({ reason: IDL.Text, block_index: IDL.Opt(IDL.Nat64) }),
      Processing: IDL.Null,
      TransactionTooOld: IDL.Nat64,
      InvalidTransaction: IDL.Text,
      Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
    }),
  });
  const mintReply = (value: unknown): MintCyclesResult => {
    const { retTypes } = method(cyclesMintingIdl, 'notify_mint_cycles');
    return IDL.decode(retTypes, (IDL.encode([publishedMint], [value])))[0] as unknown as MintCyclesResult;
  };

  it('reads the rate from a reply that carries its certificate as well', () => {
    const { retTypes } = method(cyclesMintingIdl, 'get_icp_xdr_conversion_rate');
    const reply = {
      data: { timestamp_seconds: 1_795_400_000n, xdr_permyriad_per_icp: 14_520n },
      hash_tree: new Uint8Array([1, 2, 3]),
      certificate: new Uint8Array([4, 5, 6]),
    };
    const decoded = IDL.decode(retTypes, (IDL.encode([publishedRate], [reply])))[0] as unknown as { data: { xdr_permyriad_per_icp: bigint } };
    expect(decoded.data.xdr_permyriad_per_icp).toBe(14_520n);
  });

  it('reads the cycles minted from a payment', () => {
    const minted = mintReply({ Ok: { block_index: 3_000_000n, minted: 1_500_000_000_000n, balance: 1_499_900_000_000n } });
    expect(outcomeOfMint(minted)).toEqual({ status: 'minted', cycles: 1_500_000_000_000n });
  });

  it('says to wait while the payment is being processed', () => {
    expect(outcomeOfMint(mintReply({ Err: { Processing: null } }))).toEqual({ status: 'processing' });
  });

  it('refuses, with the minting canister\'s reason, what it will not take', () => {
    const refused = (value: unknown): string => {
      const outcome = outcomeOfMint(mintReply(value));
      if (outcome.status !== 'refused') throw new Error(`expected a refusal, got ${outcome.status}`);
      return outcome.reason;
    };
    expect(refused({ Err: { Refunded: { reason: 'the rate is unavailable', block_index: [3_000_003n] } } })).toMatch(/refunded the payment: the rate is unavailable/);
    expect(refused({ Err: { Refunded: { reason: 'too small', block_index: [] } } })).toMatch(/too small/);
    expect(refused({ Err: { TransactionTooOld: 2_900_000n } })).toMatch(/TransactionTooOld/);
    expect(refused({ Err: { InvalidTransaction: 'memo is not MINT' } })).toMatch(/memo is not MINT/);
    expect(refused({ Err: { Other: { error_code: 7n, error_message: 'busy' } } })).toMatch(/\(7\): busy/);
  });
});

describe('the calls an order makes', () => {
  const sub = Uint8Array.from({ length: 32 }, (_, index) => index);
  const sent: unknown[] = [];
  const notified: unknown[] = [];
  const queried: unknown[] = [];
  const fakeLedger = (reply: LedgerTransferResult): IcpLedger => ({
    icrc1_balance_of: async (account) => (queried.push(account), 137_751_047n),
    transfer: async (args) => (sent.push(args), reply),
  });
  const fakeMinting = (reply: MintCyclesResult, rate = 14_520n): CyclesMinting => ({
    get_icp_xdr_conversion_rate: async () => ({ data: { timestamp_seconds: 1n, xdr_permyriad_per_icp: rate } }),
    notify_mint_cycles: async (args) => (notified.push(args), reply),
  });
  const ports = (ledger: IcpLedger, minting: CyclesMinting) => icPaymentPorts({ agent: {} as HttpAgent, treasury: GATEWAY, ledger, minting });

  it('reads the balance of the order\'s subaccount of the gateway\'s account', async () => {
    queried.length = 0;
    const held = await ports(fakeLedger({ Ok: 1n }), fakeMinting({ Err: { Processing: null } })).balance(sub);
    expect(held).toBe(137_751_047n);
    expect(queried).toEqual([{ owner: Principal.fromText(GATEWAY), subaccount: [sub] }]);
  });

  it('sends the deposit to the account that mints cycles for the gateway, as a payment for cycles', async () => {
    sent.length = 0;
    const block = await ports(fakeLedger({ Ok: 3_000_001n }), fakeMinting({ Err: { Processing: null } })).sendForMinting({
      fromSubaccount: sub,
      e8s: 100_000_000n,
      createdAtTime: 1_795_000_000_000_000_000n,
    });
    expect(block).toBe(3_000_001n);
    const args = sent[0] as { memo: bigint; amount: { e8s: bigint }; fee: { e8s: bigint }; from_subaccount: [Uint8Array]; to: Uint8Array; created_at_time: [{ timestamp_nanos: bigint }] };
    expect(args.memo).toBe(1_414_416_717n); // the bytes "MINT" as the number the minting canister looks for
    expect(args.memo).toBe(MEMO_MINT_CYCLES);
    expect(args.amount).toEqual({ e8s: 100_000_000n });
    expect(args.fee).toEqual({ e8s: ICP_FEE_E8S });
    expect(args.from_subaccount).toEqual([sub]);
    expect(hex(args.to)).toBe(MINT_ACCOUNT);
    expect(args.created_at_time).toEqual([{ timestamp_nanos: 1_795_000_000_000_000_000n }]);
  });

  it('encodes that transfer as the ledger\'s published arguments, which carry the memo as a number and no ICRC memo', () => {
    const { argTypes } = method(icpLedgerIdl, 'transfer');
    const args = {
      memo: MEMO_MINT_CYCLES,
      amount: { e8s: 100_000_000n },
      fee: { e8s: ICP_FEE_E8S },
      from_subaccount: [sub],
      to: Uint8Array.from(Buffer.from(MINT_ACCOUNT, 'hex')),
      created_at_time: [{ timestamp_nanos: 5n }],
    };
    // The published argument record, read back field by field.
    const Tokens = IDL.Record({ e8s: IDL.Nat64 });
    const published = IDL.Record({
      memo: IDL.Nat64,
      amount: Tokens,
      fee: Tokens,
      from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
      to: IDL.Vec(IDL.Nat8),
      created_at_time: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })),
    });
    const decoded = IDL.decode([published], (IDL.encode(argTypes, [args])))[0] as unknown as { memo: bigint; to: Uint8Array };
    expect(decoded.memo).toBe(1_414_416_717n);
    expect(hex(decoded.to)).toBe(MINT_ACCOUNT);
  });

  it('takes the block of a transfer the ledger already made as the answer', async () => {
    const port = ports(fakeLedger({ Err: { TxDuplicate: { duplicate_of: 3_000_002n } } }), fakeMinting({ Err: { Processing: null } }));
    expect(await port.sendForMinting({ fromSubaccount: sub, e8s: 1n, createdAtTime: 1n })).toBe(3_000_002n);
  });

  it('refuses a transfer the ledger will not make, and retries one it could not time', async () => {
    const refuse = (reply: LedgerTransferResult) => ports(fakeLedger(reply), fakeMinting({ Err: { Processing: null } })).sendForMinting({ fromSubaccount: sub, e8s: 1n, createdAtTime: 1n });
    await expect(refuse({ Err: { InsufficientFunds: { balance: { e8s: 0n } } } })).rejects.toBeInstanceOf(PaymentRefused);
    await expect(refuse({ Err: { TxTooOld: { allowed_window_nanos: 1n } } })).rejects.toBeInstanceOf(PaymentRefused);
    await expect(refuse({ Err: { TxCreatedInFuture: null } })).rejects.not.toBeInstanceOf(PaymentRefused);
  });

  it('asks the minting canister to mint from the block into the gateway\'s own cycles account', async () => {
    notified.length = 0;
    const outcome = await ports(
      fakeLedger({ Ok: 1n }),
      fakeMinting({ Ok: { block_index: 1n, minted: 2_000_000_002_440n, balance: 2_000_000_002_440n } }),
    ).mint(3_000_001n);
    expect(outcome).toEqual({ status: 'minted', cycles: 2_000_000_002_440n });
    // No subaccount and no memo: the cycles go to the account the gateway pays canisters from.
    expect(notified).toEqual([{ block_index: 3_000_001n, to_subaccount: [], deposit_memo: [] }]);
  });

  it('reports the rate as the minting canister states it, and refuses a rate of nothing', async () => {
    const live = ports(fakeLedger({ Ok: 1n }), fakeMinting({ Err: { Processing: null } }));
    expect(await live.rate()).toEqual({ xdrPermyriadPerIcp: 14_520n });
    const broken = icPaymentPorts({ agent: {} as HttpAgent, treasury: GATEWAY, ledger: fakeLedger({ Ok: 1n }), minting: fakeMinting({ Err: { Processing: null } }, 0n) });
    await expect(broken.rate()).rejects.toThrow(/no rate/);
  });

  it('is built for the ledger and the minting canister the Internet Computer runs', () => {
    expect(ICP_LEDGER_ID).toBe('ryjl3-tyaaa-aaaaa-aaaba-cai');
    expect(CYCLES_MINTING_ID).toBe('rkp4c-7iaaa-aaaaa-aaaca-cai');
  });
});
