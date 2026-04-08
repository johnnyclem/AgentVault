/**
 * Wiki Module Tests
 *
 * Tests for the LLM-maintained knowledge base (archivist):
 *   - WikiStore (InMemoryWikiStore)
 *   - WikiIngestService
 *   - WikiQueryService
 *   - WikiLintService
 *   - MCP tool handlers
 *   - Validators
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryWikiStore } from '../../src/wiki/wiki-store.js';
import { WikiIngestService } from '../../src/wiki/ingest.js';
import { WikiQueryService } from '../../src/wiki/query.js';
import { WikiLintService } from '../../src/wiki/lint.js';
import {
  getWikiToolDefinitions,
  handleWikiToolCall,
} from '../../src/wiki/mcp-tools.js';
import {
  createWikiPageSchema,
  updateWikiPageSchema,
  wikiSchemaValidator,
  rawSourceSchema,
} from '../../src/backbone/validators.js';
import type { WikiPage, RawSource, WikiSchema } from '../../src/backbone/types.js';
import type { WikiLLMAdapter, SynthesisResult } from '../../src/wiki/ingest.js';
import type { WikiQueryLLMAdapter } from '../../src/wiki/query.js';
import type { WikiLintLLMAdapter } from '../../src/wiki/lint.js';
import type { WikiStore } from '../../src/wiki/wiki-store.js';

// Mock the archive-manager to avoid filesystem dependencies
vi.mock('../../src/archival/archive-manager.js', () => ({
  prepareArchive: vi.fn().mockReturnValue({
    success: true,
    archiveId: 'test-archive-001',
  }),
  getArchive: vi.fn().mockReturnValue(null),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

const WIKI_ID = 'test-wiki';

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  const now = new Date().toISOString();
  return {
    id: `page-${Math.random().toString(36).slice(2, 8)}`,
    companyId: WIKI_ID,
    title: 'Test Page',
    content: 'Test content',
    category: 'general',
    status: 'draft',
    version: 1,
    createdBy: 'test',
    slug: `test-page-${Math.random().toString(36).slice(2, 8)}`,
    crossRefs: [],
    sourceRefs: [],
    staleness: 'fresh',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Mock LLM adapter for ingest */
class MockIngestLLM implements WikiLLMAdapter {
  async synthesize(
    source: RawSource,
    _existingPages: WikiPage[],
    _schemaPrompt?: string,
  ): Promise<SynthesisResult> {
    return {
      pagesToCreate: [
        {
          title: `Summary: ${source.name}`,
          content: `Summary of ${source.name}: ${source.content.slice(0, 100)}`,
          category: 'summary',
          slug: source.name.toLowerCase().replace(/\s+/g, '-'),
          crossRefs: [],
          sourceRefs: [],
          tags: ['auto-generated'],
        },
      ],
      pagesToUpdate: [],
      summary: `Ingested ${source.name}`,
    };
  }
}

/** Mock LLM adapter for query */
class MockQueryLLM implements WikiQueryLLMAdapter {
  async answerQuery(
    question: string,
    relevantPages: WikiPage[],
  ) {
    return {
      answer: `Answer to "${question}" based on ${relevantPages.length} pages`,
      citations: relevantPages.slice(0, 3).map((p) => ({
        slug: p.slug,
        title: p.title,
        excerpt: p.content.slice(0, 50),
      })),
      confidence: 0.85,
      pagesConsulted: relevantPages.map((p) => p.slug),
    };
  }
}

/** Mock LLM adapter for lint */
class MockLintLLM implements WikiLintLLMAdapter {
  async detectContradictions(pages: WikiPage[]) {
    if (pages.length >= 2) {
      return [
        {
          slugA: pages[0].slug,
          slugB: pages[1].slug,
          description: 'Test contradiction detected',
          suggestedFix: 'Reconcile the two pages',
        },
      ];
    }
    return [];
  }
}

// ── WikiStore Tests ───────────────────────────────────────────────────────

describe('InMemoryWikiStore', () => {
  let store: InMemoryWikiStore;

  beforeEach(() => {
    store = new InMemoryWikiStore();
  });

  describe('CRUD operations', () => {
    it('should create and retrieve a page by slug', async () => {
      const page = makePage({ slug: 'test-page' });
      await store.createPage(page);
      const retrieved = await store.getPage(WIKI_ID, 'test-page');
      expect(retrieved).toEqual(page);
    });

    it('should retrieve a page by id', async () => {
      const page = makePage({ id: 'unique-id', slug: 'by-id-page' });
      await store.createPage(page);
      const retrieved = await store.getPageById('unique-id');
      expect(retrieved).toEqual(page);
    });

    it('should return null for non-existent page', async () => {
      const result = await store.getPage(WIKI_ID, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should update a page', async () => {
      const page = makePage({ slug: 'updatable' });
      await store.createPage(page);
      const updated = await store.updatePage(WIKI_ID, 'updatable', {
        content: 'Updated content',
        version: 2,
      });
      expect(updated?.content).toBe('Updated content');
      expect(updated?.version).toBe(2);
    });

    it('should handle slug changes during update', async () => {
      const page = makePage({ slug: 'old-slug' });
      await store.createPage(page);
      await store.updatePage(WIKI_ID, 'old-slug', { slug: 'new-slug' });

      const oldResult = await store.getPage(WIKI_ID, 'old-slug');
      const newResult = await store.getPage(WIKI_ID, 'new-slug');
      expect(oldResult).toBeNull();
      expect(newResult?.slug).toBe('new-slug');
    });

    it('should delete a page', async () => {
      const page = makePage({ slug: 'deletable' });
      await store.createPage(page);
      const deleted = await store.deletePage(WIKI_ID, 'deletable');
      expect(deleted).toBe(true);
      const result = await store.getPage(WIKI_ID, 'deletable');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent page', async () => {
      const deleted = await store.deletePage(WIKI_ID, 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('listPages with filters', () => {
    beforeEach(async () => {
      await store.createPage(makePage({ slug: 'arch-1', category: 'architecture', status: 'ratified', staleness: 'fresh', title: 'Architecture Overview', tags: ['system'] }));
      await store.createPage(makePage({ slug: 'policy-1', category: 'policy', status: 'draft', staleness: 'stale', title: 'Security Policy', tags: ['security'] }));
      await store.createPage(makePage({ slug: 'entity-1', category: 'entity', status: 'draft', staleness: 'fresh', title: 'User Entity' }));
    });

    it('should list all pages for a wiki', async () => {
      const pages = await store.listPages(WIKI_ID);
      expect(pages).toHaveLength(3);
    });

    it('should filter by category', async () => {
      const pages = await store.listPages(WIKI_ID, { category: 'architecture' });
      expect(pages).toHaveLength(1);
      expect(pages[0].slug).toBe('arch-1');
    });

    it('should filter by status', async () => {
      const pages = await store.listPages(WIKI_ID, { status: 'ratified' });
      expect(pages).toHaveLength(1);
    });

    it('should filter by staleness', async () => {
      const pages = await store.listPages(WIKI_ID, { staleness: 'stale' });
      expect(pages).toHaveLength(1);
      expect(pages[0].slug).toBe('policy-1');
    });

    it('should filter by search term', async () => {
      const pages = await store.listPages(WIKI_ID, { search: 'security' });
      expect(pages).toHaveLength(1);
      expect(pages[0].slug).toBe('policy-1');
    });

    it('should filter by tags', async () => {
      const pages = await store.listPages(WIKI_ID, { tags: ['system'] });
      expect(pages).toHaveLength(1);
      expect(pages[0].slug).toBe('arch-1');
    });

    it('should not return pages from different wikis', async () => {
      await store.createPage(makePage({ companyId: 'other-wiki', slug: 'other-page' }));
      const pages = await store.listPages(WIKI_ID);
      expect(pages).toHaveLength(3);
    });
  });

  describe('cross-reference queries', () => {
    beforeEach(async () => {
      await store.createPage(makePage({ slug: 'page-a', crossRefs: ['page-b', 'page-c'] }));
      await store.createPage(makePage({ slug: 'page-b', crossRefs: ['page-a'] }));
      await store.createPage(makePage({ slug: 'page-c', crossRefs: [] }));
      await store.createPage(makePage({ slug: 'orphan', crossRefs: [] }));
    });

    it('should find backlinks for a page', async () => {
      const backlinks = await store.getBacklinks(WIKI_ID, 'page-b');
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0].slug).toBe('page-a');
    });

    it('should find orphan pages', async () => {
      const orphans = await store.getOrphans(WIKI_ID);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].slug).toBe('orphan');
    });
  });

  describe('log operations', () => {
    it('should append and retrieve log entries', async () => {
      await store.appendLog(WIKI_ID, {
        timestamp: new Date().toISOString(),
        operation: 'ingest',
        summary: 'Test log entry',
      });
      await store.appendLog(WIKI_ID, {
        timestamp: new Date().toISOString(),
        operation: 'query',
        summary: 'Test query',
      });

      const log = await store.getLog(WIKI_ID);
      expect(log).toHaveLength(2);
    });

    it('should limit log entries', async () => {
      for (let i = 0; i < 10; i++) {
        await store.appendLog(WIKI_ID, {
          timestamp: new Date().toISOString(),
          operation: 'ingest',
          summary: `Entry ${i}`,
        });
      }

      const log = await store.getLog(WIKI_ID, 3);
      expect(log).toHaveLength(3);
    });
  });

  describe('schema operations', () => {
    it('should store and retrieve schema', async () => {
      const schema: WikiSchema = {
        name: 'Test Wiki',
        description: 'A test wiki',
        categories: ['custom'],
      };
      await store.setSchema(WIKI_ID, schema);
      const retrieved = await store.getSchema(WIKI_ID);
      expect(retrieved).toEqual(schema);
    });

    it('should return null for non-existent schema', async () => {
      const result = await store.getSchema('nonexistent');
      expect(result).toBeNull();
    });
  });
});

// ── WikiIngestService Tests ───────────────────────────────────────────────

describe('WikiIngestService', () => {
  let store: InMemoryWikiStore;
  let llm: MockIngestLLM;
  let service: WikiIngestService;

  beforeEach(() => {
    store = new InMemoryWikiStore();
    llm = new MockIngestLLM();
    service = new WikiIngestService(store, llm, WIKI_ID);
  });

  it('should ingest a text source and create pages', async () => {
    const source: RawSource = {
      name: 'Test Document',
      type: 'text',
      content: 'This is a test document with important content.',
    };

    const result = await service.ingest(source);

    expect(result.pagesCreated).toContain('test-document');
    expect(result.sourceArchiveId).toBe('test-archive-001');
    expect(result.crossRefsAdded).toBeGreaterThanOrEqual(0);
  });

  it('should update existing pages when re-ingesting same slug', async () => {
    const source1: RawSource = {
      name: 'Topic',
      type: 'text',
      content: 'First version of content.',
    };
    const source2: RawSource = {
      name: 'Topic',
      type: 'text',
      content: 'Updated content with new info.',
    };

    await service.ingest(source1);
    const result2 = await service.ingest(source2);

    expect(result2.pagesUpdated).toContain('topic');
    expect(result2.pagesCreated).not.toContain('topic');

    const page = await store.getPage(WIKI_ID, 'topic');
    expect(page?.version).toBe(2);
    expect(page?.content).toContain('First version');
    expect(page?.content).toContain('Updated content');
  });

  it('should create an index page after ingestion', async () => {
    const source: RawSource = {
      name: 'A Source',
      type: 'text',
      content: 'Some content.',
    };

    await service.ingest(source);
    const index = await store.getPage(WIKI_ID, 'index');

    expect(index).not.toBeNull();
    expect(index?.category).toBe('index');
    expect(index?.content).toContain('Wiki Index');
  });

  it('should log the ingest operation', async () => {
    const source: RawSource = {
      name: 'Logged Source',
      type: 'text',
      content: 'Content for logging.',
    };

    await service.ingest(source);
    const log = await store.getLog(WIKI_ID);

    expect(log.length).toBeGreaterThanOrEqual(1);
    const ingestLog = log.find((e) => e.operation === 'ingest');
    expect(ingestLog).toBeDefined();
    expect(ingestLog?.sourceRef).toBe('test-archive-001');
  });

  it('should rebuild index correctly', async () => {
    await store.createPage(makePage({ slug: 'page-1', title: 'Page One', category: 'entity' }));
    await store.createPage(makePage({ slug: 'page-2', title: 'Page Two', category: 'summary' }));

    const indexPage = await service.rebuildIndex();

    expect(indexPage.content).toContain('Page One');
    expect(indexPage.content).toContain('Page Two');
    expect(indexPage.content).toContain('2 pages');
  });
});

// ── WikiQueryService Tests ────────────────────────────────────────────────

describe('WikiQueryService', () => {
  let store: InMemoryWikiStore;
  let llm: MockQueryLLM;
  let service: WikiQueryService;

  beforeEach(async () => {
    store = new InMemoryWikiStore();
    llm = new MockQueryLLM();
    service = new WikiQueryService(store, llm, WIKI_ID);

    // Seed some pages
    await store.createPage(makePage({
      slug: 'transformers',
      title: 'Transformer Architecture',
      content: 'Transformers use self-attention mechanisms.',
      tags: ['ml', 'architecture'],
    }));
    await store.createPage(makePage({
      slug: 'attention',
      title: 'Attention Mechanisms',
      content: 'Attention allows models to focus on relevant parts of the input.',
      tags: ['ml', 'attention'],
    }));
  });

  it('should query and return synthesized answer', async () => {
    const result = await service.query('How does attention work?');

    expect(result.answer).toContain('attention');
    expect(result.pagesConsulted.length).toBeGreaterThan(0);
    expect(result.confidence).toBe(0.85);
  });

  it('should include citations in query results', async () => {
    const result = await service.query('transformer architecture');

    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0].slug).toBeDefined();
    expect(result.citations[0].title).toBeDefined();
  });

  it('should log query operations', async () => {
    await service.query('test query');
    const log = await store.getLog(WIKI_ID);

    const queryLog = log.find((e) => e.operation === 'query');
    expect(queryLog).toBeDefined();
    expect(queryLog?.summary).toContain('test query');
  });

  it('should file exploration pages', async () => {
    const result = await service.query('How does attention work?');
    const exploration = await service.fileExploration(
      'How does attention work?',
      result,
    );

    expect(exploration.category).toBe('exploration');
    expect(exploration.slug).toMatch(/^exploration-/);
    expect(exploration.content).toContain('How does attention work?');
    expect(exploration.crossRefs.length).toBeGreaterThan(0);
  });

  it('should rank relevant pages higher', async () => {
    await store.createPage(makePage({
      slug: 'cooking',
      title: 'Cooking Recipes',
      content: 'How to cook pasta.',
      tags: ['food'],
    }));

    const result = await service.query('transformer attention mechanism');

    // The ML pages should be consulted, not the cooking page
    expect(result.pagesConsulted).toContain('transformers');
    expect(result.pagesConsulted).toContain('attention');
    expect(result.pagesConsulted).not.toContain('cooking');
  });
});

// ── WikiLintService Tests ─────────────────────────────────────────────────

describe('WikiLintService', () => {
  let store: InMemoryWikiStore;
  let service: WikiLintService;

  beforeEach(() => {
    store = new InMemoryWikiStore();
    service = new WikiLintService(store, WIKI_ID);
  });

  it('should detect orphan pages', async () => {
    await store.createPage(makePage({ slug: 'connected', crossRefs: ['other'] }));
    await store.createPage(makePage({ slug: 'other', crossRefs: ['connected'] }));
    await store.createPage(makePage({ slug: 'orphan', crossRefs: [] }));

    const report = await service.lint();
    const orphanIssues = report.issues.filter((i) => i.type === 'orphan');

    expect(orphanIssues.length).toBeGreaterThan(0);
    expect(orphanIssues.some((i) => i.pageSlug === 'orphan')).toBe(true);
  });

  it('should detect dead cross-references', async () => {
    await store.createPage(makePage({
      slug: 'has-dead-ref',
      crossRefs: ['nonexistent-page'],
    }));

    const report = await service.lint();
    const deadRefIssues = report.issues.filter((i) => i.type === 'missing-crossref');

    expect(deadRefIssues.length).toBe(1);
    expect(deadRefIssues[0].pageSlug).toBe('has-dead-ref');
    expect(deadRefIssues[0].description).toContain('nonexistent-page');
  });

  it('should detect stale pages', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await store.createPage(makePage({
      slug: 'old-page',
      updatedAt: thirtyOneDaysAgo,
      staleness: 'fresh',
    }));

    const report = await service.lint();
    const staleIssues = report.issues.filter((i) => i.type === 'stale');

    expect(staleIssues.length).toBe(1);
    expect(staleIssues[0].pageSlug).toBe('old-page');
  });

  it('should calculate health score', async () => {
    // Clean wiki
    await store.createPage(makePage({
      slug: 'healthy-a',
      crossRefs: ['healthy-b'],
    }));
    await store.createPage(makePage({
      slug: 'healthy-b',
      crossRefs: ['healthy-a'],
    }));

    const report = await service.lint();
    expect(report.healthScore).toBeGreaterThanOrEqual(80);
  });

  it('should reduce health score for errors', async () => {
    await store.createPage(makePage({
      slug: 'broken',
      crossRefs: ['dead-1', 'dead-2', 'dead-3'],
    }));

    const report = await service.lint();
    expect(report.healthScore).toBeLessThan(80);
  });

  it('should update lastLintedAt on all pages', async () => {
    await store.createPage(makePage({ slug: 'linted-page' }));
    await service.lint();

    const page = await store.getPage(WIKI_ID, 'linted-page');
    expect(page?.lastLintedAt).toBeDefined();
  });

  it('should use LLM for contradiction detection when provided', async () => {
    const lintLLM = new MockLintLLM();
    const serviceWithLLM = new WikiLintService(store, WIKI_ID, lintLLM);

    await store.createPage(makePage({
      slug: 'claim-a',
      category: 'general',
      content: 'The sky is blue',
    }));
    await store.createPage(makePage({
      slug: 'claim-b',
      category: 'general',
      content: 'The sky is green',
    }));

    const report = await serviceWithLLM.lint();
    const contradictions = report.issues.filter((i) => i.type === 'contradiction');

    expect(contradictions.length).toBe(1);
    expect(contradictions[0].description).toContain('contradiction');
  });

  it('should log lint operations', async () => {
    await store.createPage(makePage({ slug: 'lint-test' }));
    await service.lint();

    const log = await store.getLog(WIKI_ID);
    const lintLog = log.find((e) => e.operation === 'lint');
    expect(lintLog).toBeDefined();
    expect(lintLog?.summary).toContain('health:');
  });

  describe('autoFix', () => {
    it('should remove dead cross-references', async () => {
      await store.createPage(makePage({
        slug: 'fixable',
        crossRefs: ['dead-ref'],
      }));

      const report = await service.lint();
      const fixes = await service.autoFix(report);

      expect(fixes).toBeGreaterThan(0);
      const page = await store.getPage(WIKI_ID, 'fixable');
      expect(page?.crossRefs).not.toContain('dead-ref');
    });

    it('should mark stale pages as needs-review', async () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      await store.createPage(makePage({
        slug: 'stale-fixable',
        updatedAt: oldDate,
        staleness: 'fresh',
      }));

      const report = await service.lint();
      await service.autoFix(report);

      const page = await store.getPage(WIKI_ID, 'stale-fixable');
      expect(page?.staleness).toBe('needs-review');
    });
  });
});

// ── MCP Tools Tests ───────────────────────────────────────────────────────

describe('Wiki MCP Tools', () => {
  it('should define all expected tools', () => {
    const tools = getWikiToolDefinitions();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('wiki_init');
    expect(toolNames).toContain('wiki_ingest');
    expect(toolNames).toContain('wiki_query');
    expect(toolNames).toContain('wiki_read');
    expect(toolNames).toContain('wiki_update');
    expect(toolNames).toContain('wiki_list');
    expect(toolNames).toContain('wiki_lint');
    expect(toolNames).toContain('wiki_log');
    expect(toolNames).toContain('wiki_backlinks');
    expect(toolNames).toContain('wiki_index');
    expect(tools).toHaveLength(10);
  });

  it('should have input schemas for all tools', () => {
    const tools = getWikiToolDefinitions();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
    }
  });

  describe('handleWikiToolCall', () => {
    let store: InMemoryWikiStore;

    beforeEach(() => {
      store = new InMemoryWikiStore();
    });

    it('should handle wiki_init', async () => {
      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_init',
        { name: 'Test Wiki', description: 'A test' },
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('initialized');

      const schema = await store.getSchema(WIKI_ID);
      expect(schema?.name).toBe('Test Wiki');
    });

    it('should handle wiki_read for existing page', async () => {
      await store.createPage(makePage({ slug: 'readable', title: 'Readable Page' }));

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_read',
        { slug: 'readable' },
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.title).toBe('Readable Page');
    });

    it('should return error for non-existent page', async () => {
      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_read',
        { slug: 'nope' },
      );

      expect(result.isError).toBe(true);
    });

    it('should handle wiki_list', async () => {
      await store.createPage(makePage({ slug: 'list-1', title: 'List One' }));
      await store.createPage(makePage({ slug: 'list-2', title: 'List Two' }));

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_list',
        {},
      );

      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed).toHaveLength(2);
    });

    it('should handle wiki_update', async () => {
      await store.createPage(makePage({ slug: 'updatable', title: 'Old Title' }));

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_update',
        { slug: 'updatable', title: 'New Title' },
      );

      expect(result.isError).toBeUndefined();
      const page = await store.getPage(WIKI_ID, 'updatable');
      expect(page?.title).toBe('New Title');
    });

    it('should handle wiki_backlinks', async () => {
      await store.createPage(makePage({ slug: 'target' }));
      await store.createPage(makePage({ slug: 'linker', crossRefs: ['target'] }));

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_backlinks',
        { slug: 'target' },
      );

      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].slug).toBe('linker');
    });

    it('should handle wiki_log', async () => {
      await store.appendLog(WIKI_ID, {
        timestamp: new Date().toISOString(),
        operation: 'ingest',
        summary: 'Test entry',
      });

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_log',
        { limit: 10 },
      );

      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed).toHaveLength(1);
    });

    it('should handle wiki_lint', async () => {
      await store.createPage(makePage({ slug: 'lint-target', crossRefs: ['dead'] }));

      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_lint',
        {},
      );

      const parsed = JSON.parse(result.content[0].text!);
      expect(parsed.issues.length).toBeGreaterThan(0);
      expect(parsed.healthScore).toBeDefined();
    });

    it('should return error for unknown tool', async () => {
      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_unknown',
        {},
      );

      expect(result.isError).toBe(true);
    });

    it('should return error for wiki_ingest without LLM adapter', async () => {
      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store },
        'wiki_ingest',
        { name: 'test', type: 'text', content: 'hello' },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No LLM adapter');
    });

    it('should handle wiki_ingest with LLM adapter', async () => {
      const result = await handleWikiToolCall(
        { wikiId: WIKI_ID, store, ingestLLM: new MockIngestLLM() },
        'wiki_ingest',
        { name: 'Test Doc', type: 'text', content: 'Test content for ingestion' },
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Ingested');
    });
  });
});

// ── Validator Tests ───────────────────────────────────────────────────────

describe('Wiki Validators', () => {
  describe('createWikiPageSchema', () => {
    it('should accept valid input', () => {
      const input = {
        title: 'Test Page',
        content: 'Test content',
        category: 'entity',
        slug: 'test-page',
        crossRefs: ['other-page'],
        tags: ['test'],
      };
      const result = createWikiPageSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject invalid slug', () => {
      const input = {
        title: 'Test',
        content: 'Content',
        category: 'entity',
        slug: 'Invalid Slug!',
      };
      const result = createWikiPageSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject empty title', () => {
      const input = {
        title: '',
        content: 'Content',
        category: 'entity',
        slug: 'valid-slug',
      };
      const result = createWikiPageSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should accept new wiki categories', () => {
      for (const cat of ['entity', 'summary', 'exploration', 'index', 'log']) {
        const result = createWikiPageSchema.safeParse({
          title: 'Test',
          content: 'Content',
          category: cat,
          slug: 'test',
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('updateWikiPageSchema', () => {
    it('should accept partial updates', () => {
      const result = updateWikiPageSchema.safeParse({ title: 'New Title' });
      expect(result.success).toBe(true);
    });

    it('should accept staleness updates', () => {
      const result = updateWikiPageSchema.safeParse({ staleness: 'stale' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid staleness', () => {
      const result = updateWikiPageSchema.safeParse({ staleness: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('wikiSchemaValidator', () => {
    it('should accept valid schema', () => {
      const result = wikiSchemaValidator.safeParse({
        name: 'My Wiki',
        description: 'A knowledge base',
        categories: ['custom'],
      });
      expect(result.success).toBe(true);
    });

    it('should require name', () => {
      const result = wikiSchemaValidator.safeParse({ description: 'No name' });
      expect(result.success).toBe(false);
    });
  });

  describe('rawSourceSchema', () => {
    it('should accept valid source', () => {
      const result = rawSourceSchema.safeParse({
        name: 'Test Source',
        type: 'text',
        content: 'Source content',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
      const result = rawSourceSchema.safeParse({
        name: 'Test',
        type: 'invalid',
        content: 'Content',
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty content', () => {
      const result = rawSourceSchema.safeParse({
        name: 'Test',
        type: 'text',
        content: '',
      });
      expect(result.success).toBe(false);
    });
  });
});
