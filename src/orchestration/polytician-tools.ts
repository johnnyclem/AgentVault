/**
 * Polytician 3.0's MCP tool contract, as AgentVault calls it.
 *
 * The argument types mirror the tools' input schemas, which are strict in 3.0
 * (an unknown key is a VALIDATION_ERROR, not silently dropped), so a 2.x-style
 * call does not compile. The zod schemas mirror the tools' outputSchema, so a
 * result AgentVault cannot read is reported instead of being taken for an
 * empty one; keys they do not name are ignored, so a newer server can add
 * fields. The recorded contract is in tests/fixtures/polytician-3.0/.
 *
 * Every call to a tool that takes a namespace names the client's Polytician
 * namespace (MCPServerConfig.polyticianNamespace), so one agent's concepts stay
 * in one namespace whichever AgentVault surface wrote them.
 */

import { z } from 'zod';
import {
  MCPTimeoutError,
  MCPToolError,
  type MCPRequestOptions,
  type PolyticianMCPClient,
} from './mcp-client.js';

/** Input limits from Polytician 3.0's tool schemas. */
export const SEARCH_K_MAX = 100;
export const LIST_LIMIT_MAX = 100;
export const MAX_QUERY_LENGTH = 100_000;
export const MAX_MARKDOWN_LENGTH = 1_000_000;
export const MAX_TAG_LENGTH = 128;

/**
 * Tools Polytician registers only when it is configured for AgentVault
 * (POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN); vault_archive_concept
 * also needs agentVault.archival enabled.
 */
export const POLYTICIAN_VAULT_TOOLS = [
  'vault_archive_concept',
  'vault_get_secret',
  'vault_infer',
  'vault_memory_pull',
  'vault_memory_push',
  'vault_memory_repo_log',
] as const;

/**
 * How long AgentVault waits for the vault_* tools, which make Polytician call
 * AgentVault's HTTP API: longer than Polytician's own timeouts for those
 * requests, so Polytician answers (with UPSTREAM_ERROR if AgentVault is slow)
 * before AgentVault gives up. Disconnecting closes Polytician's stdin, which
 * stops it mid-call. Other tools use REQUEST_TIMEOUT_MS (30 s).
 */
export const POLYTICIAN_TOOL_TIMEOUT_MS: Readonly<Partial<Record<string, number>>> = {
  // Polytician's upload timeout (agentVault.archival.timeoutMs) defaults to 120 s
  vault_archive_concept: 150_000,
  // One memory_repo commit request, sent once, with Polytician's 30 s default
  vault_memory_push: 60_000,
  // A branch read retried up to twice at 30 s each, then every imported entry is embedded
  vault_memory_pull: 150_000,
};

/**
 * What a call that got no answer may still have done on AgentVault. A retry
 * of these is not safe: it can commit again or pay for a second permanent
 * upload.
 */
const UNANSWERED_EFFECT: Readonly<Partial<Record<string, string>>> = {
  vault_archive_concept: 'AgentVault may have completed the Arweave upload, which is paid and permanent. ' +
    'Check Arweave or AgentVault before archiving it again',
  vault_memory_push: "AgentVault may have committed the concept to memory_repo. Check the branch's log before pushing it again",
};

/**
 * A vault_* call that changes AgentVault (a memory_repo commit, a paid
 * Arweave upload) and got no answer in time: it may or may not have happened.
 * Its code is OUTCOME_UNKNOWN, AgentVault's own (like INVALID_RESULT).
 */
export class PolyticianOutcomeUnknownError extends MCPToolError {
  constructor(tool: string, timeoutMs: number) {
    const effect = UNANSWERED_EFFECT[tool] ?? 'it may have changed AgentVault';
    super(tool, `no answer within ${timeoutMs / 1000} s. ${effect}.`, 'OUTCOME_UNKNOWN');
    this.message = `${tool} outcome unknown: ${this.serverMessage}`;
  }
}

/**
 * A call Polytician refused because its POLYTICIAN_NAMESPACES allowlist does
 * not include the namespace AgentVault addressed. Its code stays
 * NAMESPACE_DENIED; the message adds the namespace and how to allow it.
 */
export class PolyticianNamespaceDeniedError extends MCPToolError {
  readonly namespace: string;

  constructor(tool: string, serverMessage: string, namespace: string) {
    super(tool, serverMessage, 'NAMESPACE_DENIED');
    this.namespace = namespace;
    this.message = `${this.message}. AgentVault keeps each agent's concepts in its own namespace and addressed '${namespace}': ` +
      `add '${namespace}' to Polytician's POLYTICIAN_NAMESPACES (or "namespaces" in its config file), or use a namespace it allows`;
  }
}

// ---------------------------------------------------------------------------
// Results (outputSchema)
// ---------------------------------------------------------------------------

const assertionStatusSchema = z.enum(['asserted', 'verified', 'contested', 'retracted']).nullable();

const representationFlagsSchema = z.object({
  vector: z.boolean(),
  markdown: z.boolean(),
  thoughtform: z.boolean(),
});

const statsSchema = z.object({
  conceptCount: z.number().int(),
  vectorCount: z.number().int(),
  representationCounts: z.object({
    markdown: z.number().int(),
    thoughtform: z.number().int(),
    vector: z.number().int(),
  }),
});

/** save_concept and read_concept: the concept, with the representations it has (or that were requested). */
const conceptSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  version: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tags: z.array(z.string()),
  markdown: z.string().nullable().optional(),
  thoughtform: z.unknown().optional(),
  embedding: z.array(z.number()).nullable().optional(),
  provenance: z.record(z.string(), z.looseObject({ origin: z.string() })),
  assertionStatus: assertionStatusSchema,
  ledgerRef: z.string().nullable(),
});

const conceptSummarySchema = z.object({
  id: z.string(),
  namespace: z.string(),
  version: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tags: z.array(z.string()),
  representations: representationFlagsSchema,
  assertionStatus: assertionStatusSchema,
});

const OUTPUT_SCHEMAS = {
  save_concept: conceptSchema,
  read_concept: conceptSchema,
  delete_concept: z.object({ deleted: z.string() }),
  list_concepts: z.object({ concepts: z.array(conceptSummarySchema), total: z.number().int() }),
  search_concepts: z.object({
    results: z.array(z.object({
      id: z.string(),
      namespace: z.string(),
      score: z.number().min(0).max(1),
      tags: z.array(z.string()),
      representations: representationFlagsSchema,
      assertionStatus: assertionStatusSchema,
    })),
  }),
  get_stats: statsSchema,
  health_check: z.object({
    server: z.literal('ok'),
    embedding: z.object({ loaded: z.boolean(), model: z.string(), dimension: z.number().int() }),
    llm: z.object({ provider: z.string() }),
    database: statsSchema,
  }),
  vault_memory_push: z.object({ pushed: z.literal(true), sha: z.string() }),
  vault_memory_pull: z.object({
    pulled: z.literal(true),
    branch: z.string(),
    headSha: z.string(),
    imported: z.number().int(),
    skipped: z.array(z.object({ key: z.string(), reason: z.string() })).optional(),
  }),
  vault_archive_concept: z.object({
    archived: z.literal(true),
    encrypted: z.literal(true),
    txId: z.string(),
    url: z.string(),
    size: z.number(),
  }),
  vault_memory_repo_log: z.object({
    branch: z.string(),
    headSha: z.string(),
    entryCount: z.number().int(),
    conceptKeys: z.array(z.string()),
  }),
};

export type PolyticianToolName = keyof typeof OUTPUT_SCHEMAS;
export type PolyticianToolResult<N extends PolyticianToolName> = z.infer<(typeof OUTPUT_SCHEMAS)[N]>;

// ---------------------------------------------------------------------------
// Arguments (inputSchema, for the tools AgentVault calls)
// ---------------------------------------------------------------------------

type AssertionStatus = 'asserted' | 'verified' | 'contested' | 'retracted';
type Representation = 'vector' | 'markdown' | 'thoughtform';
/** Omitted, callPolytician sends the client's polyticianNamespace; with neither, Polytician uses "default". */
type InNamespace = { namespace?: string };

export interface PolyticianToolArgs {
  save_concept: InNamespace & {
    id?: string;
    expectedVersion?: number;
    markdown?: string;
    embedding?: number[];
    tags?: string[];
    source?: { origin?: 'user' | 'import'; createdBy?: string; model?: string };
    assertionStatus?: AssertionStatus | null;
    ledgerRef?: string | null;
    autoEmbed?: boolean;
  };
  read_concept: InNamespace & { id: string; representations?: Representation[] };
  delete_concept: InNamespace & { id: string };
  list_concepts: InNamespace & { limit?: number; offset?: number; tags?: string[]; assertionStatus?: AssertionStatus[] };
  search_concepts: InNamespace & {
    query?: string;
    vector?: number[];
    k?: number;
    tags?: string[];
    assertionStatus?: AssertionStatus[];
    crossNamespace?: boolean;
  };
  get_stats: InNamespace;
  health_check: InNamespace;
  vault_memory_push: InNamespace & { conceptId: string };
  vault_memory_pull: InNamespace;
  vault_archive_concept: InNamespace & { conceptId: string };
  vault_memory_repo_log: Record<string, never>;
}

/**
 * The tools AgentVault calls whose input schema takes a namespace (Polytician
 * defaults to "default" when it is omitted). vault_memory_repo_log reads the
 * whole branch and takes none; vault_memory_pull imports only the entries
 * recorded for the namespace it names.
 */
export const NAMESPACED_POLYTICIAN_TOOLS: ReadonlySet<PolyticianToolName> = new Set<PolyticianToolName>([
  'save_concept',
  'read_concept',
  'delete_concept',
  'list_concepts',
  'search_concepts',
  'get_stats',
  'health_check',
  'vault_memory_push',
  'vault_memory_pull',
  'vault_archive_concept',
]);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Check a tool result against the tool's output schema; throws MCPToolError (INVALID_RESULT) if it does not match. */
export function parsePolyticianResult<N extends PolyticianToolName>(tool: N, result: unknown): PolyticianToolResult<N> {
  const parsed = OUTPUT_SCHEMAS[tool].safeParse(result);
  if (!parsed.success) {
    throw new MCPToolError(tool, `unexpected result: ${z.prettifyError(parsed.error)}`, 'INVALID_RESULT');
  }
  return parsed.data as PolyticianToolResult<N>;
}

/**
 * Call a Polytician tool and return its typed result. A tool that takes a
 * namespace gets the client's polyticianNamespace unless args name one. Throws
 * MCPToolError with Polytician's error code when the tool fails
 * (PolyticianNamespaceDeniedError for NAMESPACE_DENIED), and with
 * INVALID_RESULT when the result does not match the tool's output schema.
 * Waits POLYTICIAN_TOOL_TIMEOUT_MS for the vault_* tools unless options say
 * otherwise; when an archive or push gets no answer, throws
 * PolyticianOutcomeUnknownError (OUTCOME_UNKNOWN) instead of a timeout.
 */
export async function callPolytician<N extends PolyticianToolName>(
  client: PolyticianMCPClient,
  tool: N,
  args: PolyticianToolArgs[N],
  options: MCPRequestOptions = {},
): Promise<PolyticianToolResult<N>> {
  const timeoutMs = options.timeoutMs ?? POLYTICIAN_TOOL_TIMEOUT_MS[tool];
  const namespace = client.getConfig().polyticianNamespace;
  const callArgs: Record<string, unknown> = NAMESPACED_POLYTICIAN_TOOLS.has(tool) && namespace !== undefined && !('namespace' in args)
    ? { ...args, namespace }
    : args;
  let result: Record<string, unknown>;
  try {
    result = await client.callToolResult(tool, callArgs, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (error) {
    if (error instanceof MCPTimeoutError && UNANSWERED_EFFECT[tool] !== undefined) {
      throw new PolyticianOutcomeUnknownError(tool, error.timeoutMs);
    }
    if (error instanceof MCPToolError && error.code === 'NAMESPACE_DENIED') {
      throw new PolyticianNamespaceDeniedError(tool, error.serverMessage, String(callArgs['namespace'] ?? 'default'));
    }
    throw error;
  }
  return parsePolyticianResult(tool, result);
}

/** True when the error is Polytician answering that it has no tool by this name. */
export function isUnknownToolError(error: unknown, tool: string): boolean {
  return error instanceof MCPToolError && error.code === 'NOT_FOUND' && error.serverMessage === `Tool ${tool} not found`;
}

/** Why a vault_* tool is missing from a Polytician server. */
export function vaultToolUnavailableMessage(tool: string): string {
  const archival = tool === 'vault_archive_concept' ? '; vault_archive_concept also needs agentVault.archival enabled in its config file' : '';
  return `Polytician does not offer ${tool}: it registers its vault_* tools only when it is configured for AgentVault. ` +
    'Set AGENTVAULT_API_URL (AgentVault\'s base URL) and AGENTVAULT_POLYTICIAN_API_TOKEN, which AgentVault passes to the ' +
    'Polytician it starts as POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN, or set those for Polytician yourself ' +
    `(agentvault polytician config writes its config file)${archival}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Which markdown lines belong to a fenced code block (the fence lines
 * included), and the fence still open after the last line, if any. A fence is
 * closed by a line of the same character, at least as long, with nothing after it.
 */
export function markdownFences(lines: readonly string[]): { fenced: boolean[]; openFence: string | null } {
  const fenced: boolean[] = [];
  let openFence: string | null = null;
  for (const line of lines) {
    if (openFence === null) {
      const marker = FENCE.exec(line)?.[1];
      fenced.push(marker !== undefined);
      openFence = marker ?? null;
    } else {
      fenced.push(true);
      const marker = CLOSING_FENCE.exec(line)?.[1];
      if (marker !== undefined && marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = null;
      }
    }
  }
  return { fenced, openFence };
}

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * A concept's display name: its markdown's first heading outside a code
 * fence, else its id (3.0 concepts have no name).
 */
export function conceptTitle(markdown: string | null | undefined, id: string): string {
  const lines = markdown?.split(/\r?\n/) ?? [];
  const { fenced } = markdownFences(lines);
  const heading = lines.find((line, i) => !fenced[i] && ATX_HEADING.test(line))?.match(ATX_HEADING)?.[1]?.trim();
  return heading || id;
}

/** A requested count clamped into 1..max; fallback when it is not a number. */
export function clampCount(value: unknown, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.trunc(n)));
}
