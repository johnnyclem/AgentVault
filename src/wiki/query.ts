/**
 * Wiki Query Service
 *
 * Implements Karpathy's "Query" operation: search the wiki for relevant pages,
 * synthesize an answer with citations, and optionally file the exploration
 * back into the wiki as a new page.
 */

import { randomUUID } from 'node:crypto';
import type { WikiPage, WikiQueryResult } from '../backbone/types.js';
import type { WikiStore } from './wiki-store.js';

/** LLM adapter for query synthesis */
export interface WikiQueryLLMAdapter {
  /**
   * Given a question and relevant wiki pages, produce a synthesized answer
   * with citations back to source pages.
   */
  answerQuery(
    question: string,
    relevantPages: WikiPage[],
    schemaPrompt?: string,
  ): Promise<WikiQueryResult>;
}

export class WikiQueryService {
  constructor(
    private store: WikiStore,
    private llm: WikiQueryLLMAdapter,
    private wikiId: string,
  ) {}

  /**
   * Query the wiki: find relevant pages, synthesize an answer.
   */
  async query(question: string): Promise<WikiQueryResult> {
    // 1. Search for relevant pages
    const allPages = await this.store.listPages(this.wikiId);
    const relevantPages = this.rankRelevance(question, allPages);

    // 2. Get schema for query prompt customization
    const schema = await this.store.getSchema(this.wikiId);

    // 3. LLM synthesis
    const result = await this.llm.answerQuery(
      question,
      relevantPages,
      schema?.queryPrompt,
    );

    // 4. Log the query
    await this.store.appendLog(this.wikiId, {
      timestamp: new Date().toISOString(),
      operation: 'query',
      summary: `Query: "${question}" — consulted ${result.pagesConsulted.length} pages`,
      pagesSlugs: result.pagesConsulted,
    });

    return result;
  }

  /**
   * File a query result back into the wiki as an exploration page.
   * This is what makes the wiki compound — valuable queries become pages.
   */
  async fileExploration(
    question: string,
    result: WikiQueryResult,
  ): Promise<WikiPage> {
    const slug = `exploration-${Date.now()}`;
    const now = new Date().toISOString();

    // Build citation section
    const citations = result.citations
      .map((c) => `- [[${c.slug}]] — ${c.title}: "${c.excerpt}"`)
      .join('\n');

    const content = [
      `# ${question}`,
      '',
      result.answer,
      '',
      '## Sources',
      '',
      citations,
      '',
      `*Filed automatically on ${now}*`,
    ].join('\n');

    const page: WikiPage = {
      id: randomUUID(),
      companyId: this.wikiId,
      title: question,
      content,
      category: 'exploration',
      status: 'draft',
      version: 1,
      createdBy: 'wiki-query',
      slug,
      crossRefs: result.citations.map((c) => c.slug),
      sourceRefs: [],
      staleness: 'fresh',
      createdAt: now,
      updatedAt: now,
    };

    await this.store.createPage(page);

    await this.store.appendLog(this.wikiId, {
      timestamp: now,
      operation: 'ingest',
      summary: `Filed exploration: "${question}"`,
      pagesSlugs: [slug],
    });

    return page;
  }

  /**
   * Simple relevance ranking using keyword overlap.
   * In production, this would use embeddings or the LLM for semantic search.
   */
  private rankRelevance(question: string, pages: WikiPage[]): WikiPage[] {
    const queryTerms = question
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scored = pages
      .filter((p) => p.category !== 'log')
      .map((page) => {
        const text = `${page.title} ${page.content} ${(page.tags ?? []).join(' ')}`.toLowerCase();
        let score = 0;
        for (const term of queryTerms) {
          if (text.includes(term)) score++;
          // Boost title matches
          if (page.title.toLowerCase().includes(term)) score += 2;
          // Boost tag matches
          if ((page.tags ?? []).some((t) => t.toLowerCase().includes(term))) score += 1;
        }
        return { page, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Return top 20 most relevant pages
    return scored.slice(0, 20).map((s) => s.page);
  }
}
