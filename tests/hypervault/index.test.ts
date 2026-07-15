import { describe, it, expect } from 'vitest';
import { FtsIndex } from '../../src/hypervault/index/fts-index.js';
import { VectorIndex } from '../../src/hypervault/index/vector-index.js';
import { buildIndices } from '../../src/hypervault/index/builder.js';
import { hybridRecall } from '../../src/hypervault/index/recall.js';
import type { HvMemory } from '../../src/hypervault/types.js';

const MEMORIES: HvMemory[] = [
  { id: 'a', title: 'Coffee brewing', content: 'Pour over method with a gooseneck kettle', tags: ['coffee'] },
  { id: 'b', title: 'Tea steeping', content: 'Green tea steeps best at 80 degrees', tags: ['tea'] },
  { id: 'c', title: 'Espresso', content: 'A concentrated coffee shot under pressure', tags: ['coffee'] },
];

describe('FtsIndex', () => {
  it('ranks title matches above content matches', () => {
    const index = new FtsIndex();
    for (const m of MEMORIES) index.add({ id: m.id, title: m.title, tags: m.tags, content: m.content });
    const hits = index.search('coffee');
    expect(hits[0]?.id).toBe('a'); // title match beats content-only match 'c'
    expect(hits.map((h) => h.id)).toContain('c');
  });

  it('serializes and restores deterministically', () => {
    const index = new FtsIndex();
    for (const m of MEMORIES) index.add({ id: m.id, title: m.title, content: m.content });
    const restored = FtsIndex.fromJSON(index.toJSON());
    expect(restored.search('espresso')).toEqual(index.search('espresso'));
  });
});

describe('VectorIndex', () => {
  it('finds the nearest vector by cosine similarity', () => {
    const index = new VectorIndex(3, 'test-model');
    index.add('x', [1, 0, 0]);
    index.add('y', [0, 1, 0]);
    index.add('z', [0.9, 0.1, 0]);
    const hits = index.search([1, 0, 0], 2, 'test-model');
    expect(hits[0]?.id).toBe('x');
    expect(hits[1]?.id).toBe('z');
  });

  it('refuses cross-model queries', () => {
    const index = new VectorIndex(3, 'model-a');
    index.add('x', [1, 0, 0]);
    expect(() => index.search([1, 0, 0], 1, 'model-b')).toThrow(/model mismatch/i);
  });

  it('round-trips through JSON', () => {
    const index = new VectorIndex(2, 'm');
    index.add('p', [3, 4]);
    const restored = VectorIndex.fromJSON(index.toJSON());
    const hits = restored.search([3, 4], 1);
    expect(hits[0]?.id).toBe('p');
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });
});

describe('hybridRecall', () => {
  it('falls back to FTS-only when no embedder is available', async () => {
    const built = buildIndices(MEMORIES);
    const byId = new Map(MEMORIES.map((m) => [m.id, m]));
    const results = await hybridRecall('coffee', built, byId, { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.matchedBy.includes('lexical'))).toBe(true);
  });

  it('fuses lexical and semantic hits when an embedder is present', async () => {
    const embeddingsById = new Map<string, number[]>([
      ['a', [1, 0, 0]],
      ['b', [0, 1, 0]],
      ['c', [0.8, 0.2, 0]],
    ]);
    const built = buildIndices(MEMORIES, embeddingsById, 'test-model');
    const byId = new Map(MEMORIES.map((m) => [m.id, m]));
    const results = await hybridRecall('coffee', built, byId, {
      limit: 3,
      embedQuery: async () => ({ embedding: [1, 0, 0], model: 'test-model' }),
    });
    const topMatch = results.find((r) => r.matchedBy.includes('semantic'));
    expect(topMatch).toBeDefined();
  });
});
