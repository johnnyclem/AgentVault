/**
 * Hybrid recall — lexical + semantic fusion over local indices
 *
 * Ports the shape of hypervault's `hybridRecallMemories` fusion: both
 * retrieval paths run independently and are merged with reciprocal-rank
 * fusion (RRF). Falls back gracefully to FTS-only when no embedding
 * provider or vector index is available — the same degradation hypervault
 * itself applies.
 */

import type { HvMemory, HvRecallResult } from '../types.js';
import type { FtsIndex } from './fts-index.js';
import type { VectorIndex } from './vector-index.js';

/** Embeds a query string; typically backed by an OpenAI-compatible endpoint */
export type QueryEmbedder = (query: string) => Promise<{ embedding: number[]; model?: string }>;

export interface HybridRecallOptions {
  limit?: number;
  /** Optional semantic path — omitted → FTS-only */
  embedQuery?: QueryEmbedder;
  /** RRF constant (default 60) */
  rrfK?: number;
}

export async function hybridRecall(
  query: string,
  indices: { fts: FtsIndex | null; vectors: VectorIndex | null },
  memoriesById: Map<string, HvMemory>,
  options: HybridRecallOptions = {},
): Promise<HvRecallResult[]> {
  const limit = options.limit ?? 10;
  const rrfK = options.rrfK ?? 60;
  const candidateCount = Math.max(limit * 3, 30);

  const lexical = indices.fts ? indices.fts.search(query, candidateCount) : [];

  let semantic: Array<{ id: string; score: number }> = [];
  if (indices.vectors && options.embedQuery) {
    try {
      const { embedding, model } = await options.embedQuery(query);
      semantic = indices.vectors.search(embedding, candidateCount, model);
    } catch {
      // Provider unavailable or model mismatch — degrade to lexical-only.
      semantic = [];
    }
  }

  const fused = new Map<string, { score: number; matchedBy: Set<'lexical' | 'semantic'> }>();
  const fuse = (hits: Array<{ id: string }>, kind: 'lexical' | 'semantic'): void => {
    hits.forEach((hit, rank) => {
      const entry = fused.get(hit.id) ?? { score: 0, matchedBy: new Set<'lexical' | 'semantic'>() };
      entry.score += 1 / (rrfK + rank + 1);
      entry.matchedBy.add(kind);
      fused.set(hit.id, entry);
    });
  };
  fuse(lexical, 'lexical');
  fuse(semantic, 'semantic');

  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .flatMap(([id, entry]) => {
      const memory = memoriesById.get(id);
      if (!memory) return [];
      return [{ memory, score: entry.score, matchedBy: [...entry.matchedBy] }];
    })
    .slice(0, limit);
}
