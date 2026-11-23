/**
 * The owner panel's logic (webapp/src/lib/owner/): reading the owner's key in the browser, what the
 * management canister says about cycles, and which changes the canister lets its owner make.
 *
 * The key reader is checked against the CLI's own parser (src/canister/identity.ts) on keys OpenSSL
 * and dfx write, so the two agree on who a key is. The cycles reply is decoded from a real Candid
 * encoding that carries more fields than the panel declares, as the Internet Computer's does. No
 * error text may carry any part of a key.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IDL } from '@dfinity/candid';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { Principal } from '@dfinity/principal';
import { identityFromPem } from '../../src/canister/identity.js';

type KeyModule = {
  parseOwnerKey: (text: string) => Ed25519KeyIdentity;
  OwnerKeyError: new (message: string) => Error;
};

type ActionState = { allowed: true } | { allowed: false; reason: string };
type OwnerAction =
  | { kind: 'freeze' }
  | { kind: 'unfreeze' }
  | { kind: 'addWriter'; principal: string }
  | { kind: 'removeWriter'; principal: string };

type ActionsModule = {
  ownerActionStates: (
    status: { owner: string; frozen: boolean; killed: boolean },
    signer: string | null,
  ) => Record<OwnerAction['kind'], ActionState>;
  runOwnerAction: (actor: FakeActor, signer: string, action: OwnerAction) => Promise<string>;
  OwnerActionError: new (message: string) => Error;
};

type RunState = { state: string; cycles: bigint; burnPerDay: bigint; memoryBytes: bigint };
type StatusModule = {
  canisterStatusIdl: IDL.InterfaceFactory;
  readRunState: (agent: unknown, canisterId: string) => Promise<RunState>;
  toRunState: (reply: {
    status: { running: null };
    memory_size: bigint;
    cycles: bigint;
    idle_cycles_burned_per_day: bigint;
  }) => RunState;
  formatTrillions: (cycles: bigint) => string;
  runwayDays: (cycles: bigint, burnPerDay: bigint) => number | null;
  formatRunway: (days: number | null) => string;
  formatBurn: (burnPerDay: bigint) => string;
};

type Result = { ok: string } | { err: string };
type FakeActor = {
  freeze: () => Promise<Result>;
  manualUnlock: () => Promise<Result>;
  addAuthorizedPrincipal: (principal: Principal) => Promise<Result>;
  removeAuthorizedPrincipal: (principal: Principal) => Promise<Result>;
};

// Loaded by path, so the root typecheck does not compile the webapp.
const LIB = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'owner');
let keys: KeyModule;
let actions: ActionsModule;
let status: StatusModule;

beforeAll(async () => {
  keys = (await import(join(LIB, 'key.ts'))) as KeyModule;
  actions = (await import(join(LIB, 'actions.ts'))) as ActionsModule;
  status = (await import(join(LIB, 'status.ts'))) as StatusModule;
});

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const identity = Ed25519KeyIdentity.generate(SEED);
const PRINCIPAL = identity.getPrincipal().toText();

const V1_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const V2_PREFIX = Buffer.from('3053020101300506032b657004220420', 'hex');
const V2_PUBLIC = Buffer.from('a123032100', 'hex');

const pemOf = (der: Buffer, label = 'PRIVATE KEY'): string =>
  `-----BEGIN ${label}-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
const V1_PEM = pemOf(Buffer.concat([V1_PREFIX, SEED]));
const V2_PEM = pemOf(Buffer.concat([V2_PREFIX, SEED, V2_PUBLIC, Buffer.from(identity.getPublicKey().rawKey)]));

describe('reading the owner key', () => {
  it('reads PKCS#8 v1 and dfx v2 keys, and agrees with the CLI on who they are', () => {
    for (const pem of [V1_PEM, V2_PEM]) {
      expect(keys.parseOwnerKey(pem).getPrincipal().toText()).toBe(PRINCIPAL);
      expect(identityFromPem(pem).identity.getPrincipal().toText()).toBe(PRINCIPAL);
    }
  });

  it('reads a key OpenSSL wrote, the way the CLI does', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(keys.parseOwnerKey(pem).getPrincipal().toText()).toBe(identityFromPem(pem).identity.getPrincipal().toText());
  });

  it('reads the key however it was kept: one line, literal \\n, Windows line ends, or with text around it', () => {
    const oneLine = V1_PEM.trim().split('\n').join(' ');
    const escaped = V1_PEM.trim().split('\n').join('\\n');
    const windows = V1_PEM.replace(/\n/g, '\r\n');
    const surrounded = `# owner key, keep safe\n\n${V1_PEM}\ntrailing note`;
    for (const text of [oneLine, escaped, windows, surrounded]) {
      expect(keys.parseOwnerKey(text).getPrincipal().toText()).toBe(PRINCIPAL);
    }
  });

  it('refuses what it cannot use, and says why in words that carry no key material', () => {
    const body = Buffer.concat([V1_PREFIX, SEED]).toString('base64');
    const wrongPublic = Buffer.concat([V2_PREFIX, SEED, V2_PUBLIC, Buffer.alloc(32, 7)]);
    const cases: Array<[string, string, RegExp]> = [
      ['empty', '', /No private key/],
      ['a public key', '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----', /No private key/],
      ['encrypted', pemOf(Buffer.concat([V1_PREFIX, SEED]), 'ENCRYPTED PRIVATE KEY'), /encrypted/],
      ['secp256k1', pemOf(Buffer.alloc(118, 1), 'EC PRIVATE KEY'), /Ed25519/],
      ['bad base64', '-----BEGIN PRIVATE KEY-----\n!!!notbase64!!!\n-----END PRIVATE KEY-----', /damaged/],
      ['another layout', pemOf(Buffer.alloc(138, 2)), /layout/],
      ['truncated', pemOf(Buffer.concat([V1_PREFIX, SEED]).subarray(0, 40)), /layout/],
      ['public half that is not the seed’s', pemOf(wrongPublic), /public half/],
    ];
    for (const [name, text, message] of cases) {
      let thrown: unknown;
      try {
        keys.parseOwnerKey(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(keys.OwnerKeyError);
      const said = (thrown as Error).message;
      expect(said, name).toMatch(message);
      expect(said, name).not.toContain(body);
      expect(said, name).not.toContain(Buffer.from(SEED).toString('hex'));
    }
  });
});

describe('what the management canister says about cycles', () => {
  // What the Internet Computer sends: the fields the panel reads, and others it does not.
  const reply = IDL.Record({
    status: IDL.Variant({ running: IDL.Null, stopping: IDL.Null, stopped: IDL.Null }),
    memory_size: IDL.Nat,
    cycles: IDL.Nat,
    reserved_cycles: IDL.Nat,
    idle_cycles_burned_per_day: IDL.Nat,
    module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    settings: IDL.Record({
      controllers: IDL.Vec(IDL.Principal),
      freezing_threshold: IDL.Nat,
      reserved_cycles_limit: IDL.Nat,
      log_visibility: IDL.Variant({ controllers: IDL.Null, public: IDL.Null }),
      wasm_memory_limit: IDL.Nat,
    }),
    query_stats: IDL.Record({ num_calls_total: IDL.Nat, num_instructions_total: IDL.Nat }),
  });
  const real = {
    status: { running: null },
    memory_size: 5_667_368n,
    cycles: 498_163_610_560n,
    reserved_cycles: 0n,
    idle_cycles_burned_per_day: 1_008_790_149n,
    module_hash: [new Uint8Array([0x4d, 0x11])],
    settings: {
      controllers: [Principal.fromText(PRINCIPAL)],
      freezing_threshold: 2_592_000n,
      reserved_cycles_limit: 5_000_000_000_000n,
      log_visibility: { controllers: null },
      wasm_memory_limit: 67_108_864n,
    },
    query_stats: { num_calls_total: 0n, num_instructions_total: 0n },
  };

  it('is decoded by the panel’s own declaration from a reply that has more fields', () => {
    const service = status.canisterStatusIdl({ IDL }) as unknown as {
      _fields: Array<[string, { retTypes: IDL.Type[] }]>;
    };
    const retTypes = service._fields[0]?.[1].retTypes ?? [];
    const decoded = IDL.decode(retTypes, new Uint8Array(IDL.encode([reply], [real])))[0] as Record<string, unknown>;
    expect(decoded).toMatchObject({
      status: { running: null },
      memory_size: 5_667_368n,
      cycles: 498_163_610_560n,
      idle_cycles_burned_per_day: 1_008_790_149n,
    });
  });

  it('sends the question to the management canister, routed by the canister it is about', async () => {
    // The real actor runs; the agent it is given records the call and stops it before any network.
    const sent: Array<{ canisterId: string; methodName: string; effectiveCanisterId: string; arg: Uint8Array }> = [];
    const agent = {
      call: async (canisterId: Principal, fields: { methodName: string; effectiveCanisterId: Principal; arg: ArrayBuffer }) => {
        sent.push({
          canisterId: canisterId.toText(),
          methodName: fields.methodName,
          effectiveCanisterId: fields.effectiveCanisterId.toText(),
          arg: new Uint8Array(fields.arg),
        });
        throw new Error('stopped before the network');
      },
      getPrincipal: async () => Principal.anonymous(),
    };
    const canister = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
    await expect(status.readRunState(agent, canister)).rejects.toThrow('stopped before the network');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ canisterId: 'aaaaa-aa', methodName: 'canister_status', effectiveCanisterId: canister });
    const service = status.canisterStatusIdl({ IDL }) as unknown as { _fields: Array<[string, { argTypes: IDL.Type[] }]> };
    const argument = IDL.decode(service._fields[0]?.[1].argTypes ?? [], sent[0]?.arg ?? new Uint8Array())[0] as unknown as { canister_id: Principal };
    expect(argument.canister_id.toText()).toBe(canister);
  });

  it('reads the fields it declares, and names each run state', () => {
    expect(status.toRunState({ status: { running: null }, memory_size: 5_667_368n, cycles: 498_163_610_560n, idle_cycles_burned_per_day: 1_008_790_149n })).toEqual({
      state: 'running',
      cycles: 498_163_610_560n,
      burnPerDay: 1_008_790_149n,
      memoryBytes: 5_667_368n,
    });
    for (const state of ['running', 'stopping', 'stopped']) {
      const reply = { status: { [state]: null } as { running: null }, memory_size: 1n, cycles: 2n, idle_cycles_burned_per_day: 3n };
      expect(status.toRunState(reply).state).toBe(state);
    }
  });

  it('counts cycles exactly and says how long they last', () => {
    expect(status.formatTrillions(498_163_610_560n)).toBe('0.498 T');
    expect(status.formatTrillions(0n)).toBe('0.000 T');
    expect(status.formatTrillions(499_999_999_999n)).toBe('0.500 T');
    expect(status.formatTrillions(1_234_567_890_123n)).toBe('1.235 T');
    expect(status.formatTrillions(12_345_678_901_234_567_890n)).toBe('12345678.901 T');
    expect(status.runwayDays(498_163_610_560n, 1_008_790_149n)).toBe(493);
    expect(status.runwayDays(10n, 0n)).toBeNull();
    expect(status.formatRunway(493)).toBe('493 days');
    expect(status.formatRunway(1)).toBe('1 day');
    expect(status.formatRunway(0)).toBe('Under a day');
    expect(status.formatRunway(1_000)).toBe('2.7 years');
    expect(status.formatRunway(null)).toBe('No burn reported');
    expect(status.formatBurn(1_008_790_149n)).toBe('1,008 M a day');
    expect(status.formatBurn(999_999n)).toBe('0 M a day');
  });
});

describe('what the owner may do', () => {
  const OWNER = PRINCIPAL;
  const state = (frozen: boolean, killed: boolean, signer: string | null = OWNER) =>
    actions.ownerActionStates({ owner: OWNER, frozen, killed }, signer);
  const allowed = (states: Record<string, ActionState>) =>
    Object.entries(states).filter(([, value]) => value.allowed).map(([kind]) => kind).sort();

  it('allows nothing without a key, or with a key that is not the owner’s', () => {
    expect(allowed(state(false, false, null))).toEqual([]);
    expect(allowed(state(false, false, 'aaaaa-aa'))).toEqual([]);
    expect(state(false, false, 'aaaaa-aa').freeze).toEqual({ allowed: false, reason: 'This key is not the owner.' });
  });

  it('lets the owner freeze, and change writers, while it is running', () => {
    expect(allowed(state(false, false))).toEqual(['addWriter', 'freeze', 'removeWriter']);
  });

  it('lets the owner only unfreeze while frozen, because the canister refuses writer changes then', () => {
    expect(allowed(state(true, false))).toEqual(['unfreeze']);
    const refused = state(true, false).removeWriter;
    expect(refused.allowed).toBe(false);
    expect('reason' in refused && refused.reason).toMatch(/Unfreeze first/);
  });

  it('allows nothing once it is killed', () => {
    expect(allowed(state(false, true))).toEqual([]);
    expect(allowed(state(true, true))).toEqual([]);
  });
});

describe('making a change', () => {
  const SIGNER = PRINCIPAL;
  const WRITER = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(9)).getPrincipal().toText();
  const fake = (overrides: Partial<FakeActor> = {}) => {
    const calls: string[] = [];
    const actor: FakeActor = {
      freeze: async () => (calls.push('freeze'), { ok: 'Canister frozen' }),
      manualUnlock: async () => (calls.push('manualUnlock'), { ok: 'Canister unfrozen' }),
      addAuthorizedPrincipal: async (principal) => (calls.push(`add ${principal.toText()}`), { ok: 'Principal authorized' }),
      removeAuthorizedPrincipal: async (principal) => (calls.push(`remove ${principal.toText()}`), { ok: 'Principal removed' }),
      ...overrides,
    };
    return { actor, calls };
  };
  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(actions.OwnerActionError);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('calls the canister method for each change and returns its own confirmation', async () => {
    const { actor, calls } = fake();
    expect(await actions.runOwnerAction(actor, SIGNER, { kind: 'freeze' })).toBe('Canister frozen');
    expect(await actions.runOwnerAction(actor, SIGNER, { kind: 'unfreeze' })).toBe('Canister unfrozen');
    expect(await actions.runOwnerAction(actor, SIGNER, { kind: 'addWriter', principal: ` ${WRITER} ` })).toBe('Principal authorized');
    expect(await actions.runOwnerAction(actor, SIGNER, { kind: 'removeWriter', principal: WRITER })).toBe('Principal removed');
    expect(calls).toEqual(['freeze', 'manualUnlock', `add ${WRITER}`, `remove ${WRITER}`]);
  });

  it('signs nothing for a principal that is not valid, or is anonymous', async () => {
    const { actor, calls } = fake();
    expect(await refusal(actions.runOwnerAction(actor, SIGNER, { kind: 'addWriter', principal: 'not a principal' }))).toBe('That is not a valid principal.');
    expect(await refusal(actions.runOwnerAction(actor, SIGNER, { kind: 'removeWriter', principal: '' }))).toBe('That is not a valid principal.');
    expect(await refusal(actions.runOwnerAction(actor, SIGNER, { kind: 'addWriter', principal: '2vxsx-fae' }))).toMatch(/anonymous/);
    expect(calls).toEqual([]);
  });

  it('passes on the canister’s own answer when it declines', async () => {
    const { actor } = fake({ addAuthorizedPrincipal: async () => ({ err: 'Principal already authorized' }) });
    expect(await refusal(actions.runOwnerAction(actor, SIGNER, { kind: 'addWriter', principal: WRITER }))).toBe('Principal already authorized');
  });

  it('turns the canister’s traps into what to do', async () => {
    const trap = (text: string) => async (): Promise<Result> => {
      throw new Error(`The replica returned a rejection error:\n  Request ID: abc\n  Reject code: 5\n  Reject text: ${text}`);
    };
    const said = async (text: string) => refusal(actions.runOwnerAction(fake({ freeze: trap(text) }).actor, SIGNER, { kind: 'freeze' }));
    expect(await said('Canister x trapped explicitly: only the canister owner may call this function')).toBe(
      'Only the owner can do this, and this key is not the owner.',
    );
    expect(await said('Canister x trapped explicitly: canister is frozen — call manualUnlock() first')).toBe(
      'The canister is frozen. Unfreeze it first.',
    );
    expect(await said('Canister x trapped explicitly: canister killed')).toBe('The canister was killed.');
    // Anything else keeps the replica's own words, without the request id and the rest of the envelope.
    expect(await said('Canister x trapped explicitly: heap full')).toBe('Canister x trapped explicitly: heap full');
  });
});

describe('the panel keeps the key to itself', () => {
  // The page and its logic hold the key in memory and talk only to the Internet Computer: nothing
  // here stores it, or reaches this server, where an operator could read it.
  const roots = [LIB, join(import.meta.dirname, '..', '..', 'webapp', 'src', 'app', '(dashboard)', 'owner')];
  const sources = roots.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => ({ file: join(entry.parentPath, entry.name), text: readFileSync(join(entry.parentPath, entry.name), 'utf8') })),
  );

  it('has code to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['browser storage', /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/],
    ['this server’s API', /(api-client|apiClient|\bfetch\s*\(|XMLHttpRequest|sendBeacon|navigator\.clipboard\.writeText)/],
    ['the console', /\bconsole\.\w+/],
  ])('does not use %s', (_name, pattern) => {
    // Comments may describe what the code does not do.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const offenders = sources.filter((source) => pattern.test(code(source.text))).map((source) => source.file);
    expect(offenders).toEqual([]);
  });
});
