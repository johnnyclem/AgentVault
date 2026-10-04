import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * AgentVault's own secrets, kept out of every server's environment, from
 * AgentVault's environment and from MCPServerConfig.env alike: the key the
 * webapp signs memory_repo writes with (the PEM or its path) and the wallet
 * secrets. Polytician reaches memory_repo through the webapp's API and needs
 * none of them, and a key that reached a child process could not be revoked
 * by rotating the API token.
 */
export const WITHHELD_SERVER_ENV = [
  'AGENTVAULT_ICP_IDENTITY_PEM',
  'AGENTVAULT_ICP_IDENTITY_PEM_FILE',
  'AGENTVAULT_MNEMONIC',
  'AGENTVAULT_PRIVATE_KEY',
  'AGENTVAULT_PASSWORD',
  'AGENTVAULT_BUNDLE_SECRET',
] as const;

/** The environment a server is started with: AgentVault's, then config.env over it, without WITHHELD_SERVER_ENV. */
export function serverEnvironment(config: Pick<MCPServerConfig, 'env'>, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, ...config.env, MCP_MODE: 'stdio' };
  for (const name of WITHHELD_SERVER_ENV) {
    delete childEnv[name];
  }
  return childEnv;
}

export interface MCPServerConfig {
  /**
   * The name AgentVault knows the server by (registration, display). It is not
   * a Polytician namespace: see polyticianNamespace.
   */
  namespace: string;
  entryPoint: string;
  healthPort?: number;
  tools?: string[];
  metadata?: Record<string, string>;
  /**
   * The Polytician namespace every call to a tool that takes one names (see
   * callPolytician). Unset, those calls name none and Polytician uses "default".
   */
  polyticianNamespace?: string;
  /** Polytician's config file, passed to the server as --config <path>. */
  configPath?: string;
  /** Environment variables for the server, over AgentVault's own environment (see serverEnvironment). */
  env?: Record<string, string>;
}

export interface MCPServerRegistration extends MCPServerConfig {
  registeredAt: number;
  lastHealthCheck?: number;
  healthy: boolean;
}

export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  /** The tool's typed result (MCP 2025-06-18 and later); servers also put it, as JSON, in content[0].text. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface MCPServerInfo {
  name: string;
  version: string;
}

/** Requested in initialize: the first MCP revision with structuredContent and outputSchema. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Revisions the client accepts in the initialize answer. Results are read from
 * structuredContent when present and from content[0].text otherwise, so the
 * older revisions work too.
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** How long a request waits for its answer unless the caller gives a timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_000;

/**
 * A tool call the server answered with isError: true. Polytician 3.0 puts
 * { error, code, currentVersion? } in content[0].text, where code is one of
 * NOT_FOUND, VALIDATION_ERROR, VERSION_CONFLICT, NAMESPACE_DENIED,
 * OVERWRITE_REFUSED, CONVERSION_ERROR, EMBEDDING_MODEL_MISMATCH, CONFIG_ERROR,
 * UPSTREAM_ERROR or INTERNAL_ERROR. INVALID_RESULT is AgentVault's own code for
 * a result it cannot read.
 */
export class MCPToolError extends Error {
  readonly tool: string;
  readonly code: string | undefined;
  readonly serverMessage: string;
  readonly currentVersion: number | undefined;

  constructor(tool: string, serverMessage: string, code?: string, currentVersion?: number) {
    super(`${tool} failed${code ? ` (${code})` : ''}: ${serverMessage}`);
    this.name = 'MCPToolError';
    this.tool = tool;
    this.code = code;
    this.serverMessage = serverMessage;
    this.currentVersion = currentVersion;
  }
}

/**
 * A request the server did not answer within its timeout. The server may
 * still be working on it, so a tool call that changes state may yet complete.
 */
export class MCPTimeoutError extends Error {
  readonly method: string;
  readonly tool: string | undefined;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number, tool?: string) {
    super(`MCP request ${tool ? `${method} ${tool}` : method} got no answer within ${timeoutMs / 1000} s`);
    this.name = 'MCPTimeoutError';
    this.method = method;
    this.tool = tool;
    this.timeoutMs = timeoutMs;
  }
}

export interface MCPRequestOptions {
  /** How long to wait for the answer (default REQUEST_TIMEOUT_MS) */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a tools/call result: structuredContent when present, else the JSON
 * object in the first text content item. Throws MCPToolError when the tool
 * reports isError (with the server's code when the text is an { error, code }
 * body) or when a successful result carries no JSON object.
 */
export function parseToolResult(tool: string, result: MCPToolCallResult): Record<string, unknown> {
  const text = result.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;

  if (result.isError) {
    const body = parseJsonObject(text);
    throw new MCPToolError(
      tool,
      typeof body?.error === 'string' ? body.error : (text ?? 'the tool reported an error'),
      typeof body?.code === 'string' ? body.code : undefined,
      typeof body?.currentVersion === 'number' ? body.currentVersion : undefined,
    );
  }

  if (isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  const parsed = parseJsonObject(text);
  if (parsed) {
    return parsed;
  }
  throw new MCPToolError(tool, 'the result has no structuredContent and no JSON object in its text content', 'INVALID_RESULT');
}

interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface InitializeResult {
  protocolVersion?: unknown;
  serverInfo?: { name?: unknown; version?: unknown };
}

export class PolyticianMCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private connected = false;
  private connecting: Promise<void> | null = null;
  private stderrTail = '';
  private serverInfo: MCPServerInfo | null = null;
  private protocolVersion: string | null = null;

  constructor(private config: MCPServerConfig) {
    super();
  }

  /**
   * Spawn the server and run the MCP handshake: initialize (written right away;
   * the pipe holds it until the server reads stdin), a check that the answered
   * protocol version is one this client supports, then notifications/initialized.
   * A call made while a handshake is running waits for that handshake.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.spawnAndInitialize().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async spawnAndInitialize(): Promise<void> {
    const [command, ...args] = this.config.entryPoint.trim().split(/\s+/);
    if (!command) {
      throw new Error('Invalid entry point: empty command');
    }
    // A separate argument, so a path with spaces survives
    if (this.config.configPath) {
      args.push('--config', this.config.configPath);
    }

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: serverEnvironment(this.config),
    });
    this.process = child;
    this.buffer = '';
    this.stderrTail = '';

    // Decode as a stream: a multi-byte character split across two pipe reads
    // (a response over 64 KiB) would otherwise turn into two U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (data: string) => {
      this.handleData(data);
    });

    child.stderr.on('data', (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      this.emit('stderr', text);
    });

    // Writes to a server that has exited fail with EPIPE; the close handler reports it.
    child.stdin.on('error', () => {});

    child.on('error', (error: Error) => {
      if (this.process === child) {
        this.failPending(error);
      }
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.process === child) {
        this.process = null;
        this.connected = false;
        const exit = code !== null ? `code ${code}` : `signal ${signal}`;
        const stderr = this.stderrTail.trim();
        this.failPending(new Error(`MCP server exited (${exit})${stderr ? `: ${stderr}` : ''}`));
      }
      this.emit('close', code);
    });

    try {
      const result = await this.sendRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'agentvault',
          version: '1.0.0',
        },
      }) as InitializeResult | undefined;

      const version = result?.protocolVersion;
      if (typeof version !== 'string' || !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)) {
        throw new Error(
          `MCP server answered with protocol version ${String(version)}; this client supports ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(', ')}`
        );
      }
      this.protocolVersion = version;
      const info = result?.serverInfo;
      this.serverInfo = typeof info?.name === 'string' && typeof info.version === 'string'
        ? { name: info.name, version: info.version }
        : null;

      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.connected = true;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          // Ignore lines that are not JSON-RPC
          continue;
        }
        this.handleMessage(message);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    // A request from the server shares the id space of our requests, so it must
    // not be taken for a response: answer ping, refuse anything else.
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        this.write(message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'MCP request failed'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    this.process?.stdin?.write(JSON.stringify(message) + '\n');
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private async sendRequest(
    method: string,
    params?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
    tool?: string
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('MCP client not connected'));
        return;
      }

      const id = ++this.requestId;
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new MCPTimeoutError(method, timeoutMs, tool));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list') as { tools: MCPToolDefinition[] };
    return result.tools || [];
  }

  /**
   * Call a tool and return the raw result. A tool error is a result with
   * isError: true, not a rejection; use callToolResult to have it thrown.
   * Rejects with MCPTimeoutError when the server does not answer in time.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: MCPRequestOptions = {}
  ): Promise<MCPToolCallResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }, options.timeoutMs, name) as MCPToolCallResult;
    return result;
  }

  /**
   * Call a tool and return its result object (structuredContent, else the JSON
   * in content[0].text). Throws MCPToolError, with the server's error code,
   * when the tool fails.
   */
  async callToolResult(
    name: string,
    args: Record<string, unknown> = {},
    options: MCPRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    return parseToolResult(name, await this.callTool(name, args, options));
  }

  /**
   * Close the server's stdin (an MCP stdio server exits when it closes) and
   * wait briefly for it to exit before killing it.
   */
  async disconnect(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }
    this.process = null;
    this.connected = false;
    this.failPending(new Error('MCP client disconnected'));

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, DISCONNECT_GRACE_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConfig(): MCPServerConfig {
    return this.config;
  }

  /** The server's name and version from initialize (null before connect). */
  getServerInfo(): MCPServerInfo | null {
    return this.serverInfo;
  }

  /** The protocol version the server answered in initialize (null before connect). */
  getProtocolVersion(): string | null {
    return this.protocolVersion;
  }
}

/**
 * Probe an MCP server's HTTP health endpoint. Polytician 3.0 serves one only
 * on its HTTP transport or, in stdio mode, when the operator sets
 * POLYTICIAN_HEALTH_PORT; it belongs to that running instance, not to a stdio
 * server this client spawns (use the health_check tool for that).
 */
export async function probeMCPServerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function discoverMCPTools(entryPoint: string): Promise<string[]> {
  const client = new PolyticianMCPClient({
    namespace: '_discovery',
    entryPoint,
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    return tools.map(t => t.name);
  } finally {
    await client.disconnect();
  }
}
