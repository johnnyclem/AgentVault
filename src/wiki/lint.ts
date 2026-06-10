/**
 * Wiki Lint Service
 *
 * Implements Karpathy's "Lint" operation: periodically health-check
 * the wiki for contradictions, orphan pages, stale claims, and
 * missing cross-references.
 *
 * Can run autonomously via AgentVault's cron infrastructure.
 */

import type {
  WikiPage,
  WikiLintIssue,
  WikiLintReport,
} from '../backbone/types.js';
import type { WikiStore } from './wiki-store.js';
import { getArchive } from '../archival/archive-manager.js';

/** LLM adapter for deep lint checks (contradiction detection, etc.) */
export interface WikiLintLLMAdapter {
  /**
   * Given a set of pages, detect contradictions and suggest fixes.
   * This is the expensive operation — only run on suspicious page pairs.
   */
  detectContradictions(
    pages: WikiPage[],
  ): Promise<Array<{ slugA: string; slugB: string; description: string; suggestedFix: string }>>;
}

export class WikiLintService {
  constructor(
    private store: WikiStore,
    private wikiId: string,
    private llm?: WikiLintLLMAdapter,
  ) {}

  /**
   * Run a full lint pass on the wiki.
   *
   * Structural checks (orphans, dead refs, missing cross-refs) are
   * deterministic. Contradiction detection requires the LLM adapter.
   */
  async lint(): Promise<WikiLintReport> {
    const pages = await this.store.listPages(this.wikiId);
    const issues: WikiLintIssue[] = [];

    // Build slug set for validation
    const slugSet = new Set(pages.map((p) => p.slug));

    // 1. Find orphan pages (no incoming or outgoing cross-refs)
    const orphans = await this.store.getOrphans(this.wikiId);
    for (const orphan of orphans) {
      issues.push({
        type: 'orphan',
        severity: 'warning',
        pageSlug: orphan.slug,
        description: `Page "${orphan.title}" has no cross-references to or from other pages`,
        suggestedFix: `Review and add cross-references to related pages`,
      });
    }

    // 2. Find dead cross-references (point to non-existent pages)
    for (const page of pages) {
      for (const ref of page.crossRefs) {
        if (!slugSet.has(ref)) {
          issues.push({
            type: 'missing-crossref',
            severity: 'error',
            pageSlug: page.slug,
            description: `Cross-reference to "${ref}" points to a non-existent page`,
            suggestedFix: `Create page "${ref}" or remove the cross-reference`,
            relatedSlugs: [ref],
          });
        }
      }
    }

    // 3. Check for dead source references
    for (const page of pages) {
      for (const sourceRef of page.sourceRefs) {
        if (sourceRef.startsWith('local-')) continue; // Skip non-archived sources
        const archive = getArchive(sourceRef);
        if (!archive) {
          issues.push({
            type: 'dead-source',
            severity: 'warning',
            pageSlug: page.slug,
            description: `Source reference "${sourceRef}" not found in archive`,
            suggestedFix: `Re-ingest the source or remove the stale reference`,
          });
        }
      }
    }

    // 4. Check for stale pages (not updated recently relative to their sources)
    const now = Date.now();
    const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    for (const page of pages) {
      if (page.category === 'index' || page.category === 'log') continue;
      const updatedAt = new Date(page.updatedAt).getTime();
      if (now - updatedAt > STALE_THRESHOLD_MS && page.staleness !== 'stale') {
        issues.push({
          type: 'stale',
          severity: 'info',
          pageSlug: page.slug,
          description: `Page "${page.title}" has not been updated in over 30 days`,
          suggestedFix: `Review for accuracy and update if needed`,
        });

        // Mark as stale
        await this.store.updatePage(this.wikiId, page.slug, {
          staleness: 'stale',
        });
      }
    }

    // 5. LLM-powered contradiction detection (if adapter provided)
    if (this.llm && pages.length >= 2) {
      // Only check pages in the same category to limit LLM calls
      const byCategory = new Map<string, WikiPage[]>();
      for (const page of pages) {
        if (page.category === 'index' || page.category === 'log') continue;
        const cat = page.category;
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(page);
      }

      for (const [, categoryPages] of byCategory) {
        if (categoryPages.length < 2) continue;
        const contradictions = await this.llm.detectContradictions(categoryPages);
        for (const c of contradictions) {
          issues.push({
            type: 'contradiction',
            severity: 'error',
            pageSlug: c.slugA,
            description: c.description,
            suggestedFix: c.suggestedFix,
            relatedSlugs: [c.slugB],
          });
        }
      }
    }

    // Mark all checked pages with lint timestamp
    const lintTime = new Date().toISOString();
    for (const page of pages) {
      await this.store.updatePage(this.wikiId, page.slug, {
        lastLintedAt: lintTime,
      });
    }

    // Calculate health score (0-100)
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const healthScore = Math.max(
      0,
      100 - errorCount * 10 - warningCount * 5 - issues.length,
    );

    const report: WikiLintReport = {
      wikiId: this.wikiId,
      timestamp: lintTime,
      issues,
      pagesChecked: pages.length,
      healthScore,
    };

    // Log the lint operation
    await this.store.appendLog(this.wikiId, {
      timestamp: lintTime,
      operation: 'lint',
      summary: `Lint: ${issues.length} issues found across ${pages.length} pages (health: ${healthScore}/100)`,
      pagesSlugs: issues.map((i) => i.pageSlug),
    });

    return report;
  }

  /**
   * Auto-fix simple structural issues (dead cross-refs, staleness markers).
   * Returns the number of fixes applied.
   */
  async autoFix(report: WikiLintReport): Promise<number> {
    let fixes = 0;

    for (const issue of report.issues) {
      if (issue.type === 'missing-crossref') {
        // Remove dead cross-refs
        const page = await this.store.getPage(this.wikiId, issue.pageSlug);
        if (page && issue.relatedSlugs) {
          const deadSlugs = new Set(issue.relatedSlugs);
          const cleanedRefs = page.crossRefs.filter((r) => !deadSlugs.has(r));
          await this.store.updatePage(this.wikiId, issue.pageSlug, {
            crossRefs: cleanedRefs,
          });
          fixes++;
        }
      }

      if (issue.type === 'stale') {
        // Mark as needs-review (already marked stale in lint pass)
        await this.store.updatePage(this.wikiId, issue.pageSlug, {
          staleness: 'needs-review',
        });
        fixes++;
      }
    }

    if (fixes > 0) {
      await this.store.appendLog(this.wikiId, {
        timestamp: new Date().toISOString(),
        operation: 'lint',
        summary: `Auto-fix: applied ${fixes} fixes`,
      });
    }

    return fixes;
  }
}
