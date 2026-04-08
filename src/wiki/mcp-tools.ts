/**
 * Wiki MCP Tools
 *
 * Exposes the wiki as an MCP tool server so any MCP-compatible agent
 * can read, write, query, and lint the knowledge base.
 *
 * Tools:
 *   wiki_init       — Initialize a new wiki with a schema
 *   wiki_ingest     — Add a raw source to the wiki
 *   wiki_query      — Ask a question, get a synthesized answer
 *   wiki_read       — Read a specific wiki page by slug
 *   wiki_update     — Update a page's content
 *   wiki_list       — List all pages (with optional filters)
 *   wiki_lint       — Run a health check
 *   wiki_log        — View the activity log
 *   wiki_backlinks  — Find pages that reference a given page
 *   wiki_index      — Rebuild the wiki index
 */

import type { MCPToolDefinition, MCPToolCallResult } from '../orchestration/mcp-client.js';
import type { WikiStore } from './wiki-store.js';
import type { WikiLLMAdapter } from './ingest.js';
import type { WikiQueryLLMAdapter } from './query.js';
import type { WikiLintLLMAdapter } from './lint.js';
import { WikiIngestService } from './ingest.js';
import { WikiQueryService } from './query.js';
import { WikiLintService } from './lint.js';
import type {
  RawSource,
  WikiSchema,
  UpdateWikiPageInput,
} from '../backbone/types.js';
import type { WikiListFilters } from './wiki-store.js';

export interface WikiMCPConfig {
  wikiId: string;
  store: WikiStore;
  ingestLLM?: WikiLLMAdapter;
  queryLLM?: WikiQueryLLMAdapter;
  lintLLM?: WikiLintLLMAdapter;
}

/** Returns the list of MCP tool definitions for the wiki */
export function getWikiToolDefinitions(): MCPToolDefinition[] {
  return [
    {
      name: 'wiki_init',
      description: 'Initialize a new wiki with a name and optional schema',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Wiki name' },
          description: { type: 'string', description: 'Wiki description' },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Custom categories beyond defaults',
          },
          ingestPrompt: { type: 'string', description: 'Custom prompt for ingest synthesis' },
          queryPrompt: { type: 'string', description: 'Custom prompt for query synthesis' },
          lintPrompt: { type: 'string', description: 'Custom prompt for lint checks' },
        },
        required: ['name'],
      },
    },
    {
      name: 'wiki_ingest',
      description: 'Ingest a raw source into the wiki (file, URL, or text)',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Source name/title' },
          type: { type: 'string', enum: ['file', 'url', 'text'], description: 'Source type' },
          content: { type: 'string', description: 'Source content (text or file path)' },
          mimeType: { type: 'string', description: 'MIME type of the source' },
        },
        required: ['name', 'type', 'content'],
      },
    },
    {
      name: 'wiki_query',
      description: 'Query the wiki — ask a question, get a synthesized answer with citations',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to answer' },
          fileExploration: {
            type: 'boolean',
            description: 'If true, file the answer back as an exploration page',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'wiki_read',
      description: 'Read a specific wiki page by slug',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Page slug identifier' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'wiki_update',
      description: 'Update an existing wiki page',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Page slug to update' },
          content: { type: 'string', description: 'New content (replaces existing)' },
          title: { type: 'string', description: 'New title' },
          crossRefs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Updated cross-references',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Updated tags',
          },
        },
        required: ['slug'],
      },
    },
    {
      name: 'wiki_list',
      description: 'List wiki pages with optional filters',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category' },
          status: { type: 'string', description: 'Filter by status' },
          staleness: { type: 'string', enum: ['fresh', 'stale', 'needs-review'] },
          search: { type: 'string', description: 'Full-text search term' },
        },
      },
    },
    {
      name: 'wiki_lint',
      description: 'Run a health check on the wiki — find contradictions, orphans, stale pages',
      inputSchema: {
        type: 'object',
        properties: {
          autoFix: {
            type: 'boolean',
            description: 'Automatically fix simple structural issues',
          },
        },
      },
    },
    {
      name: 'wiki_log',
      description: 'View the wiki activity log',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of log entries to return (default: 50)' },
        },
      },
    },
    {
      name: 'wiki_backlinks',
      description: 'Find all pages that reference a given page',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Page slug to find backlinks for' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'wiki_index',
      description: 'Rebuild the wiki index page',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

/** Handle an MCP tool call for the wiki */
export async function handleWikiToolCall(
  config: WikiMCPConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<MCPToolCallResult> {
  const { wikiId, store } = config;

  try {
    switch (toolName) {
      case 'wiki_init': {
        const schema: WikiSchema = {
          name: args.name as string,
          description: (args.description as string) ?? '',
          categories: (args.categories as string[]) ?? [],
          ingestPrompt: args.ingestPrompt as string | undefined,
          queryPrompt: args.queryPrompt as string | undefined,
          lintPrompt: args.lintPrompt as string | undefined,
        };
        await store.setSchema(wikiId, schema);
        return {
          content: [{ type: 'text', text: `Wiki "${schema.name}" initialized successfully.` }],
        };
      }

      case 'wiki_ingest': {
        if (!config.ingestLLM) {
          return {
            content: [{ type: 'text', text: 'No LLM adapter configured for ingest.' }],
            isError: true,
          };
        }
        const source: RawSource = {
          name: args.name as string,
          type: args.type as 'file' | 'url' | 'text',
          content: args.content as string,
          mimeType: args.mimeType as string | undefined,
        };
        const ingestService = new WikiIngestService(store, config.ingestLLM, wikiId);
        const result = await ingestService.ingest(source);
        return {
          content: [{
            type: 'text',
            text: `Ingested "${source.name}": created ${result.pagesCreated.length} pages, updated ${result.pagesUpdated.length} pages, added ${result.crossRefsAdded} cross-refs.`,
          }],
        };
      }

      case 'wiki_query': {
        if (!config.queryLLM) {
          return {
            content: [{ type: 'text', text: 'No LLM adapter configured for query.' }],
            isError: true,
          };
        }
        const queryService = new WikiQueryService(store, config.queryLLM, wikiId);
        const question = args.question as string;
        const result = await queryService.query(question);
        if (args.fileExploration) {
          await queryService.fileExploration(question, result);
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'wiki_read': {
        const page = await store.getPage(wikiId, args.slug as string);
        if (!page) {
          return {
            content: [{ type: 'text', text: `Page "${args.slug}" not found.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(page, null, 2) }],
        };
      }

      case 'wiki_update': {
        const slug = args.slug as string;
        const updates: Partial<UpdateWikiPageInput> = {};
        if (args.content) updates.content = args.content as string;
        if (args.title) updates.title = args.title as string;
        if (args.crossRefs) updates.crossRefs = args.crossRefs as string[];
        if (args.tags) updates.tags = args.tags as string[];

        const updated = await store.updatePage(wikiId, slug, updates);
        if (!updated) {
          return {
            content: [{ type: 'text', text: `Page "${slug}" not found.` }],
            isError: true,
          };
        }

        await store.appendLog(wikiId, {
          timestamp: new Date().toISOString(),
          operation: 'update',
          summary: `Updated page "${slug}"`,
          pagesSlugs: [slug],
        });

        return {
          content: [{ type: 'text', text: `Page "${slug}" updated (v${updated.version}).` }],
        };
      }

      case 'wiki_list': {
        const filters: WikiListFilters = {};
        if (args.category) filters.category = args.category as any;
        if (args.status) filters.status = args.status as any;
        if (args.staleness) filters.staleness = args.staleness as any;
        if (args.search) filters.search = args.search as string;

        const pages = await store.listPages(wikiId, filters);
        const summary = pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          category: p.category,
          status: p.status,
          staleness: p.staleness,
          version: p.version,
          crossRefs: p.crossRefs.length,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      }

      case 'wiki_lint': {
        const lintService = new WikiLintService(store, wikiId, config.lintLLM);
        const report = await lintService.lint();
        if (args.autoFix) {
          const fixes = await lintService.autoFix(report);
          report.issues.push({
            type: 'orphan',
            severity: 'info',
            pageSlug: '_system',
            description: `Auto-fix applied ${fixes} corrections`,
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        };
      }

      case 'wiki_log': {
        const limit = (args.limit as number) ?? 50;
        const log = await store.getLog(wikiId, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(log, null, 2) }],
        };
      }

      case 'wiki_backlinks': {
        const backlinks = await store.getBacklinks(wikiId, args.slug as string);
        const summary = backlinks.map((p) => ({
          slug: p.slug,
          title: p.title,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      }

      case 'wiki_index': {
        if (!config.ingestLLM) {
          return {
            content: [{ type: 'text', text: 'No LLM adapter configured for index rebuild.' }],
            isError: true,
          };
        }
        const ingestService = new WikiIngestService(store, config.ingestLLM, wikiId);
        const indexPage = await ingestService.rebuildIndex();
        return {
          content: [{ type: 'text', text: indexPage.content }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown wiki tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Wiki tool error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
