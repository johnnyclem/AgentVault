/**
 * Total Recall — MCP tools
 *
 * Served by `agentvault mcp serve` next to the hypervault_* and wiki_* tools.
 * Two assistants connect to the same server config (ChatGPT through its MCP
 * connector, Claude through .mcp.json); both get the same guardrail in
 * `initialize.instructions`, both record into one volume, and the one being
 * migrated to catches up with `total_recall_pull`.
 *
 *   total_recall_record      write a memory event (created/recalled/updated/deleted)
 *   total_recall_transcribe  append a conversation turn (transcript mode only)
 *   total_recall_pull        events after a cursor — the ingestion path
 *   total_recall_list        current memories, folded from their events
 *   total_recall_search      lexical search over current memories
 *   total_recall_history     every version of one memory
 *   total_recall_status      counts, heads, policy, last anchor
 *   total_recall_verify      re-walk both hash chains
 *   total_recall_policy      the guardrail text, for an agent to re-read
 */

import type { MCPToolCallResult, MCPToolDefinition } from '../orchestration/mcp-client.js';
import { MEMORY_OPS, TRANSCRIPT_ROLES, type MemoryOp, type TranscriptRole } from './format.js';
import { hasSinks, notifyEvent } from './notify.js';
import { policyInstructions, policyRefusal } from './policy.js';
import { TotalRecallVolume } from './volume.js';

export const TOTAL_RECALL_TOOL_PREFIX = 'total_recall_';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const APPEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function getTotalRecallToolDefinitions(): MCPToolDefinition[] {
  return [
    {
      name: 'total_recall_record',
      description:
        'Record a memory event in the total-recall archive. Call this every time you create, recall, update or delete a memory about the user. Append-only: nothing is overwritten.',
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...MEMORY_OPS], description: 'What happened to the memory' },
          key: { type: 'string', description: "The memory's stable id or slug in your own memory system" },
          content: { type: 'string', description: 'The full memory text as you hold it now' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          provider: { type: 'string', description: 'Your product name: "chatgpt", "claude", "gemini", ...' },
          agent: { type: 'string', description: 'Your model or agent identity, if you know it' },
          session: { type: 'string', description: 'The conversation id this happened in, if you know it' },
        },
        required: ['op', 'key', 'content', 'provider'],
      },
      annotations: APPEND,
    },
    {
      name: 'total_recall_transcribe',
      description: 'Append one conversation turn to the full transcript (only when the volume has transcript mode on).',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: [...TRANSCRIPT_ROLES] },
          content: { type: 'string', description: 'The complete text of the turn' },
          session: { type: 'string', description: 'A stable id for this conversation' },
          provider: { type: 'string' },
          model: { type: 'string' },
          timestamp: { type: 'string', description: 'ISO time; defaults to now' },
          message_id: { type: 'string', description: "The provider's own message id, if any" },
        },
        required: ['role', 'content', 'session', 'provider'],
      },
      annotations: APPEND,
    },
    {
      name: 'total_recall_pull',
      description:
        'Memory events after a cursor, oldest first, with next_seq to pass back. Start at since_seq 0 to ingest everything another assistant has remembered.',
      inputSchema: {
        type: 'object',
        properties: {
          since_seq: { type: 'number', description: 'Return events with seq greater than this (default 0)' },
          limit: { type: 'number', description: 'Max events (default 100, max 1000)' },
          ops: { type: 'array', items: { type: 'string', enum: [...MEMORY_OPS] }, description: 'Only these ops' },
          provider: { type: 'string', description: 'Only events from this provider' },
        },
      },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_list',
      description: 'Current memories (latest version of each), folded from the archive.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          include_deleted: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_search',
      description: 'Lexical search over current memories (title, tags, content).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          provider: { type: 'string' },
          include_deleted: { type: 'boolean' },
        },
        required: ['query'],
      },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_history',
      description: 'Every recorded version and recall of one memory, oldest first.',
      inputSchema: {
        type: 'object',
        properties: { provider: { type: 'string' }, key: { type: 'string' } },
        required: ['provider', 'key'],
      },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_status',
      description: 'Volume status: event counts, chain heads, policy, last anchor.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_verify',
      description: 'Re-walk the memory and transcript hash chains and check them against the last anchor.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY,
    },
    {
      name: 'total_recall_policy',
      description: 'The guardrail this volume asks every connected assistant to follow, and the policy behind it.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ_ONLY,
    },
  ];
}

export interface TotalRecallToolOptions {
  /** Volume directory. The volume is created on first write if missing. */
  volumeDir: string;
  /** Called with each delivery failure (default: a line on stderr) */
  onDeliveryError?: (sink: string, error: string) => void;
}

function ok(value: unknown): MCPToolCallResult {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
  };
}

function fail(message: string): MCPToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`"${name}" must be a non-empty string`);
  return value;
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optStrArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error('"tags" must be an array of strings');
  return value as string[];
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(max, n));
}

/** Resolve the volume: open it, or create it on a write. */
function volumeFor(options: TotalRecallToolOptions, forWrite: boolean): TotalRecallVolume {
  if (TotalRecallVolume.exists(options.volumeDir)) return TotalRecallVolume.open(options.volumeDir);
  if (forWrite) return TotalRecallVolume.init(options.volumeDir);
  throw new Error(`No total-recall volume at ${options.volumeDir} yet (nothing has been recorded)`);
}

export async function handleTotalRecallToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: TotalRecallToolOptions,
): Promise<MCPToolCallResult> {
  try {
    switch (toolName) {
      case 'total_recall_record': {
        const op = str(args.op, 'op') as MemoryOp;
        if (!MEMORY_OPS.includes(op)) return fail(`"op" must be one of ${MEMORY_OPS.join(', ')}`);
        const provider = str(args.provider, 'provider').toLowerCase();
        const volume = volumeFor(options, true);
        const refusal = policyRefusal(volume.policy, { kind: 'memory', op, provider });
        if (refusal) return fail(refusal);
        const event = volume.appendMemoryEvent({
          op,
          source: { provider, agent: optStr(args.agent), session: optStr(args.session) },
          memory: {
            key: str(args.key, 'key'),
            content: typeof args.content === 'string' ? args.content : '',
            title: optStr(args.title),
            tags: optStrArray(args.tags),
          },
        });
        let delivered: Array<{ sink: string; ok: boolean; error?: string }> = [];
        if (hasSinks(volume.policy)) {
          delivered = await notifyEvent(volume.policy, event, { volumeId: volume.volumeId });
          for (const d of delivered) {
            if (!d.ok) {
              (options.onDeliveryError ?? ((sink, error) => process.stderr.write(`total-recall: ${sink} failed: ${error}\n`)))(
                d.sink,
                d.error ?? 'unknown error',
              );
            }
          }
        }
        return ok({ recorded: true, seq: event.seq, id: event.id, hash: event.hash, delivered });
      }
      case 'total_recall_transcribe': {
        const role = str(args.role, 'role') as TranscriptRole;
        if (!TRANSCRIPT_ROLES.includes(role)) return fail(`"role" must be one of ${TRANSCRIPT_ROLES.join(', ')}`);
        const provider = str(args.provider, 'provider').toLowerCase();
        const volume = volumeFor(options, true);
        const refusal = policyRefusal(volume.policy, { kind: 'transcript', provider });
        if (refusal) return fail(refusal);
        const message = volume.appendTranscript({
          role,
          content: typeof args.content === 'string' ? args.content : '',
          sessionId: str(args.session, 'session'),
          provider,
          model: optStr(args.model),
          timestamp: optStr(args.timestamp),
          id: optStr(args.message_id),
        });
        return ok({ recorded: true, seq: message.seq, id: message.id, hash: message.hash });
      }
      case 'total_recall_pull': {
        const volume = volumeFor(options, false);
        const sinceSeq = typeof args.since_seq === 'number' ? Math.max(0, Math.floor(args.since_seq)) : 0;
        const limit = clampLimit(args.limit, 100, 1000);
        const ops = Array.isArray(args.ops) ? (args.ops.filter((o) => MEMORY_OPS.includes(o as MemoryOp)) as MemoryOp[]) : undefined;
        const events = volume.readMemoryEvents({ sinceSeq, limit, ops, provider: optStr(args.provider) });
        const head = volume.memoriesSeq();
        const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : sinceSeq;
        return ok({ events, next_seq: nextSeq, head_seq: head, more: nextSeq < head });
      }
      case 'total_recall_list': {
        const volume = volumeFor(options, false);
        const memories = volume.foldMemories({ includeDeleted: Boolean(args.include_deleted), provider: optStr(args.provider) });
        const limit = clampLimit(args.limit, memories.length || 1, 10_000);
        return ok({ count: memories.length, memories: memories.slice(0, limit) });
      }
      case 'total_recall_search': {
        const volume = volumeFor(options, false);
        const results = volume.searchMemories(str(args.query, 'query'), {
          limit: clampLimit(args.limit, 10, 200),
          includeDeleted: Boolean(args.include_deleted),
          provider: optStr(args.provider),
        });
        return ok({ results });
      }
      case 'total_recall_history': {
        const volume = volumeFor(options, false);
        return ok({ events: volume.memoryHistory(str(args.provider, 'provider').toLowerCase(), str(args.key, 'key')) });
      }
      case 'total_recall_status': {
        const volume = volumeFor(options, false);
        return ok(volume.status());
      }
      case 'total_recall_verify': {
        const volume = volumeFor(options, false);
        const result = volume.verify();
        return result.valid ? ok(result) : { ...ok(result), isError: true };
      }
      case 'total_recall_policy': {
        const volume = TotalRecallVolume.exists(options.volumeDir) ? TotalRecallVolume.open(options.volumeDir) : null;
        const policy = volume?.policy ?? (await import('./policy.js')).defaultPolicy();
        return ok({ instructions: policyInstructions(policy, { volumeId: volume?.volumeId }), policy, volume_dir: options.volumeDir });
      }
      default:
        return fail(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Server `instructions` for the volume, or undefined when nothing should be injected. */
export function totalRecallInstructions(volumeDir: string): string | undefined {
  if (!TotalRecallVolume.exists(volumeDir)) return undefined;
  const volume = TotalRecallVolume.open(volumeDir);
  if (!volume.policy.recordMemories && volume.policy.transcript === 'off') return undefined;
  return policyInstructions(volume.policy, { volumeId: volume.volumeId });
}
