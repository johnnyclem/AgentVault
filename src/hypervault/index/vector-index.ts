/**
 * Vector index — cosine similarity over exported embeddings
 *
 * Pure-TS exact (brute force) nearest-neighbour search. This is fine for
 * typical accounts (well under ~20k vectors — plan risk #5); an optional
 * `hnswlib-node` accelerator can be layered on later without changing the
 * on-disk format. Vectors are stored packed as float32 (base64) with an
 * id/model sidecar, matching the snapshot's `embeddings.bin` layout.
 *
 * The recorded `model` guards against cross-model mixing (plan risk #1):
 * queries embedded with a different model are refused.
 */

export interface VectorHit {
  id: string;
  /** Cosine similarity in [-1, 1] */
  score: number;
}

interface SerializedVectorIndex {
  version: 1;
  dims: number;
  model?: string;
  ids: string[];
  /** base64-packed float32, row-major [ids.length x dims] */
  vectors: string;
}

export class VectorIndex {
  private ids: string[] = [];
  private vectors: Float32Array;
  private norms: number[] = [];

  constructor(
    public readonly dims: number,
    public readonly model?: string,
  ) {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`Vector index dims must be a positive integer (got ${dims})`);
    }
    this.vectors = new Float32Array(0);
  }

  get size(): number {
    return this.ids.length;
  }

  add(id: string, vector: number[]): void {
    if (vector.length !== this.dims) {
      throw new Error(`Vector for ${id} has ${vector.length} dims, index expects ${this.dims}`);
    }
    const next = new Float32Array((this.ids.length + 1) * this.dims);
    next.set(this.vectors);
    next.set(vector, this.ids.length * this.dims);
    this.vectors = next;
    this.ids.push(id);
    this.norms.push(norm(vector));
  }

  /**
   * Exact cosine-similarity search.
   * @param queryModel - model that produced the query embedding; refused if
   *                     it differs from the index's model (risk #1)
   */
  search(query: number[], limit = 10, queryModel?: string): VectorHit[] {
    if (queryModel && this.model && queryModel !== this.model) {
      throw new Error(
        `Embedding model mismatch: index was built with "${this.model}" but the query used "${queryModel}"`,
      );
    }
    if (query.length !== this.dims) {
      throw new Error(`Query has ${query.length} dims, index expects ${this.dims}`);
    }
    const queryNorm = norm(query);
    if (queryNorm === 0 || this.ids.length === 0) return [];

    const hits: VectorHit[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      let dot = 0;
      const offset = i * this.dims;
      for (let j = 0; j < this.dims; j++) {
        dot += this.vectors[offset + j]! * query[j]!;
      }
      const denominator = (this.norms[i] ?? 0) * queryNorm;
      hits.push({ id: this.ids[i]!, score: denominator === 0 ? 0 : dot / denominator });
    }
    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  toJSON(): SerializedVectorIndex {
    return {
      version: 1,
      dims: this.dims,
      model: this.model,
      ids: [...this.ids],
      vectors: Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength).toString('base64'),
    };
  }

  static fromJSON(data: SerializedVectorIndex): VectorIndex {
    const index = new VectorIndex(data.dims, data.model);
    const raw = Buffer.from(data.vectors, 'base64');
    index.vectors = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    index.ids = [...data.ids];
    index.norms = data.ids.map((_, i) => {
      let sum = 0;
      for (let j = 0; j < data.dims; j++) {
        sum += index.vectors[i * data.dims + j]! ** 2;
      }
      return Math.sqrt(sum);
    });
    return index;
  }
}

function norm(vector: number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}
