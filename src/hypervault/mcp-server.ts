/**
 * Native MCP server — `agentvault mcp serve`
 *
 * AgentVault's first real MCP *server* (it previously only consumed MCP via
 * PolyticianMCPClient and had serverless wiki tool definitions). Implements
 * the Model Context Protocol over stdio (default) or newline-delimited
 * JSON-RPC — enough for `initialize`, `tools/list`, and `tools/call` — with
 * no new runtime dependency. This makes the entire store→chain pipeline
 * "MCP available": an agent with this server can archive its own mind.
 *
 * Tools exposed:
 *   Pipeline (net-new): hypervault_bootstrap, hypervault_pull, hypervault_push,
 *     hypervault_snapshot, hypervault_archive, hypervault_verify,
 *     hypervault_restore, hypervault_status, hypervault_recall_local
 *   Wiki (already defined, finally served): the 10 wiki_* tools
 */

import * as readline from 'node:readline';
import type { MCPToolCallResult, MCPToolDefinition } from '../orchestration/mcp-client.js';
import { getWikiToolDefinitions, handleWikiToolCall, type WikiMCPConfig } from '../wiki/mcp-tools.js';
import { clientFromProject } from './pipeline.js';
import {
  archiveHyperVault,
  bootstrapHyperVault,
  pullHyperVault,
  pushHyperVault,
  recallLocal,
  restoreHyperVault,
  snapshotHyperVault,
  statusHyperVault,
  verifySnapshotFile,
} from './pipeline.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'agentvault';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** The pipeline (hypervault_*) tool definitions served natively. */
export function getHyperVaultToolDefinitions(): MCPToolDefinition[] {
  return [
    {
      name: 'hypervault_bootstrap',
      description: 'Scaffold a HyperVault-backed agent: connect, pull memories & mind, build indices, wire MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Target project directory' },
          branch: { type: 'string', description: 'Mind branch to pull (default main)' },
          no_artifacts: { type: 'boolean', description: 'Skip artifact content' },
          no_index: { type: 'boolean', description: 'Skip building local indices' },
          soul: { type: 'string', description: 'Memory slug to use as the agent soul' },
        },
        required: ['project'],
      },
    },
    {
      name: 'hypervault_pull',
      description: 'Incremental export from hypervault.store into the local snapshot, working tree, and indices.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          since: { type: 'string', description: 'ISO cursor; defaults to the last sync cursor' },
          no_artifacts: { type: 'boolean' },
          no_index: { type: 'boolean' },
        },
      },
    },
    {
      name: 'hypervault_push',
      description: 'Push locally edited memories back up as provenance-stamped mind commits.',
      inputSchema: {
        type: 'object',
        properties: { dry_run: { type: 'boolean', description: 'Print the diff-as-mind-commits without writing' } },
      },
    },
    {
      name: 'hypervault_snapshot',
      description: 'Full export → agentvault-hypervault-snapshot-v1 bundle on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Output bundle path' },
          passphrase: { type: 'string', description: 'Encrypt entries with a passphrase-derived key' },
          include_conversations: { type: 'boolean' },
        },
      },
    },
    {
      name: 'hypervault_archive',
      description: 'Sovereign archive pipeline: snapshot → encrypt → canister replay → Arweave → receipts → verify.',
      inputSchema: {
        type: 'object',
        properties: {
          passphrase: { type: 'string' },
          canister_id: { type: 'string' },
          since: { type: 'string' },
          include_conversations: { type: 'boolean' },
        },
      },
    },
    {
      name: 'hypervault_verify',
      description: 'Verify a snapshot bundle: manifest hash, ed25519 signature, Merkle root, per-entry checksums.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Snapshot bundle file path' },
          passphrase: { type: 'string' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'hypervault_restore',
      description: 'Restore a snapshot (ar://<tx> or file) to a local project or a fresh hypervault account.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'ar://<tx-id> or a snapshot file path' },
          to: { type: 'string', enum: ['local', 'hypervault'], description: 'Restore target' },
          passphrase: { type: 'string' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'hypervault_status',
      description: 'The three-tier picture: cloud counts, local sync/indices, canister commit, Arweave receipt.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'hypervault_recall_local',
      description: 'Offline hybrid (lexical + semantic) recall over the local indices.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export interface McpServeOptions {
  projectRoot?: string;
  apiUrl?: string;
  /** Wiki config; when omitted, wiki tools are still listed but return an error */
  wikiConfig?: WikiMCPConfig;
}

function ok(text: string): MCPToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function fail(message: string): MCPToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Handle a hypervault_* tool call. */
export async function handleHyperVaultToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: McpServeOptions = {},
): Promise<MCPToolCallResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  try {
    switch (toolName) {
      case 'hypervault_bootstrap': {
        const result = await bootstrapHyperVault({
          project: String(args.project),
          branch: args.branch ? String(args.branch) : undefined,
          includeArtifacts: args.no_artifacts ? false : undefined,
          buildIndex: args.no_index ? false : undefined,
          soulSlug: args.soul ? String(args.soul) : undefined,
          cwd: projectRoot,
        });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_pull': {
        const client = await clientFromProject({ apiUrl: options.apiUrl, projectRoot });
        const result = await pullHyperVault({
          client,
          projectRoot,
          branch: args.branch ? String(args.branch) : undefined,
          since: args.since ? String(args.since) : undefined,
          includeArtifacts: args.no_artifacts ? false : undefined,
          buildIndex: args.no_index ? false : undefined,
        });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_push': {
        const client = await clientFromProject({ apiUrl: options.apiUrl, projectRoot });
        const result = await pushHyperVault({ client, projectRoot, dryRun: Boolean(args.dry_run) });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_snapshot': {
        const client = await clientFromProject({ apiUrl: options.apiUrl, projectRoot });
        const result = await snapshotHyperVault({
          client,
          projectRoot,
          outputPath: args.output ? String(args.output) : undefined,
          passphrase: args.passphrase ? String(args.passphrase) : undefined,
          includeConversations: Boolean(args.include_conversations),
        });
        return ok(JSON.stringify({ path: result.path, sizeBytes: result.sizeBytes, rowCounts: result.rowCounts }, null, 2));
      }
      case 'hypervault_archive': {
        const client = await clientFromProject({ apiUrl: options.apiUrl, projectRoot });
        const result = await archiveHyperVault({
          client,
          projectRoot,
          passphrase: args.passphrase ? String(args.passphrase) : undefined,
          canisterId: args.canister_id ? String(args.canister_id) : undefined,
          since: args.since ? String(args.since) : undefined,
          includeConversations: Boolean(args.include_conversations),
        });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_verify': {
        const result = await verifySnapshotFile(String(args.ref), {
          passphrase: args.passphrase ? String(args.passphrase) : undefined,
        });
        return result.valid ? ok(JSON.stringify(result, null, 2)) : fail(JSON.stringify(result, null, 2));
      }
      case 'hypervault_restore': {
        const to = args.to === 'hypervault' ? 'hypervault' : 'local';
        const client = to === 'hypervault' ? await clientFromProject({ apiUrl: options.apiUrl, projectRoot }) : undefined;
        const result = await restoreHyperVault({
          ref: String(args.ref),
          to,
          passphrase: args.passphrase ? String(args.passphrase) : undefined,
          projectRoot,
          client,
        });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_status': {
        let client;
        try {
          client = await clientFromProject({ apiUrl: options.apiUrl, projectRoot });
        } catch {
          client = undefined;
        }
        const result = await statusHyperVault({ projectRoot, client });
        return ok(JSON.stringify(result, null, 2));
      }
      case 'hypervault_recall_local': {
        const results = await recallLocal(String(args.query), {
          projectRoot,
          limit: args.limit ? Number(args.limit) : undefined,
        });
        return ok(
          JSON.stringify(
            results.map((r) => ({ id: r.memory.id, title: r.memory.title, score: r.score, matchedBy: r.matchedBy })),
            null,
            2,
          ),
        );
      }
      default:
        return fail(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** All tools this server exposes (pipeline + wiki). */
export function getAllToolDefinitions(): MCPToolDefinition[] {
  return [...getHyperVaultToolDefinitions(), ...getWikiToolDefinitions()];
}

/** Dispatch any tool call (pipeline or wiki). */
export async function dispatchToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: McpServeOptions = {},
): Promise<MCPToolCallResult> {
  if (toolName.startsWith('wiki_')) {
    if (!options.wikiConfig) {
      return fail('Wiki tools require a configured wiki (run this server from a project with a wiki).');
    }
    return handleWikiToolCall(options.wikiConfig, toolName, args);
  }
  return handleHyperVaultToolCall(toolName, args, options);
}

// ---------------------------------------------------------------------------
// JSON-RPC transport (stdio)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Serve the MCP protocol over stdin/stdout (newline-delimited JSON-RPC).
 * Resolves when the input stream closes.
 */
export async function serveMcp(options: McpServeOptions & { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const send = (message: Record<string, unknown>): void => {
    output.write(JSON.stringify(message) + '\n');
  };

  const respond = (id: JsonRpcRequest['id'], result: unknown): void => {
    if (id === undefined || id === null) return; // notification — no response
    send({ jsonrpc: '2.0', id, result });
  };
  const respondError = (id: JsonRpcRequest['id'], code: number, message: string): void => {
    if (id === undefined || id === null) return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      respondError(null, -32700, 'Parse error');
      continue;
    }

    switch (req.method) {
      case 'initialize':
        respond(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        break;
      case 'notifications/initialized':
      case 'initialized':
        // notification, no reply
        break;
      case 'ping':
        respond(req.id, {});
        break;
      case 'tools/list':
        respond(req.id, { tools: getAllToolDefinitions() });
        break;
      case 'tools/call': {
        const params = req.params ?? {};
        const name = String(params.name ?? '');
        const toolArgs = (params.arguments as Record<string, unknown>) ?? {};
        const result = await dispatchToolCall(name, toolArgs, options);
        respond(req.id, result);
        break;
      }
      default:
        respondError(req.id ?? null, -32601, `Method not found: ${req.method}`);
    }
  }
}
