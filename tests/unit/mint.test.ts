import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arweaveTestJwk, fakeArweaveGateway, sha256Hex } from '../fixtures/arweave-gateway.js';

describe('Mint command wiring', () => {
  const ROOT_DIR = join(import.meta.dirname, '..', '..');

  it('cli/commands/mint.ts exists', () => {
    expect(existsSync(join(ROOT_DIR, 'cli', 'commands', 'mint.ts'))).toBe(true);
  });

  it('cli/index.ts imports mintCmd', () => {
    const content = readFileSync(join(ROOT_DIR, 'cli', 'index.ts'), 'utf-8');
    expect(content).toContain("from './commands/mint.js'");
  });

  it('cli/index.ts registers mintCmd', () => {
    const content = readFileSync(join(ROOT_DIR, 'cli', 'index.ts'), 'utf-8');
    expect(content).toContain('program.addCommand(mintCmd())');
  });

  it('mint command supports Google ADK templates', () => {
    const content = readFileSync(join(ROOT_DIR, 'cli', 'commands', 'mint.ts'), 'utf-8');
    expect(content).toContain('--google-adk-loop-agent');
    expect(content).toContain('--google-adk-workflow-agent');
    expect(content).toContain('--google-adk-sequential-agent');
    expect(content).toContain('--google-adk-parallel-agent');
  });
});

// The mint writes its archive record under ~/.agentvault, so each test gets
// its own HOME and fresh module instances that read it.
describe('mintGoogleAdkAgent scaffold', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agentvault-mint-'));
    vi.stubEnv('HOME', join(sandbox, 'home'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('creates scaffold files and birthday backup', async () => {
    const { mintGoogleAdkAgent } = await import('../../src/mint/google-adk.js');

    const result = await mintGoogleAdkAgent({
      agentName: 'hello-agent',
      template: 'loop-agent',
      targetRoot: sandbox,
      installAdk: false,
    });

    expect(existsSync(join(result.agentDir, 'agent.py'))).toBe(true);
    expect(existsSync(join(result.agentDir, 'a2a-manifest.json'))).toBe(true);
    expect(existsSync(join(result.agentDir, '.agentvault', 'config', 'agent.config.json'))).toBe(true);
    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.canisterId.length).toBeGreaterThan(0);
  });

  it('leaves an uploaded birthday archive pending with its transaction id', async () => {
    const gateway = fakeArweaveGateway();
    vi.stubGlobal('fetch', gateway.fetch);
    const jwkPath = join(sandbox, 'arweave-wallet.json');
    writeFileSync(jwkPath, JSON.stringify(arweaveTestJwk()));
    const { mintGoogleAdkAgent } = await import('../../src/mint/google-adk.js');
    const { getArchive } = await import('../../src/archival/archive-manager.js');

    const result = await mintGoogleAdkAgent({
      agentName: 'hello-agent',
      template: 'loop-agent',
      targetRoot: sandbox,
      installAdk: false,
      arweaveJwkPath: jwkPath,
    });

    const [tx] = gateway.posted;
    expect(result.arweaveTransactionId).toBe(tx!.id);
    const record = getArchive(result.archiveId!);
    expect(record).toMatchObject({ status: 'pending', transactionId: tx!.id });
    expect(sha256Hex(tx!.data)).toBe(record!.checksum);
  });

  it('uploads no local paths in the birthday archive', async () => {
    const gateway = fakeArweaveGateway();
    vi.stubGlobal('fetch', gateway.fetch);
    const jwkPath = join(sandbox, 'arweave-wallet.json');
    writeFileSync(jwkPath, JSON.stringify(arweaveTestJwk()));
    const { mintGoogleAdkAgent } = await import('../../src/mint/google-adk.js');

    const result = await mintGoogleAdkAgent({
      agentName: 'hello-agent',
      template: 'loop-agent',
      targetRoot: sandbox,
      installAdk: false,
      arweaveJwkPath: jwkPath,
    });

    const posted = gateway.posted[0]!.data.toString('utf8');
    expect(existsSync(result.backupPath)).toBe(true);
    expect(posted).not.toContain(sandbox);
    expect(JSON.parse(posted)).toMatchObject({ kind: 'birthday-backup', agentName: 'hello-agent' });
  });
});
