import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  serveMcp,
  getAllToolDefinitions,
  getHyperVaultToolDefinitions,
  handleHyperVaultToolCall,
} from '../../src/hypervault/mcp-server.js';

/** Drive the stdio JSON-RPC server with a scripted set of requests. */
async function driveServer(requests: object[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: Record<string, unknown>[] = [];

  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
    }
  });

  const done = serveMcp({ input, output });
  for (const req of requests) {
    input.write(JSON.stringify(req) + '\n');
  }
  input.end();
  await done;
  return responses;
}

describe('native MCP server protocol conformance', () => {
  it('responds to initialize with protocol version and server info', async () => {
    const responses = await driveServer([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    const res = responses[0]!;
    expect(res.id).toBe(1);
    const result = res.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBeTruthy();
    expect(result.serverInfo.name).toBe('agentvault');
  });

  it('lists both pipeline and wiki tools', async () => {
    const responses = await driveServer([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const result = responses[0]!.result as { tools: { name: string }[] };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('hypervault_archive');
    expect(names).toContain('hypervault_bootstrap');
    expect(names).toContain('wiki_read');
    expect(result.tools.length).toBe(getAllToolDefinitions().length);
  });

  it('returns method-not-found for unknown methods', async () => {
    const responses = await driveServer([{ jsonrpc: '2.0', id: 3, method: 'does/not/exist' }]);
    const error = responses[0]!.error as { code: number };
    expect(error.code).toBe(-32601);
  });

  it('does not respond to notifications (no id)', async () => {
    const responses = await driveServer([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 9, method: 'ping' },
    ]);
    // Only the ping (id 9) produces a response
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(9);
  });

  it('exposes all 9 pipeline tools', () => {
    expect(getHyperVaultToolDefinitions()).toHaveLength(9);
  });

  it('returns an error result for an unknown tool call', async () => {
    const result = await handleHyperVaultToolCall('hypervault_nope', {});
    expect(result.isError).toBe(true);
  });
});
