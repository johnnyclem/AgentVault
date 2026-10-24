import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLAUDE_INGEST_PROMPT,
  CHATGPT_MEMORY_EXPORT_PROMPT,
  applyPlan,
  buildServerEntry,
  clientTargets,
  expandHome,
  locateChatGptExport,
  mergeMcpServer,
  resolveVolumeDir,
  selfTest,
  writeClientConfig,
  type McpServerEntry,
  type OnboardReporter,
} from '../../src/total-recall/onboard.js';
import { TotalRecallVolume } from '../../src/total-recall/volume.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-onboard-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ENTRY: McpServerEntry = { command: '/usr/bin/node', args: ['/opt/agentvault/dist/cli/index.js', 'mcp', 'serve', '--total-recall', '/data/vol'] };
const CLI_TS = path.resolve('cli/index.ts');
/** The real server, run from source, for the end-to-end checks. */
const realEntry = (dir: string): McpServerEntry => ({ command: process.execPath, args: ['--import', 'tsx', CLI_TS, 'mcp', 'serve', '--total-recall', dir] });

describe('resolveVolumeDir', () => {
  it('prefers a flag, then the env, then an existing project volume, then an existing home volume, else the project default', () => {
    const cwd = path.join(root, 'proj');
    const home = path.join(root, 'home');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    expect(resolveVolumeDir({ cwd, home })).toBe(path.join(cwd, '.agentvault', 'total-recall'));
    TotalRecallVolume.init(path.join(home, '.agentvault', 'total-recall'));
    expect(resolveVolumeDir({ cwd, home })).toBe(path.join(home, '.agentvault', 'total-recall'));
    TotalRecallVolume.init(path.join(cwd, '.agentvault', 'total-recall'));
    expect(resolveVolumeDir({ cwd, home })).toBe(path.join(cwd, '.agentvault', 'total-recall'));
    expect(resolveVolumeDir({ cwd, home, env: '~/from-env' })).toBe(path.join(home, 'from-env'));
    expect(resolveVolumeDir({ cwd, home, env: '/x/env', flag: 'rel/flag' })).toBe(path.join(cwd, 'rel', 'flag'));
    expect(expandHome('~/a', home)).toBe(path.join(home, 'a'));
    expect(expandHome('/abs', home)).toBe('/abs');
  });
});

describe('locateChatGptExport', () => {
  const write = (p: string): string => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '[]');
    return p;
  };

  it('takes the file, the folder, sharded files in order, or a folder holding one export', () => {
    const file = write(path.join(root, 'a', 'conversations.json'));
    expect(locateChatGptExport(file)).toEqual([file]);
    expect(locateChatGptExport(path.dirname(file))).toEqual([file]);

    const s1 = write(path.join(root, 'b', 'conversations-001.json'));
    const s0 = write(path.join(root, 'b', 'conversations-000.json'));
    write(path.join(root, 'b', 'chat.html'));
    expect(locateChatGptExport(path.join(root, 'b'))).toEqual([s0, s1]);

    const nested = write(path.join(root, 'c', 'chatgpt-export-2026', 'conversations.json'));
    expect(locateChatGptExport(path.join(root, 'c'))).toEqual([nested]);
  });

  it('says what to do about a zip, a missing path, an empty folder and a wrong file', () => {
    fs.writeFileSync(path.join(root, 'export.zip'), 'x');
    expect(() => locateChatGptExport(path.join(root, 'export.zip'))).toThrow(/Unzip it first/);
    expect(() => locateChatGptExport(path.join(root, 'nope'))).toThrow(/Not found/);
    fs.mkdirSync(path.join(root, 'empty'));
    expect(() => locateChatGptExport(path.join(root, 'empty'))).toThrow(/Export data/);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => locateChatGptExport(path.join(root, 'notes.txt'))).toThrow(/Expected conversations.json/);
  });
});

describe('client configs', () => {
  it('knows where each assistant keeps its config', () => {
    const t = (platform: NodeJS.Platform) => clientTargets({ projectDir: '/p', platform, home: '/h', appData: '/h/AppData/Roaming' });
    expect(t('darwin').find((x) => x.id === 'claude-desktop')!.configPath).toBe('/h/Library/Application Support/Claude/claude_desktop_config.json');
    expect(t('win32').find((x) => x.id === 'claude-desktop')!.configPath).toBe(path.join('/h/AppData/Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(t('linux').find((x) => x.id === 'claude-desktop')!.configPath).toBe('/h/.config/Claude/claude_desktop_config.json');
    expect(t('linux').find((x) => x.id === 'claude-code')!.configPath).toBe('/p/.mcp.json');
  });

  it('builds an absolute-path server entry, and a tsx one when run from source', () => {
    expect(buildServerEntry({ volumeDir: '/data/vol', scriptPath: '/opt/av/dist/cli/index.js', nodePath: '/usr/bin/node' })).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/av/dist/cli/index.js', 'mcp', 'serve', '--total-recall', '/data/vol'],
    });
    expect(buildServerEntry({ volumeDir: '/data/vol', scriptPath: '/src/cli/index.ts' })).toEqual({
      command: 'npx',
      args: ['tsx', '/src/cli/index.ts', 'mcp', 'serve', '--total-recall', '/data/vol'],
    });
  });

  it('merges one server in, keeping every other key and server', () => {
    const existing = { theme: 'dark', mcpServers: { other: { command: 'x', args: [] } } };
    const merged = mergeMcpServer(existing, 'total-recall', ENTRY);
    expect(merged).toMatchObject({ changed: true, replaced: false });
    expect(merged.config).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x', args: [] }, 'total-recall': ENTRY } });
    expect(existing.mcpServers).not.toHaveProperty('total-recall'); // the input is not mutated
    expect(mergeMcpServer(merged.config, 'total-recall', ENTRY)).toMatchObject({ changed: false, replaced: true });
    expect(mergeMcpServer({}, 'total-recall', ENTRY).config).toEqual({ mcpServers: { 'total-recall': ENTRY } });
    expect(() => mergeMcpServer([], 'x', ENTRY)).toThrow(/not a JSON object/);
    expect(() => mergeMcpServer({ mcpServers: [] }, 'x', ENTRY)).toThrow(/mcpServers/);
  });

  it('creates a missing config (and its folders), merges into an existing one with a backup, and is idempotent', () => {
    const file = path.join(root, 'new', 'dir', 'claude_desktop_config.json');
    expect(writeClientConfig(file, 'total-recall', ENTRY)).toEqual({ path: file, action: 'created' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { 'total-recall': ENTRY } });

    const existing = path.join(root, 'existing.json');
    const original = JSON.stringify({ globalShortcut: 'Cmd+Space', mcpServers: { files: { command: 'fs', args: ['--ro'] } } }, null, 2);
    fs.writeFileSync(existing, original, { mode: 0o644 });
    const added = writeClientConfig(existing, 'total-recall', ENTRY);
    expect(added.action).toBe('added');
    expect(fs.readFileSync(added.backup!, 'utf8')).toBe(original);
    const after = JSON.parse(fs.readFileSync(existing, 'utf8')) as { globalShortcut: string; mcpServers: Record<string, unknown> };
    expect(after.globalShortcut).toBe('Cmd+Space');
    expect(Object.keys(after.mcpServers)).toEqual(['files', 'total-recall']);
    expect(fs.statSync(existing).mode & 0o777).toBe(0o644); // permissions kept

    expect(writeClientConfig(existing, 'total-recall', ENTRY)).toEqual({ path: existing, action: 'unchanged' });
    expect(fs.readdirSync(root).filter((f) => f.startsWith('existing.json.bak-'))).toHaveLength(1); // no second backup

    const moved: McpServerEntry = { ...ENTRY, args: [...ENTRY.args.slice(0, -1), '/elsewhere'] };
    expect(writeClientConfig(existing, 'total-recall', moved).action).toBe('updated');
  });

  it('leaves a config it cannot understand exactly as it found it', () => {
    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(broken, '{ "mcpServers": { oops');
    expect(() => writeClientConfig(broken, 'total-recall', ENTRY)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ "mcpServers": { oops');
    const wrongShape = path.join(root, 'array.json');
    fs.writeFileSync(wrongShape, '[1,2]');
    expect(() => writeClientConfig(wrongShape, 'total-recall', ENTRY)).toThrow(/left untouched/);
    expect(fs.readFileSync(wrongShape, 'utf8')).toBe('[1,2]');
    expect(fs.readdirSync(root).some((f) => f.includes('.bak-'))).toBe(false);
    const empty = path.join(root, 'empty.json');
    fs.writeFileSync(empty, '  \n');
    expect(writeClientConfig(empty, 'total-recall', ENTRY).action).toBe('added'); // an empty file is a blank slate
  });
});

describe('selfTest', () => {
  const fake = (body: string): ((dir: string) => McpServerEntry) => {
    const script = path.join(root, `fake-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(script, body);
    return () => ({ command: process.execPath, args: [script] });
  };

  it('passes against the real server, leaves no probe in any archive, and cleans up its scratch volume', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('total-recall-selftest-')).length;
    const result = await selfTest(realEntry, { timeoutMs: 60_000 });
    expect(result.steps.map((s) => [s.name, s.ok])).toEqual([
      ['The server starts', true],
      ['Assistants receive the guardrail', true],
      ['The tools are available', true],
      ['A memory written is a memory read back', true],
      ['The hash chain verifies', true],
    ]);
    expect(result.ok).toBe(true);
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('total-recall-selftest-')).length).toBe(before);
  }, 90_000);

  it('reports a server that cannot be started', async () => {
    const result = await selfTest(() => ({ command: path.join(root, 'no-such-binary'), args: [] }), { timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ name: 'The server responds', ok: false });
    expect(result.steps[0]!.detail).toMatch(/ENOENT/);
  });

  it('reports a server that crashes, with its last words', async () => {
    const result = await selfTest(fake(`console.error('boom: cannot open volume'); process.exit(3);`), { timeoutMs: 5_000 });
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.detail).toMatch(/exited \(3\).*boom: cannot open volume/);
  });

  it('reports a server that never answers', async () => {
    const result = await selfTest(fake(`setInterval(() => {}, 1000);`), { timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.detail).toMatch(/no answer to initialize/);
  });

  it('flags a server that does not deliver the guardrail', async () => {
    const result = await selfTest(
      fake(`
        import readline from 'node:readline';
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (l) => {
          const m = JSON.parse(l);
          if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05' } }));
          else if (m.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }));
          else if (m.id) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }));
        });
      `),
      { timeoutMs: 5_000 },
    );
    expect(result.ok).toBe(false);
    const byName = Object.fromEntries(result.steps.map((s) => [s.name, s]));
    expect(byName['Assistants receive the guardrail']).toMatchObject({ ok: false, detail: 'the server sent no instructions' });
    expect(byName['The tools are available']!.ok).toBe(false);
  });
});

describe('applyPlan', () => {
  const noTest = { runSelfTest: false } as const;
  const events: string[] = [];
  const reporter: OnboardReporter = {
    start: (step, label) => void events.push(`start:${step}:${label}`),
    progress: (step, detail) => void events.push(`progress:${step}:${detail}`),
    done: (step, detail) => void events.push(`done:${step}:${detail}`),
    warn: (step, detail) => void events.push(`warn:${step}:${detail}`),
  };
  beforeEach(() => {
    events.length = 0;
  });

  const exportFile = (): string => {
    const file = path.join(root, 'export', 'conversations.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'c1',
          create_time: 1_700_000_000,
          mapping: {
            a: { id: 'a', message: { id: 'm1', author: { role: 'user' }, create_time: 1_700_000_001, content: { parts: ['hello'] } } },
            b: { id: 'b', message: { id: 'm2', author: { role: 'assistant' }, create_time: 1_700_000_002, content: { parts: ['hi there'] } } },
          },
        },
      ]),
    );
    return path.dirname(file);
  };

  it('does the whole thing: creates the archive, imports, connects, and is safe to run again', async () => {
    const plan = {
      volumeDir: path.join(root, 'vol'),
      transcript: 'append' as const,
      recordRecalls: false,
      chatgptExport: exportFile(),
      memoriesText: '- Likes pour-over coffee\n- Lives in Portland\n',
      connect: ['claude-code' as const],
      projectDir: path.join(root, 'proj'),
      ...noTest,
    };
    const deps = { scriptPath: '/opt/av/dist/cli/index.js', home: path.join(root, 'home') };
    const first = await applyPlan(plan, reporter, deps);

    expect(first.problems).toEqual([]);
    expect(first.volume).toMatchObject({ created: true, memoryEvents: 2 });
    expect(first.volume.policy).toMatchObject({ transcript: 'append' });
    expect(first.volume.policy.recordOps).toEqual(['created', 'updated', 'deleted']);
    expect(first.history.chatgpt).toEqual({ conversations: 1, messages: 2, skipped: 0, files: 1 });
    expect(first.history.memories).toEqual({ imported: 2, skipped: 0 });
    expect(first.connected).toHaveLength(1);
    expect(first.connected[0]).toMatchObject({ client: 'claude-code', action: 'created', path: path.join(root, 'proj', '.mcp.json') });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, 'proj', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, McpServerEntry> };
    expect(mcp.mcpServers['total-recall']!.args).toEqual(['/opt/av/dist/cli/index.js', 'mcp', 'serve', '--total-recall', path.join(root, 'vol')]);
    expect(events.filter((e) => e.startsWith('done:')).map((e) => e.split(':')[1])).toEqual(['archive', 'history', 'history', 'connect']);

    const volume = TotalRecallVolume.open(plan.volumeDir);
    expect(volume.readTranscript().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(volume.verify().valid).toBe(true);

    // Again: nothing doubles, nothing is rewritten, no backup appears
    const second = await applyPlan(plan, undefined, deps);
    expect(second.volume).toMatchObject({ created: false, memoryEvents: 2 });
    expect(second.history.chatgpt).toMatchObject({ messages: 0, skipped: 2 });
    expect(second.history.memories).toEqual({ imported: 0, skipped: 2 });
    expect(second.connected[0]).toMatchObject({ action: 'unchanged' });
    expect(fs.readdirSync(path.join(root, 'proj')).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('changes an existing archive only where the plan says to, and never what it holds', async () => {
    const dir = path.join(root, 'vol');
    const v = TotalRecallVolume.init(dir, { policy: { transcript: 'append', providers: ['chatgpt'] } });
    v.appendMemoryEvent({ op: 'created', source: { provider: 'chatgpt' }, memory: { key: 'k', content: 'kept' } });
    const before = fs.readFileSync(v.memoriesPath, 'utf8');

    const unchanged = await applyPlan({ volumeDir: dir, ...noTest });
    expect(unchanged.volume.policy).toMatchObject({ transcript: 'append', providers: ['chatgpt'] });

    const changed = await applyPlan({ volumeDir: dir, transcript: 'off', recordRecalls: false, ...noTest });
    expect(changed.volume.policy).toMatchObject({ transcript: 'off', providers: ['chatgpt'] });
    expect(changed.volume.policy.recordOps).not.toContain('recalled');
    expect(fs.readFileSync(v.memoriesPath, 'utf8')).toBe(before);

    const back = await applyPlan({ volumeDir: dir, recordRecalls: true, ...noTest });
    expect(back.volume.policy.recordOps).toEqual(['created', 'recalled', 'updated', 'deleted']);
  });

  it('carries on past a step that fails and says what went wrong', async () => {
    const broken = path.join(root, 'proj', '.mcp.json');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, '{ nope');
    const result = await applyPlan(
      {
        volumeDir: path.join(root, 'vol'),
        chatgptExport: path.join(root, 'missing-export'),
        memoriesText: '- one memory\n',
        connect: ['claude-code'],
        projectDir: path.join(root, 'proj'),
        ...noTest,
      },
      reporter,
      { scriptPath: '/opt/av/dist/cli/index.js' },
    );
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/ChatGPT export: Not found/);
    expect(result.problems[1]).toMatch(/Claude Code: .*not valid JSON/);
    expect(result.history.memories).toEqual({ imported: 1, skipped: 0 }); // the good step still ran
    expect(result.connected).toEqual([]);
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ nope');
    expect(events.filter((e) => e.startsWith('warn:')).map((e) => e.split(':')[1])).toEqual(['history', 'connect']);
  });

  it('runs the self-test when asked and reports its failures as problems', async () => {
    const failing = async () => ({ ok: false, ms: 12, steps: [{ name: 'The server starts', ok: false, detail: 'boom' }] });
    const result = await applyPlan({ volumeDir: path.join(root, 'vol') }, reporter, { selfTest: failing });
    expect(result.selfTest?.ok).toBe(false);
    expect(result.problems).toEqual(['Self-test: The server starts: boom']);
    expect(events.some((e) => e.startsWith('warn:test:'))).toBe(true);
  });

  it('streams progress for a large export and batches the append', async () => {
    const file = path.join(root, 'big', 'conversations.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conversations = Array.from({ length: 60 }, (_, c) => ({
      id: `c${c}`,
      create_time: 1_700_000_000 + c,
      mapping: Object.fromEntries(
        Array.from({ length: 20 }, (_, m) => [`n${m}`, { id: `n${m}`, message: { id: `c${c}-m${m}`, author: { role: m % 2 ? 'assistant' : 'user' }, create_time: 1_700_000_000 + c * 100 + m, content: { parts: [`message ${m} of ${c}`] } } }]),
      ),
    }));
    fs.writeFileSync(file, JSON.stringify(conversations));
    const result = await applyPlan({ volumeDir: path.join(root, 'vol'), chatgptExport: path.dirname(file), ...noTest }, reporter);
    expect(result.history.chatgpt).toMatchObject({ conversations: 60, messages: 1200 });
    expect(events.filter((e) => e.startsWith('progress:history:')).map((e) => e.split(': ')[1])).toEqual(['25 of 60', '50 of 60', '60 of 60']);
    const volume = TotalRecallVolume.open(path.join(root, 'vol'));
    expect(volume.readTranscript()).toHaveLength(1200);
    expect(volume.verify().valid).toBe(true);
  });
});

describe('words to carry between assistants', () => {
  it('asks ChatGPT for a verbatim list and tells Claude to pull the archive and keep recording', () => {
    expect(CHATGPT_MEMORY_EXPORT_PROMPT).toMatch(/exactly as stored/);
    expect(CLAUDE_INGEST_PROMPT).toMatch(/total_recall_pull/);
    expect(CLAUDE_INGEST_PROMPT).toMatch(/total_recall_record/);
    expect(CLAUDE_INGEST_PROMPT).toMatch(/since_seq 0/);
  });
});
