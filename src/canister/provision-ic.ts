/**
 * The Internet Computer calls behind provisioning: creating a funded canister,
 * installing code on it, and changing who controls it.
 *
 * Creating a canister costs cycles, and only a canister (or the cycles ledger,
 * on behalf of its caller) can pay for one. On the Internet Computer the
 * gateway's identity pays from its cycles ledger balance, which the operator
 * fills by converting ICP (`dfx cycles convert`). A local replica has no cycles
 * ledger, so there the management canister's provisional API, which a local
 * replica allows anyone to use, creates the canister instead.
 *
 * The Candid below is the part of each interface this uses; fields it does not
 * send are optional on the receiving side.
 */

import { Actor, type HttpAgent } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  isLocalReplicaHost,
  memoryRepoErrorText,
} from './memory-repo-actor.js';
import { readCanisterControl } from './memory-repo-control.js';
import type { ProvisionedRepoPort, ProvisioningPorts } from './provision.js';

/** The cycles ledger on the Internet Computer. */
export const CYCLES_LEDGER_ID = 'um5iw-rqaaa-aaaaq-qaaba-cai';
/** The first canister of dfx's default local subnet: any id in the subnet routes a management call there. */
const LOCAL_EFFECTIVE_CANISTER_ID = 'uqqxf-5h777-77774-qaaaa-cai';
const MANAGEMENT_CANISTER_ID = 'aaaaa-aa';
/** The heap limit dfx.json gives memory_repo, which the canister's own 64 MB guard matches. */
const WASM_MEMORY_LIMIT = 67_108_864n;
/** The Candid encoding of no arguments: what a canister with no init arguments is installed with. */
const EMPTY_ARGUMENTS = new Uint8Array(IDL.encode([], []));

export const managementIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const settings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
  });
  return IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [IDL.Record({
        amount: IDL.Opt(IDL.Nat),
        settings: IDL.Opt(settings),
        specified_id: IDL.Opt(IDL.Principal),
        sender_canister_version: IDL.Opt(IDL.Nat64),
      })],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
    install_code: IDL.Func(
      [IDL.Record({
        mode: IDL.Variant({ install: IDL.Null }),
        canister_id: IDL.Principal,
        wasm_module: IDL.Vec(IDL.Nat8),
        arg: IDL.Vec(IDL.Nat8),
        sender_canister_version: IDL.Opt(IDL.Nat64),
      })],
      [],
      [],
    ),
    update_settings: IDL.Func(
      [IDL.Record({
        canister_id: IDL.Principal,
        settings,
        sender_canister_version: IDL.Opt(IDL.Nat64),
      })],
      [],
      [],
    ),
  });
};

/** The cycles ledger's errors carry payloads this does not read, so they are accepted as they come; `Duplicate` is the one it does. */
export const cyclesLedgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const settings = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
  });
  return IDL.Service({
    create_canister: IDL.Func(
      [IDL.Record({
        from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
        created_at_time: IDL.Opt(IDL.Nat64),
        amount: IDL.Nat,
        creation_args: IDL.Opt(IDL.Record({ settings: IDL.Opt(settings) })),
      })],
      [IDL.Variant({
        Ok: IDL.Record({ block_id: IDL.Nat, canister_id: IDL.Principal }),
        Err: IDL.Variant({
          InsufficientFunds: IDL.Reserved,
          TooOld: IDL.Reserved,
          CreatedInFuture: IDL.Reserved,
          TemporarilyUnavailable: IDL.Reserved,
          // Read, not skipped: it carries the canister an earlier, unanswered attempt made, which is how
          // a retry after a crash finds it instead of paying for another. Only the field that is read is
          // declared, so a reply with more fields still decodes.
          Duplicate: IDL.Record({ canister_id: IDL.Opt(IDL.Principal) }),
          FailedToCreate: IDL.Reserved,
          GenericError: IDL.Reserved,
        }),
      })],
      [],
    ),
  });
};

type Management = {
  provisional_create_canister_with_cycles(args: {
    amount: [bigint];
    settings: [{ controllers: [Principal[]]; wasm_memory_limit: [bigint] }];
    specified_id: [];
    sender_canister_version: [];
  }): Promise<{ canister_id: Principal }>;
  install_code(args: {
    mode: { install: null };
    canister_id: Principal;
    wasm_module: Uint8Array;
    arg: Uint8Array;
    sender_canister_version: [];
  }): Promise<void>;
  update_settings(args: {
    canister_id: Principal;
    settings: { controllers: [Principal[]]; wasm_memory_limit: [] };
    sender_canister_version: [];
  }): Promise<void>;
};

type CyclesLedgerResult =
  | { Ok: { block_id: bigint; canister_id: Principal } }
  | { Err: Record<string, unknown> };
export type CyclesLedger = {
  create_canister(args: {
    from_subaccount: [];
    created_at_time: [bigint];
    amount: bigint;
    creation_args: [{ settings: [{ controllers: [Principal[]]; wasm_memory_limit: [bigint] }] }];
  }): Promise<CyclesLedgerResult>;
};

/** A cycles ledger refusal, in words that say what to do. */
export function cyclesLedgerErrorText(error: Record<string, unknown>): string {
  const [kind] = Object.keys(error);
  switch (kind) {
    case 'InsufficientFunds':
      return "The gateway's cycles ledger balance is too low to create a canister. Fund its principal with cycles (`dfx cycles convert`, then `dfx cycles transfer`).";
    case 'TemporarilyUnavailable':
      return 'The cycles ledger is temporarily unavailable. Try again.';
    case 'FailedToCreate':
      return 'The cycles ledger could not create the canister. Nothing was lost; try again.';
    case 'TooOld':
      // The ledger only recognizes a repeated creation for a day. After that it cannot say whether an
      // earlier attempt made a canister, and making another could pay twice, so this stops and asks.
      return "The cycles ledger can no longer tell whether an earlier attempt already made this canister (TooOld). Check the gateway's cycles ledger history before trying again.";
    default:
      return `The cycles ledger refused to create the canister (${kind ?? 'unknown'}).`;
  }
}

/** Raised for a creation the cycles ledger recognizes as one it already made, carrying that canister. */
function duplicateCanister(error: Record<string, unknown>): string | null {
  const duplicate = error.Duplicate;
  if (duplicate && typeof duplicate === 'object') {
    const id = (duplicate as { canister_id?: unknown }).canister_id;
    if (Array.isArray(id) && id[0] instanceof Principal) return id[0].toText();
    if (id instanceof Principal) return id.toText();
  }
  return null;
}

/**
 * Creates a canister paid from the caller's cycles ledger balance. A creation the ledger recognizes
 * as one it already made (same `createdAtTime`) answers with that canister instead of a new one.
 */
export async function createWithCyclesLedger(
  ledger: CyclesLedger,
  args: { controllers: string[]; cycles: bigint; createdAtTime: bigint },
): Promise<string> {
  const result = await ledger.create_canister({
    from_subaccount: [],
    created_at_time: [args.createdAtTime],
    amount: args.cycles,
    creation_args: [{
      settings: [{
        controllers: [args.controllers.map((controller) => Principal.fromText(controller))],
        wasm_memory_limit: [WASM_MEMORY_LIMIT],
      }],
    }],
  });
  if ('Ok' in result) return result.Ok.canister_id.toText();
  const duplicate = duplicateCanister(result.Err);
  if (duplicate) return duplicate;
  throw new Error(cyclesLedgerErrorText(result.Err));
}

export type CycleSource = 'local' | { cyclesLedger: string };

export interface IcProvisioningOptions {
  host: string;
  identity: Parameters<typeof createMemoryRepoAgent>[1];
  /** Where the cycles come from; defaults to the provisional API on a local replica, else the cycles ledger. */
  source?: CycleSource;
}

/** The Internet Computer behind a provisioner. */
export async function icProvisioningPorts(options: IcProvisioningOptions): Promise<ProvisioningPorts> {
  const agent = await createMemoryRepoAgent(options.host, options.identity);
  const source: CycleSource =
    options.source ?? (isLocalReplicaHost(options.host) ? 'local' : { cyclesLedger: CYCLES_LEDGER_ID });
  return icPorts(agent, source);
}

export function icPorts(agent: HttpAgent, source: CycleSource): ProvisioningPorts {
  const management = (effectiveCanisterId: string) =>
    Actor.createActor<Management>(managementIdl, {
      agent,
      canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
      effectiveCanisterId: Principal.fromText(effectiveCanisterId),
    });
  const settingsFor = (controllers: string[]) => ({
    controllers: [controllers.map((controller) => Principal.fromText(controller))] as [Principal[]],
  });

  return {
    async createCanister({ controllers, cycles, createdAtTime }) {
      if (source === 'local') {
        const { canister_id } = await management(LOCAL_EFFECTIVE_CANISTER_ID).provisional_create_canister_with_cycles({
          amount: [cycles],
          settings: [{ ...settingsFor(controllers), wasm_memory_limit: [WASM_MEMORY_LIMIT] }],
          specified_id: [],
          sender_canister_version: [],
        });
        return canister_id.toText();
      }
      const ledger = Actor.createActor<CyclesLedger>(cyclesLedgerIdl, {
        agent,
        canisterId: Principal.fromText(source.cyclesLedger),
      });
      return createWithCyclesLedger(ledger, { controllers, cycles, createdAtTime });
    },

    control: (canisterId) => readCanisterControl(agent, canisterId),

    async installCode(canisterId, wasm) {
      await management(canisterId).install_code({
        mode: { install: null },
        canister_id: Principal.fromText(canisterId),
        wasm_module: wasm,
        arg: EMPTY_ARGUMENTS,
        sender_canister_version: [],
      });
    },

    async setControllers(canisterId, controllers) {
      await management(canisterId).update_settings({
        canister_id: Principal.fromText(canisterId),
        settings: { ...settingsFor(controllers), wasm_memory_limit: [] },
        sender_canister_version: [],
      });
    },

    repo(canisterId): ProvisionedRepoPort {
      const actor = createMemoryRepoActor(canisterId, agent);
      const unwrap = (result: { ok: string } | { err: string }, what: string): string => {
        if ('ok' in result) return result.ok;
        throw new Error(`${what}: ${result.err}`);
      };
      return {
        async status() {
          const { initialized, owner } = await actor.getRepoStatus();
          return { initialized, owner };
        },
        async init(soul) {
          unwrap(await actor.initRepo(soul), 'Could not initialize the repository');
        },
        async authorize(principal) {
          try {
            const result = await actor.addAuthorizedPrincipal(Principal.fromText(principal));
            if ('err' in result && result.err === 'Principal already authorized') return 'already';
            unwrap(result, 'Could not authorize a writer');
            return 'added';
          } catch (error) {
            throw new Error(`Could not authorize a writer: ${memoryRepoErrorText(error)}`);
          }
        },
        async transferOwnership(newOwner) {
          unwrap(await actor.transferOwnership(Principal.fromText(newOwner)), 'Could not hand over the repository');
        },
      };
    },
  };
}
