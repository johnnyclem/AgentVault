/**
 * The Polytician flows against a real Polytician 3.x server. Skipped unless
 * POLYTICIAN_ENTRY names the server command:
 *
 *   POLYTICIAN_ENTRY="node /path/to/polytician/dist/index.js" \
 *   POLYTICIAN_MODELS_DIR=/path/to/dir/holding/Xenova \
 *   npx vitest run tests/integration/polytician-real.test.ts
 *
 * The server gets a fresh temporary POLYTICIAN_DATA_DIR and HOME and no other
 * POLYTICIAN_* setting, so a real data directory or ~/.polytician/config.json
 * is never touched. Without POLYTICIAN_MODELS_DIR the server downloads its
 * embedding model (~25 MB) on first use.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolyticianMCPClient, type MCPServerConfig } from '../../src/orchestration/mcp-client.js';
import { callPolytician } from '../../src/orchestration/polytician-tools.js';
import {
  enrichWithPolyticianContext,
  saveConceptFromOrchestration,
} from '../../src/orchestration/polytician-enricher.js';

const ENTRY = process.env['POLYTICIAN_ENTRY'];
const MODELS_DIR = process.env['POLYTICIAN_MODELS_DIR'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.runIf(ENTRY)('Polytician flows against a real server', () => {
  const server: MCPServerConfig = { namespace: 'polytician', entryPoint: ENTRY ?? '' };
  const savedEnv = { ...process.env };
  const dirs: string[] = [];

  beforeAll(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'av-polytician-data-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'av-polytician-home-'));
    dirs.push(dataDir, homeDir);
    if (MODELS_DIR) cpSync(MODELS_DIR, join(dataDir, 'models'), { recursive: true });

    // The client passes its own environment to the server it spawns.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('POLYTICIAN_')) delete process.env[key];
    }
    Object.assign(process.env, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      POLYTICIAN_DATA_DIR: dataDir,
      POLYTICIAN_NLP_PIPELINE: 'rule-based',
    });
  });

  afterAll(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('saves orchestration results and finds the relevant one for enrichment', async () => {
    const related = await saveConceptFromOrchestration(
      'real-1',
      'Refactor the parser to stream tokens',
      'Replaced the recursive descent loop with a streaming tokenizer.',
      ['src/parser.ts'],
      server,
    );
    const unrelated = await saveConceptFromOrchestration(
      'real-2',
      'Write a banana bread recipe',
      'Mash three ripe bananas, mix with flour, sugar and butter, and bake for an hour.',
      ['recipes/banana-bread.md'],
      server,
    );
    expect(related).toMatch(UUID);
    expect(unrelated).toMatch(UUID);

    const enrichment = await enrichWithPolyticianContext('Refactor the parser so it streams tokens', { mcpServer: server });
    const used = enrichment.conceptsUsed.map((c) => c.id);
    expect(used).toContain(related);
    expect(used).not.toContain(unrelated);
    expect(enrichment.conceptsUsed.find((c) => c.id === related)?.name).toBe('Refactor the parser to stream tokens');
    expect(enrichment.enrichedPrompt).toContain('Replaced the recursive descent loop with a streaming tokenizer.');
  }, 120_000);

  it('reads back a non-ASCII concept larger than one pipe read unchanged', async () => {
    // ~290 KB: the response spans several 64 KiB reads, some ending inside a character
    const markdown = '# 认证 JWT 过期\n\n' + '认证中间件必须拒绝过期的令牌 — JWT 过期检查 ✓ 🔐\n'.repeat(4000);
    const client = new PolyticianMCPClient(server);
    await client.connect();
    try {
      const saved = await callPolytician(client, 'save_concept', { markdown, autoEmbed: false });
      expect(saved.markdown).toBe(markdown);
      for (let i = 0; i < 3; i++) {
        const read = await callPolytician(client, 'read_concept', { id: saved.id, representations: ['markdown'] });
        expect(read.markdown).toBe(markdown);
      }
      await callPolytician(client, 'delete_concept', { id: saved.id });
    } finally {
      await client.disconnect();
    }
  }, 120_000);

  it('reads typed health and stats, and reports tool errors with their codes', async () => {
    const client = new PolyticianMCPClient(server);
    await client.connect();
    try {
      expect(client.getServerInfo()?.version).toMatch(/^3\./);
      const health = await callPolytician(client, 'health_check', {});
      expect(health.server).toBe('ok');
      expect(health.embedding.dimension).toBe(384);
      const stats = await callPolytician(client, 'get_stats', {});
      expect(stats.conceptCount).toBeGreaterThanOrEqual(2);

      await expect(client.callToolResult('search_concepts', { query: 'parser', limit: 5 }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(client.callToolResult('vault_memory_push', { conceptId: '00000000-0000-4000-8000-000000000000' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await client.disconnect();
    }
  }, 120_000);
});
