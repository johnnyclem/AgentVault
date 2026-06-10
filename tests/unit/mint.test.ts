import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mintGoogleAdkAgent } from '../../src/mint/google-adk.js';

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

describe('mintGoogleAdkAgent scaffold', () => {
  it('creates scaffold files and birthday backup', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'agentvault-mint-'));

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
});
