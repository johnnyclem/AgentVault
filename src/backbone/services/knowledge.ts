/**
 * Knowledge Base Service
 *
 * Company-scoped shared knowledge base with status lifecycle:
 *   draft → proposed → ratified → archived
 *
 * Default implementation uses an in-memory store; consumers can inject
 * a database-backed adapter by implementing KnowledgeStore.
 */

import { randomUUID } from 'node:crypto';
import type {
  KnowledgeEntry,
  CreateKnowledgeEntryInput,
  UpdateKnowledgeEntryInput,
} from '../types.js';
import type { KnowledgeStatus, KnowledgeCategory } from '../constants.js';

export interface KnowledgeListFilters {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  search?: string;
}

/** Storage adapter interface for knowledge entries */
export interface KnowledgeStore {
  list(companyId: string, filters?: KnowledgeListFilters): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry | null>;
  create(entry: KnowledgeEntry): Promise<KnowledgeEntry>;
  update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | null>;
  delete(id: string): Promise<boolean>;
}

/** In-memory implementation of KnowledgeStore */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private entries = new Map<string, KnowledgeEntry>();

  async list(companyId: string, filters?: KnowledgeListFilters): Promise<KnowledgeEntry[]> {
    const results: KnowledgeEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.companyId !== companyId) continue;
      if (filters?.category && entry.category !== filters.category) continue;
      if (filters?.status && entry.status !== filters.status) continue;
      if (filters?.search) {
        const term = filters.search.toLowerCase();
        if (
          !entry.title.toLowerCase().includes(term) &&
          !entry.content.toLowerCase().includes(term)
        ) {
          continue;
        }
      }
      results.push(entry);
    }
    return results;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async create(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  async update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...partial, updatedAt: new Date().toISOString() };
    this.entries.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
}

export class KnowledgeService {
  constructor(private store: KnowledgeStore = new InMemoryKnowledgeStore()) {}

  async listKnowledge(
    companyId: string,
    filters?: KnowledgeListFilters,
  ): Promise<KnowledgeEntry[]> {
    return this.store.list(companyId, filters);
  }

  async getKnowledge(id: string): Promise<KnowledgeEntry | null> {
    return this.store.get(id);
  }

  async createKnowledge(
    companyId: string,
    createdBy: string,
    input: CreateKnowledgeEntryInput,
  ): Promise<KnowledgeEntry> {
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = {
      id: randomUUID(),
      companyId,
      title: input.title,
      content: input.content,
      category: input.category,
      status: input.status ?? 'draft',
      version: 1,
      createdBy,
      tags: input.tags,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.create(entry);
  }

  async updateKnowledge(
    id: string,
    updatedBy: string,
    input: UpdateKnowledgeEntryInput,
  ): Promise<KnowledgeEntry | null> {
    const existing = await this.store.get(id);
    if (!existing) return null;

    return this.store.update(id, {
      ...input,
      updatedBy,
      version: existing.version + 1,
    });
  }

  async deleteKnowledge(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async ratifyKnowledge(id: string): Promise<KnowledgeEntry | null> {
    return this.store.update(id, { status: 'ratified' });
  }
}
