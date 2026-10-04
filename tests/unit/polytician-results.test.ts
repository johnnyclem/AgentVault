/**
 * Unit tests for reading Polytician 3.0 tool results: parseToolResult
 * (structuredContent, the content[0].text fallback and isError bodies) and the
 * zod schemas in polytician-tools.ts, checked against the responses recorded
 * from the real server in tests/fixtures/polytician-3.0/contract.json.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseToolResult,
  MCPToolError,
  MCPTimeoutError,
  type MCPToolCallResult,
  type PolyticianMCPClient,
} from '../../src/orchestration/mcp-client.js';
import {
  callPolytician,
  parsePolyticianResult,
  conceptTitle,
  clampCount,
  type PolyticianToolName,
} from '../../src/orchestration/polytician-tools.js';
import { formatConceptBlock } from '../../src/orchestration/polytician-enricher.js';

interface RecordedExchange {
  request: { params: { name: string; arguments: Record<string, unknown> } };
  response: { result: MCPToolCallResult };
}

const contract = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'polytician-3.0', 'contract.json'), 'utf8'),
) as { calls: Record<string, RecordedExchange>; errors: Record<string, RecordedExchange> };

const recorded = (key: string) => contract.calls[key]!.response.result;
const recordedError = (key: string) => contract.errors[key]!.response.result;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('parseToolResult', () => {
  it('returns structuredContent', () => {
    const result = recorded('get_stats');
    expect(parseToolResult('get_stats', result)).toEqual(result.structuredContent);
  });

  it('falls back to the JSON object in content[0].text', () => {
    const { structuredContent, ...textOnly } = recorded('search_concepts');
    expect(parseToolResult('search_concepts', textOnly)).toEqual(structuredContent);
  });

  it('throws MCPToolError with the code and message of an isError body', () => {
    const error = thrown(() => parseToolResult('search_concepts', recordedError('search_concepts.v2Args')));
    expect(error).toBeInstanceOf(MCPToolError);
    expect(error).toMatchObject({
      tool: 'search_concepts',
      code: 'VALIDATION_ERROR',
      serverMessage: "Input validation error: Invalid arguments for tool search_concepts: Unrecognized key(s) in object: 'limit', 'min_score'",
    });
    expect((error as Error).message).toBe(
      "search_concepts failed (VALIDATION_ERROR): Input validation error: Invalid arguments for tool search_concepts: Unrecognized key(s) in object: 'limit', 'min_score'",
    );
  });

  it('keeps currentVersion from a VERSION_CONFLICT body', () => {
    const conflict: MCPToolCallResult = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'version mismatch', code: 'VERSION_CONFLICT', currentVersion: 3 }) }],
    };
    expect(thrown(() => parseToolResult('save_concept', conflict))).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 3 });
  });

  it('reports an isError result whose text is not JSON', () => {
    const plain: MCPToolCallResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    const error = thrown(() => parseToolResult('get_stats', plain));
    expect(error).toMatchObject({ code: undefined, serverMessage: 'boom' });
  });

  it('rejects a success that carries no JSON object (a 2.x content[0].data result)', () => {
    const legacy: MCPToolCallResult = { content: [{ type: 'json', data: { concepts: [] } }] };
    expect(thrown(() => parseToolResult('search_concepts', legacy))).toMatchObject({ code: 'INVALID_RESULT' });
  });
});

describe('Polytician 3.0 output schemas', () => {
  it('accept every recorded successful response', () => {
    for (const [key, exchange] of Object.entries(contract.calls)) {
      const tool = exchange.request.params.name as PolyticianToolName;
      const structured = exchange.response.result.structuredContent;
      expect(parsePolyticianResult(tool, structured), key).toMatchObject(structured ?? {});
    }
  });

  it('reject a 2.x-shaped result instead of reading it as empty', () => {
    const legacy = { concepts: [{ id: 'concept-123', name: 'Parser', score: 0.9 }] };
    expect(thrown(() => parsePolyticianResult('search_concepts', legacy))).toMatchObject({
      tool: 'search_concepts',
      code: 'INVALID_RESULT',
    });
  });
});

describe('callPolytician timeouts', () => {
  const receipt = { archived: true, encrypted: true, txId: 'tx', url: 'https://arweave.net/tx', size: 10 };
  const fakeClient = (callToolResult: (...args: unknown[]) => Promise<unknown>) =>
    ({ callToolResult: vi.fn(callToolResult) }) as unknown as PolyticianMCPClient & { callToolResult: ReturnType<typeof vi.fn> };

  it('gives the vault_* tools longer than Polytician gives its own AgentVault requests', async () => {
    // Polytician's upload timeout is 120 s by default; its memory_repo requests, 30 s (a pull retries twice).
    const client = fakeClient(async () => receipt);
    await callPolytician(client, 'vault_archive_concept', { conceptId: 'c1' });
    expect(client.callToolResult).toHaveBeenLastCalledWith('vault_archive_concept', { conceptId: 'c1' }, { timeoutMs: 150_000 });

    client.callToolResult.mockImplementation(async () => ({ pushed: true, sha: 's' }));
    await callPolytician(client, 'vault_memory_push', { conceptId: 'c1' });
    expect(client.callToolResult).toHaveBeenLastCalledWith('vault_memory_push', { conceptId: 'c1' }, { timeoutMs: 60_000 });

    client.callToolResult.mockImplementation(async () => ({ conceptCount: 0, vectorCount: 0, representationCounts: { markdown: 0, thoughtform: 0, vector: 0 } }));
    await callPolytician(client, 'get_stats', {});
    expect(client.callToolResult).toHaveBeenLastCalledWith('get_stats', {}, {});

    await callPolytician(client, 'get_stats', {}, { timeoutMs: 5 });
    expect(client.callToolResult).toHaveBeenLastCalledWith('get_stats', {}, { timeoutMs: 5 });
  });

  it('reports an archive or push that got no answer as an unknown outcome, not a failure', async () => {
    const timedOut = (tool: string) => fakeClient(async () => {
      throw new MCPTimeoutError('tools/call', 150_000, tool);
    });

    const archive = await callPolytician(timedOut('vault_archive_concept'), 'vault_archive_concept', { conceptId: 'c1' })
      .catch((error: unknown) => error);
    expect(archive).toBeInstanceOf(MCPToolError);
    expect(archive).toMatchObject({ tool: 'vault_archive_concept', code: 'OUTCOME_UNKNOWN' });
    expect((archive as Error).message).toMatch(/^vault_archive_concept outcome unknown: no answer within 150 s/);
    expect((archive as Error).message).not.toContain('failed');
    expect((archive as Error).message).toContain('before archiving it again');

    const push = await callPolytician(timedOut('vault_memory_push'), 'vault_memory_push', { conceptId: 'c1' })
      .catch((error: unknown) => error);
    expect(push).toMatchObject({ code: 'OUTCOME_UNKNOWN' });

    // A read that timed out changed nothing: it stays a timeout.
    const stats = await callPolytician(timedOut('get_stats'), 'get_stats', {}).catch((error: unknown) => error);
    expect(stats).toBeInstanceOf(MCPTimeoutError);
  });
});

describe('conceptTitle', () => {
  it('uses the first markdown heading', () => {
    expect(conceptTitle('# Orchestration Result: session-1\n\n## Task\nx', 'id-1')).toBe('Orchestration Result: session-1');
    expect(conceptTitle('Intro line\n\n## Deployment checklist ##\n', 'id-1')).toBe('Deployment checklist');
    expect(conceptTitle('# C#\n', 'id-1')).toBe('C#');
  });

  it('skips comment lines inside fenced code blocks', () => {
    const markdown = '```bash\n# install the parser deps\nnpm install tokenizer\n```\n\n## Streaming parser\n';
    expect(conceptTitle(markdown, 'id-1')).toBe('Streaming parser');
    expect(conceptTitle('~~~py\n# only a comment\n~~~\n', 'id-1')).toBe('id-1');
    // A fence is closed only by the same character, at least as long
    expect(conceptTitle('````\n```\n# still code\n````\n# Title\n', 'id-1')).toBe('Title');
  });

  it('falls back to the id', () => {
    expect(conceptTitle('no heading here', 'id-1')).toBe('id-1');
    expect(conceptTitle(undefined, 'id-1')).toBe('id-1');
    expect(conceptTitle('#hashtag only', 'id-1')).toBe('id-1');
  });
});

describe('clampCount', () => {
  it('clamps into 1..max and falls back for non-numbers', () => {
    expect(clampCount(5, 100, 10)).toBe(5);
    expect(clampCount(500, 100, 10)).toBe(100);
    expect(clampCount(0, 100, 10)).toBe(1);
    expect(clampCount('20', 100, 10)).toBe(20);
    expect(clampCount('abc', 100, 10)).toBe(10);
    expect(clampCount(null, 100, 10)).toBe(10);
    expect(clampCount(2.7, 100, 10)).toBe(2);
  });
});

describe('formatConceptBlock', () => {
  it('pushes body headings below the block heading, but leaves code in fences alone', () => {
    const block = formatConceptBlock('id-1', 'Streaming parser', ['parser'], [
      '# Streaming parser',
      '',
      '## Task',
      'Refactor the parser',
      '',
      '```bash',
      '# install the parser deps',
      'npm install tokenizer',
      '```',
    ].join('\n'));

    expect(block).toContain('### Streaming parser\nID: id-1\nTags: parser\n');
    expect(block).toContain('##### Task\nRefactor the parser');
    expect(block).toContain('```bash\n# install the parser deps\nnpm install tokenizer\n```');
    expect(block.match(/^## Task$/m)).toBeNull();
  });

  it('turns Setext headings into demoted ATX headings', () => {
    const block = formatConceptBlock('id-1', 'Notes', [], 'Intro\n\nTask\n----\nDo it\n\nOverview\n========\ntext\n\n---\n');
    expect(block).toContain('##### Task\nDo it');
    expect(block).toContain('#### Overview\ntext');
    // A rule after a blank line is not a heading underline
    expect(block).toMatch(/text\n\n---$/);
  });

  it('closes a fence the 1000-character preview cuts open', () => {
    const block = formatConceptBlock('id-1', 'Big', [], '# Big\n\n```ts\n' + 'const x = 1;\n'.repeat(200) + '```\n');
    const preview = block.slice(block.indexOf('```ts'));
    expect(preview.match(/^```/gm)).toHaveLength(2);
    expect(preview.endsWith('```\n...')).toBe(true);
  });
});
