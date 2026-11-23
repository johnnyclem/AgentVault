/**
 * The Internet Computer calls behind an order: how much ICP an account holds, sending it to the
 * cycles minting canister, and asking that canister to mint cycles from it.
 *
 * Minting cycles is what `dfx cycles convert` does: ICP goes to the minting canister's account whose
 * subaccount names the asker, in a transfer whose memo is "MINT", and the asker then notifies the
 * minting canister of the ledger block. The cycles land in the asker's cycles ledger account, which
 * is where creating a canister (provision-ic.ts) pays from.
 *
 * The Candid below is the part of each published interface this uses. A record decodes by field name,
 * so fields it does not declare are skipped; a variant must name every case the canister can send, and
 * any case whose payload is read is declared with that payload rather than as reserved, which drops it.
 */

import { Actor, type HttpAgent } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { accountIdentifierBytes, mintSubaccount } from './icp-account.js';
import { ICP_FEE_E8S, PaymentRefused, type MintOutcome, type PaymentPorts } from './payments.js';

export const ICP_LEDGER_ID = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
export const CYCLES_MINTING_ID = 'rkp4c-7iaaa-aaaaa-aaaca-cai';
/** The memo the minting canister recognizes a payment for cycles by: the bytes "MINT" read as a number. */
export const MEMO_MINT_CYCLES = 0x544e494dn;

export const icpLedgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ['query']),
    transfer: IDL.Func(
      [
        IDL.Record({
          memo: IDL.Nat64,
          amount: Tokens,
          fee: Tokens,
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          to: IDL.Vec(IDL.Nat8),
          created_at_time: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })),
        }),
      ],
      [
        IDL.Variant({
          Ok: IDL.Nat64,
          Err: IDL.Variant({
            BadFee: IDL.Record({ expected_fee: Tokens }),
            InsufficientFunds: IDL.Record({ balance: Tokens }),
            TxTooOld: IDL.Record({ allowed_window_nanos: IDL.Nat64 }),
            TxCreatedInFuture: IDL.Null,
            // Read, not skipped: a repeat of a transfer the ledger already made answers with its block.
            TxDuplicate: IDL.Record({ duplicate_of: IDL.Nat64 }),
          }),
        }),
      ],
      [],
    ),
  });
};

export const cyclesMintingIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    // The reply also carries a certificate and a hash tree; those are not checked here.
    get_icp_xdr_conversion_rate: IDL.Func(
      [],
      [IDL.Record({ data: IDL.Record({ timestamp_seconds: IDL.Nat64, xdr_permyriad_per_icp: IDL.Nat64 }) })],
      ['query'],
    ),
    notify_mint_cycles: IDL.Func(
      [IDL.Record({ block_index: IDL.Nat64, to_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), deposit_memo: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
      [
        IDL.Variant({
          Ok: IDL.Record({ block_index: IDL.Nat, minted: IDL.Nat, balance: IDL.Nat }),
          Err: IDL.Variant({
            Refunded: IDL.Record({ reason: IDL.Text, block_index: IDL.Opt(IDL.Nat64) }),
            Processing: IDL.Null,
            TransactionTooOld: IDL.Nat64,
            InvalidTransaction: IDL.Text,
            Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
          }),
        }),
      ],
      [],
    ),
  });

type Tokens = { e8s: bigint };
export type LedgerTransferResult =
  | { Ok: bigint }
  | { Err: { BadFee: { expected_fee: Tokens } } | { InsufficientFunds: { balance: Tokens } } | { TxTooOld: { allowed_window_nanos: bigint } } | { TxCreatedInFuture: null } | { TxDuplicate: { duplicate_of: bigint } } };

export type MintCyclesResult =
  | { Ok: { block_index: bigint; minted: bigint; balance: bigint } }
  | {
      Err:
        | { Refunded: { reason: string; block_index: [] | [bigint] } }
        | { Processing: null }
        | { TransactionTooOld: bigint }
        | { InvalidTransaction: string }
        | { Other: { error_code: bigint; error_message: string } };
    };

export interface IcpLedger {
  icrc1_balance_of(account: { owner: Principal; subaccount: [Uint8Array] }): Promise<bigint>;
  transfer(args: {
    memo: bigint;
    amount: Tokens;
    fee: Tokens;
    from_subaccount: [Uint8Array];
    to: Uint8Array;
    created_at_time: [{ timestamp_nanos: bigint }];
  }): Promise<LedgerTransferResult>;
}

export interface CyclesMinting {
  get_icp_xdr_conversion_rate(): Promise<{ data: { timestamp_seconds: bigint; xdr_permyriad_per_icp: bigint } }>;
  notify_mint_cycles(args: { block_index: bigint; to_subaccount: []; deposit_memo: [] }): Promise<MintCyclesResult>;
}

/** What the ledger said about a transfer, as the block it is in, or a refusal in words that say what to do. */
export function blockOfTransfer(result: LedgerTransferResult): bigint {
  if ('Ok' in result) return result.Ok;
  const error = result.Err;
  // A transfer the ledger already made: its block is the answer, so a retry after a crash finds it.
  if ('TxDuplicate' in error) return error.TxDuplicate.duplicate_of;
  if ('BadFee' in error) throw new PaymentRefused(`The ledger's fee is ${error.BadFee.expected_fee.e8s} e8s, not the ${ICP_FEE_E8S} this was built for`);
  if ('InsufficientFunds' in error) throw new PaymentRefused(`The deposit account holds ${error.InsufficientFunds.balance.e8s} e8s, less than was to be sent`);
  if ('TxTooOld' in error) {
    // The ledger only recognizes a repeated transfer for a day. After that it cannot say whether an earlier one was made.
    throw new PaymentRefused('The ledger can no longer tell whether an earlier attempt already sent this payment (TxTooOld). Check the deposit account and the minting canister\'s account before trying again.');
  }
  throw new Error('The ledger says the transfer was created in the future (TxCreatedInFuture): the clock is ahead. Try again.');
}

/** What the minting canister said about a block. */
export function outcomeOfMint(result: MintCyclesResult): MintOutcome {
  if ('Ok' in result) return { status: 'minted', cycles: result.Ok.minted };
  const error = result.Err;
  if ('Processing' in error) return { status: 'processing' };
  if ('Refunded' in error) return { status: 'refused', reason: `The minting canister refunded the payment: ${error.Refunded.reason}` };
  if ('TransactionTooOld' in error) return { status: 'refused', reason: 'The minting canister can no longer process that ledger block (TransactionTooOld)' };
  if ('InvalidTransaction' in error) return { status: 'refused', reason: `The minting canister did not accept the payment: ${error.InvalidTransaction}` };
  return { status: 'refused', reason: `The minting canister refused (${error.Other.error_code}): ${error.Other.error_message}` };
}

export interface IcPaymentOptions {
  agent: HttpAgent;
  /** The gateway's principal: whose account is paid, and for whom cycles are minted. */
  treasury: string;
  ledgerId?: string;
  mintingId?: string;
  /** The calls themselves, in place of actors made from `agent`: for tests, which cannot reach the network. */
  ledger?: IcpLedger;
  minting?: CyclesMinting;
}

/** The Internet Computer behind an order service. */
export function icPaymentPorts(options: IcPaymentOptions): PaymentPorts {
  const { agent, treasury } = options;
  const owner = Principal.fromText(treasury);
  const ledger = options.ledger ?? Actor.createActor<IcpLedger>(icpLedgerIdl, { agent, canisterId: Principal.fromText(options.ledgerId ?? ICP_LEDGER_ID) });
  const minting =
    options.minting ?? Actor.createActor<CyclesMinting>(cyclesMintingIdl, { agent, canisterId: Principal.fromText(options.mintingId ?? CYCLES_MINTING_ID) });
  const mintingAccount = accountIdentifierBytes(options.mintingId ?? CYCLES_MINTING_ID, mintSubaccount(treasury));

  return {
    async rate() {
      const { data } = await minting.get_icp_xdr_conversion_rate();
      if (data.xdr_permyriad_per_icp <= 0n) throw new Error('The cycles minting canister reported no rate');
      return { xdrPermyriadPerIcp: data.xdr_permyriad_per_icp };
    },

    balance: (subaccount) => ledger.icrc1_balance_of({ owner, subaccount: [subaccount] }),

    async sendForMinting({ fromSubaccount, e8s, createdAtTime }) {
      return blockOfTransfer(
        await ledger.transfer({
          memo: MEMO_MINT_CYCLES,
          amount: { e8s },
          fee: { e8s: ICP_FEE_E8S },
          from_subaccount: [fromSubaccount],
          to: mintingAccount,
          created_at_time: [{ timestamp_nanos: createdAtTime }],
        }),
      );
    },

    async mint(block) {
      return outcomeOfMint(await minting.notify_mint_cycles({ block_index: block, to_subaccount: [], deposit_memo: [] }));
    },
  };
}
