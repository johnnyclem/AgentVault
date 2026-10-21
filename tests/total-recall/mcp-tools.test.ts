import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  getTotalRecallToolDefinitions,
  handleTotalRecallToolCall,
  totalRecallInstructions,
} from '../../src/total-recall/mcp-tools.js';
import { TotalRecallVolume } from '../../src/total-recall/volume.js';
import { serveMcp, getAllToolDefinitions, dispatchToolCall } from '../../src/hypervault/mcp-server.js';

let root: string;
let volumeDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-mcp-'));
  volumeDir = path.join(root, 'vol');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => handleTotalRecallToolCall(name, args, { volumeDir });
const parse = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]!.text!) as Record<string, any>;

describe('total_recall_* tool definitions', () => {
  it('declares nine tools with read-only annotations on the readers', () => {
    const defs = getTotalRecallToolDefinitions();
    expect(defs).toHaveLength(9);
    expect(defs.every((d) => d.name.startsWith('total_recall_'))).toBe(true);
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.total_recall_record!.annotations?.readOnlyHint).toBe(false);
    expect(byName.total_recall_pull!.annotations?.readOnlyHint).toBe(true);
    expect(byName.total_recall_record!.inputSchema).toMatchObject({ required: ['op', 'key', 'content', 'provider'] });
  });

  it('is served by the native MCP server', () => {
    const names = getAllToolDefinitions().map((t) => t.name);
    expect(names).toContain('total_recall_record');
    expect(names).toContain('total_recall_pull');
  });
});

describe('record / pull / list / search / history', () => {
  it('creates the volume on first write and chains events', async () => {
    const r1 = parse(await call('total_recall_record', { op: 'created', key: 'coffee', content: 'Likes pour-over', provider: 'ChatGPT', agent: 'gpt-5' }));
    expect(r1.recorded).toBe(true);
    expect(r1.seq).toBe(1);
    expect(TotalRecallVolume.exists(volumeDir)).toBe(true);

    const r2 = parse(await call('total_recall_record', { op: 'updated', key: 'coffee', content: 'Likes pour-over, no sugar', provider: 'chatgpt' }));
    expect(r2.seq).toBe(2);

    const pull = parse(await call('total_recall_pull', { since_seq: 0 }));
    expect(pull.events).toHaveLength(2);
    expect(pull.events[0].source.provider).toBe('chatgpt'); // provider is lower-cased
    expect(pull.next_seq).toBe(2);
    expect(pull.more).toBe(false);

    const page = parse(await call('total_recall_pull', { since_seq: 0, limit: 1 }));
    expect(page.events).toHaveLength(1);
    expect(page.next_seq).toBe(1);
    expect(page.more).toBe(true);
    expect(parse(await call('total_recall_pull', { since_seq: 2 })).events).toHaveLength(0);

    const list = parse(await call('total_recall_list'));
    expect(list.count).toBe(1);
    expect(list.memories[0].content).toBe('Likes pour-over, no sugar');

    const search = parse(await call('total_recall_search', { query: 'sugar' }));
    expect(search.results[0].memory.key).toBe('coffee');

    const history = parse(await call('total_recall_history', { provider: 'chatgpt', key: 'coffee' }));
    expect(history.events.map((e: { op: string }) => e.op)).toEqual(['created', 'updated']);
  });

  it('rejects bad input without writing', async () => {
    expect((await call('total_recall_record', { op: 'forgot', key: 'k', content: 'c', provider: 'x' })).isError).toBe(true);
    expect((await call('total_recall_record', { op: 'created', key: 'k', content: 'c' })).isError).toBe(true);
    expect((await call('total_recall_pull')).isError).toBe(true); // no volume yet
    expect((await call('total_recall_nope')).isError).toBe(true);
  });
});

describe('policy enforcement', () => {
  it('refuses providers and ops the policy excludes, and transcript writes when off', async () => {
    TotalRecallVolume.init(volumeDir, { policy: { providers: ['chatgpt'], recordOps: ['created', 'updated', 'deleted'] } });
    const other = await call('total_recall_record', { op: 'created', key: 'k', content: 'c', provider: 'gemini' });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/not allowed/);
    const recall = await call('total_recall_record', { op: 'recalled', key: 'k', content: 'c', provider: 'chatgpt' });
    expect(recall.isError).toBe(true);
    expect(recall.content[0]!.text).toMatch(/does not record "recalled"/);
    const turn = await call('total_recall_transcribe', { role: 'user', content: 'hi', session: 's', provider: 'chatgpt' });
    expect(turn.isError).toBe(true);
    expect(turn.content[0]!.text).toMatch(/transcript mode off/);
    expect(TotalRecallVolume.open(volumeDir).memoriesSeq()).toBe(0);
  });

  it('appends transcript turns when the policy allows them', async () => {
    TotalRecallVolume.init(volumeDir, { policy: { transcript: 'append' } });
    const r = parse(await call('total_recall_transcribe', { role: 'assistant', content: 'hello', session: 's1', provider: 'claude', model: 'claude-fable-5-1' }));
    expect(r.recorded).toBe(true);
    expect(TotalRecallVolume.open(volumeDir).readTranscript()[0]).toMatchObject({ role: 'assistant', sessionId: 's1', model: 'claude-fable-5-1' });
  });

  it('exposes the guardrail through total_recall_policy and the initialize instructions', async () => {
    expect(totalRecallInstructions(volumeDir)).toBeUndefined();
    TotalRecallVolume.init(volumeDir, { volumeId: 'tr_x', policy: { transcript: 'append' } });
    const instructions = totalRecallInstructions(volumeDir)!;
    expect(instructions).toMatch(/GUARDRAIL/);
    expect(instructions).toMatch(/total_recall_record/);
    expect(instructions).toMatch(/TRANSCRIPT/);
    const p = parse(await call('total_recall_policy'));
    expect(p.instructions).toBe(instructions);
    expect(p.policy.transcript).toBe('append');
  });
});

describe('status / verify', () => {
  it('reports status and verifies through the tools', async () => {
    await call('total_recall_record', { op: 'created', key: 'k', content: 'c', provider: 'claude' });
    const status = parse(await call('total_recall_status'));
    expect(status.memories.events).toBe(1);
    const verify = await call('total_recall_verify');
    expect(verify.isError).toBeUndefined();
    expect(parse(verify).valid).toBe(true);
    fs.writeFileSync(path.join(volumeDir, 'memories.jsonl'), fs.readFileSync(path.join(volumeDir, 'memories.jsonl'), 'utf8').replace('"content":"c"', '"content":"d"'));
    const broken = await call('total_recall_verify');
    expect(broken.isError).toBe(true);
  });
});

describe('stdio server integration', () => {
  async function drive(requests: object[], totalRecallDir: string): Promise<Record<string, any>[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: Record<string, any>[] = [];
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) if (line.trim()) responses.push(JSON.parse(line));
    });
    const done = serveMcp({ input, output, totalRecallDir });
    for (const req of requests) input.write(JSON.stringify(req) + '\n');
    input.end();
    await done;
    return responses;
  }

  it('injects the guardrail as initialize.instructions only when a volume exists', async () => {
    const before = await drive([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }], volumeDir);
    expect(before[0]!.result.instructions).toBeUndefined();
    TotalRecallVolume.init(volumeDir);
    const after = await drive([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }], volumeDir);
    expect(after[0]!.result.instructions).toMatch(/GUARDRAIL/);
  });

  it('routes total_recall_* tool calls', async () => {
    const responses = await drive(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'total_recall_record', arguments: { op: 'created', key: 'k', content: 'c', provider: 'chatgpt' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'total_recall_pull', arguments: { since_seq: 0 } } },
      ],
      volumeDir,
    );
    expect(JSON.parse(responses[0]!.result.content[0].text).seq).toBe(1);
    expect(JSON.parse(responses[1]!.result.content[0].text).events).toHaveLength(1);
    const direct = await dispatchToolCall('total_recall_status', {}, { totalRecallDir: volumeDir });
    expect(direct.isError).toBeUndefined();
  });
});
