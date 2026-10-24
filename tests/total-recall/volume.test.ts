import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TotalRecallVolume } from '../../src/total-recall/volume.js';
import { memoryEventSchema, transcriptMessageSchema } from '../../src/total-recall/format.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const gpt = { provider: 'chatgpt', agent: 'gpt-5' };

describe('TotalRecallVolume lifecycle', () => {
  it('init creates the manifest and refuses to init twice', () => {
    const dir = path.join(root, 'vol');
    const v = TotalRecallVolume.init(dir, { volumeId: 'tr_test' });
    expect(v.volumeId).toBe('tr_test');
    expect(fs.existsSync(path.join(dir, 'volume.json'))).toBe(true);
    expect(() => TotalRecallVolume.init(dir)).toThrow(/already exists/);
    expect(TotalRecallVolume.open(dir).volumeId).toBe('tr_test');
    expect(() => TotalRecallVolume.open(path.join(root, 'nope'))).toThrow(/No total-recall volume/);
  });

  it('setPolicy rewrites only the manifest', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    const before = fs.readFileSync(v.memoriesPath, 'utf8');
    v.setPolicy({ transcript: 'append', providers: ['chatgpt'] });
    expect(TotalRecallVolume.open(v.dir).policy.transcript).toBe('append');
    expect(fs.readFileSync(v.memoriesPath, 'utf8')).toBe(before);
  });
});

describe('memory events', () => {
  it('appends a hash-chained line per event and folds them into current memories', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const e1 = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'coffee', content: 'Likes pour-over', tags: ['pref'] } });
    const e2 = v.appendMemoryEvent({ op: 'recalled', source: { ...gpt, session: 'conv-1' }, memory: { key: 'coffee', content: 'Likes pour-over' } });
    const e3 = v.appendMemoryEvent({ op: 'updated', source: gpt, memory: { key: 'coffee', content: 'Likes pour-over, no sugar' } });
    const e4 = v.appendMemoryEvent({ op: 'created', source: { provider: 'claude' }, memory: { key: 'tea', content: 'Green tea at 80C' } });

    expect([e1.seq, e2.seq, e3.seq, e4.seq]).toEqual([1, 2, 3, 4]);
    expect(e1.prevHash).toBeNull();
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(v.memoriesSeq()).toBe(4);

    const lines = fs.readFileSync(v.memoriesPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(() => memoryEventSchema.parse(JSON.parse(lines[0]!))).not.toThrow();

    const folded = v.foldMemories();
    expect(folded).toHaveLength(2);
    const coffee = folded.find((m) => m.key === 'coffee')!;
    expect(coffee.content).toBe('Likes pour-over, no sugar');
    expect(coffee.versions).toBe(2);
    expect(coffee.recalls).toBe(1);
    expect(coffee.lastChangeSeq).toBe(3);
    expect(coffee.agents).toEqual(['gpt-5']);
    expect(v.foldMemories({ provider: 'claude' }).map((m) => m.key)).toEqual(['tea']);
  });

  it('keeps every version readable after an update and a delete', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'v1' } });
    v.appendMemoryEvent({ op: 'updated', source: gpt, memory: { key: 'k', content: 'v2' } });
    v.appendMemoryEvent({ op: 'deleted', source: gpt, memory: { key: 'k', content: 'v2' } });
    expect(v.foldMemories()).toHaveLength(0);
    const deleted = v.foldMemories({ includeDeleted: true });
    expect(deleted[0]?.deleted).toBe(true);
    expect(v.memoryHistory('chatgpt', 'k').map((e) => [e.op, e.memory.content])).toEqual([
      ['created', 'v1'],
      ['updated', 'v2'],
      ['deleted', 'v2'],
    ]);
  });

  it('reads after a cursor with filters and limits', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    for (let i = 0; i < 5; i++) {
      v.appendMemoryEvent({ op: i % 2 ? 'recalled' : 'created', source: gpt, memory: { key: `k${i}`, content: `c${i}` } });
    }
    expect(v.readMemoryEvents({ sinceSeq: 3 }).map((e) => e.seq)).toEqual([4, 5]);
    expect(v.readMemoryEvents({ ops: ['created'] }).map((e) => e.seq)).toEqual([1, 3, 5]);
    expect(v.readMemoryEvents({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('searches current memories lexically', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'a', title: 'Coffee', content: 'Pour-over with a gooseneck kettle' } });
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'b', title: 'Tea', content: 'Steeps at 80 degrees' } });
    const hits = v.searchMemories('coffee');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.memory.key).toBe('a');
  });

  it('validates inputs', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    expect(() => v.appendMemoryEvent({ op: 'created', source: { provider: '' }, memory: { key: 'k', content: 'c' } })).toThrow();
    expect(() => v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: '', content: 'c' } })).toThrow();
  });
});

describe('transcript', () => {
  it('writes stenographer-compatible, chained lines', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'), { policy: { transcript: 'append' } });
    const m1 = v.appendTranscript({ role: 'user', content: 'hello', sessionId: 's1', provider: 'chatgpt' });
    const m2 = v.appendTranscript({ role: 'assistant', content: 'hi', sessionId: 's1', provider: 'chatgpt', model: 'gpt-5' });
    expect(m2.prevHash).toBe(m1.hash);
    const lines = fs.readFileSync(v.transcriptPath, 'utf8').trimEnd().split('\n');
    const parsed = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(() => transcriptMessageSchema.parse(parsed)).not.toThrow();
    // The shape stenographer's jsonl adapter needs: id, role, content, timestamp.
    expect(parsed).toMatchObject({ id: m2.id, role: 'assistant', content: 'hi', sessionId: 's1', model: 'gpt-5' });
    expect(typeof parsed.timestamp).toBe('string');
    expect(v.readTranscript({ sessionId: 's1' })).toHaveLength(2);
    expect(v.readTranscript({ sinceSeq: 1 }).map((m) => m.seq)).toEqual([2]);
  });
});

describe('transcript batches', () => {
  it('appends many messages under one lock as one verified chain, and writes nothing if one is invalid', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendTranscript({ role: 'user', content: 'first', sessionId: 's', provider: 'chatgpt', id: 'm0' });
    const batch = v.appendTranscriptBatch(
      Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i + 1}`, sessionId: 's', provider: 'chatgpt', id: `m${i + 1}` })),
    );
    expect(batch.map((m) => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
    expect(batch[0]!.prevHash).toBe(v.readTranscript({ limit: 1 })[0]!.hash);
    expect(v.verify().valid).toBe(true);
    expect(v.appendTranscriptBatch([])).toEqual([]);

    const before = fs.readFileSync(v.transcriptPath, 'utf8');
    expect(() =>
      v.appendTranscriptBatch([
        { role: 'user', content: 'fine', sessionId: 's', provider: 'chatgpt' },
        { role: 'user', content: 'bad', sessionId: '', provider: 'chatgpt' },
      ]),
    ).toThrow();
    expect(fs.readFileSync(v.transcriptPath, 'utf8')).toBe(before);
    expect(v.verify().valid).toBe(true);
  });

  it('lists transcript ids without validating, and skips a damaged line', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    expect(v.transcriptIds().size).toBe(0);
    v.appendTranscriptBatch([
      { role: 'user', content: 'a', sessionId: 's', provider: 'chatgpt', id: 'x1' },
      { role: 'user', content: 'b', sessionId: 's', provider: 'chatgpt', id: 'x2' },
    ]);
    fs.appendFileSync(v.transcriptPath, 'not json\n');
    expect([...v.transcriptIds()].sort()).toEqual(['x1', 'x2']);
  });
});

describe('integrity', () => {
  it('verifies clean chains and anchors', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    v.appendTranscript({ role: 'user', content: 'x', sessionId: 's', provider: 'chatgpt' });
    const anchor = v.anchor('local');
    expect(anchor.memoriesSeq).toBe(1);
    expect(anchor.transcriptSeq).toBe(1);
    const result = v.verify();
    expect(result.valid).toBe(true);
    expect(result.memories.head).toBe(anchor.memoriesHead);
    expect(v.lastAnchor()?.ts).toBe(anchor.ts);
  });

  it('detects a rewritten memory, a removed line, and a truncation past the anchor', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'truth' } });
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k2', content: 'more' } });
    v.anchor('local');
    const original = fs.readFileSync(v.memoriesPath, 'utf8');

    fs.writeFileSync(v.memoriesPath, original.replace('"content":"truth"', '"content":"lie"'));
    let result = v.verify();
    expect(result.valid).toBe(false);
    expect(result.memories.errors.join('\n')).toMatch(/line 1: hash mismatch/);

    const lines = original.trimEnd().split('\n');
    fs.writeFileSync(v.memoriesPath, lines[0] + '\n');
    result = v.verify();
    expect(result.memories.valid).toBe(true); // the remaining prefix is a valid chain...
    expect(result.anchor.consistent).toBe(false); // ...but shorter than what was anchored
    expect(result.anchor.errors.join('\n')).toMatch(/lines removed/);
  });

  it('refuses to extend a chain whose last line is broken', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    fs.appendFileSync(v.memoriesPath, 'garbage\n');
    expect(() => v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k2', content: 'c' } })).toThrow(/broken chain/);
  });

  it('truncates a torn tail (interrupted write) and continues the chain from the last record', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const e1 = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    fs.appendFileSync(v.memoriesPath, '{"seq":2,"half'); // no newline: never a record
    expect(v.status().tornTail.memories).toBe(true);
    const e2 = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k2', content: 'c' } });
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(v.verify().valid).toBe(true);
  });

  it('handles a last line longer than the tail window', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'));
    const big = 'x'.repeat(200 * 1024);
    const e1 = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'big', content: big } });
    const e2 = v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'small', content: 'y' } });
    expect(e2.prevHash).toBe(e1.hash);
    expect(v.verify().valid).toBe(true);
  });

  it('status summarizes the volume', () => {
    const v = TotalRecallVolume.init(path.join(root, 'vol'), { policy: { transcript: 'append' } });
    v.appendMemoryEvent({ op: 'created', source: gpt, memory: { key: 'k', content: 'c' } });
    v.appendMemoryEvent({ op: 'created', source: { provider: 'claude' }, memory: { key: 'k', content: 'c' } });
    v.appendTranscript({ role: 'user', content: 'x', sessionId: 's', provider: 'chatgpt' });
    const s = v.status();
    expect(s.memories.events).toBe(2);
    expect(s.memories.current).toBe(2);
    expect(s.memories.providers).toEqual({ chatgpt: 1, claude: 1 });
    expect(s.transcript.messages).toBe(1);
    expect(s.transcript.sessions).toBe(1);
    expect(s.lastAnchor).toBeNull();
  });
});

describe('concurrent writers', () => {
  it('two handles on one volume extend a single chain', () => {
    const dir = path.join(root, 'vol');
    const a = TotalRecallVolume.init(dir);
    const b = TotalRecallVolume.open(dir);
    for (let i = 0; i < 10; i++) {
      (i % 2 ? a : b).appendMemoryEvent({ op: 'created', source: gpt, memory: { key: `k${i}`, content: 'c' } });
    }
    expect(a.verify().valid).toBe(true);
    expect(a.memoriesSeq()).toBe(10);
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
  });
});
