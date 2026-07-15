/**
 * HyperVaultWikiStore — WikiStore backed by the cloud mind
 *
 * Wiki pages persist as memories tagged `wiki:<wikiId>` (one memory per
 * page, full page JSON in the content), so `agentvault wiki` can run
 * against hypervault instead of `.agentvault/wiki/*.json`. Backlinks are
 * derived from each page's `crossRefs` (mirrored upstream as
 * `memory_links` by hypervault's auto-linking). The wiki log and schema
 * are memories tagged `wiki-log:<wikiId>` / `wiki-schema:<wikiId>`.
 */

import type { WikiLogEntry, WikiPage, WikiSchema } from '../backbone/types.js';
import type { WikiListFilters, WikiStore } from '../wiki/wiki-store.js';
import type { HyperVaultClient } from './client.js';
import type { HvMemory } from './types.js';

const TAG_PREFIX = 'av';

function wikiTag(wikiId: string): string {
  return `wiki:${wikiId}`;
}
function slugTag(slug: string): string {
  return `${TAG_PREFIX}:slug:${slug}`;
}
function pageIdTag(id: string): string {
  return `${TAG_PREFIX}:page-id:${id}`;
}
function logTag(wikiId: string): string {
  return `wiki-log:${wikiId}`;
}
function schemaTag(wikiId: string): string {
  return `wiki-schema:${wikiId}`;
}

export class HyperVaultWikiStore implements WikiStore {
  constructor(private readonly client: HyperVaultClient) {}

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  async listPages(wikiId: string, filters?: WikiListFilters): Promise<WikiPage[]> {
    const memories = await this.client.listMemories({ tags: [wikiTag(wikiId)] });
    let pages = memories
      .filter((m) => m.tags.includes(wikiTag(wikiId)) && !m.tags.includes(logTag(wikiId)) && !m.tags.includes(schemaTag(wikiId)))
      .map((m) => parsePage(m))
      .filter((p): p is WikiPage => p !== null);

    if (filters?.category) pages = pages.filter((p) => p.category === filters.category);
    if (filters?.status) pages = pages.filter((p) => p.status === filters.status);
    if (filters?.staleness) pages = pages.filter((p) => p.staleness === filters.staleness);
    if (filters?.tags && filters.tags.length > 0) {
      pages = pages.filter((p) => filters.tags!.every((t) => (p.tags ?? []).includes(t)));
    }
    if (filters?.search) {
      const needle = filters.search.toLowerCase();
      pages = pages.filter(
        (p) => p.title.toLowerCase().includes(needle) || p.content.toLowerCase().includes(needle),
      );
    }
    return pages;
  }

  async getPage(wikiId: string, slug: string): Promise<WikiPage | null> {
    const memory = await this.findPageMemory(wikiId, slug);
    return memory ? parsePage(memory) : null;
  }

  async getPageById(id: string): Promise<WikiPage | null> {
    const memories = await this.client.listMemories({ tags: [pageIdTag(id)] });
    const memory = memories.find((m) => m.tags.includes(pageIdTag(id)));
    return memory ? parsePage(memory) : null;
  }

  async createPage(page: WikiPage): Promise<WikiPage> {
    await this.client.memorize({
      title: page.title,
      content: JSON.stringify(page),
      tags: pageTags(page),
    });
    return page;
  }

  async updatePage(wikiId: string, slug: string, partial: Partial<WikiPage>): Promise<WikiPage | null> {
    const memory = await this.findPageMemory(wikiId, slug);
    if (!memory) return null;
    const existing = parsePage(memory);
    if (!existing) return null;

    const updated: WikiPage = {
      ...existing,
      ...partial,
      id: existing.id,
      companyId: existing.companyId,
      slug: existing.slug,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.client.editMemory(memory.id, {
      title: updated.title,
      content: JSON.stringify(updated),
      tags: pageTags(updated),
    });
    return updated;
  }

  async deletePage(wikiId: string, slug: string): Promise<boolean> {
    const memory = await this.findPageMemory(wikiId, slug);
    if (!memory) return false;
    return this.client.forgetMemory(memory.id);
  }

  // -------------------------------------------------------------------------
  // Cross-reference queries
  // -------------------------------------------------------------------------

  async getBacklinks(wikiId: string, slug: string): Promise<WikiPage[]> {
    const pages = await this.listPages(wikiId);
    return pages.filter((p) => p.slug !== slug && p.crossRefs.includes(slug));
  }

  async getOrphans(wikiId: string): Promise<WikiPage[]> {
    const pages = await this.listPages(wikiId);
    const referenced = new Set(pages.flatMap((p) => p.crossRefs));
    return pages.filter((p) => !referenced.has(p.slug));
  }

  // -------------------------------------------------------------------------
  // Log
  // -------------------------------------------------------------------------

  async appendLog(wikiId: string, entry: WikiLogEntry): Promise<void> {
    await this.client.memorize({
      title: `wiki log: ${entry.operation}`,
      content: JSON.stringify(entry),
      tags: [wikiTag(wikiId), logTag(wikiId)],
    });
  }

  async getLog(wikiId: string, limit = 50): Promise<WikiLogEntry[]> {
    const memories = await this.client.listMemories({ tags: [logTag(wikiId)] });
    return memories
      .filter((m) => m.tags.includes(logTag(wikiId)))
      .map((m) => {
        try {
          return JSON.parse(m.content) as WikiLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is WikiLogEntry => e !== null)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async getSchema(wikiId: string): Promise<WikiSchema | null> {
    const memories = await this.client.listMemories({ tags: [schemaTag(wikiId)] });
    const memory = memories.find((m) => m.tags.includes(schemaTag(wikiId)));
    if (!memory) return null;
    try {
      return JSON.parse(memory.content) as WikiSchema;
    } catch {
      return null;
    }
  }

  async setSchema(wikiId: string, schema: WikiSchema): Promise<void> {
    const memories = await this.client.listMemories({ tags: [schemaTag(wikiId)] });
    const existing = memories.find((m) => m.tags.includes(schemaTag(wikiId)));
    if (existing) {
      await this.client.editMemory(existing.id, {
        title: `wiki schema: ${schema.name}`,
        content: JSON.stringify(schema),
      });
    } else {
      await this.client.memorize({
        title: `wiki schema: ${schema.name}`,
        content: JSON.stringify(schema),
        tags: [wikiTag(wikiId), schemaTag(wikiId)],
      });
    }
  }

  // -------------------------------------------------------------------------

  private async findPageMemory(wikiId: string, slug: string): Promise<HvMemory | null> {
    const memories = await this.client.listMemories({ tags: [wikiTag(wikiId), slugTag(slug)] });
    return memories.find((m) => m.tags.includes(wikiTag(wikiId)) && m.tags.includes(slugTag(slug))) ?? null;
  }
}

function pageTags(page: WikiPage): string[] {
  return [wikiTag(page.companyId), slugTag(page.slug), pageIdTag(page.id), ...(page.tags ?? [])];
}

function parsePage(memory: HvMemory): WikiPage | null {
  try {
    const parsed = JSON.parse(memory.content) as WikiPage;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.slug !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
