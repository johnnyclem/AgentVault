import { Actor, type HttpAgent } from '@dfinity/agent'
import { IDL } from '@dfinity/candid'
import { Principal } from '@dfinity/principal'

/*
 * What a canister holds and burns, as the management canister reports it to a controller. This is
 * the one read that needs the owner's key: any other part of the panel's view is public. Imports
 * are packages only, so the root test suite loads this file by path.
 */

const MANAGEMENT_CANISTER_ID = 'aaaaa-aa'

/**
 * Only the fields the panel reads. The management canister sends more (controllers, query stats,
 * log visibility, ...); a record decodes by field name, so those are skipped and a new one never
 * breaks this. The controllers and code hash are read separately from the subnet's certificate.
 */
export const canisterStatusIdl: IDL.InterfaceFactory = ({ IDL }) =>
  IDL.Service({
    canister_status: IDL.Func(
      [IDL.Record({ canister_id: IDL.Principal })],
      [
        IDL.Record({
          status: IDL.Variant({ running: IDL.Null, stopping: IDL.Null, stopped: IDL.Null }),
          memory_size: IDL.Nat,
          cycles: IDL.Nat,
          idle_cycles_burned_per_day: IDL.Nat,
        }),
      ],
      [],
    ),
  })

type CanisterStatusService = {
  canister_status(args: { canister_id: Principal }): Promise<{
    status: { running: null } | { stopping: null } | { stopped: null }
    memory_size: bigint
    cycles: bigint
    idle_cycles_burned_per_day: bigint
  }>
}

export interface RunState {
  state: 'running' | 'stopping' | 'stopped'
  /** The cycles the canister holds. */
  cycles: bigint
  /** What it burns a day just by existing, as the Internet Computer reports it. */
  burnPerDay: bigint
  memoryBytes: bigint
}

type StatusReply = Awaited<ReturnType<CanisterStatusService['canister_status']>>

export function toRunState(reply: StatusReply): RunState {
  const state = 'running' in reply.status ? 'running' : 'stopping' in reply.status ? 'stopping' : 'stopped'
  return { state, cycles: reply.cycles, burnPerDay: reply.idle_cycles_burned_per_day, memoryBytes: reply.memory_size }
}

/** Needs an agent signed by one of the canister's controllers; anyone else is refused. */
export async function readRunState(agent: HttpAgent, canisterId: string): Promise<RunState> {
  const canister = Principal.fromText(canisterId)
  const management = Actor.createActor<CanisterStatusService>(canisterStatusIdl, {
    agent,
    canisterId: Principal.fromText(MANAGEMENT_CANISTER_ID),
    effectiveCanisterId: canister,
  })
  return toRunState(await management.canister_status({ canister_id: canister }))
}

/** Cycles in trillions to three places, the way they are counted: "0.498 T". Exact, with no floating point. */
export function formatTrillions(cycles: bigint): string {
  const thousandths = (cycles + 500_000_000n) / 1_000_000_000n
  const fraction = (thousandths % 1000n).toString().padStart(3, '0')
  return `${thousandths / 1000n}.${fraction} T`
}

/** A daily burn in millions of cycles, which is how small it is: "1,009 M a day". */
export function formatBurn(burnPerDay: bigint): string {
  return `${(burnPerDay / 1_000_000n).toLocaleString('en-US')} M a day`
}

/** Whole days the balance lasts at the current idle burn; null when nothing is burning. */
export function runwayDays(cycles: bigint, burnPerDay: bigint): number | null {
  return burnPerDay > 0n ? Number(cycles / burnPerDay) : null
}

export function formatRunway(days: number | null): string {
  if (days === null) return 'No burn reported'
  if (days < 1) return 'Under a day'
  if (days < 730) return `${days} ${days === 1 ? 'day' : 'days'}`
  return `${(days / 365).toFixed(1)} years`
}
