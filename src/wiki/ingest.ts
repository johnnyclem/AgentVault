/**
 * Wiki Ingest Service
 *
 * Implements Karpathy's "Ingest" operation: accept a raw source,
 * archive it immutably, then have the LLM synthesize/update wiki pages.
 *
 * Flow:
 *   1. Archive raw source (Arweave or local)
 *   2. LLM reads source, generates summary page
 *   3. LLM identifies entities → creates/updates entity pages
 *   4. Cross-references are woven between pages
 *   5. Activity is logged
 */

import { randomUUID } from 'node:crypto';
import type {
  WikiPage,
  RawSource,
  WikiIngestResult,
  CreateWikiPageInput,
} from '../backbone/types.js';
import type { WikiStore } from './wiki-store.js';
import {
  prepareArchive,
  type ArchiveOptions,
} from '../archival/archive-manager.js';

/** LLM adapter interface — consumers inject their orchestration layer */
export interface WikiLLMAdapter {
  /**
   * Given a raw source and existing wiki pages, produce synthesis instructions:
   * - pages to create (with content, cross-refs, category)
   * - pages to update (slug + patch)
   */
  synthesize(
    source: RawSource,
    existingPages: WikiPage[],
    schemaPrompt?: string,
  ): Promise<SynthesisResult>;
}

export interface SynthesisResult {
  pagesToCreate: CreateWikiPageInput[];
  pagesToUpdate: Array<{ slug: string; contentPatch: string; newCrossRefs?: string[] }>;
  summary: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class WikiIngestService {
  constructor(
    private store: WikiStore,
    private llm: WikiLLMAdapter,
    private wikiId: string,
  ) {}

  /**
   * Ingest a raw source into the wiki.
   *
   * Archives the source, calls the LLM to synthesize pages,
   * then creates/updates pages and weaves cross-references.
   */
  async ingest(source: RawSource): Promise<WikiIngestResult> {
    // 1. Archive the raw source immutably
    const archiveResult = prepareArchive(
      `wiki-${this.wikiId}`,
      '1.0.0',
      {
        source: {
          name: source.name,
          type: source.type,
          content: source.content,
          mimeType: source.mimeType,
          metadata: source.metadata,
        },
        ingestedAt: new Date().toISOString(),
      },
      {
        tags: {
          'wiki-id': this.wikiId,
          'source-name': source.name,
          'source-type': source.type,
        },
      } as ArchiveOptions,
    );

    const sourceArchiveId = archiveResult.archiveId ?? `local-${randomUUID()}`;

    // 2. Get existing pages for context
    const existingPages = await this.store.listPages(this.wikiId);
    const schema = await this.store.getSchema(this.wikiId);

    // 3. LLM synthesis
    const synthesis = await this.llm.synthesize(
      source,
      existingPages,
      schema?.ingestPrompt,
    );

    const pagesCreated: string[] = [];
    const pagesUpdated: string[] = [];
    let crossRefsAdded = 0;

    // 4. Create new pages
    for (const input of synthesis.pagesToCreate) {
      const now = new Date().toISOString();
      const slug = input.slug || slugify(input.title);

      // Check if page already exists — update instead
      const existing = await this.store.getPage(this.wikiId, slug);
      if (existing) {
        const updatedRefs = [
          ...new Set([...existing.crossRefs, ...(input.crossRefs ?? [])]),
        ];
        const updatedSourceRefs = [
          ...new Set([...existing.sourceRefs, sourceArchiveId]),
        ];
        crossRefsAdded += updatedRefs.length - existing.crossRefs.length;

        await this.store.updatePage(this.wikiId, slug, {
          content: existing.content + '\n\n---\n\n' + input.content,
          crossRefs: updatedRefs,
          sourceRefs: updatedSourceRefs,
          staleness: 'fresh',
          version: existing.version + 1,
        });
        pagesUpdated.push(slug);
        continue;
      }

      const page: WikiPage = {
        id: randomUUID(),
        companyId: this.wikiId,
        title: input.title,
        content: input.content,
        category: input.category,
        status: 'draft',
        version: 1,
        createdBy: 'wiki-ingest',
        tags: input.tags,
        metadata: input.metadata,
        slug,
        crossRefs: input.crossRefs ?? [],
        sourceRefs: [sourceArchiveId, ...(input.sourceRefs ?? [])],
        staleness: 'fresh',
        createdAt: now,
        updatedAt: now,
      };

      await this.store.createPage(page);
      pagesCreated.push(slug);
      crossRefsAdded += page.crossRefs.length;
    }

    // 5. Update existing pages
    for (const update of synthesis.pagesToUpdate) {
      const existing = await this.store.getPage(this.wikiId, update.slug);
      if (!existing) continue;

      const newRefs = update.newCrossRefs ?? [];
      const mergedRefs = [...new Set([...existing.crossRefs, ...newRefs])];
      crossRefsAdded += mergedRefs.length - existing.crossRefs.length;

      await this.store.updatePage(this.wikiId, update.slug, {
        content: existing.content + '\n\n' + update.contentPatch,
        crossRefs: mergedRefs,
        sourceRefs: [...new Set([...existing.sourceRefs, sourceArchiveId])],
        staleness: 'fresh',
        version: existing.version + 1,
      });
      pagesUpdated.push(update.slug);
    }

    // 6. Log the ingest operation
    await this.store.appendLog(this.wikiId, {
      timestamp: new Date().toISOString(),
      operation: 'ingest',
      summary: synthesis.summary,
      pagesSlugs: [...pagesCreated, ...pagesUpdated],
      sourceRef: sourceArchiveId,
    });

    // 7. Rebuild index page
    await this.rebuildIndex();

    return {
      sourceArchiveId,
      pagesCreated,
      pagesUpdated,
      crossRefsAdded,
    };
  }

  /**
   * Rebuild the index page from the current page inventory.
   */
  async rebuildIndex(): Promise<WikiPage> {
    const pages = await this.store.listPages(this.wikiId);
    const nonIndexPages = pages.filter(
      (p) => p.category !== 'index' && p.category !== 'log',
    );

    // Group by category
    const grouped = new Map<string, WikiPage[]>();
    for (const page of nonIndexPages) {
      const cat = page.category;
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(page);
    }

    // Build index content
    let content = `# Wiki Index\n\n`;
    content += `*${nonIndexPages.length} pages across ${grouped.size} categories*\n\n`;

    for (const [category, categoryPages] of grouped) {
      content += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
      for (const page of categoryPages.sort((a, b) => a.title.localeCompare(b.title))) {
        const status = page.staleness !== 'fresh' ? ` [${page.staleness}]` : '';
        content += `- **${page.title}** (\`${page.slug}\`)${status}\n`;
      }
      content += '\n';
    }

    const now = new Date().toISOString();
    const existing = await this.store.getPage(this.wikiId, 'index');

    if (existing) {
      const updated = await this.store.updatePage(this.wikiId, 'index', {
        content,
        version: existing.version + 1,
      });
      return updated!;
    }

    const indexPage: WikiPage = {
      id: randomUUID(),
      companyId: this.wikiId,
      title: 'Wiki Index',
      content,
      category: 'index',
      status: 'ratified',
      version: 1,
      createdBy: 'wiki-system',
      slug: 'index',
      crossRefs: nonIndexPages.map((p) => p.slug),
      sourceRefs: [],
      staleness: 'fresh',
      createdAt: now,
      updatedAt: now,
    };

    return this.store.createPage(indexPage);
  }
}
