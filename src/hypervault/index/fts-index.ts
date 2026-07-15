/**
 * Full-text index — pure-TS inverted index with weighted fields
 *
 * Mirrors the field weighting of hypervault's generated tsvector
 * (A = title, B = tags/summary, C = content) so offline recall ranks
 * comparably to the cloud index. Scoring is TF-IDF with length
 * normalization (BM25-lite). No native dependencies.
 */

export interface FtsDocInput {
  id: string;
  title?: string;
  tags?: string[];
  summary?: string;
  content?: string;
}

export interface FtsHit {
  id: string;
  score: number;
}

/** tsvector-style weights: A/B/C */
const FIELD_WEIGHTS = {
  title: 1.0,
  tags: 0.4,
  summary: 0.4,
  content: 0.2,
} as const;

interface SerializedFtsIndex {
  version: 1;
  docCount: number;
  docLengths: Record<string, number>;
  /** term -> { docId -> weighted term frequency } */
  postings: Record<string, Record<string, number>>;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

export class FtsIndex {
  private postings = new Map<string, Map<string, number>>();
  private docLengths = new Map<string, number>();

  get size(): number {
    return this.docLengths.size;
  }

  add(doc: FtsDocInput): void {
    if (this.docLengths.has(doc.id)) {
      this.remove(doc.id);
    }
    let length = 0;
    const addTokens = (text: string | undefined, weight: number): void => {
      for (const token of tokenize(text ?? '')) {
        const docs = this.postings.get(token) ?? new Map<string, number>();
        docs.set(doc.id, (docs.get(doc.id) ?? 0) + weight);
        this.postings.set(token, docs);
        length += 1;
      }
    };
    addTokens(doc.title, FIELD_WEIGHTS.title);
    addTokens((doc.tags ?? []).join(' '), FIELD_WEIGHTS.tags);
    addTokens(doc.summary, FIELD_WEIGHTS.summary);
    addTokens(doc.content, FIELD_WEIGHTS.content);
    this.docLengths.set(doc.id, Math.max(length, 1));
  }

  remove(id: string): void {
    if (!this.docLengths.delete(id)) return;
    for (const [term, docs] of this.postings) {
      docs.delete(id);
      if (docs.size === 0) this.postings.delete(term);
    }
  }

  search(query: string, limit = 10): FtsHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docLengths.size === 0) return [];

    const scores = new Map<string, number>();
    const totalDocs = this.docLengths.size;
    for (const term of terms) {
      const docs = this.postings.get(term);
      if (!docs) continue;
      const idf = Math.log(1 + (totalDocs - docs.size + 0.5) / (docs.size + 0.5));
      for (const [docId, weightedTf] of docs) {
        const docLength = this.docLengths.get(docId) ?? 1;
        const norm = weightedTf / (weightedTf + 1 + docLength / 500);
        scores.set(docId, (scores.get(docId) ?? 0) + idf * norm);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  toJSON(): SerializedFtsIndex {
    const postings: Record<string, Record<string, number>> = {};
    for (const [term, docs] of this.postings) {
      postings[term] = Object.fromEntries(docs);
    }
    return {
      version: 1,
      docCount: this.docLengths.size,
      docLengths: Object.fromEntries(this.docLengths),
      postings,
    };
  }

  static fromJSON(data: SerializedFtsIndex): FtsIndex {
    const index = new FtsIndex();
    for (const [docId, length] of Object.entries(data.docLengths)) {
      index.docLengths.set(docId, length);
    }
    for (const [term, docs] of Object.entries(data.postings)) {
      index.postings.set(term, new Map(Object.entries(docs)));
    }
    return index;
  }
}
