import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Principal } from '@dfinity/principal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CanisterProvisioner,
  ProvisionError,
  ProvisionStore,
  type ProvisionerOptions,
  type ProvisioningPorts,
} from '../../src/canister/provision.js';

const principal = (seed: number): string => Principal.fromUint8Array(Uint8Array.of(seed, seed, seed, seed)).toText();
const TREASURY = principal(1);
const OWNER = principal(2);
const OTHER = principal(3);
const WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const WASM_HASH = createHash('sha256').update(WASM).digest('hex');
const CYCLES = 1_000_000_000_000n;

interface FakeCanister {
  controllers: string[];
  moduleHash: string | null;
  initialized: boolean;
  owner: string;
  writers: string[];
}

/**
 * The Internet Computer and a memory_repo, with the rules that matter here: only a controller can
 * install code or change settings, and only the repository's owner can authorize or hand it over.
 */
class FakeIc {
  readonly canisters = new Map<string, FakeCanister>();
  readonly calls: string[] = [];
  readonly createdAtTimes: bigint[] = [];
  /** Steps that throw once when reached, as a call cut short would. */
  readonly failOnce = new Set<string>();
  private next = 100;

  private step(name: string): void {
    this.calls.push(name);
    if (this.failOnce.delete(name)) throw new Error(`${name} was cut short`);
  }

  private canister(id: string): FakeCanister {
    const found = this.canisters.get(id);
    if (!found) throw new Error(`no canister ${id}`);
    return found;
  }

  get created(): number {
    return this.canisters.size;
  }

  ports(): ProvisioningPorts {
    return {
      createCanister: async ({ controllers, cycles, createdAtTime }) => {
        this.createdAtTimes.push(createdAtTime);
        this.step('create');
        expect(cycles).toBe(CYCLES);
        const id = principal(this.next++);
        this.canisters.set(id, { controllers, moduleHash: null, initialized: false, owner: '2vxsx-fae', writers: [] });
        return id;
      },
      control: async (id) => {
        const { controllers, moduleHash } = this.canister(id);
        return { controllers: [...controllers], moduleHash };
      },
      installCode: async (id, wasm) => {
        this.step('install');
        const canister = this.canister(id);
        if (!canister.controllers.includes(TREASURY)) throw new Error('Only controllers can install code');
        canister.moduleHash = createHash('sha256').update(wasm).digest('hex');
      },
      setControllers: async (id, controllers) => {
        this.step('controllers');
        const canister = this.canister(id);
        if (!canister.controllers.includes(TREASURY)) throw new Error('Only controllers can update settings');
        canister.controllers = controllers;
      },
      repo: (id) => ({
        status: async () => {
          const { initialized, owner } = this.canister(id);
          return { initialized, owner };
        },
        init: async () => {
          this.step('init');
          const canister = this.canister(id);
          if (canister.moduleHash === null) throw new Error('no code installed');
          canister.initialized = true;
          canister.owner = TREASURY;
        },
        authorize: async (who) => {
          this.step('authorize');
          const canister = this.canister(id);
          if (canister.owner !== TREASURY) throw new Error('only the canister owner may call this function');
          if (canister.writers.includes(who)) return 'already';
          canister.writers.push(who);
          return 'added';
        },
        transferOwnership: async (newOwner) => {
          this.step('transfer');
          const canister = this.canister(id);
          if (canister.owner !== TREASURY) throw new Error('only the canister owner may call this function');
          canister.owner = newOwner;
          canister.writers = canister.writers.filter((writer) => writer !== newOwner);
        },
      }),
    };
  }
}

let dir: string;
let ic: FakeIc;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-provision-'));
  ic = new FakeIc();
  clock = Date.parse('2026-11-17T00:00:00Z');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function provisioner(overrides: Partial<ProvisionerOptions> = {}): CanisterProvisioner {
  return new CanisterProvisioner({
    ports: ic.ports(),
    store: new ProvisionStore(dir),
    treasury: TREASURY,
    wasm: WASM,
    cycles: CYCLES,
    limit: 10,
    writers: [TREASURY],
    now: () => (clock += 1000),
    ...overrides,
  });
}

describe('creating a canister for an owner', () => {
  it('creates it, installs the code, hands it to the owner, and leaves them its only controller', async () => {
    const record = await provisioner().provision('order-1', OWNER);

    expect(record).toMatchObject({ key: 'order-1', owner: OWNER, state: 'ready', error: null, moduleHash: WASM_HASH });
    const canister = ic.canisters.get(record.canisterId!)!;
    expect(canister).toMatchObject({ controllers: [OWNER], owner: OWNER, initialized: true, moduleHash: WASM_HASH });
    expect(ic.calls).toEqual(['create', 'install', 'init', 'authorize', 'transfer', 'controllers']);
  });

  it('authorizes the writers before the handover, since only the owner can', async () => {
    const record = await provisioner({ writers: [TREASURY, OTHER] }).provision('order-1', OWNER);

    // The fake refuses an authorize after the transfer, so reaching `ready` shows the order.
    expect(ic.canisters.get(record.canisterId!)!.writers).toEqual([TREASURY, OTHER]);
    expect(ic.calls.indexOf('transfer')).toBeGreaterThan(ic.calls.lastIndexOf('authorize'));
  });

  it('leaves the host able to write but not to reinstall, stop or reconfigure', async () => {
    const record = await provisioner().provision('order-1', OWNER);
    const canister = ic.canisters.get(record.canisterId!)!;

    expect(canister.writers).toContain(TREASURY);
    expect(canister.controllers).not.toContain(TREASURY);
    await expect(ic.ports().installCode(record.canisterId!, WASM)).rejects.toThrow(/Only controllers/);
    await expect(ic.ports().setControllers(record.canisterId!, [TREASURY])).rejects.toThrow(/Only controllers/);
    await expect(ic.ports().repo(record.canisterId!).authorize(OTHER)).rejects.toThrow(/only the canister owner/);
  });

  it('creates one canister for one key, however often it is asked', async () => {
    const first = provisioner();
    const a = await first.provision('order-1', OWNER);
    const again = await first.provision('order-1', OWNER);
    // A restarted gateway reads the same record from disk.
    const afterRestart = await provisioner().provision('order-1', OWNER);

    expect(again.canisterId).toBe(a.canisterId);
    expect(afterRestart.canisterId).toBe(a.canisterId);
    expect(ic.created).toBe(1);
    expect(ic.calls).toEqual(['create', 'install', 'init', 'authorize', 'transfer', 'controllers']);
  });

  it('runs once when asked twice at the same moment', async () => {
    const p = provisioner();

    const [a, b] = await Promise.all([p.provision('order-1', OWNER), p.provision('order-1', OWNER)]);

    expect(a.canisterId).toBe(b.canisterId);
    expect(ic.created).toBe(1);
  });

  it('answers a begin at once, with the work going on behind it', async () => {
    const p = provisioner();

    const started = p.begin('order-1', OWNER);
    expect(started.state).toBe('pending');
    expect(started.canisterId).toBeNull();

    const done = await p.provision('order-1', OWNER);
    expect(done.state).toBe('ready');
    expect(p.get('order-1')?.state).toBe('ready');
    expect(p.get('never-asked')).toBeNull();
  });

  it('keeps the same creation time across retries, so a source that deduplicates can recognize it', async () => {
    ic.failOnce.add('create');
    const p = provisioner();

    expect((await p.provision('order-1', OWNER)).state).toBe('failed');
    expect((await p.provision('order-1', OWNER)).state).toBe('ready');

    expect(ic.createdAtTimes).toHaveLength(2);
    expect(ic.createdAtTimes[0]).toBe(ic.createdAtTimes[1]);
    expect(ic.created).toBe(1);
  });
});

describe('a run that is cut short', () => {
  it.each(['install', 'init', 'authorize', 'transfer', 'controllers'])(
    'resumes after %s on the same canister, creating no other',
    async (step) => {
      ic.failOnce.add(step);
      const p = provisioner();

      const failed = await p.provision('order-1', OWNER);
      expect(failed.state).toBe('failed');
      expect(failed.error).toContain(`${step} was cut short`);
      expect(failed.canisterId).not.toBeNull();

      const resumed = await p.provision('order-1', OWNER);
      expect(resumed).toMatchObject({ state: 'ready', error: null, canisterId: failed.canisterId });
      expect(ic.created).toBe(1);
      const canister = ic.canisters.get(resumed.canisterId!)!;
      expect(canister).toMatchObject({ controllers: [OWNER], owner: OWNER, initialized: true });
    },
  );

  it('does not repeat the steps already done', async () => {
    ic.failOnce.add('controllers');
    const p = provisioner();
    await p.provision('order-1', OWNER);
    ic.calls.length = 0;

    await p.provision('order-1', OWNER);

    expect(ic.calls).toEqual(['controllers']);
  });

  it('keeps a failed record across a restart and finishes it from there', async () => {
    ic.failOnce.add('transfer');
    const failed = await provisioner().provision('order-1', OWNER);

    const resumed = await provisioner().provision('order-1', OWNER);

    expect(resumed).toMatchObject({ state: 'ready', canisterId: failed.canisterId });
    expect(ic.created).toBe(1);
  });

  it('says why in one short line', async () => {
    ic.failOnce.add('install');
    const failed = await provisioner().provision('order-1', OWNER);

    expect(failed.error).toBe('install was cut short');
    expect(failed.error).not.toContain('\n');
  });

  it('stops rather than carry on when the canister is not what it expects', async () => {
    const p = provisioner();
    ic.failOnce.add('init');
    const failed = await p.provision('order-1', OWNER);
    ic.canisters.get(failed.canisterId!)!.moduleHash = 'ff'.repeat(32);

    const stopped = await p.provision('order-1', OWNER);

    expect(stopped.state).toBe('failed');
    expect(stopped.error).toMatch(/holds code other than the memory_repo/);
    expect(ic.canisters.get(failed.canisterId!)!.controllers).toEqual([TREASURY]);
  });

  it('stops when the repository belongs to someone who is neither the host nor the owner', async () => {
    const p = provisioner();
    ic.failOnce.add('authorize');
    const failed = await p.provision('order-1', OWNER);
    ic.canisters.get(failed.canisterId!)!.owner = OTHER;

    const stopped = await p.provision('order-1', OWNER);

    expect(stopped.state).toBe('failed');
    expect(stopped.error).toContain(`owned by ${OTHER}`);
  });
});

describe('what it refuses', () => {
  it('refuses a key that was used for someone else', async () => {
    const p = provisioner();
    await p.provision('order-1', OWNER);

    expect(() => p.begin('order-1', OTHER)).toThrow(expect.objectContaining({ code: 'key_conflict' }));
    expect(ic.created).toBe(1);
  });

  it.each([
    ['an owner that is not a principal', 'not a principal'],
    ['the anonymous principal', '2vxsx-fae'],
    ['the gateway itself', TREASURY],
    ['nobody', ''],
  ])('refuses %s as the owner, creating nothing', async (_label, owner) => {
    const p = provisioner();

    expect(() => p.begin('order-1', owner)).toThrow(expect.objectContaining({ code: 'invalid_owner' }));
    expect(ic.created).toBe(0);
    expect(p.get('order-1')).toBeNull();
  });

  it.each(['', ' ', 'has space', 'a/b', '../x', 'x'.repeat(129), '-leading'])('refuses the key %j', (key) => {
    expect(() => provisioner().begin(key, OWNER)).toThrow(expect.objectContaining({ code: 'invalid_key' }));
  });

  it('stops at the limit it was given, counting every record, and still serves the ones it has', async () => {
    const p = provisioner({ limit: 2 });
    await p.provision('a', OWNER);
    ic.failOnce.add('create');
    await p.provision('b', OWNER);

    expect(() => p.begin('c', OWNER)).toThrow(expect.objectContaining({ code: 'limit_reached' }));
    expect(p.get('c')).toBeNull();
    // A key it already holds is not new, so the limit does not stop it finishing.
    expect((await p.provision('b', OWNER)).state).toBe('ready');
    expect((await p.provision('a', OWNER)).state).toBe('ready');
    expect(ic.created).toBe(2);
  });

  it('uses the cycles it was configured with, whatever a request says', async () => {
    // FakeIc.createCanister asserts the amount is the configured one.
    await expect(provisioner().provision('order-1', OWNER)).resolves.toMatchObject({ state: 'ready' });
  });

  it('is a ProvisionError, carrying a code a caller can switch on', () => {
    try {
      provisioner().begin('x y', OWNER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).code).toBe('invalid_key');
    }
  });
});

describe('the record store', () => {
  it('refuses a file it does not recognize rather than guess', () => {
    const store = new ProvisionStore(dir);
    fs.mkdirSync(path.join(dir, 'provisions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'provisions', 'order-1.json'), JSON.stringify({ format: 'something-else' }));

    expect(() => store.get('order-1')).toThrow(/not in a format/);
  });

  it('counts none before any, and one file per key after', async () => {
    const p = provisioner();
    expect(new ProvisionStore(dir).count()).toBe(0);
    await p.provision('a:1', OWNER);
    await p.provision('a:2', OWNER);

    expect(new ProvisionStore(dir).count()).toBe(2);
    expect(new ProvisionStore(dir).get('a:1')?.owner).toBe(OWNER);
  });

  it('keeps only the gateway-side record, with no secrets in it', async () => {
    await provisioner().provision('order-1', OWNER);

    const text = fs.readFileSync(path.join(dir, 'provisions', 'order-1.json'), 'utf8');
    expect(Object.keys(JSON.parse(text).record).sort()).toEqual(
      ['canisterId', 'createdAt', 'createdAtTime', 'error', 'key', 'moduleHash', 'owner', 'state', 'updatedAt'],
    );
  });
});
