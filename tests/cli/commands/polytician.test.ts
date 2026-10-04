/**
 * `agentvault polytician` against Polytician 3.0.
 *
 * Runs the real CLI (through tsx) against the fake Polytician 3.0 server in
 * tests/fixtures/polytician-3.0/, which validates every tools/call against
 * the captured input schemas and answers with the recorded responses.
 *
 * The CLI runs in a temporary project directory: the namespace it defaults to
 * comes from the project's agent.json, and other tests leave one in the
 * repository root.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI = join(ROOT, 'cli', 'index.ts');
// By URL, so the CLI can run from a directory with no node_modules
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'polytician-3.0');
const FAKE_SERVER = join(FIXTURE_DIR, 'fake-server.mjs');

interface RecordedCall {
  response: { result: { structuredContent?: Record<string, unknown> } };
}
const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contract.json'), 'utf8')) as {
  calls: Record<string, RecordedCall>;
};
const recordedResults = contract.calls['search_concepts']!.response.result.structuredContent!.results as Array<{ id: string }>;
const [ORCHESTRATION_ID, NOTES_ID] = recordedResults.map((r) => r.id) as [string, string];

interface CliRun {
  code: number;
  output: string;
  elapsedMs: number;
}

interface RunOptions {
  /** Working directory (default: a project with no agent name) */
  cwd?: string;
  /** Set over the test's environment, from which the AgentVault and Polytician settings are removed; undefined unsets */
  env?: Record<string, string | undefined>;
}

function cliEnv(extra: RunOptions['env'] = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('POLYTICIAN_') || key.startsWith('AGENTVAULT_')) delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(args: string[], options: RunOptions = {}): Promise<CliRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', TSX, CLI, ...args],
      { cwd: options.cwd ?? plainProject, env: cliEnv(options.env), timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}`, elapsedMs: Date.now() - started });
      },
    );
  });
}

/** Like runCli, with stdout and stderr apart (ora writes to stderr). */
function runCliSplit(args: string[], options: RunOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', TSX, CLI, ...args],
      { cwd: options.cwd ?? plainProject, env: cliEnv(options.env), timeout: 90_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function loggedCalls(logFile: string, tool: string): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } })
    .filter((m) => m.method === 'tools/call' && m.params?.name === tool)
    .map((m) => m.params?.arguments ?? {});
}

function startups(file: string): Array<{ argv: string[]; env: Record<string, string> }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as never);
}

// One directory for the file, each test with its own log file. The tests run
// one at a time: each starts the CLI under tsx, which is CPU-heavy.
let workDir: string;
let plainProject: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'av-polytician-cli-'));
  plainProject = join(workDir, 'plain-project');
  mkdirSync(plainProject);
});

/** A project directory whose agent is named in agent.json (or, with configFile, in .agentvault/config/agent.config.json). */
function project(dirName: string, agentName: string, configFile = false): string {
  const dir = join(workDir, dirName);
  const file = configFile ? join(dir, '.agentvault', 'config', 'agent.config.json') : join(dir, 'agent.json');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ name: agentName, version: '1.0.0' }));
  return dir;
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** The shape of an Arweave keyfile: an RSA private key as a JWK (values shortened). */
const WALLET = JSON.stringify({ kty: 'RSA', n: 'sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri23bOdgWp4Dy1Wl', e: 'AQAB', d: 'VFCWOqXr8nvZNyaaJLXdnNPXZKRaWCjkU5Q2egQQpTBMwhprMzWzpR8Sx' });

function entry(...flags: string[]): string {
  return [process.execPath, FAKE_SERVER, ...flags].join(' ');
}

describe('agentvault polytician against Polytician 3.0', () => {
  it('status reports health, version and counts, and exits without waiting on request timers', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'status']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Server:\s+healthy/);
    expect(run.output).toMatch(/Version:\s+polytician 3\.0\.0/);
    expect(run.output).toMatch(/Embedding:\s+Xenova\/all-MiniLM-L6-v2, 384 dimensions/);
    expect(run.output).toMatch(/Concepts:\s+2/);
    expect(run.output).toMatch(/Vectors:\s+2/);
    expect(run.output).toMatch(/Namespace:\s+default/);
    expect(run.output).toMatch(/AgentVault tools:\s+not configured/);
    expect(run.output).toContain('AGENTVAULT_API_URL');
    // The 2.x client left a 30 s timer behind for every request.
    expect(run.elapsedMs).toBeLessThan(25_000);
  }, 90_000);

  it('search sends { query, k } and prints ids, scores and titles', async () => {
    const logFile = join(workDir, 'search.jsonl');
    const run = await runCli(['polytician', '-e', entry('--log', logFile), 'search', 'refactor the parser', '-l', '500']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(new RegExp(`${ORCHESTRATION_ID}\\s+0\\.731\\s+Orchestration Result: session-1`));
    expect(run.output).toMatch(new RegExp(`${NOTES_ID}\\s+0\\.471\\s+Deployment checklist`));
    expect(run.output).toMatch(/Found 2 matching concept\(s\) in namespace default/);
    expect(loggedCalls(logFile, 'search_concepts')).toEqual([{ query: 'refactor the parser', k: 100, namespace: 'default' }]);
  }, 90_000);

  it('search --json prints the 3.0 results array', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'search', 'refactor the parser', '--json']);

    expect(run.code, run.output).toBe(0);
    const json = run.output.slice(run.output.indexOf('['), run.output.lastIndexOf(']') + 1);
    expect(JSON.parse(json)).toEqual(recordedResults);
  }, 90_000);

  it('search --json prints [] when nothing matches', async () => {
    const run = await runCliSplit(['polytician', '-e', entry('--empty'), 'search', 'anything', '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  }, 90_000);

  it('search lists a hit deleted between the search and the title read, without a title', async () => {
    const run = await runCli(['polytician', '-e', entry('--forget', NOTES_ID), 'search', 'refactor the parser']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(new RegExp(`${ORCHESTRATION_ID}\\s+0\\.731\\s+Orchestration Result: session-1`));
    expect(run.output).toMatch(new RegExp(`${NOTES_ID}\\s+0\\.471\\s+\\[notes\\]`));
  }, 90_000);

  it('push-all explains that Polytician has no AgentVault configured', async () => {
    const run = await runCli(['polytician', '-e', entry(), 'push-all']);

    expect(run.code).toBe(1);
    expect(run.output).toContain('vault_memory_push');
    expect(run.output).toContain('POLYTICIAN_AV_API_URL');
  }, 90_000);

  it('push-all pushes every concept with vault_memory_push', async () => {
    const logFile = join(workDir, 'push.jsonl');
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok', '--log', logFile), 'push-all']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toContain('Pushed 2 of 2 concepts in namespace default to memory_repo');
    expect(loggedCalls(logFile, 'vault_memory_push')).toEqual([
      { conceptId: NOTES_ID, namespace: 'default' },
      { conceptId: ORCHESTRATION_ID, namespace: 'default' },
    ]);
  }, 90_000);

  it('archive calls vault_archive_concept and prints the Arweave receipt', async () => {
    const logFile = join(workDir, 'archive.jsonl');
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok', '--log', logFile), 'archive', ORCHESTRATION_ID]);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/TX ID:\s+fake-arweave-tx-1/);
    expect(loggedCalls(logFile, 'vault_archive_concept')).toEqual([{ conceptId: ORCHESTRATION_ID, namespace: 'default' }]);
  }, 90_000);

  it('archive prints the Polytician error code when AgentVault is unreachable', async () => {
    const run = await runCli(['polytician', '-e', entry('--vault', 'unreachable'), 'archive', ORCHESTRATION_ID]);

    expect(run.code).toBe(1);
    expect(run.output).toContain('UPSTREAM_ERROR');
    expect(run.output).toContain('fetch failed');
  }, 90_000);

  it('pull calls vault_memory_pull and reports what was imported', async () => {
    const run = await runCli(['polytician', '-e', entry('--vault', 'ok'), 'pull']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Pulled polytician-main @ commit_000001 into namespace default: 0 imported, 0 skipped/);
  }, 90_000);
});

describe('agentvault polytician: the namespace', () => {
  it("defaults to the project's agent name from agent.json and sends it with every call", async () => {
    const logFile = join(workDir, 'ns-agent-json.jsonl');
    const cwd = project('agent-json', 'agent-a');
    const fake = entry('--vault', 'ok', '--seed-namespace', 'agent-a', '--require-namespace', 'agent-a', '--log', logFile);

    const status = await runCli(['polytician', '-e', fake, 'status'], { cwd });
    expect(status.code, status.output).toBe(0);
    expect(status.output).toMatch(/Namespace:\s+agent-a/);
    expect(status.output).toMatch(/Concepts:\s+2/);

    const push = await runCli(['polytician', '-e', fake, 'push-all'], { cwd });
    expect(push.code, push.output).toBe(0);
    expect(push.output).toContain("Pushed 2 of 2 concepts in namespace agent-a to memory_repo");

    const pull = await runCli(['polytician', '-e', fake, 'pull'], { cwd });
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toMatch(/into namespace agent-a/);

    for (const tool of ['get_stats', 'health_check', 'list_concepts', 'vault_memory_push', 'vault_memory_pull']) {
      expect(loggedCalls(logFile, tool).length, tool).toBeGreaterThan(0);
      expect(loggedCalls(logFile, tool).every((args) => args.namespace === 'agent-a'), tool).toBe(true);
    }
  }, 120_000);

  it('finds the agent name from a subdirectory of the project', async () => {
    const cwd = join(project('nested', 'agent-a'), 'src', 'deep');
    mkdirSync(cwd, { recursive: true });

    const run = await runCli(['polytician', '-e', entry('--seed-namespace', 'agent-a', '--require-namespace', 'agent-a'), 'status'], { cwd });

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Namespace:\s+agent-a/);
    expect(run.output).toMatch(/Concepts:\s+2/);
  }, 90_000);

  it('reads the agent name from .agentvault/config/agent.config.json, and --namespace overrides it', async () => {
    const cwd = project('agent-config', 'agent-b', true);

    const fromConfig = await runCli(['polytician', '-e', entry('--require-namespace', 'agent-b'), 'search', 'parser', '--json'], { cwd });
    expect(fromConfig.code, fromConfig.output).toBe(0);

    const overridden = await runCli(['polytician', '-e', entry('--require-namespace', 'team.shared'), '-n', 'team.shared', 'search', 'parser', '--json'], { cwd });
    expect(overridden.code, overridden.output).toBe(0);
  }, 120_000);

  it('refuses an invalid namespace before starting Polytician', async () => {
    const startupLog = join(workDir, 'ns-invalid.jsonl');

    const run = await runCli(['polytician', '-e', entry('--startup-log', startupLog), '--namespace', 'my agent', 'status']);
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/--namespace "my agent" is not a valid Polytician namespace/);

    const fromAgent = await runCli(['polytician', '-e', entry('--startup-log', startupLog), 'status'], { cwd: project('bad-name', 'My Agent') });
    expect(fromAgent.code).toBe(1);
    expect(fromAgent.output).toMatch(/agent name "My Agent".*--namespace/s);
    expect(startups(startupLog)).toEqual([]);
  }, 120_000);

  it('explains NAMESPACE_DENIED', async () => {
    const run = await runCli(['polytician', '-e', entry('--namespaces', 'agent-b'), '-n', 'agent-a', 'search', 'parser']);

    expect(run.code).toBe(1);
    expect(run.output).toContain('NAMESPACE_DENIED');
    expect(run.output).toContain("Namespace 'agent-a' is not in this server's POLYTICIAN_NAMESPACES allowlist");
    expect(run.output).toMatch(/POLYTICIAN_NAMESPACES/);
  }, 90_000);
});

describe("agentvault polytician: Polytician's AgentVault settings", () => {
  it('passes AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN on, so Polytician offers its vault_* tools', async () => {
    const startupLog = join(workDir, 'inject.jsonl');
    const run = await runCli(['polytician', '-e', entry('--vault', 'auto', '--startup-log', startupLog), 'status'], {
      env: { AGENTVAULT_API_URL: 'http://localhost:3000', AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token' },
    });

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/AgentVault tools:\s+.*vault_memory_push/);
    expect(run.output).not.toContain('av-cli-token');
    expect(startups(startupLog)[0]!.env).toMatchObject({ POLYTICIAN_AV_API_URL: 'http://localhost:3000', POLYTICIAN_AV_API_TOKEN: 'av-cli-token' });
  }, 90_000);

  it("leaves the operator's own POLYTICIAN_AV_* settings alone, and injects nothing when AgentVault's are unset", async () => {
    const explicitLog = join(workDir, 'explicit.jsonl');
    const explicit = await runCli(['polytician', '-e', entry('--vault', 'auto', '--startup-log', explicitLog), 'status'], {
      env: {
        AGENTVAULT_API_URL: 'http://localhost:3000',
        AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token',
        POLYTICIAN_AV_API_URL: 'https://operator.example.com',
      },
    });
    expect(explicit.code, explicit.output).toBe(0);
    expect(startups(explicitLog)[0]!.env).toEqual({ POLYTICIAN_AV_API_URL: 'https://operator.example.com', MCP_MODE: 'stdio' });

    const unsetLog = join(workDir, 'unset.jsonl');
    const unset = await runCli(['polytician', '-e', entry('--vault', 'auto', '--startup-log', unsetLog), 'status']);
    expect(unset.code, unset.output).toBe(0);
    expect(unset.output).toMatch(/AgentVault tools:\s+not configured/);
    expect(startups(unsetLog)[0]!.env).toEqual({ MCP_MODE: 'stdio' });
  }, 120_000);

  it("does not hand Polytician AgentVault's signing key or wallet secrets", async () => {
    const startupLog = join(workDir, 'secrets.jsonl');
    const run = await runCli(['polytician', '-e', entry('--startup-log', startupLog), 'status'], {
      env: {
        AGENTVAULT_ICP_IDENTITY_PEM: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
        AGENTVAULT_ICP_IDENTITY_PEM_FILE: '/keys/webapp.pem',
        AGENTVAULT_MNEMONIC: 'abandon abandon abandon',
        AGENTVAULT_PRIVATE_KEY: '0xdeadbeef',
        AGENTVAULT_PASSWORD: 'hunter2',
        AGENTVAULT_BUNDLE_SECRET: 'bundle-secret',
      },
    });

    expect(run.code, run.output).toBe(0);
    expect(startups(startupLog)[0]!.env).toEqual({ MCP_MODE: 'stdio' });
  }, 90_000);

  it('warns when Polytician offers its vault_* tools but has no token to send', async () => {
    const file = join(workDir, 'no-token', 'polytician.json');
    const written = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com']);
    expect(written.code, written.output).toBe(0);

    // The file names AgentVault but holds only a reference to the token
    const referenceOnly = await runCli(['polytician', '-e', entry('--vault', 'auto'), '--config', file, 'status'], {
      env: { AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token' },
    });
    expect(referenceOnly.code, referenceOnly.output).toBe(0);
    expect(referenceOnly.output).toMatch(/AgentVault tools:\s+.*vault_memory_push/);
    expect(referenceOnly.output).toMatch(/no POLYTICIAN_AV_API_TOKEN[\s\S]*refuse/);
    expect(referenceOnly.output).toContain('AGENTVAULT_API_URL');
    expect(referenceOnly.output).not.toContain('av-cli-token');

    // With AgentVault's URL and token set, AgentVault passes the token on
    const injected = await runCli(['polytician', '-e', entry('--vault', 'auto'), '--config', file, 'status'], {
      env: { AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token' },
    });
    expect(injected.code, injected.output).toBe(0);
    expect(injected.output).not.toMatch(/no POLYTICIAN_AV_API_TOKEN/);

    // A token written into the file itself needs nothing from the environment
    writeFileSync(file, JSON.stringify({ agentVault: { apiBaseUrl: 'https://vault.example.com', apiToken: 'literal-token' } }));
    const literal = await runCli(['polytician', '-e', entry('--vault', 'auto'), '--config', file, 'status']);
    expect(literal.code, literal.output).toBe(0);
    expect(literal.output).not.toMatch(/no POLYTICIAN_AV_API_TOKEN/);
  }, 180_000);

  it('refuses an AGENTVAULT_API_URL Polytician would refuse, before starting it', async () => {
    const startupLog = join(workDir, 'refused.jsonl');
    const run = await runCli(['polytician', '-e', entry('--startup-log', startupLog), 'status'], {
      env: { AGENTVAULT_API_URL: 'http://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token' },
    });

    expect(run.code).toBe(1);
    expect(run.output).toMatch(/AGENTVAULT_API_URL .*http:\/\/vault\.example\.com.*https/s);
    expect(run.output).not.toContain('av-cli-token');
    expect(startups(startupLog)).toEqual([]);
  }, 90_000);
});

describe('agentvault polytician config', () => {
  it("writes Polytician's AgentVault settings to ~/.polytician/config.json, owner-only, with a token reference instead of the token", async () => {
    const home = join(workDir, 'home-default');
    mkdirSync(home);
    const run = await runCli(['polytician', 'config', '--api-url', 'https://vault.example.com'], {
      env: { HOME: home, AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-secret-token' },
    });

    expect(run.code, run.output).toBe(0);
    const file = join(home, '.polytician', 'config.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      agentVault: { apiBaseUrl: 'https://vault.example.com', apiToken: '${POLYTICIAN_AV_API_TOKEN}', memoryRepoBranch: 'polytician-main' },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('av-secret-token');
    expect(run.output).not.toContain('av-secret-token');
    expect(run.output).toContain(file);
    expect(run.output).toContain('POLYTICIAN_AV_API_TOKEN');
  }, 90_000);

  it('takes the URL from AGENTVAULT_API_URL, refuses to overwrite without --force, and replaces only the agentVault section with it', async () => {
    const file = join(workDir, 'force', 'polytician.json');
    const env = { AGENTVAULT_API_URL: 'http://localhost:3000' };

    const first = await runCli(['polytician', '--config', file, 'config', '--branch', 'team-memory'], { env });
    expect(first.code, first.output).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).agentVault).toMatchObject({ apiBaseUrl: 'http://localhost:3000', memoryRepoBranch: 'team-memory' });

    writeFileSync(file, JSON.stringify({ namespaces: ['agent-a'], agentVault: { apiBaseUrl: 'https://old.example.com' } }));
    const refused = await runCli(['polytician', '--config', file, 'config'], { env });
    expect(refused.code).toBe(1);
    expect(refused.output).toMatch(/already exists.*--force/s);
    expect(JSON.parse(readFileSync(file, 'utf8')).agentVault.apiBaseUrl).toBe('https://old.example.com');

    const forced = await runCli(['polytician', '--config', file, 'config', '--force'], { env });
    expect(forced.code, forced.output).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      namespaces: ['agent-a'],
      agentVault: { apiBaseUrl: 'http://localhost:3000', apiToken: '${POLYTICIAN_AV_API_TOKEN}', memoryRepoBranch: 'polytician-main' },
    });
  }, 120_000);

  it('writes an archival block only on request, and warns that Arweave uploads are permanent, public and paid', async () => {
    const file = join(workDir, 'archival', 'polytician.json');
    const jwk = join(workDir, 'wallet.json');
    writeFileSync(jwk, WALLET);

    const run = await runCli([
      'polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com',
      '--archival-tag', 'archive', '--archival-tag', 'public', '--arweave-jwk', jwk,
    ]);

    expect(run.code, run.output).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).agentVault.archival).toEqual({ enabled: true, tagFilter: ['archive', 'public'], arweaveJwk: jwk });
    expect(run.output).toMatch(/permanent/i);
    expect(run.output).toMatch(/public/i);
    expect(run.output).toMatch(/paid/i);

    const noWallet = await runCli(['polytician', '--config', join(workDir, 'no-wallet.json'), 'config', '--api-url', 'https://vault.example.com', '--archival-tag', 'archive']);
    expect(noWallet.code).toBe(1);
    expect(noWallet.output).toMatch(/--arweave-jwk/);
    expect(existsSync(join(workDir, 'no-wallet.json'))).toBe(false);
  }, 120_000);

  it('says AgentVault will not pass the token on when AGENTVAULT_API_URL is unset', async () => {
    const file = join(workDir, 'token-only', 'polytician.json');
    const run = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com'], {
      env: { AGENTVAULT_POLYTICIAN_API_TOKEN: 'av-cli-token' },
    });

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/AGENTVAULT_API_URL is not set[\s\S]*POLYTICIAN_AV_API_TOKEN/);
    expect(run.output).not.toContain('av-cli-token');
  }, 90_000);

  it('with --force keeps the agentVault settings it does not write, and --no-archival turns archival off', async () => {
    const file = join(workDir, 'keep', 'polytician.json');
    const jwk = join(workDir, 'keep-wallet.json');
    writeFileSync(jwk, WALLET);
    const first = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com', '--archival-tag', 'publish', '--arweave-jwk', jwk]);
    expect(first.code, first.output).toBe(0);
    const withSync = JSON.parse(readFileSync(file, 'utf8')) as { agentVault: Record<string, unknown> };
    withSync.agentVault.sync = { enabled: true };
    writeFileSync(file, JSON.stringify(withSync));

    const forced = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://new.example.com', '--force']);
    expect(forced.code, forced.output).toBe(0);
    const kept = JSON.parse(readFileSync(file, 'utf8')).agentVault;
    expect(kept).toMatchObject({ apiBaseUrl: 'https://new.example.com', sync: { enabled: true }, archival: { enabled: true, tagFilter: ['publish'] } });
    expect(forced.output).toMatch(/Kept .*archival.*sync|Kept .*sync.*archival/);

    const off = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://new.example.com', '--no-archival', '--force']);
    expect(off.code, off.output).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).agentVault).not.toHaveProperty('archival');
    expect(JSON.parse(readFileSync(file, 'utf8')).agentVault.sync).toEqual({ enabled: true });
  }, 180_000);

  it('refuses a wallet file that is not an Arweave key', async () => {
    const file = join(workDir, 'bad-wallet', 'polytician.json');
    const jwk = join(workDir, 'bad-wallet.json');
    writeFileSync(jwk, 'not json');

    const run = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com', '--archival-tag', 'publish', '--arweave-jwk', jwk]);

    expect(run.code).toBe(1);
    expect(run.output).toMatch(/not an Arweave wallet/);
    expect(existsSync(file)).toBe(false);
  }, 90_000);

  it('refuses a URL Polytician would refuse, and needs one', async () => {
    const file = join(workDir, 'bad-url.json');
    const plainHttp = await runCli(['polytician', '--config', file, 'config', '--api-url', 'http://vault.example.com']);
    expect(plainHttp.code).toBe(1);
    expect(plainHttp.output).toMatch(/https/);

    const none = await runCli(['polytician', '--config', file, 'config']);
    expect(none.code).toBe(1);
    expect(none.output).toMatch(/--api-url.*AGENTVAULT_API_URL/s);
    expect(existsSync(file)).toBe(false);
  }, 120_000);

  it('passes the file to Polytician with --config, which then offers the vault_* tools', async () => {
    const file = join(workDir, 'passed', 'polytician.json');
    const startupLog = join(workDir, 'passed.jsonl');
    const written = await runCli(['polytician', '--config', file, 'config', '--api-url', 'https://vault.example.com']);
    expect(written.code, written.output).toBe(0);

    const run = await runCli(['polytician', '-e', entry('--vault', 'auto', '--startup-log', startupLog), '--config', file, 'status']);

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/AgentVault tools:\s+.*vault_memory_push/);
    expect(startups(startupLog)[0]!.argv.slice(-2)).toEqual(['--config', file]);
  }, 120_000);
});
