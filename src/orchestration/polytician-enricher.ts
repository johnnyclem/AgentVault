import { PolyticianMCPClient, MCPToolError, type MCPServerConfig } from './mcp-client.js';
import {
  callPolytician,
  conceptTitle,
  clampCount,
  markdownFences,
  MAX_MARKDOWN_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_TAG_LENGTH,
  SEARCH_K_MAX,
} from './polytician-tools.js';

export interface EnrichmentConfig {
  mcpServer: MCPServerConfig;
  maxContextLength?: number;
  topK?: number;
  minRelevanceScore?: number;
}

export interface EnrichmentResult {
  enrichedPrompt: string;
  /** The concept blocks added to the prompt, without the task ('' when there are none) */
  context: string;
  conceptsUsed: ConceptReference[];
  contextLength: number;
  truncated: boolean;
}

export interface ConceptReference {
  id: string;
  name: string;
  relevanceScore?: number;
}

/**
 * Polytician 3.0 scores a hit (1 + cosine similarity) / 2, so 0.65 is a cosine
 * of 0.3. Search ranks every concept in the namespace, so the client drops the
 * rest: with Xenova/all-MiniLM-L6-v2, related text scored about 0.67-0.88 and
 * unrelated text 0.45-0.64.
 */
export const DEFAULT_MIN_RELEVANCE_SCORE = 0.65;

/**
 * Prepend the Polytician concepts most relevant to the prompt, from the
 * server's Polytician namespace (mcpServer.polyticianNamespace). Throws when
 * Polytician reports an error (an MCPToolError carrying its code), so the
 * caller can report it.
 */
export async function enrichWithPolyticianContext(
  prompt: string,
  config: EnrichmentConfig
): Promise<EnrichmentResult> {
  const {
    mcpServer,
    maxContextLength = 8000,
    topK = 5,
    minRelevanceScore = DEFAULT_MIN_RELEVANCE_SCORE,
  } = config;

  const unenriched: EnrichmentResult = {
    enrichedPrompt: prompt,
    context: '',
    conceptsUsed: [],
    contextLength: prompt.length,
    truncated: false,
  };
  if (!prompt.trim()) {
    return unenriched;
  }

  const client = new PolyticianMCPClient(mcpServer);
  const conceptsUsed: ConceptReference[] = [];
  const conceptContexts: string[] = [];

  try {
    await client.connect();

    const { results } = await callPolytician(client, 'search_concepts', {
      query: prompt.slice(0, MAX_QUERY_LENGTH),
      k: clampCount(topK, SEARCH_K_MAX, 5),
    });
    const matchedConcepts = results.filter(hit => hit.score >= minRelevanceScore && hit.representations.markdown);

    let totalContextLength = 0;

    for (const hit of matchedConcepts) {
      let markdown: string | null | undefined;
      try {
        ({ markdown } = await callPolytician(client, 'read_concept', {
          id: hit.id,
          representations: ['markdown'],
        }));
      } catch (error) {
        // A concept deleted between the search and the read is skipped
        if (error instanceof MCPToolError && error.code === 'NOT_FOUND') {
          continue;
        }
        throw error;
      }

      if (!markdown) {
        continue;
      }

      const name = conceptTitle(markdown, hit.id);
      const conceptBlock = formatConceptBlock(hit.id, name, hit.tags, markdown);
      const blockLength = conceptBlock.length;

      if (totalContextLength + blockLength > maxContextLength - prompt.length - 500) {
        break;
      }

      conceptContexts.push(conceptBlock);
      totalContextLength += blockLength;
      conceptsUsed.push({
        id: hit.id,
        name,
        relevanceScore: hit.score,
      });
    }
  } finally {
    await client.disconnect();
  }

  if (conceptContexts.length === 0) {
    return unenriched;
  }

  const context = conceptContexts.join('\n\n');
  const contextHeader = `## Semantic Memory Context\n\nThe following concepts from the knowledge base are relevant to your task:\n\n`;
  // A blank line before the rule, or Markdown reads the last line above it as a heading
  const contextFooter = `\n\n---\n\n## Task\n\n`;

  let enrichedPrompt = contextHeader + context + contextFooter + prompt;

  const truncated = enrichedPrompt.length > maxContextLength;
  if (truncated) {
    enrichedPrompt = enrichedPrompt.slice(0, maxContextLength - 3) + '...';
  }

  return {
    enrichedPrompt,
    context,
    conceptsUsed,
    contextLength: enrichedPrompt.length,
    truncated,
  };
}

/** A concept as it goes into the prompt: its name as a heading, its id and tags, and a preview of its markdown. */
export function formatConceptBlock(id: string, name: string, tags: string[], markdown: string): string {
  const lines: string[] = [];

  lines.push(`### ${name}`);
  lines.push(`ID: ${id}`);

  if (tags.length > 0) {
    lines.push(`Tags: ${tags.join(', ')}`);
  }

  lines.push('');
  lines.push(previewBody(markdown));

  return lines.join('\n');
}

const PREVIEW_CHARS = 1000;
const ATX_HEADING_MARKER = /^ {0,3}(#{1,6})(?=[ \t])/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// Lines a Setext underline cannot turn into a heading: blank, headings, list
// items, quotes, indented code
const NOT_PARAGRAPH_TEXT = /^(?:\s*$| {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>)| {4}|\t)/;

/**
 * A concept's markdown as it goes under its block heading. The title heading
 * is dropped (it is the block heading), and the body's headings are pushed
 * three levels down, Setext ones made ATX, so a concept's own "## Task" is not
 * read as the prompt's task section. Fenced code is left as it is. The body is
 * cut to PREVIEW_CHARS, closing a fence the cut leaves open.
 */
function previewBody(markdown: string): string {
  const source = markdown.split(/\r?\n/);
  const { fenced } = markdownFences(source);
  const out: string[] = [];

  let titleDropped = false;
  for (const [i, line] of source.entries()) {
    if (!titleDropped && !line.trim()) {
      continue;
    }
    if (!titleDropped) {
      titleDropped = true;
      if (!fenced[i] && ATX_HEADING_MARKER.test(line)) {
        continue;
      }
    }

    if (fenced[i]) {
      out.push(line);
      continue;
    }

    const underline = SETEXT_UNDERLINE.exec(line)?.[1];
    const previous = source[i - 1];
    if (
      underline && previous !== undefined && !fenced[i - 1] && out.length > 0 &&
      !NOT_PARAGRAPH_TEXT.test(previous) && !SETEXT_UNDERLINE.test(previous) && !THEMATIC_BREAK.test(previous)
    ) {
      out[out.length - 1] = `${underline.startsWith('=') ? '####' : '#####'} ${previous.trim()}`;
      continue;
    }

    out.push(line.replace(ATX_HEADING_MARKER, (_heading, hashes: string) => '#'.repeat(Math.min(6, hashes.length + 3))));
  }

  // Only blank lines are trimmed at the start: indentation there can be code
  const body = out.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (body.length <= PREVIEW_CHARS) {
    return body;
  }
  const cut = body.slice(0, PREVIEW_CHARS);
  const { openFence } = markdownFences(cut.split('\n'));
  return openFence ? `${cut}\n${openFence}\n...` : `${cut}...`;
}

/**
 * Save an orchestration session's result as a Polytician concept (markdown,
 * tagged "orchestration" and "session:<id>") in the server's Polytician
 * namespace and return the stored concept's id. Throws when Polytician
 * reports an error.
 */
export async function saveConceptFromOrchestration(
  sessionId: string,
  task: string,
  result: string,
  filesChanged: string[],
  mcpServer: MCPServerConfig
): Promise<string> {
  const client = new PolyticianMCPClient(mcpServer);

  try {
    await client.connect();

    const saved = await callPolytician(client, 'save_concept', {
      markdown: buildConceptContent(sessionId, task, result, filesChanged).slice(0, MAX_MARKDOWN_LENGTH),
      tags: ['orchestration', `session:${sessionId}`.slice(0, MAX_TAG_LENGTH)],
      source: { origin: 'user', createdBy: 'agentvault' },
    });

    return saved.id;
  } finally {
    await client.disconnect();
  }
}

/**
 * The concept's title (its first heading, which search and enrichment show as
 * its name) is the task's first line; the session id is in the body and in
 * the session:<id> tag. Concepts have no free-form metadata in 3.0, so the
 * save time and file count go in the markdown too.
 */
function buildConceptContent(
  sessionId: string,
  task: string,
  result: string,
  filesChanged: string[]
): string {
  const firstLine = task
    .split(/\r?\n/)
    .map(line => line.replace(/^ {0,3}#{1,6}[ \t]+/, '').trim())
    .find(Boolean);
  const title = firstLine ? Array.from(firstLine).slice(0, 100).join('') : `Orchestration session ${sessionId}`;

  const lines: string[] = [
    `# ${title}`,
    '',
    `Orchestration session ${sessionId}, saved at ${new Date().toISOString()}.`,
    '',
    `## Task`,
    task,
    '',
    `## Files Changed (${filesChanged.length})`,
    ...filesChanged.map(f => `- ${f}`),
    '',
    `## Result`,
    result.slice(0, 4000),
  ];

  return lines.join('\n');
}
