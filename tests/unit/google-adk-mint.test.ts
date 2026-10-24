/**
 * mintGoogleADKAgent deploys no canister. Without --canister-id it makes an
 * ID up, and the generated README and .agentvault/config.json must say so;
 * with one it must not talk about a placeholder at all.
 *
 * The google-adk check shells out to Python, so execa is a stand-in. HOME is
 * a temporary directory because the birthday record goes under ~/.agentvault.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('execa', () => ({
  execaCommand: async () => ({ stdout: 'Version: 1.0.0' }),
}));

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'av-adk-mint-'));
  vi.stubEnv('HOME', join(sandbox, 'home'));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

async function mint(canisterId?: string) {
  const { mintGoogleADKAgent } = await import('../../src/orchestration/google-adk.js');
  const progress: string[] = [];
  const result = await mintGoogleADKAgent({
    agentName: 'my-bot',
    agentType: 'loop',
    outputDir: sandbox,
    canisterId,
    onProgress: (message) => progress.push(message),
  });
  expect(result.success).toBe(true);
  const agentDir = join(sandbox, 'my-bot');
  return {
    result,
    progress: progress.join('\n'),
    readme: readFileSync(join(agentDir, 'README.md'), 'utf8'),
    config: JSON.parse(readFileSync(join(agentDir, '.agentvault', 'config.json'), 'utf8')) as Record<string, unknown>,
  };
}

describe('mintGoogleADKAgent canister ID', () => {
  it('marks a made-up canister ID as a placeholder in the README and config', async () => {
    const { result, progress, readme, config } = await mint();

    expect(progress).toContain(`Placeholder canister ID: ${result.canisterId} (no canister is deployed)`);
    expect(readme).toContain(`| ICP Canister   | \`${result.canisterId}\` (placeholder, not deployed) |`);
    expect(config).toMatchObject({ canisterId: result.canisterId, canisterIdIsPlaceholder: true });
  });

  it('does not call a canister ID given with --canister-id a placeholder', async () => {
    const given = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

    const { progress, readme, config } = await mint(given);

    expect(progress).toContain(`Using the given canister ID: ${given}`);
    expect(progress).not.toMatch(/placeholder/i);
    expect(readme).not.toMatch(/placeholder/i);
    expect(readme).toContain(`\`${given}\``);
    expect(config).toMatchObject({ canisterId: given, canisterIdIsPlaceholder: false });
  });
});
