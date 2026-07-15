/**
 * Index builder — derives local FTS + vector indices from a snapshot
 *
 * Indices live under `.agentvault/index/` and are always rebuildable from
 * the snapshot, so they are never part of an archived bundle's integrity
 * surface (they're `derived` artifacts — §5.5).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../utils/path-validation.js';
import { hvMemorySchema, type HvMemory } from '../types.js';
import { readEmbeddings, snapshotEmbeddingModel, readSnapshotEntry, type HypervaultSnapshot } from '../snapshot.js';
import { FtsIndex } from './fts-index.js';
import { VectorIndex } from './vector-index.js';

export const INDEX_DIR_NAME = 'index';
export const FTS_INDEX_FILENAME = 'fts.json';
export const VECTOR_INDEX_FILENAME = 'vectors.json';

export interface BuiltIndices {
  fts: FtsIndex;
  vectors: VectorIndex | null;
  memoriesIndexed: number;
  vectorsIndexed: number;
}

export function indexDir(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, '.agentvault', INDEX_DIR_NAME);
}

/** Build indices from in-memory rows. */
export function buildIndices(
  memories: HvMemory[],
  embeddingsById: Map<string, number[]> = new Map(),
  embeddingModel?: string,
): BuiltIndices {
  const fts = new FtsIndex();
  for (const memory of memories) {
    fts.add({
      id: memory.id,
      title: memory.title,
      tags: memory.tags,
      summary: memory.summary,
      content: memory.content,
    });
  }

  let vectors: VectorIndex | null = null;
  let vectorsIndexed = 0;
  for (const [id, embedding] of embeddingsById) {
    if (!vectors) {
      vectors = new VectorIndex(embedding.length, embeddingModel);
    }
    if (embedding.length !== vectors.dims) continue; // refuse mixed dims
    vectors.add(id, embedding);
    vectorsIndexed += 1;
  }

  return { fts, vectors, memoriesIndexed: memories.length, vectorsIndexed };
}

/** Build indices straight from a snapshot bundle. */
export async function buildIndicesFromSnapshot(
  snapshot: HypervaultSnapshot,
  passphrase?: string,
): Promise<BuiltIndices> {
  const memories = await snapshotMemories(snapshot, passphrase);
  const embeddings = await readEmbeddings(snapshot, passphrase);
  const model = await snapshotEmbeddingModel(snapshot, passphrase);
  return buildIndices(memories, embeddings, model);
}

/** Parse the memories entry of a snapshot into typed rows. */
export async function snapshotMemories(
  snapshot: HypervaultSnapshot,
  passphrase?: string,
): Promise<HvMemory[]> {
  if (!('memories.ndjson' in snapshot.entries)) return [];
  const text = (await readSnapshotEntry(snapshot, 'memories.ndjson', passphrase)).toString('utf-8');
  const memories: HvMemory[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = hvMemorySchema.safeParse(JSON.parse(line));
    if (parsed.success) memories.push(parsed.data);
  }
  return memories;
}

/** Persist built indices under `.agentvault/index/`. */
export function saveIndices(indices: BuiltIndices, projectRoot: string = process.cwd()): string {
  const dir = indexDir(projectRoot);
  atomicWriteFileSync(path.join(dir, FTS_INDEX_FILENAME), JSON.stringify(indices.fts.toJSON()), {
    encoding: 'utf8',
  });
  if (indices.vectors) {
    atomicWriteFileSync(path.join(dir, VECTOR_INDEX_FILENAME), JSON.stringify(indices.vectors.toJSON()), {
      encoding: 'utf8',
    });
  }
  return dir;
}

/** Load previously built indices (nulls when absent). */
export function loadIndices(projectRoot: string = process.cwd()): {
  fts: FtsIndex | null;
  vectors: VectorIndex | null;
} {
  const dir = indexDir(projectRoot);
  let fts: FtsIndex | null = null;
  let vectors: VectorIndex | null = null;

  const ftsPath = path.join(dir, FTS_INDEX_FILENAME);
  if (fs.existsSync(ftsPath)) {
    fts = FtsIndex.fromJSON(JSON.parse(fs.readFileSync(ftsPath, 'utf-8')));
  }
  const vectorPath = path.join(dir, VECTOR_INDEX_FILENAME);
  if (fs.existsSync(vectorPath)) {
    vectors = VectorIndex.fromJSON(JSON.parse(fs.readFileSync(vectorPath, 'utf-8')));
  }
  return { fts, vectors };
}
