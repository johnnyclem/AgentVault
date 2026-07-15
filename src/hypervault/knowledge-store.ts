/**
 * HyperVaultKnowledgeStore — backbone KnowledgeStore backed by the cloud mind
 *
 * `KnowledgeEntry` lifecycle (draft → proposed → ratified → archived) maps to
 * memories tagged `knowledge:<status>`. The full entry is serialized into
 * the memory content so nothing is lost in the round trip; versions are
 * backed upstream by `memory_history` (every edit is a mind commit).
 */

import type { KnowledgeEntry } from '../backbone/types.js';
import type { KnowledgeListFilters, KnowledgeStore } from '../backbone/services/knowledge.js';
import type { HyperVaultClient } from './client.js';
import type { HvMemory } from './types.js';

const TAG_PREFIX = 'av';

function companyTag(companyId: string): string {
  return `${TAG_PREFIX}:company:${companyId}`;
}
function idTag(id: string): string {
  return `${TAG_PREFIX}:kid:${id}`;
}
function statusTag(status: string): string {
  return `knowledge:${status}`;
}
function categoryTag(category: string): string {
  return `${TAG_PREFIX}:kcat:${category}`;
}

export class HyperVaultKnowledgeStore implements KnowledgeStore {
  constructor(private readonly client: HyperVaultClient) {}

  async list(companyId: string, filters?: KnowledgeListFilters): Promise<KnowledgeEntry[]> {
    const tags = [companyTag(companyId), `${TAG_PREFIX}:kind:knowledge`];
    if (filters?.status) tags.push(statusTag(filters.status));
    if (filters?.category) tags.push(categoryTag(filters.category));

    const memories = await this.client.listMemories({ tags });
    let entries = memories
      .map((m) => parseEntry(m))
      .filter((e): e is KnowledgeEntry => e !== null && e.companyId === companyId);

    if (filters?.status) entries = entries.filter((e) => e.status === filters.status);
    if (filters?.category) entries = entries.filter((e) => e.category === filters.category);
    if (filters?.search) {
      const needle = filters.search.toLowerCase();
      entries = entries.filter(
        (e) => e.title.toLowerCase().includes(needle) || e.content.toLowerCase().includes(needle),
      );
    }
    return entries;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const memories = await this.client.listMemories({ tags: [idTag(id)] });
    const memory = memories.find((m) => m.tags.includes(idTag(id)));
    return memory ? parseEntry(memory) : null;
  }

  async create(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    await this.client.memorize({
      title: entry.title,
      content: JSON.stringify(entry),
      tags: entryTags(entry),
    });
    return entry;
  }

  async update(id: string, partial: Partial<KnowledgeEntry>): Promise<KnowledgeEntry | null> {
    const memories = await this.client.listMemories({ tags: [idTag(id)] });
    const memory = memories.find((m) => m.tags.includes(idTag(id)));
    if (!memory) return null;
    const existing = parseEntry(memory);
    if (!existing) return null;

    const updated: KnowledgeEntry = {
      ...existing,
      ...partial,
      id: existing.id,
      companyId: existing.companyId,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.client.editMemory(memory.id, {
      title: updated.title,
      content: JSON.stringify(updated),
      tags: entryTags(updated),
    });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const memories = await this.client.listMemories({ tags: [idTag(id)] });
    const memory = memories.find((m) => m.tags.includes(idTag(id)));
    if (!memory) return false;
    return this.client.forgetMemory(memory.id);
  }
}

function entryTags(entry: KnowledgeEntry): string[] {
  return [
    `${TAG_PREFIX}:kind:knowledge`,
    companyTag(entry.companyId),
    idTag(entry.id),
    statusTag(entry.status),
    categoryTag(entry.category),
    ...(entry.tags ?? []),
  ];
}

function parseEntry(memory: HvMemory): KnowledgeEntry | null {
  try {
    const parsed = JSON.parse(memory.content) as KnowledgeEntry;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
