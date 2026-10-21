import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TotalRecallVolume } from '../../src/total-recall/volume.js';
import {
  chatGptConversationMessages,
  importChatGptConversations,
  importMemoryList,
  parseMemoryList,
} from '../../src/total-recall/import-chatgpt.js';
import { eventPayload, isLoopbackUrl, notifyEvent } from '../../src/total-recall/notify.js';
import { readWatchCursor, watchVolume } from '../../src/total-recall/watch.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-import-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const gpt = { provider: 'chatgpt' };

const conversation = {
  id: 'conv-1',
  title: 'Coffee',
  create_time: 1_700_000_000,
  mapping: {
    root: { id: 'root', message: null, children: ['n1'] },
    n1: {
      id: 'n1',
      message: { id: 'm1', author: { role: 'system' }, create_time: null, content: { content_type: 'text', parts: [''] }, metadata: {} },
    },
    n2: {
      id: 'n2',
      message: { id: 'm2', author: { role: 'user' }, create_time: 1_700_000_001, content: { content_type: 'text', parts: ['How do I brew pour-over?'] } },
    },
    n3: {
      id: 'n3',
      message: {
        id: 'm3',
        author: { role: 'assistant' },
        create_time: 1_700_000_005,
        content: { content_type: 'text', parts: ['Use a gooseneck kettle.', { text: 'Bloom first.' }] },
        metadata: { model_slug: 'gpt-4o' },
      },
    },
    hidden: {
      id: 'hidden',
      message: { id: 'm4', author: { role: 'user' }, create_time: 1_700_000_002, content: { parts: ['secret'] }, metadata: { is_visually_hidden_from_conversation: true } },
    },
  },
};

describe('ChatGPT export import', () => {
  it('maps a conversation to ordered transcript inputs, dropping empty and hidden nodes', () => {
    const messages = chatGptConversationMessages(conversation as never);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'How do I brew pour-over?'],
      ['assistant', 'Use a gooseneck kettle.\nBloom first.'],
    ]);
    expect(messages[1]).toMatchObject({ id: 'chatgpt_m3', sessionId: 'conv-1', provider: 'chatgpt', model: 'gpt-4o' });
    expect(messages[0]!.timestamp).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it('imports conversations.json idempotently', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const file = path.join(root, 'conversations.json');
    fs.writeFileSync(file, JSON.stringify([conversation]));
    expect(importChatGptConversations(v, file)).toEqual({ conversations: 1, messages: 2, skipped: 0 });
    expect(importChatGptConversations(v, file)).toEqual({ conversations: 1, messages: 0, skipped: 2 });
    expect(v.readTranscript({ sessionId: 'conv-1' })).toHaveLength(2);
    expect(v.verify().valid).toBe(true);
    fs.writeFileSync(file, '{"not":"an array"}');
    expect(() => importChatGptConversations(v, file)).toThrow(/expected a JSON array/);
  });

  it('imports a pasted memory list as created events, once', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const text = '- Likes pour-over coffee\n2. Lives in Portland\n\nPrefers dark mode\n';
    expect(parseMemoryList(text)).toEqual(['Likes pour-over coffee', 'Lives in Portland', 'Prefers dark mode']);
    expect(importMemoryList(v, text, { provider: 'chatgpt' })).toEqual({ imported: 3, skipped: 0 });
    expect(importMemoryList(v, text, { provider: 'chatgpt' })).toEqual({ imported: 0, skipped: 3 });
    expect(v.foldMemories()).toHaveLength(3);
    expect(v.foldMemories()[0]?.tags).toEqual(['imported']);
  });
});

describe('notify', () => {
  it('posts to loopback webhooks and refuses remote ones without allowRemote', async () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'), { volumeId: 'tr_n' });
    const event = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const results = await notifyEvent(
      {
        webhooks: [
          { url: 'http://127.0.0.1:9/hook', allowRemote: false, bearerToken: 't0k' },
          { url: 'https://example.com/hook', allowRemote: false },
        ],
      },
      event,
      { fetchImpl, volumeId: 'tr_n' },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]!.error).toMatch(/non-loopback/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe('Bearer t0k');
    expect(calls[0]!.body).toEqual(eventPayload(event, 'tr_n'));
    expect(isLoopbackUrl('http://localhost:1/x')).toBe(true);
    expect(isLoopbackUrl('http://10.0.0.1/x')).toBe(false);
  });

  it('runs a hook command with the event on stdin', async () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const event = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'hook me' } });
    const out = path.join(root, 'hook.out');
    const script = path.join(root, 'hook.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs'; let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(out)}, d); process.exit(0);});`,
    );
    const results = await notifyEvent({ webhooks: [], hookCommand: [process.execPath, script] }, event, { timeoutMs: 10_000 });
    expect(results[0]!.ok).toBe(true);
    expect((JSON.parse(fs.readFileSync(out, 'utf8')) as { event: { memory: { content: string } } }).event.memory.content).toBe('hook me');

    const failing = await notifyEvent({ webhooks: [], hookCommand: [process.execPath, '-e', 'process.exit(3)'] }, event, { timeoutMs: 10_000 });
    expect(failing[0]!.ok).toBe(false);
    expect(failing[0]!.error).toMatch(/exit 3/);
  });
});

describe('watch', () => {
  it('delivers new events past the cursor and persists it', async () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'old', content: 'before the watcher' } });
    const seen: number[] = [];
    const watcher = watchVolume(v, (e) => void seen.push(e.seq), { pollMs: 50 });
    await watcher.poke();
    expect(seen).toEqual([1]);
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'new', content: 'after' } });
    await watcher.poke();
    expect(seen).toEqual([1, 2]);
    await watcher.close();
    expect(readWatchCursor(v)).toBe(2);

    // A second watcher resumes where the first stopped.
    const later: number[] = [];
    const resumed = watchVolume(v, (e) => void later.push(e.seq), { pollMs: 50 });
    await resumed.poke();
    expect(later).toEqual([]);
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k3', content: 'x' } });
    await resumed.poke();
    expect(later).toEqual([3]);
    await resumed.close();
  });

  it('named cursors are independent and a bad handler does not advance the cursor', async () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'x' } });
    const w = watchVolume(v, () => { throw new Error('boom'); }, { pollMs: 50, cursorName: 'claude' });
    await expect(w.poke()).rejects.toThrow('boom');
    await w.close();
    expect(readWatchCursor(v, 'claude')).toBe(0);
    expect(readWatchCursor(v)).toBe(0);
  });
});
