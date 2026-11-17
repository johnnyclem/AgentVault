import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { describe, expect, it, vi } from 'vitest';
import {
  CYCLES_LEDGER_ID,
  createWithCyclesLedger,
  cyclesLedgerErrorText,
  cyclesLedgerIdl,
  managementIdl,
  type CyclesLedger,
} from '../../src/canister/provision-ic.js';

const GATEWAY = 'yzoj6-sgrt2-fa25n-xcseg-7gr7y-7nciu-cuqts-edigf-s5vts-cwigu-jae';
const CANISTER = 'uzt4z-lp777-77774-qaabq-cai';
const AT = 1_794_900_000_000_000_000n;

const request = { controllers: [GATEWAY], cycles: 1_000_000_000_000n, createdAtTime: AT };

function ledger(result: Awaited<ReturnType<CyclesLedger['create_canister']>>): CyclesLedger & { create_canister: ReturnType<typeof vi.fn> } {
  return { create_canister: vi.fn().mockResolvedValue(result) } as never;
}

describe('creating a canister from the cycles ledger', () => {
  it('asks for the amount, controlled by who it was told, with the creation time it was given', async () => {
    const fake = ledger({ Ok: { block_id: 7n, canister_id: Principal.fromText(CANISTER) } });

    await expect(createWithCyclesLedger(fake, request)).resolves.toBe(CANISTER);

    expect(fake.create_canister).toHaveBeenCalledExactlyOnceWith({
      from_subaccount: [],
      created_at_time: [AT],
      amount: 1_000_000_000_000n,
      creation_args: [{ settings: [{ controllers: [[Principal.fromText(GATEWAY)]], wasm_memory_limit: [67_108_864n] }] }],
    });
  });

  it('takes the canister an earlier, unanswered attempt made, rather than paying for another', async () => {
    const duplicate = ledger({ Err: { Duplicate: { duplicate_of: 3n, canister_id: [Principal.fromText(CANISTER)] } } });

    await expect(createWithCyclesLedger(duplicate, request)).resolves.toBe(CANISTER);
  });

  it('says what to do when the balance is too low', async () => {
    const poor = ledger({ Err: { InsufficientFunds: { balance: 5n } } });

    await expect(createWithCyclesLedger(poor, request)).rejects.toThrow(/cycles ledger balance is too low.*dfx cycles/s);
  });

  it.each([
    ['TemporarilyUnavailable', /temporarily unavailable/],
    ['FailedToCreate', /Nothing was lost/],
    ['TooOld', /refused to create the canister \(TooOld\)/],
    ['Duplicate', /refused to create the canister \(Duplicate\)/],
  ])('explains %s', async (kind, message) => {
    const refused = ledger({ Err: { [kind]: kind === 'Duplicate' ? { duplicate_of: 1n, canister_id: [] } : null } });

    await expect(createWithCyclesLedger(refused, request)).rejects.toThrow(message);
  });

  it('names the mainnet cycles ledger', () => {
    expect(CYCLES_LEDGER_ID).toBe('um5iw-rqaaa-aaaaq-qaaba-cai');
    expect(cyclesLedgerErrorText({})).toMatch(/unknown/);
  });
});

/**
 * What these interfaces send must decode against the full types the receiving canisters publish:
 * ours leave out the fields this never sets, which are optional there.
 */
describe('what goes on the wire', () => {
  const officialSettings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(IDL.Variant({ controllers: IDL.Null, public: IDL.Null })),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
  });
  const argTypes = (factory: IDL.InterfaceFactory, method: string): IDL.Type[] => {
    const service = factory({ IDL }) as unknown as { _fields: Array<[string, IDL.FuncClass]> };
    return service._fields.find(([name]) => name === method)![1].argTypes;
  };

  it('lets the cycles ledger read a creation request', () => {
    const official = IDL.Record({
      from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
      created_at_time: IDL.Opt(IDL.Nat64),
      amount: IDL.Nat,
      creation_args: IDL.Opt(IDL.Record({
        settings: IDL.Opt(officialSettings),
        subnet_selection: IDL.Opt(IDL.Variant({ Subnet: IDL.Record({ subnet: IDL.Principal }), Filter: IDL.Record({ subnet_type: IDL.Opt(IDL.Text) }) })),
      })),
    });
    const sent = {
      from_subaccount: [],
      created_at_time: [AT],
      amount: 1_000_000_000_000n,
      creation_args: [{ settings: [{ controllers: [[Principal.fromText(GATEWAY)]], wasm_memory_limit: [67_108_864n] }] }],
    };

    const [decoded] = IDL.decode([official], IDL.encode(argTypes(cyclesLedgerIdl, 'create_canister'), [sent])) as unknown as [typeof sent];

    expect(decoded.amount).toBe(1_000_000_000_000n);
    expect(decoded.created_at_time).toEqual([AT]);
    expect(decoded.creation_args[0]!.settings[0]!.controllers[0]![0]!.toText()).toBe(GATEWAY);
  });

  it('reads the cycles ledger’s answers, whatever their details', () => {
    const service = cyclesLedgerIdl({ IDL }) as unknown as { _fields: Array<[string, IDL.FuncClass]> };
    const [answer] = service._fields[0]![1].retTypes;
    const officialAnswer = IDL.Variant({
      Ok: IDL.Record({ block_id: IDL.Nat, canister_id: IDL.Principal }),
      Err: IDL.Variant({
        InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
        TooOld: IDL.Null,
        CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
        TemporarilyUnavailable: IDL.Null,
        Duplicate: IDL.Record({ duplicate_of: IDL.Nat, canister_id: IDL.Opt(IDL.Principal) }),
        FailedToCreate: IDL.Record({ fee_block: IDL.Opt(IDL.Nat), refund_block: IDL.Opt(IDL.Nat), error: IDL.Text }),
        GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }),
      }),
    });

    for (const value of [
      { Ok: { block_id: 9n, canister_id: Principal.fromText(CANISTER) } },
      { Err: { InsufficientFunds: { balance: 1n } } },
      { Err: { FailedToCreate: { fee_block: [], refund_block: [4n], error: 'no subnet' } } },
      { Err: { TooOld: null } },
    ]) {
      const [decoded] = IDL.decode([answer!], IDL.encode([officialAnswer], [value])) as unknown as [Record<string, unknown>];
      expect(Object.keys(decoded)).toEqual(Object.keys(value));
    }
  });

  it('lets the management canister read each call', () => {
    const principal = Principal.fromText(CANISTER);
    const create = IDL.Record({
      amount: IDL.Opt(IDL.Nat),
      settings: IDL.Opt(officialSettings),
      specified_id: IDL.Opt(IDL.Principal),
      sender_canister_version: IDL.Opt(IDL.Nat64),
    });
    const install = IDL.Record({
      mode: IDL.Variant({ install: IDL.Null, reinstall: IDL.Null, upgrade: IDL.Opt(IDL.Record({ skip_pre_upgrade: IDL.Opt(IDL.Bool) })) }),
      canister_id: IDL.Principal,
      wasm_module: IDL.Vec(IDL.Nat8),
      arg: IDL.Vec(IDL.Nat8),
      sender_canister_version: IDL.Opt(IDL.Nat64),
    });
    const update = IDL.Record({ canister_id: IDL.Principal, settings: officialSettings, sender_canister_version: IDL.Opt(IDL.Nat64) });

    const [created] = IDL.decode([create], IDL.encode(argTypes(managementIdl, 'provisional_create_canister_with_cycles'), [{
      amount: [2n], settings: [{ controllers: [[principal]], wasm_memory_limit: [67_108_864n] }], specified_id: [], sender_canister_version: [],
    }])) as unknown as [{ amount: [bigint] }];
    const [installed] = IDL.decode([install], IDL.encode(argTypes(managementIdl, 'install_code'), [{
      mode: { install: null }, canister_id: principal, wasm_module: Uint8Array.of(0, 97, 115, 109), arg: Uint8Array.of(68, 73, 68, 76, 0, 0), sender_canister_version: [],
    }])) as unknown as [{ mode: Record<string, null> }];
    const [updated] = IDL.decode([update], IDL.encode(argTypes(managementIdl, 'update_settings'), [{
      canister_id: principal, settings: { controllers: [[principal]], wasm_memory_limit: [] }, sender_canister_version: [],
    }])) as unknown as [{ settings: { controllers: [Principal[]] } }];

    expect(created.amount).toEqual([2n]);
    expect(Object.keys(installed.mode)).toEqual(['install']);
    expect(updated.settings.controllers[0]![0]!.toText()).toBe(CANISTER);
  });
});
