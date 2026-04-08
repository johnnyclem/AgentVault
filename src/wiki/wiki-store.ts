/**
 * Wiki Store
 *
 * Storage adapter for wiki pages. Extends the KnowledgeStore pattern
 * with wiki-specific operations (slug lookup, cross-ref queries, etc.).
 *
 * Default implementation is in-memory; consumers can inject a
 * canister-backed or file-system adapter.
 */

import type {
  WikiPage,
  WikiStaleness,
  WikiLogEntry,
  WikiSchema,
} from '../backbone/types.js';
import type { KnowledgeCategory, KnowledgeStatus } from '../backbone/constants.js';

export interface WikiListFilters {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  staleness?: WikiStaleness;
  search?: string;
  tags?: string[];
}

/** Storage adapter interface for wiki pages */
export interface WikiStore {
  listPages(wikiId: string, filters?: WikiListFilters): Promise<WikiPage[]>;
  getPage(wikiId: string, slug: string): Promise<WikiPage | null>;
  getPageById(id: string): Promise<WikiPage | null>;
  createPage(page: WikiPage): Promise<WikiPage>;
  updatePage(wikiId: string, slug: string, partial: Partial<WikiPage>): Promise<WikiPage | null>;
  deletePage(wikiId: string, slug: string): Promise<boolean>;

  // Cross-reference queries
  getBacklinks(wikiId: string, slug: string): Promise<WikiPage[]>;
  getOrphans(wikiId: string): Promise<WikiPage[]>;

  // Log
  appendLog(wikiId: string, entry: WikiLogEntry): Promise<void>;
  getLog(wikiId: string, limit?: number): Promise<WikiLogEntry[]>;

  // Schema
  getSchema(wikiId: string): Promise<WikiSchema | null>;
  setSchema(wikiId: string, schema: WikiSchema): Promise<void>;
}

/** In-memory implementation of WikiStore */
export class InMemoryWikiStore implements WikiStore {
  private pages = new Map<string, WikiPage>();
  private logs = new Map<string, WikiLogEntry[]>();
  private schemas = new Map<string, WikiSchema>();

  private makeKey(wikiId: string, slug: string): string {
    return `${wikiId}:${slug}`;
  }

  async listPages(wikiId: string, filters?: WikiListFilters): Promise<WikiPage[]> {
    const results: WikiPage[] = [];
    for (const page of this.pages.values()) {
      if (page.companyId !== wikiId) continue;
      if (filters?.category && page.category !== filters.category) continue;
      if (filters?.status && page.status !== filters.status) continue;
      if (filters?.staleness && page.staleness !== filters.staleness) continue;
      if (filters?.tags?.length) {
        const pageTags = page.tags ?? [];
        if (!filters.tags.some((t) => pageTags.includes(t))) continue;
      }
      if (filters?.search) {
        const term = filters.search.toLowerCase();
        if (
          !page.title.toLowerCase().includes(term) &&
          !page.content.toLowerCase().includes(term) &&
          !page.slug.toLowerCase().includes(term)
        ) {
          continue;
        }
      }
      results.push(page);
    }
    return results;
  }

  async getPage(wikiId: string, slug: string): Promise<WikiPage | null> {
    return this.pages.get(this.makeKey(wikiId, slug)) ?? null;
  }

  async getPageById(id: string): Promise<WikiPage | null> {
    for (const page of this.pages.values()) {
      if (page.id === id) return page;
    }
    return null;
  }

  async createPage(page: WikiPage): Promise<WikiPage> {
    this.pages.set(this.makeKey(page.companyId, page.slug), page);
    return page;
  }

  async updatePage(
    wikiId: string,
    slug: string,
    partial: Partial<WikiPage>,
  ): Promise<WikiPage | null> {
    const key = this.makeKey(wikiId, slug);
    const existing = this.pages.get(key);
    if (!existing) return null;

    const updated: WikiPage = {
      ...existing,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    // If slug changed, re-key
    if (partial.slug && partial.slug !== slug) {
      this.pages.delete(key);
      this.pages.set(this.makeKey(wikiId, partial.slug), updated);
    } else {
      this.pages.set(key, updated);
    }

    return updated;
  }

  async deletePage(wikiId: string, slug: string): Promise<boolean> {
    return this.pages.delete(this.makeKey(wikiId, slug));
  }

  async getBacklinks(wikiId: string, slug: string): Promise<WikiPage[]> {
    const results: WikiPage[] = [];
    for (const page of this.pages.values()) {
      if (page.companyId !== wikiId) continue;
      if (page.crossRefs.includes(slug)) {
        results.push(page);
      }
    }
    return results;
  }

  async getOrphans(wikiId: string): Promise<WikiPage[]> {
    // Pages that are not referenced by any other page and reference no pages
    const allSlugs = new Set<string>();
    const referencedSlugs = new Set<string>();
    const wikiPages: WikiPage[] = [];

    for (const page of this.pages.values()) {
      if (page.companyId !== wikiId) continue;
      wikiPages.push(page);
      allSlugs.add(page.slug);
      for (const ref of page.crossRefs) {
        referencedSlugs.add(ref);
      }
    }

    return wikiPages.filter(
      (page) =>
        !referencedSlugs.has(page.slug) &&
        page.crossRefs.length === 0 &&
        page.category !== 'index' &&
        page.category !== 'log',
    );
  }

  async appendLog(wikiId: string, entry: WikiLogEntry): Promise<void> {
    const log = this.logs.get(wikiId) ?? [];
    log.push(entry);
    this.logs.set(wikiId, log);
  }

  async getLog(wikiId: string, limit?: number): Promise<WikiLogEntry[]> {
    const log = this.logs.get(wikiId) ?? [];
    if (limit) {
      return log.slice(-limit);
    }
    return [...log];
  }

  async getSchema(wikiId: string): Promise<WikiSchema | null> {
    return this.schemas.get(wikiId) ?? null;
  }

  async setSchema(wikiId: string, schema: WikiSchema): Promise<void> {
    this.schemas.set(wikiId, schema);
  }
}
