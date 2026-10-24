import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { addOnboardCommand } from '../../cli/commands/total-recall-onboard.js';
import { createProgram } from '../../cli/index.js';
import { TotalRecallVolume } from '../../src/total-recall/volume.js';

let root: string;
let out: string[];
let err: string[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-onboard-cli-'));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Run `total-recall [--volume dir] onboard ...` the way the real program parses it. */
async function run(args: string[], volume?: string): Promise<void> {
  const parent = new Command('total-recall').option('--volume <dir>');
  addOnboardCommand(parent);
  const program = new Command().addCommand(parent);
  await program.parseAsync(['node', 'agentvault', 'total-recall', ...(volume ? ['--volume', volume] : []), 'onboard', ...args]);
}

describe('agentvault total-recall onboard (scripted)', () => {
  it('is registered under total-recall in the real program', () => {
    const tr = createProgram().commands.find((c) => c.name() === 'total-recall')!;
    const onboard = tr.commands.find((c) => c.name() === 'onboard')!;
    expect(onboard.description()).toMatch(/Guided setup/);
    expect(onboard.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--yes', '--json', '--transcript', '--record-recalls', '--chatgpt-export', '--memories', '--connect', '--project', '--no-test']),
    );
  });

  it('does the whole job from flags and prints the result as JSON', async () => {
    const vol = path.join(root, 'vol');
    const proj = path.join(root, 'proj');
    const memories = path.join(root, 'memories.txt');
    fs.writeFileSync(memories, '- Likes pour-over\n- Lives in Portland\n');
    const exportDir = path.join(root, 'export');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(
      path.join(exportDir, 'conversations.json'),
      JSON.stringify([{ id: 'c1', create_time: 1, mapping: { a: { id: 'a', message: { id: 'm1', author: { role: 'user' }, create_time: 2, content: { parts: ['hello'] } } } } }]),
    );
    await run(['--yes', '--transcript', 'append', '--record-recalls', 'off', '--memories', memories, '--chatgpt-export', exportDir, '--connect', 'claude-code', '--project', proj, '--no-test'], vol);

    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    const result = JSON.parse(out.join('\n')) as { volume: { dir: string; created: boolean; policy: { transcript: string; recordOps: string[] } }; history: { chatgpt: { messages: number }; memories: { imported: number } }; connected: Array<{ client: string; action: string }>; problems: string[] };
    expect(result.volume).toMatchObject({ dir: vol, created: true });
    expect(result.volume.policy).toMatchObject({ transcript: 'append' });
    expect(result.volume.policy.recordOps).not.toContain('recalled');
    expect(result.history.chatgpt.messages).toBe(1);
    expect(result.history.memories.imported).toBe(2);
    expect(result.connected).toMatchObject([{ client: 'claude-code', action: 'created' }]);
    expect(result.problems).toEqual([]);
    expect(fs.existsSync(path.join(proj, '.mcp.json'))).toBe(true);
    expect(TotalRecallVolume.open(vol).verify().valid).toBe(true);
  });

  it('connects nothing unless asked, and honours the environment variable for the archive', async () => {
    const vol = path.join(root, 'envvol');
    process.env.AGENTVAULT_TOTAL_RECALL_DIR = vol;
    try {
      await run(['--yes', '--no-test', '--project', path.join(root, 'proj')]);
    } finally {
      delete process.env.AGENTVAULT_TOTAL_RECALL_DIR;
    }
    const result = JSON.parse(out.join('\n')) as { volume: { dir: string }; connected: unknown[] };
    expect(result.volume.dir).toBe(vol);
    expect(result.connected).toEqual([]);
    expect(fs.existsSync(path.join(root, 'proj', '.mcp.json'))).toBe(false);
  });

  it('exits non-zero with the reason for bad flags, a missing export, and a missing terminal', async () => {
    const vol = path.join(root, 'vol');
    await run(['--yes', '--connect', 'chatgpt', '--no-test'], vol);
    expect(err.join('\n')).toMatch(/--connect takes claude-code, claude-desktop or none/);
    expect(process.exitCode).toBe(1);

    err.length = 0;
    process.exitCode = undefined;
    await run(['--yes', '--transcript', 'sometimes', '--no-test'], vol);
    expect(err.join('\n')).toMatch(/--transcript takes off or append/);

    err.length = 0;
    process.exitCode = undefined;
    out.length = 0;
    await run(['--yes', '--chatgpt-export', path.join(root, 'nope'), '--no-test'], vol);
    expect(process.exitCode).toBe(1); // the step failed, the rest still ran
    expect((JSON.parse(out.join('\n')) as { problems: string[] }).problems[0]).toMatch(/ChatGPT export: Not found/);

    err.length = 0;
    process.exitCode = undefined;
    await run([], path.join(root, 'other')); // vitest has no TTY and no --yes
    expect(err.join('\n')).toMatch(/needs a terminal/);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(root, 'other'))).toBe(false); // it asked nothing and wrote nothing
  });

  it('adds to an existing archive without touching what it holds', async () => {
    const vol = path.join(root, 'vol');
    const v = TotalRecallVolume.init(vol);
    v.appendMemoryEvent({ op: 'created', source: { provider: 'claude' }, memory: { key: 'k', content: 'kept as is' } });
    const before = fs.readFileSync(v.memoriesPath, 'utf8');
    await run(['--yes', '--no-test', '--transcript', 'append'], vol);
    expect((JSON.parse(out.join('\n')) as { volume: { created: boolean; memoryEvents: number } }).volume).toMatchObject({ created: false, memoryEvents: 1 });
    expect(fs.readFileSync(v.memoriesPath, 'utf8')).toBe(before);
    expect(TotalRecallVolume.open(vol).policy.transcript).toBe('append');
  });
});
