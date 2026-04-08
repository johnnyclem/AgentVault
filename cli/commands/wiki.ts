/**
 * agentvault wiki — LLM-Maintained Knowledge Base (Archivist)
 *
 * Subcommands:
 *   wiki init <name>           Initialize a new wiki with schema
 *   wiki ingest <source>       Ingest a source (file, URL, or text)
 *   wiki query "question"      Query the wiki, get synthesized answer
 *   wiki read <slug>           Read a specific wiki page
 *   wiki list [--category]     List all pages with optional filters
 *   wiki lint [--auto-fix]     Run health check (contradictions, orphans, stale)
 *   wiki log [--limit N]       View activity log
 *   wiki index                 Rebuild the wiki index
 *   wiki pages                 Show page count and stats
 *   wiki backlinks <slug>      Find pages referencing a given page
 *   wiki export [dir]          Export wiki as markdown files
 *
 * Based on the "LLM Wiki" pattern (Karpathy, 2025):
 *   Raw Sources → LLM Synthesis → Persistent Wiki Pages
 *
 * Examples:
 *   agentvault wiki init "Research Notes"
 *   agentvault wiki ingest --type text --name "Transformer Paper" --content "..."
 *   agentvault wiki query "How do attention mechanisms work?"
 *   agentvault wiki lint --auto-fix
 *   agentvault wiki export ./wiki-output
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { InMemoryWikiStore } from '../../src/wiki/wiki-store.js';
import { WikiIngestService } from '../../src/wiki/ingest.js';
import { WikiQueryService } from '../../src/wiki/query.js';
import { WikiLintService } from '../../src/wiki/lint.js';
import type { WikiStore } from '../../src/wiki/wiki-store.js';
import type { WikiLLMAdapter, SynthesisResult } from '../../src/wiki/ingest.js';
import type { WikiQueryLLMAdapter } from '../../src/wiki/query.js';
import type { RawSource, WikiSchema, WikiQueryResult, WikiPage } from '../../src/backbone/types.js';
import {
  createWikiPageSchema,
  wikiSchemaValidator,
  rawSourceSchema,
} from '../../src/backbone/validators.js';

// ── Persistent store singleton (file-backed in .agentvault/wiki/) ─────────

const WIKI_DIR = path.join(process.cwd(), '.agentvault', 'wiki');

function ensureWikiDir(): void {
  if (!fs.existsSync(WIKI_DIR)) {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
  }
}

function getWikiStorePath(wikiId: string): string {
  return path.join(WIKI_DIR, `${wikiId}.json`);
}

/**
 * Load wiki store from disk, or create a fresh in-memory store.
 * In production this would be backed by the ICP canister.
 */
function loadStore(wikiId: string): WikiStore {
  const store = new InMemoryWikiStore();
  const storePath = getWikiStorePath(wikiId);
  if (fs.existsSync(storePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      // Hydrate store from saved state
      if (data.pages) {
        for (const page of data.pages) {
          store.createPage(page);
        }
      }
      if (data.schema) {
        store.setSchema(wikiId, data.schema);
      }
      if (data.log) {
        for (const entry of data.log) {
          store.appendLog(wikiId, entry);
        }
      }
    } catch {
      // Start fresh if corrupt
    }
  }
  return store;
}

async function saveStore(wikiId: string, store: WikiStore): Promise<void> {
  ensureWikiDir();
  const pages = await store.listPages(wikiId);
  const schema = await store.getSchema(wikiId);
  const log = await store.getLog(wikiId);
  const data = { pages, schema, log };
  fs.writeFileSync(getWikiStorePath(wikiId), JSON.stringify(data, null, 2), 'utf8');
}

function getActiveWikiId(): string {
  const configPath = path.join(WIKI_DIR, 'active.txt');
  if (fs.existsSync(configPath)) {
    return fs.readFileSync(configPath, 'utf8').trim();
  }
  return 'default';
}

function setActiveWikiId(wikiId: string): void {
  ensureWikiDir();
  fs.writeFileSync(path.join(WIKI_DIR, 'active.txt'), wikiId, 'utf8');
}

// ── Default LLM adapter (structural, no actual LLM call) ─────────────────

/**
 * A structural LLM adapter that creates pages without calling an LLM.
 * Useful for CLI testing and when no LLM is configured.
 * Real LLM integration would replace this via the orchestration layer.
 */
class StructuralLLMAdapter implements WikiLLMAdapter, WikiQueryLLMAdapter {
  async synthesize(
    source: RawSource,
    _existingPages: WikiPage[],
    _schemaPrompt?: string,
  ): Promise<SynthesisResult> {
    const slug = source.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return {
      pagesToCreate: [
        {
          title: source.name,
          content: `# ${source.name}\n\n${source.content}`,
          category: 'summary',
          slug,
          crossRefs: [],
          sourceRefs: [],
          tags: [source.type],
        },
      ],
      pagesToUpdate: [],
      summary: `Ingested source: "${source.name}" (${source.type})`,
    };
  }

  async answerQuery(
    question: string,
    relevantPages: WikiPage[],
    _schemaPrompt?: string,
  ): Promise<WikiQueryResult> {
    const citations = relevantPages.slice(0, 5).map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.content.slice(0, 200),
    }));

    return {
      answer: `Found ${relevantPages.length} relevant pages for: "${question}"\n\n` +
        relevantPages
          .slice(0, 5)
          .map((p) => `- **${p.title}** (\`${p.slug}\`): ${p.content.slice(0, 100)}...`)
          .join('\n'),
      citations,
      confidence: relevantPages.length > 0 ? 0.7 : 0.1,
      pagesConsulted: relevantPages.map((p) => p.slug),
    };
  }
}

// ── CLI Command ───────────────────────────────────────────────────────────

export const wikiCmd = new Command('wiki');

wikiCmd
  .description('LLM-maintained knowledge base (archivist)')
  .action(() => {
    console.log(chalk.cyan.bold('AgentVault Wiki — LLM-Maintained Knowledge Base'));
    console.log(chalk.gray('Based on the "LLM Wiki" pattern (Karpathy, 2025)\n'));
    console.log('Subcommands:');
    console.log(`  ${chalk.cyan('init <name>')}            Initialize a new wiki`);
    console.log(`  ${chalk.cyan('ingest')}                 Ingest a source (file, URL, or text)`);
    console.log(`  ${chalk.cyan('query "question"')}       Query the wiki`);
    console.log(`  ${chalk.cyan('read <slug>')}            Read a specific page`);
    console.log(`  ${chalk.cyan('list')}                   List all pages`);
    console.log(`  ${chalk.cyan('lint')}                   Run health check`);
    console.log(`  ${chalk.cyan('log')}                    View activity log`);
    console.log(`  ${chalk.cyan('index')}                  Rebuild wiki index`);
    console.log(`  ${chalk.cyan('stats')}                  Page count and stats`);
    console.log(`  ${chalk.cyan('backlinks <slug>')}       Find pages referencing a page`);
    console.log(`  ${chalk.cyan('export [dir]')}           Export as markdown files`);
  });

// ── init ──────────────────────────────────────────────────────────────────

wikiCmd
  .command('init')
  .description('Initialize a new wiki with a name and optional schema')
  .argument('<name>', 'Wiki name')
  .option('-d, --description <desc>', 'Wiki description', '')
  .option('--ingest-prompt <prompt>', 'Custom LLM prompt for source ingestion')
  .option('--query-prompt <prompt>', 'Custom LLM prompt for query synthesis')
  .action(async (name: string, options) => {
    const spinner = ora('Initializing wiki...').start();

    try {
      const parsed = wikiSchemaValidator.parse({
        name,
        description: options.description,
        ingestPrompt: options.ingestPrompt,
        queryPrompt: options.queryPrompt,
      });

      const wikiId = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const store = new InMemoryWikiStore();
      const schema: WikiSchema = {
        name: parsed.name,
        description: parsed.description,
        categories: parsed.categories,
        ingestPrompt: parsed.ingestPrompt,
        queryPrompt: parsed.queryPrompt,
      };
      await store.setSchema(wikiId, schema);

      // Create initial index page
      const llm = new StructuralLLMAdapter();
      const ingestService = new WikiIngestService(store, llm, wikiId);
      await ingestService.rebuildIndex();

      await saveStore(wikiId, store);
      setActiveWikiId(wikiId);

      spinner.succeed(chalk.green(`Wiki "${name}" initialized (id: ${wikiId})`));
      console.log(chalk.gray(`  Store: ${getWikiStorePath(wikiId)}`));
      console.log(chalk.gray(`  Active wiki set to: ${wikiId}`));
    } catch (error) {
      spinner.fail(chalk.red(`Failed to initialize wiki: ${error instanceof Error ? error.message : error}`));
    }
  });

// ── ingest ────────────────────────────────────────────────────────────────

wikiCmd
  .command('ingest')
  .description('Ingest a raw source into the wiki')
  .option('-n, --name <name>', 'Source name/title')
  .option('-t, --type <type>', 'Source type: file, url, or text', 'text')
  .option('-c, --content <content>', 'Source content (text) or path (file)')
  .option('-f, --file <path>', 'Read source content from a file')
  .option('-w, --wiki <id>', 'Wiki ID (defaults to active wiki)')
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const spinner = ora('Ingesting source...').start();

    try {
      let content = options.content || '';
      let sourceType = options.type;
      let sourceName = options.name || 'untitled';

      if (options.file) {
        const filePath = path.resolve(options.file);
        if (!fs.existsSync(filePath)) {
          spinner.fail(chalk.red(`File not found: ${filePath}`));
          return;
        }
        content = fs.readFileSync(filePath, 'utf8');
        sourceType = 'file';
        sourceName = options.name || path.basename(filePath);
      }

      const source = rawSourceSchema.parse({
        name: sourceName,
        type: sourceType,
        content,
      });

      const store = loadStore(wikiId);
      const llm = new StructuralLLMAdapter();
      const ingestService = new WikiIngestService(store, llm, wikiId);
      const result = await ingestService.ingest(source as RawSource);

      await saveStore(wikiId, store);

      spinner.succeed(chalk.green(`Ingested "${sourceName}"`));
      console.log(chalk.gray(`  Archive ID: ${result.sourceArchiveId}`));
      console.log(chalk.gray(`  Pages created: ${result.pagesCreated.join(', ') || 'none'}`));
      console.log(chalk.gray(`  Pages updated: ${result.pagesUpdated.join(', ') || 'none'}`));
      console.log(chalk.gray(`  Cross-refs added: ${result.crossRefsAdded}`));
    } catch (error) {
      spinner.fail(chalk.red(`Ingest failed: ${error instanceof Error ? error.message : error}`));
    }
  });

// ── query ─────────────────────────────────────────────────────────────────

wikiCmd
  .command('query')
  .description('Query the wiki — ask a question, get a synthesized answer')
  .argument('<question>', 'The question to ask')
  .option('-w, --wiki <id>', 'Wiki ID (defaults to active wiki)')
  .option('--file', 'File the answer back as an exploration page', false)
  .action(async (question: string, options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const spinner = ora('Querying wiki...').start();

    try {
      const store = loadStore(wikiId);
      const llm = new StructuralLLMAdapter();
      const queryService = new WikiQueryService(store, llm, wikiId);
      const result = await queryService.query(question);

      spinner.stop();

      console.log(chalk.cyan.bold('\nAnswer:\n'));
      console.log(result.answer);

      if (result.citations.length > 0) {
        console.log(chalk.gray('\nCitations:'));
        for (const c of result.citations) {
          console.log(chalk.gray(`  - ${c.title} (${c.slug})`));
        }
      }

      console.log(chalk.gray(`\nConfidence: ${(result.confidence * 100).toFixed(0)}%`));
      console.log(chalk.gray(`Pages consulted: ${result.pagesConsulted.length}`));

      if (options.file) {
        const page = await queryService.fileExploration(question, result);
        await saveStore(wikiId, store);
        console.log(chalk.green(`\nFiled as exploration: ${page.slug}`));
      }
    } catch (error) {
      spinner.fail(chalk.red(`Query failed: ${error instanceof Error ? error.message : error}`));
    }
  });

// ── read ──────────────────────────────────────────────────────────────────

wikiCmd
  .command('read')
  .description('Read a specific wiki page by slug')
  .argument('<slug>', 'Page slug')
  .option('-w, --wiki <id>', 'Wiki ID')
  .action(async (slug: string, options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const store = loadStore(wikiId);
    const page = await store.getPage(wikiId, slug);

    if (!page) {
      console.log(chalk.red(`Page "${slug}" not found.`));
      return;
    }

    console.log(chalk.cyan.bold(page.title));
    console.log(chalk.gray(`slug: ${page.slug} | category: ${page.category} | v${page.version} | ${page.staleness}`));
    if (page.tags?.length) {
      console.log(chalk.gray(`tags: ${page.tags.join(', ')}`));
    }
    if (page.crossRefs.length > 0) {
      console.log(chalk.gray(`cross-refs: ${page.crossRefs.join(', ')}`));
    }
    console.log('');
    console.log(page.content);
  });

// ── list ──────────────────────────────────────────────────────────────────

wikiCmd
  .command('list')
  .description('List wiki pages with optional filters')
  .option('-w, --wiki <id>', 'Wiki ID')
  .option('-c, --category <cat>', 'Filter by category')
  .option('-s, --status <status>', 'Filter by status')
  .option('--stale', 'Show only stale pages', false)
  .option('--search <term>', 'Full-text search')
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const store = loadStore(wikiId);

    const filters: any = {};
    if (options.category) filters.category = options.category;
    if (options.status) filters.status = options.status;
    if (options.stale) filters.staleness = 'stale';
    if (options.search) filters.search = options.search;

    const pages = await store.listPages(wikiId, filters);

    if (pages.length === 0) {
      console.log(chalk.yellow('No pages found.'));
      return;
    }

    console.log(chalk.cyan.bold(`Wiki pages (${pages.length}):\n`));
    for (const page of pages) {
      const staleMarker = page.staleness !== 'fresh' ? chalk.yellow(` [${page.staleness}]`) : '';
      const refs = page.crossRefs.length > 0 ? chalk.gray(` → ${page.crossRefs.length} refs`) : '';
      console.log(`  ${chalk.white(page.title)} ${chalk.gray(`(${page.slug})`)}${staleMarker}${refs}`);
      console.log(chalk.gray(`    ${page.category} | v${page.version} | ${page.status}`));
    }
  });

// ── lint ──────────────────────────────────────────────────────────────────

wikiCmd
  .command('lint')
  .description('Run wiki health check — find contradictions, orphans, stale pages')
  .option('-w, --wiki <id>', 'Wiki ID')
  .option('--auto-fix', 'Auto-fix simple structural issues', false)
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const spinner = ora('Running lint...').start();

    try {
      const store = loadStore(wikiId);
      const lintService = new WikiLintService(store, wikiId);
      const report = await lintService.lint();

      if (options.autoFix) {
        const fixes = await lintService.autoFix(report);
        spinner.info(chalk.blue(`Auto-fixed ${fixes} issues`));
      }

      await saveStore(wikiId, store);
      spinner.stop();

      console.log(chalk.cyan.bold(`\nWiki Health Report`));
      console.log(chalk.gray(`  Pages checked: ${report.pagesChecked}`));

      const scoreColor = report.healthScore >= 80 ? chalk.green : report.healthScore >= 50 ? chalk.yellow : chalk.red;
      console.log(`  Health score: ${scoreColor(`${report.healthScore}/100`)}`);

      if (report.issues.length === 0) {
        console.log(chalk.green('\n  No issues found!'));
      } else {
        console.log(`\n  Issues (${report.issues.length}):`);
        for (const issue of report.issues) {
          const icon = issue.severity === 'error' ? chalk.red('✗') : issue.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
          console.log(`    ${icon} [${issue.type}] ${issue.pageSlug}: ${issue.description}`);
          if (issue.suggestedFix) {
            console.log(chalk.gray(`      Fix: ${issue.suggestedFix}`));
          }
        }
      }
    } catch (error) {
      spinner.fail(chalk.red(`Lint failed: ${error instanceof Error ? error.message : error}`));
    }
  });

// ── log ───────────────────────────────────────────────────────────────────

wikiCmd
  .command('log')
  .description('View the wiki activity log')
  .option('-w, --wiki <id>', 'Wiki ID')
  .option('-n, --limit <n>', 'Number of entries to show', '20')
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const store = loadStore(wikiId);
    const log = await store.getLog(wikiId, parseInt(options.limit, 10));

    if (log.length === 0) {
      console.log(chalk.yellow('No log entries.'));
      return;
    }

    console.log(chalk.cyan.bold(`Wiki Activity Log (${log.length} entries):\n`));
    for (const entry of log.reverse()) {
      const op = chalk.cyan(entry.operation.padEnd(7));
      const time = chalk.gray(entry.timestamp);
      console.log(`  ${time} ${op} ${entry.summary}`);
      if (entry.pagesSlugs?.length) {
        console.log(chalk.gray(`    pages: ${entry.pagesSlugs.join(', ')}`));
      }
    }
  });

// ── index ─────────────────────────────────────────────────────────────────

wikiCmd
  .command('index')
  .description('Rebuild the wiki index page')
  .option('-w, --wiki <id>', 'Wiki ID')
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const spinner = ora('Rebuilding index...').start();

    try {
      const store = loadStore(wikiId);
      const llm = new StructuralLLMAdapter();
      const ingestService = new WikiIngestService(store, llm, wikiId);
      const indexPage = await ingestService.rebuildIndex();
      await saveStore(wikiId, store);

      spinner.succeed(chalk.green('Index rebuilt'));
      console.log('');
      console.log(indexPage.content);
    } catch (error) {
      spinner.fail(chalk.red(`Index rebuild failed: ${error instanceof Error ? error.message : error}`));
    }
  });

// ── stats ─────────────────────────────────────────────────────────────────

wikiCmd
  .command('stats')
  .description('Show wiki statistics')
  .option('-w, --wiki <id>', 'Wiki ID')
  .action(async (options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const store = loadStore(wikiId);
    const pages = await store.listPages(wikiId);
    const schema = await store.getSchema(wikiId);
    const log = await store.getLog(wikiId);

    console.log(chalk.cyan.bold(`Wiki: ${schema?.name ?? wikiId}\n`));
    console.log(`  Pages: ${pages.length}`);
    console.log(`  Log entries: ${log.length}`);

    // Category breakdown
    const categories = new Map<string, number>();
    let totalRefs = 0;
    let staleCount = 0;
    for (const page of pages) {
      categories.set(page.category, (categories.get(page.category) ?? 0) + 1);
      totalRefs += page.crossRefs.length;
      if (page.staleness !== 'fresh') staleCount++;
    }

    console.log(`  Cross-references: ${totalRefs}`);
    console.log(`  Stale pages: ${staleCount}`);
    console.log(`\n  Categories:`);
    for (const [cat, count] of categories) {
      console.log(`    ${cat}: ${count}`);
    }
  });

// ── backlinks ─────────────────────────────────────────────────────────────

wikiCmd
  .command('backlinks')
  .description('Find pages that reference a given page')
  .argument('<slug>', 'Page slug to find backlinks for')
  .option('-w, --wiki <id>', 'Wiki ID')
  .action(async (slug: string, options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const store = loadStore(wikiId);
    const backlinks = await store.getBacklinks(wikiId, slug);

    if (backlinks.length === 0) {
      console.log(chalk.yellow(`No pages reference "${slug}".`));
      return;
    }

    console.log(chalk.cyan.bold(`Pages referencing "${slug}" (${backlinks.length}):\n`));
    for (const page of backlinks) {
      console.log(`  ${chalk.white(page.title)} ${chalk.gray(`(${page.slug})`)}`);
    }
  });

// ── export ────────────────────────────────────────────────────────────────

wikiCmd
  .command('export')
  .description('Export wiki as markdown files')
  .argument('[dir]', 'Output directory', './wiki-export')
  .option('-w, --wiki <id>', 'Wiki ID')
  .action(async (dir: string, options) => {
    const wikiId = options.wiki || getActiveWikiId();
    const spinner = ora('Exporting wiki...').start();

    try {
      const store = loadStore(wikiId);
      const pages = await store.listPages(wikiId);
      const outputDir = path.resolve(dir);

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      for (const page of pages) {
        const frontmatter = [
          '---',
          `title: "${page.title}"`,
          `slug: ${page.slug}`,
          `category: ${page.category}`,
          `status: ${page.status}`,
          `version: ${page.version}`,
          `staleness: ${page.staleness}`,
          page.tags?.length ? `tags: [${page.tags.join(', ')}]` : null,
          page.crossRefs.length ? `crossRefs: [${page.crossRefs.join(', ')}]` : null,
          `created: ${page.createdAt}`,
          `updated: ${page.updatedAt}`,
          '---',
          '',
        ]
          .filter(Boolean)
          .join('\n');

        const filePath = path.join(outputDir, `${page.slug}.md`);
        fs.writeFileSync(filePath, frontmatter + page.content, 'utf8');
      }

      spinner.succeed(chalk.green(`Exported ${pages.length} pages to ${outputDir}`));
    } catch (error) {
      spinner.fail(chalk.red(`Export failed: ${error instanceof Error ? error.message : error}`));
    }
  });
