/**
 * Creating a memory_repo canister for someone else, and handing it to them.
 *
 * A host that keeps agents' records for other people can give each of them a
 * canister they own, so the record stays theirs whatever happens to the host.
 * The host pays for the canister and installs it; the person then holds it:
 *
 *   1. create the canister, funded with cycles, the host's identity controlling it
 *   2. install the memory_repo code
 *   3. initialize the repository (the host is its owner for the moment)
 *   4. authorize the principals that will write to it, such as the gateway
 *   5. transfer ownership of the repository to the person
 *   6. make the person the canister's only controller
 *
 * After step 6 the host can still write (it was authorized in step 4) and can
 * top the canister up with cycles, which needs no control, but it cannot
 * reinstall, stop or delete the canister, or change who may write.
 *
 * The steps are separate Internet Computer calls, so any of them can be cut
 * short. Each run therefore reads what the canister already is and does only
 * what is missing, which makes one idempotency key safe to run again.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Principal } from '@dfinity/principal';
import { atomicWriteFileSync } from '../utils/path-validation.js';

/** What a provisioner needs from the Internet Computer; the real calls, or a stand-in under test. */
export interface ProvisioningPorts {
  /**
   * Creates a canister holding `cycles` and controlled by `controllers`, and returns its id.
   * `createdAtTime` is the same on every retry of one creation, so a source that deduplicates
   * can hand back the canister an earlier, unanswered attempt made.
   */
  createCanister(args: { controllers: string[]; cycles: bigint; createdAtTime: bigint }): Promise<string>;
  /** The canister's controllers and installed code hash (hex, null when none), from the subnet's certificate. */
  control(canisterId: string): Promise<{ controllers: string[]; moduleHash: string | null }>;
  installCode(canisterId: string, wasm: Uint8Array): Promise<void>;
  setControllers(canisterId: string, controllers: string[]): Promise<void>;
  repo(canisterId: string): ProvisionedRepoPort;
}

/** The memory_repo calls provisioning makes. */
export interface ProvisionedRepoPort {
  status(): Promise<{ initialized: boolean; owner: string }>;
  init(soul: string): Promise<void>;
  /** Adds a writer; `already` when it was one. */
  authorize(principal: string): Promise<'added' | 'already'>;
  transferOwnership(newOwner: string): Promise<void>;
}

export type ProvisionState = 'pending' | 'ready' | 'failed';

export interface ProvisionRecord {
  key: string;
  /** Who the repository and the canister are handed to. */
  owner: string;
  state: ProvisionState;
  canisterId: string | null;
  /** Nanoseconds since the epoch, as a decimal string; fixed for the life of the record. */
  createdAtTime: string;
  /** The code installed, as hex. */
  moduleHash: string | null;
  /** Why the last run stopped, in words safe to show; null unless failed. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProvisionErrorCode = 'invalid_key' | 'invalid_owner' | 'key_conflict' | 'limit_reached';

export class ProvisionError extends Error {
  constructor(
    readonly code: ProvisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECORD_FORMAT = 'agentvault-provision/v1';
/** What a repository is initialized with: the canister needs some text, and nothing reads it. */
export const PROVISIONED_SOUL = '# Memory\n\nThe record of an agent, kept on a canister its owner holds.\n';

/** One JSON file per idempotency key, written atomically. */
export class ProvisionStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'provisions');
  }

  private file(key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  get(key: string): ProvisionRecord | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(text) as { format?: string; record?: ProvisionRecord };
    if (parsed.format !== RECORD_FORMAT || !parsed.record) {
      throw new Error(`The provisioning record for ${key} is not in a format this version reads`);
    }
    return parsed.record;
  }

  put(record: ProvisionRecord): void {
    atomicWriteFileSync(this.file(record.key), JSON.stringify({ format: RECORD_FORMAT, record }, null, 2) + '\n');
  }

  count(): number {
    try {
      return fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }
}

export interface ProvisionerOptions {
  ports: ProvisioningPorts;
  store: ProvisionStore;
  /** The principal everything is signed as. It controls each canister until the handover. */
  treasury: string;
  /** The memory_repo code every canister is installed with. */
  wasm: Uint8Array;
  /** Cycles each canister is created with. Fixed here, never taken from a request. */
  cycles: bigint;
  /** The most canisters this will ever create in this directory. */
  limit: number;
  /** Principals authorized to write before the handover, such as the identity the gateway anchors as. */
  writers: string[];
  now?: () => number;
  log?: (message: string) => void;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Creates canisters for owners, one per idempotency key, and brings each to the handed-over state. */
export class CanisterProvisioner {
  private readonly running = new Map<string, Promise<ProvisionRecord>>();
  private readonly wasmHash: string;
  private readonly now: () => number;

  constructor(private readonly options: ProvisionerOptions) {
    this.wasmHash = sha256Hex(options.wasm);
    this.now = options.now ?? Date.now;
  }

  get(key: string): ProvisionRecord | null {
    return this.options.store.get(key);
  }

  /** The hash of the code every canister is installed with. */
  get moduleHash(): string {
    return this.wasmHash;
  }

  /**
   * Starts provisioning in the background, or reports where it is. Safe to repeat: a key that is
   * running or ready changes nothing, and one that failed is tried again from where it stopped.
   */
  begin(key: string, owner: string): ProvisionRecord {
    const record = this.record(key, owner);
    if (record.state !== 'ready' && !this.running.has(key)) {
      const run = this.run(record).finally(() => this.running.delete(key));
      this.running.set(key, run);
      // The outcome is in the record; nobody waits on this promise.
      run.catch(() => undefined);
    }
    return this.options.store.get(key) ?? record;
  }

  /** Provisions and waits; the record says how it ended. */
  async provision(key: string, owner: string): Promise<ProvisionRecord> {
    const record = this.begin(key, owner);
    const run = this.running.get(key);
    if (run) await run.catch(() => undefined);
    return this.options.store.get(key) ?? record;
  }

  private record(key: string, owner: string): ProvisionRecord {
    if (!KEY_PATTERN.test(key)) {
      throw new ProvisionError('invalid_key', 'The key is 1 to 128 letters, digits, dots, colons, dashes or underscores');
    }
    this.assertOwner(owner);
    const existing = this.options.store.get(key);
    if (existing) {
      if (existing.owner !== owner) {
        throw new ProvisionError('key_conflict', 'That key was already used for another owner');
      }
      return existing;
    }
    if (this.options.store.count() >= this.options.limit) {
      throw new ProvisionError('limit_reached', 'This gateway has created as many canisters as it is set to');
    }
    const at = new Date(this.now()).toISOString();
    const created: ProvisionRecord = {
      key,
      owner,
      state: 'pending',
      canisterId: null,
      createdAtTime: (BigInt(this.now()) * 1_000_000n).toString(),
      moduleHash: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    this.options.store.put(created);
    return created;
  }

  private assertOwner(owner: string): void {
    let principal: Principal;
    try {
      principal = Principal.fromText(owner);
    } catch {
      throw new ProvisionError('invalid_owner', 'The owner is not a valid principal');
    }
    if (principal.isAnonymous()) throw new ProvisionError('invalid_owner', 'The anonymous principal cannot own a canister');
    if (owner === this.options.treasury) {
      throw new ProvisionError('invalid_owner', 'The gateway cannot be the owner of a canister it creates for someone else');
    }
  }

  private update(record: ProvisionRecord, changes: Partial<ProvisionRecord>): ProvisionRecord {
    const next = { ...record, ...changes, updatedAt: new Date(this.now()).toISOString() };
    this.options.store.put(next);
    return next;
  }

  private async run(start: ProvisionRecord): Promise<ProvisionRecord> {
    const { ports, treasury, wasm, cycles, writers, log } = this.options;
    let record = this.update(start, { state: 'pending', error: null });
    try {
      if (!record.canisterId) {
        const canisterId = await ports.createCanister({
          controllers: [treasury],
          cycles,
          createdAtTime: BigInt(record.createdAtTime),
        });
        record = this.update(record, { canisterId });
        log?.(`Created canister ${canisterId} for ${record.key}`);
      }
      const canisterId = record.canisterId!;

      const before = await ports.control(canisterId);
      if (before.moduleHash === null) {
        await ports.installCode(canisterId, wasm);
        log?.(`Installed memory_repo on ${canisterId}`);
      } else if (before.moduleHash !== this.wasmHash) {
        throw new Error(`Canister ${canisterId} holds code other than the memory_repo this gateway installs`);
      }

      const repo = ports.repo(canisterId);
      let status = await repo.status();
      if (!status.initialized) {
        await repo.init(PROVISIONED_SOUL);
        status = await repo.status();
      }
      if (status.owner !== record.owner) {
        if (status.owner !== treasury) {
          throw new Error(`The repository on ${canisterId} is owned by ${status.owner}, which is neither the gateway nor the owner`);
        }
        for (const writer of writers) await repo.authorize(writer);
        await repo.transferOwnership(record.owner);
        log?.(`Handed the repository on ${canisterId} to ${record.owner}`);
      }

      const after = await ports.control(canisterId);
      if (after.controllers.length !== 1 || after.controllers[0] !== record.owner) {
        await ports.setControllers(canisterId, [record.owner]);
        const settled = await ports.control(canisterId);
        if (settled.controllers.length !== 1 || settled.controllers[0] !== record.owner) {
          throw new Error(`Canister ${canisterId} is still controlled by ${settled.controllers.join(', ') || 'no one'}`);
        }
        log?.(`Made ${record.owner} the only controller of ${canisterId}`);
      }
      return this.update(record, { state: 'ready', moduleHash: this.wasmHash, error: null });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
      log?.(`Provisioning ${record.key} stopped: ${message}`);
      this.update(record, { state: 'failed', error: message });
      throw error;
    }
  }
}
