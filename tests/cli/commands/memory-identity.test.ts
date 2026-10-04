/**
 * `agentvault memory` signs its writes. whoami prints the principal of the
 * configured identity; authorize / deauthorize have the owner grant and
 * revoke write access; every write fails closed (exit 1, with guidance) when
 * no identity is configured, while reads stay anonymous.
 *
 * The commands run in-process, each against a fresh copy of the module.
 * createMemoryRepoActor is wrapped to hand back a fake canister and record
 * the agent each command built; HOME is a temp directory, so the developer's
 * own dfx identities are never read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HttpAgent } from '@dfinity/agent';
import { ed25519Key, secp256k1Key, writeDfxConfig, type TestKey } from '../../fixtures/signing-identities.js';

const canister = vi.hoisted(() => ({
  created: [] as Array<{ canisterId: string; agent: HttpAgent }>,
  actor: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../../../src/canister/memory-repo-actor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/canister/memory-repo-actor.js')>();
  return {
    ...actual,
    createMemoryRepoActor: (canisterId: string, agent: HttpAgent) => {
      canister.created.push({ canisterId, agent });
      return canister.actor;
    },
  };
});

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      text: '',
      start: () => spinner,
      stop: () => spinner,
      succeed: (msg?: string) => { if (msg) console.log(msg); return spinner; },
      fail: (msg?: string) => { if (msg) console.error(msg); return spinner; },
      warn: (msg?: string) => { if (msg) console.log(msg); return spinner; },
      info: (msg?: string) => { if (msg) console.log(msg); return spinner; },
    };
    return spinner;
  },
}));

const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const OTHER = 'aaaaa-aa';
// A mainnet host: no root key fetch, and the fake canister answers every call.
const HOST = 'https://ic0.app';

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

async function runMemory(args: string[]): Promise<Run> {
  vi.resetModules();
  const { memoryCmd } = await import('../../../cli/commands/memory.js');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  let code = 0;
  try {
    await memoryCmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    code = e.code;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code, stdout: stripAnsi(stdout.join('\n')), stderr: stripAnsi(stderr.join('\n')) };
}

let tmp: string;
let home: string;

function pemFile(key: TestKey, name = 'key.pem'): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, key.pem, { mode: 0o600 });
  return file;
}

async function agentPrincipal(index = 0): Promise<string> {
  return (await canister.created[index]!.agent.getPrincipal()).toText();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-memory-cli-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('DFX_CONFIG_ROOT', undefined);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', undefined);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);
  vi.stubEnv('MEMORY_REPO_CANISTER_ID', undefined);
  canister.created.length = 0;
  canister.actor = {
    addAuthorizedPrincipal: vi.fn().mockResolvedValue({ ok: `Principal authorized: ${OTHER}` }),
    removeAuthorizedPrincipal: vi.fn().mockResolvedValue({ ok: `Principal removed: ${OTHER}` }),
    initRepo: vi.fn().mockResolvedValue({ ok: 'genesis-1' }),
    commit: vi.fn().mockResolvedValue({ ok: 'commit-1' }),
    getCommit: vi.fn().mockResolvedValue([]),
    getRepoStatus: vi.fn().mockResolvedValue({
      initialized: true, currentBranch: 'main', totalCommits: 1n, totalBranches: 1n, owner: 'owner',
    }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('memory whoami', () => {
  it('prints the principal of --identity alone on stdout, and where it came from on stderr', async () => {
    const key = ed25519Key();
    const file = pemFile(key);

    const run = await runMemory(['whoami', '--identity', file]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(key.principal);
    expect(run.stderr).toContain(`--identity ${file}`);
    expect(run.stderr).toContain('ed25519');
  });

  it('uses AGENTVAULT_ICP_IDENTITY_PEM_FILE, then dfx', async () => {
    const envKey = secp256k1Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', pemFile(envKey, 'env.pem'));
    const dfxKey = ed25519Key();
    writeDfxConfig(home, 'dev', { dev: dfxKey.pem });

    expect((await runMemory(['whoami'])).stdout).toBe(envKey.principal);

    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', undefined);
    const run = await runMemory(['whoami']);
    expect(run.stdout).toBe(dfxKey.principal);
    expect(run.stderr).toContain("dfx identity 'dev'");
  });

  it('exits 1 with guidance when no identity is configured', async () => {
    const run = await runMemory(['whoami']);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/--identity[\s\S]*AGENTVAULT_ICP_IDENTITY_PEM_FILE[\s\S]*dfx identity use/);
  });
});

describe('memory authorize / deauthorize', () => {
  it('authorize has the owner add the principal, signing as the owner', async () => {
    const owner = ed25519Key();

    const run = await runMemory(['authorize', OTHER, '--identity', pemFile(owner), '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Signing as ${owner.principal}`);
    expect(run.stdout).toContain(`Principal authorized: ${OTHER}`);
    expect(canister.created[0]!.canisterId).toBe(CANISTER_ID);
    expect(await agentPrincipal()).toBe(owner.principal);
    expect(canister.actor.addAuthorizedPrincipal).toHaveBeenCalledTimes(1);
    expect(canister.actor.addAuthorizedPrincipal!.mock.calls[0]![0].toText()).toBe(OTHER);
  });

  it('deauthorize has the owner remove the principal', async () => {
    const owner = secp256k1Key();

    const run = await runMemory(['deauthorize', OTHER, '--identity', pemFile(owner), '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(await agentPrincipal()).toBe(owner.principal);
    expect(canister.actor.removeAuthorizedPrincipal!.mock.calls[0]![0].toText()).toBe(OTHER);
  });

  it('refuses a malformed principal before calling the canister', async () => {
    const run = await runMemory(['authorize', 'not-a-principal', '--identity', pemFile(ed25519Key()), '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/not a valid principal/i);
    expect(canister.created).toHaveLength(0);
  });

  it("reports the canister's refusal, and explains a non-owner signer", async () => {
    const key = ed25519Key();
    canister.actor.addAuthorizedPrincipal = vi.fn().mockResolvedValue({ err: 'Principal already authorized' });
    let run = await runMemory(['authorize', OTHER, '--identity', pemFile(key), '--canister-id', CANISTER_ID, '--host', HOST]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Principal already authorized');

    canister.actor.addAuthorizedPrincipal = vi.fn().mockRejectedValue(
      new Error("Reject text: Canister called `ic0.trap` with message: 'only the canister owner may call this function'"),
    );
    run = await runMemory(['authorize', OTHER, '--identity', pemFile(key), '--canister-id', CANISTER_ID, '--host', HOST]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`only the repo owner`);
    expect(run.stderr).toContain(key.principal);
  });

  it('exits 1 with guidance when no identity is configured', async () => {
    const run = await runMemory(['authorize', OTHER, '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/anonymous[\s\S]*--identity/);
    expect(canister.created).toHaveLength(0);
  });
});

describe('memory writes and reads', () => {
  it('commit fails closed without an identity, before calling the canister', async () => {
    const run = await runMemory(['commit', 'remember this', '-d', 'diff', '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/anonymous[\s\S]*--identity[\s\S]*AGENTVAULT_ICP_IDENTITY_PEM_FILE/);
    expect(canister.created).toHaveLength(0);
  });

  it('commit signs with the configured identity and prints it', async () => {
    const key = secp256k1Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', pemFile(key));

    const run = await runMemory(['commit', 'remember this', '-d', 'diff', '-t', 'a,b', '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`Signing as ${key.principal}`);
    expect(await agentPrincipal()).toBe(key.principal);
    expect(canister.actor.commit).toHaveBeenCalledWith('remember this', 'diff', ['a', 'b']);
  });

  it('commit names the branch the canister recorded the commit on', async () => {
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', pemFile(ed25519Key()));
    canister.actor.getCommit = vi.fn().mockResolvedValue([{
      id: 'commit-1', timestamp: 1n, message: 'remember this', diff: 'diff', tags: [], parent: [], branch: 'feature',
    }]);

    const run = await runMemory(['commit', 'remember this', '-d', 'diff', '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(canister.actor.getCommit).toHaveBeenCalledWith('commit-1');
    expect(run.stdout).toMatch(/Committed commit-1 on branch feature/);
  });

  it('commit reports a refusal with the reject text only, and the authorize command for the signer', async () => {
    const key = ed25519Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', pemFile(key));
    canister.actor.commit = vi.fn().mockRejectedValue(new Error(
      "The replica returned a rejection error:\n  Reject text: Error from Canister x: Canister called `ic0.trap` with message: 'caller principal is not authorized'\n" +
        '  Error code: IC0503\n\nCall context:\n  HTTP details: {"body":{"certificate":{"0":217}}}',
    ));

    const run = await runMemory(['commit', 'remember this', '-d', 'diff', '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`agentvault memory authorize ${key.principal}`);
    expect(run.stderr).not.toContain('certificate');
  });

  it("init signs with dfx's selected identity, which becomes the owner", async () => {
    const key = ed25519Key();
    writeDfxConfig(home, 'default', { default: key.pem });
    const soul = path.join(tmp, 'soul.md');
    fs.writeFileSync(soul, '# Soul\n');

    const run = await runMemory(['init', soul, '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(await agentPrincipal()).toBe(key.principal);
    expect(run.stdout).toContain(`Owner: ${key.principal}`);
  });

  it('status reads anonymously, with no identity configured', async () => {
    const run = await runMemory(['status', '--canister-id', CANISTER_ID, '--host', HOST]);

    expect(run.code, run.stderr).toBe(0);
    expect(await agentPrincipal()).toBe('2vxsx-fae');
  });
});
