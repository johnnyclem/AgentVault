/**
 * The other CLI commands that write to memory_repo sign too, and fail closed
 * without an identity: `agentvault merge` (commitToBranch) and the
 * warm tier of `agentvault hypervault archive` (initRepo, branches, commits,
 * thoughtforms). `agentvault rebase` only reads, and stays anonymous.
 *
 * Commands run in-process; createMemoryRepoActor is wrapped to hand back a
 * fake canister and record the agent each command built.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HttpAgent } from '@dfinity/agent';
import type { Command } from 'commander';
import { ed25519Key, secp256k1Key } from '../../fixtures/signing-identities.js';

const canister = vi.hoisted(() => ({
  created: [] as Array<{ canisterId: string; agent: HttpAgent }>,
  actor: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

const pipeline = vi.hoisted(() => ({
  archive: vi.fn(),
  client: vi.fn(),
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

vi.mock('../../../src/hypervault/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/hypervault/pipeline.js')>();
  return { ...actual, archiveHyperVault: pipeline.archive, clientFromProject: pipeline.client };
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
    };
    return spinner;
  },
}));

const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const HOST = 'https://ic0.app';

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function run(command: Command, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(' ')); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  let code = 0;
  try {
    await command.parseAsync(args, { from: 'user' });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    code = e.code;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

let tmp: string;

function pemFile(pem: string): string {
  const file = path.join(tmp, `key-${Math.random().toString(36).slice(2)}.pem`);
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-signed-writers-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('DFX_CONFIG_ROOT', undefined);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', undefined);
  vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM', undefined);
  canister.created.length = 0;
  canister.actor = {
    getBranches: vi.fn().mockResolvedValue([['main', 'commit-0']]),
    switchBranch: vi.fn().mockResolvedValue({ ok: "Switched to branch 'main'" }),
    log: vi.fn().mockResolvedValue([]),
    commit: vi.fn().mockResolvedValue({ ok: 'commit-1' }),
    commitToBranch: vi.fn().mockResolvedValue({ ok: 'commit-1' }),
  };
  pipeline.archive.mockReset().mockResolvedValue({ snapshotFile: 'bundle.json', rowCounts: {}, errors: [] });
  pipeline.client.mockReset().mockResolvedValue({});
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('agentvault merge', () => {
  function bundle(): string {
    const file = path.join(tmp, 'bundle.json');
    fs.writeFileSync(file, JSON.stringify({ thoughtforms: [{ id: 'a', content: 'x', updatedAt: 1 }] }));
    return file;
  }

  it('fails closed without an identity, before calling the canister', async () => {
    const { mergeCommand } = await import('../../../cli/merge.js');

    const result = await run(mergeCommand(), ['--input', bundle(), '--branch', 'main', '--canister', CANISTER_ID, '--host', HOST]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/anonymous[\s\S]*--identity/);
    expect(canister.created).toHaveLength(0);
  });

  it('signs with --identity', async () => {
    const key = ed25519Key();
    const { mergeCommand } = await import('../../../cli/merge.js');

    const result = await run(mergeCommand(), [
      '--input', bundle(), '--branch', 'main', '--canister', CANISTER_ID, '--host', HOST, '--identity', pemFile(key.pem),
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Signing as ${key.principal}`);
    expect((await canister.created[0]!.agent.getPrincipal()).toText()).toBe(key.principal);
    // Onto the target branch in one call, without moving the canister's current branch
    expect(canister.actor.commitToBranch).toHaveBeenCalledTimes(1);
    expect(canister.actor.commitToBranch).toHaveBeenCalledWith('main', expect.any(String), expect.any(String), ['merge', 'cli']);
    expect(canister.actor.switchBranch).not.toHaveBeenCalled();
    expect(canister.actor.commit).not.toHaveBeenCalled();
  });

  it('refuses a target branch that does not exist, before committing', async () => {
    const { mergeCommand } = await import('../../../cli/merge.js');

    const result = await run(mergeCommand(), [
      '--input', bundle(), '--branch', 'nope', '--canister', CANISTER_ID, '--host', HOST, '--identity', pemFile(ed25519Key().pem),
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Branch 'nope' does not exist/);
    expect(canister.actor.commitToBranch).not.toHaveBeenCalled();
  });
});

describe('agentvault hypervault archive', () => {
  it('fails closed when --canister-id is given without an identity, before archiving', async () => {
    const { hypervaultCmd } = await import('../../../cli/commands/hypervault.js');

    const result = await run(hypervaultCmd, ['archive', '--yes', '--canister-id', CANISTER_ID, '--network', 'ic']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/anonymous[\s\S]*--identity/);
    expect(pipeline.archive).not.toHaveBeenCalled();
    expect(canister.created).toHaveLength(0);
  });

  it('hands the archive pipeline an actor signed with the identity', async () => {
    const key = secp256k1Key();
    vi.stubEnv('AGENTVAULT_ICP_IDENTITY_PEM_FILE', pemFile(key.pem));
    const { hypervaultCmd } = await import('../../../cli/commands/hypervault.js');

    const result = await run(hypervaultCmd, ['archive', '--yes', '--canister-id', CANISTER_ID, '--network', 'ic']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Signing as ${key.principal}`);
    expect((await canister.created[0]!.agent.getPrincipal()).toText()).toBe(key.principal);
    expect(pipeline.archive.mock.calls[0]![0].actor).toBe(canister.actor);
  });

  it('archives without a canister, and without an identity, when --canister-id is omitted', async () => {
    const { hypervaultCmd } = await import('../../../cli/commands/hypervault.js');

    const result = await run(hypervaultCmd, ['archive', '--yes']);

    expect(result.code, result.stderr).toBe(0);
    expect(pipeline.archive.mock.calls[0]![0].actor).toBeUndefined();
    expect(canister.created).toHaveLength(0);
  });
});

describe('agentvault rebase', () => {
  it('reads anonymously', async () => {
    const { executeRebase } = await import('../../../cli/commands/rebase.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await executeRebase({ branch: 'main', canister: CANISTER_ID, output: path.join(tmp, 'out.json'), host: HOST });
    } finally {
      log.mockRestore();
    }

    expect((await canister.created[0]!.agent.getPrincipal()).toText()).toBe('2vxsx-fae');
  });
});
