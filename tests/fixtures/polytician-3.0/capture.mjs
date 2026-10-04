#!/usr/bin/env node
/**
 * Captures Polytician 3.0's MCP tool contract as AgentVault's orchestrator
 * sees it: spawns the real server over stdio, performs the MCP handshake and
 * records tools/list entries plus real request/response pairs (successes,
 * errors, removed 2.x tools, vault_* tools) as one JSON document.
 *
 * Every server gets a fresh temporary POLYTICIAN_DATA_DIR and HOME, and every
 * inherited POLYTICIAN_* variable is dropped, so a real data directory or
 * ~/.polytician/config.json is never touched. The vault_* run points
 * Polytician at a closed loopback port, so nothing leaves the machine.
 *
 * Usage:
 *   POLYTICIAN_MODELS_DIR=<dir holding Xenova/all-MiniLM-L6-v2> \
 *     node capture.mjs [--out contract.json] [--date YYYY-MM-DD] -- node <polytician>/dist/index.js
 *
 * The server command can also come from POLYTICIAN_ENTRY (split on spaces,
 * as AgentVault splits an entry point). Without POLYTICIAN_MODELS_DIR (or
 * --models) the server downloads the embedding model (~25 MB) on first use.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';

// AgentVault's PolyticianMCPClient sends this protocol version.
const AGENTVAULT_PROTOCOL_VERSION = '2024-11-05';
const PROBED_PROTOCOL_VERSIONS = ['2024-11-05', '2024-10-07', '2025-03-26', '2025-06-18', '2025-11-25', '1999-01-01'];
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const FIXED_TIMESTAMP = '2026-10-04T00:00:00.000Z';
const FIXED_EPOCH_MS = Date.parse(FIXED_TIMESTAMP);
const REQUEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, date: new Date().toISOString().slice(0, 10), models: process.env.POLYTICIAN_MODELS_DIR ?? null, entry: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts.entry = argv.slice(i + 1);
      break;
    }
    if (arg === '--out' || arg === '--date' || arg === '--models') {
      const value = argv[i + 1];
      if (!value) fail(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i++;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  if (!opts.entry || opts.entry.length === 0) {
    const fromEnv = process.env.POLYTICIAN_ENTRY?.trim();
    opts.entry = fromEnv ? fromEnv.split(/\s+/) : null;
  }
  if (!opts.entry) {
    fail('No server command. Pass it after `--` or set POLYTICIAN_ENTRY, e.g. -- node /path/to/polytician/dist/index.js');
  }
  if (opts.models && !fs.existsSync(opts.models)) fail(`Models directory not found: ${opts.models}`);
  return opts;
}

function fail(message) {
  process.stderr.write(`capture: ${message}\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`capture: ${message}\n`);
}

// ---------------------------------------------------------------------------
// Isolated server environment
// ---------------------------------------------------------------------------

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A fresh HOME and data dir, the cached model copied in, no inherited POLYTICIAN_* settings. */
function isolatedEnv(opts, extra = {}) {
  const home = makeTempDir('polytician-contract-home-');
  const dataDir = makeTempDir('polytician-contract-data-');
  if (opts.models) {
    fs.cpSync(opts.models, path.join(dataDir, 'models'), { recursive: true });
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('POLYTICIAN_')) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    POLYTICIAN_DATA_DIR: dataDir,
    POLYTICIAN_NLP_PIPELINE: 'rule-based',
    // AgentVault's client sets this; Polytician ignores it.
    MCP_MODE: 'stdio',
    LOG_LEVEL: 'warn',
  }, extra);
  return { env, home, dataDir };
}

async function closedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Newline-delimited JSON-RPC over the server's stdio
// ---------------------------------------------------------------------------

class Session {
  constructor(entry, env, extraArgs = []) {
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.nonJsonStdoutLines = [];
    this.stderr = '';
    this.exit = null;
    const [command, ...args] = entry;
    this.child = spawn(command, [...args, ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exit = { code, signal };
        for (const { reject } of this.pending.values()) reject(new Error('server exited'));
        this.pending.clear();
        resolve(this.exit);
      });
    });
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.stdin.on('error', () => {});
  }

  onData(data) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.nonJsonStdoutLines.push(line);
        continue;
      }
      const waiter = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (waiter) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  send(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  notify(method, params) {
    const message = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
    this.send(message);
    return message;
  }

  /** Send a request and return { request, response, ms }; response is null on timeout or exit. */
  async request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = ++this.nextId;
    const request = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
    const started = Date.now();
    const response = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(null);
        },
      });
      this.send(request);
    });
    return { request, response, ms: Date.now() - started };
  }

  call(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  /** Close stdin (what a disconnecting client does) and wait for the process to exit. */
  async close(timeoutMs = 10_000) {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }
}

/** Spawn a server and complete the handshake the way a spec-following client does. */
async function openSession(opts, envExtra = {}, extraArgs = []) {
  const isolated = isolatedEnv(opts, envExtra);
  const session = new Session(opts.entry, isolated.env, extraArgs);
  session.isolated = isolated;
  const init = await session.request('initialize', initializeParams(AGENTVAULT_PROTOCOL_VERSION));
  if (!init.response?.result) {
    throw new Error(`initialize failed: ${JSON.stringify(init.response)}\n${session.stderr}`);
  }
  const initialized = session.notify('notifications/initialized');
  return { session, init, initialized };
}

function initializeParams(protocolVersion) {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'agentvault', version: '1.0.0' },
  };
}

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

const timings = [];

function exchange(label, result, note) {
  timings.push({ label, ms: result.ms });
  const entry = { request: result.request, response: result.response };
  return note ? { note, ...entry } : entry;
}

function toolEntry(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

function structured(result) {
  return result.response?.result?.structuredContent;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function orchestrationMarkdown(sessionId, task, filesChanged, result) {
  // The concept text AgentVault's saveConceptFromOrchestration() builds.
  return [
    `# Orchestration Result: ${sessionId}`,
    '',
    '## Task',
    task,
    '',
    '## Files Changed',
    ...filesChanged.map((f) => `- ${f}`),
    '',
    '## Result',
    result,
  ].join('\n');
}

async function captureMain(opts, ids) {
  // AgentVault writes initialize 100 ms after spawn, before the server is
  // listening; this run writes it at spawn time to show the pipe buffers it.
  const isolated = isolatedEnv(opts);
  const session = new Session(opts.entry, isolated.env);
  const init = await session.request('initialize', initializeParams(AGENTVAULT_PROTOCOL_VERSION));
  if (!init.response?.result) throw new Error(`initialize failed: ${session.stderr}`);
  const initialized = session.notify('notifications/initialized');
  const toolsList = await session.request('tools/list', {});
  const tools = toolsList.response.result.tools;

  const out = {
    handshake: {
      initialize: exchange('initialize', init, 'Written at spawn time, before the server has opened its transport; the pipe buffers it and the server answers once ready.'),
      initializedNotification: initialized,
    },
    toolsList: { request: toolsList.request, names: tools.map((t) => t.name).sort(), tools },
    calls: {},
    errors: {},
    removedTools: {},
    vaultToolsWithoutAgentVault: {},
  };

  const healthCold = await session.call('health_check', {});
  out.calls['health_check.cold'] = exchange('health_check.cold', healthCold, 'Before any embedding: the model loads lazily on the first save/search.');

  const saveA = await session.call('save_concept', {
    markdown: orchestrationMarkdown('session-1', 'Refactor the parser to stream tokens', ['src/parser.ts', 'tests/parser.test.ts'], 'Replaced the recursive descent loop with a streaming tokenizer.'),
    tags: ['orchestration', 'session:session-1'],
  });
  ids.register(structured(saveA)?.id);
  out.calls.save_concept = exchange('save_concept', saveA, 'The corrected orchestration save: markdown + tags. The response is the stored concept; its id is in structuredContent.id.');

  const saveB = await session.call('save_concept', {
    markdown: '# Deployment checklist\n\nRotate the canister controller keys before every mainnet upgrade.',
    tags: ['notes'],
  });
  ids.register(structured(saveB)?.id);
  out.calls['save_concept.second'] = exchange('save_concept.second', saveB);

  const search = await session.call('search_concepts', { query: 'refactor the parser', k: 5 });
  out.calls.search_concepts = exchange('search_concepts', search, 'score = (1 + cosine) / 2 in [0, 1], higher is better; every concept in the namespace with a vector is ranked, so filter by score on the client.');

  const idA = structured(saveA)?.id;
  const idB = structured(saveB)?.id;

  const read = await session.call('read_concept', { id: idA });
  out.calls.read_concept = exchange('read_concept', read, 'As AgentVault sends it: { id } returns every representation, including the 384-float embedding.');
  const readMarkdown = await session.call('read_concept', { id: idA, representations: ['markdown'] });
  out.calls['read_concept.markdownOnly'] = exchange('read_concept.markdownOnly', readMarkdown, 'Recommended for prompt enrichment: only the markdown representation.');

  const list = await session.call('list_concepts', { limit: 50, offset: 0 });
  out.calls.list_concepts = exchange('list_concepts', list, 'The webapp concepts route default (limit 50, offset 0).');
  const listPage = await session.call('list_concepts', { limit: 1, offset: 1 });
  out.calls['list_concepts.page2'] = exchange('list_concepts.page2', listPage);

  const stats = await session.call('get_stats', {});
  out.calls.get_stats = exchange('get_stats', stats);
  const health = await session.call('health_check', {});
  out.calls.health_check = exchange('health_check', health);

  // --- Errors: what AgentVault sends today, and other plausible mistakes ---

  out.errors['save_concept.v2Args'] = exchange('save_concept.v2Args', await session.call('save_concept', {
    name: 'orchestration-session-1',
    content: orchestrationMarkdown('session-1', 'Refactor the parser', ['src/parser.ts'], 'done'),
    representation: 'orchestration_result',
    metadata: { sessionId: 'session-1', timestamp: '2026-10-04T00:00:00.000Z', filesChangedCount: 1 },
  }), 'saveConceptFromOrchestration() today: rejected, nothing stored.');
  out.errors['save_concept.noRepresentation'] = exchange('save_concept.noRepresentation', await session.call('save_concept', { tags: ['only-tags'] }));
  out.errors['search_concepts.v2Args'] = exchange('search_concepts.v2Args', await session.call('search_concepts', {
    query: 'refactor the parser',
    limit: 5,
    min_score: 0.3,
  }), 'enrichWithPolyticianContext() today.');
  out.errors['search_concepts.limit'] = exchange('search_concepts.limit', await session.call('search_concepts', {
    query: 'refactor the parser',
    limit: 10,
  }), 'cli/commands/polytician.ts search and the webapp search route today.');
  out.errors['search_concepts.kTooLarge'] = exchange('search_concepts.kTooLarge', await session.call('search_concepts', {
    query: 'refactor the parser',
    k: 101,
  }), 'k is capped at 100; the webapp passes ?limit= through unchecked.');
  out.errors['list_concepts.limitTooLarge'] = exchange('list_concepts.limitTooLarge', await session.call('list_concepts', {
    limit: 101,
    offset: 0,
  }), 'limit is capped at 100; the webapp passes ?limit= through unchecked.');
  out.errors['list_concepts.limitNull'] = exchange('list_concepts.limitNull', await session.call('list_concepts', {
    limit: null,
    offset: 0,
  }), 'What the webapp sends for ?limit=abc: parseInt gives NaN, which JSON.stringify writes as null.');
  out.errors['read_concept.unknownId'] = exchange('read_concept.unknownId', await session.call('read_concept', { id: UNKNOWN_ID }));
  out.errors['read_concept.nonUuidId'] = exchange('read_concept.nonUuidId', await session.call('read_concept', { id: 'concept-123' }), 'Concept ids are UUIDs; the CLI help example uses concept-123.');
  out.errors['delete_concept.unknownId'] = exchange('delete_concept.unknownId', await session.call('delete_concept', { id: UNKNOWN_ID }));
  out.calls['get_stats.afterRejectedCalls'] = exchange('get_stats.afterRejectedCalls', await session.call('get_stats', {}), 'Still the two concepts saved above: the rejected saves stored nothing.');

  // --- Tools AgentVault calls that 3.0 does not have ---

  out.removedTools.archive_concept = exchange('archive_concept', await session.call('archive_concept', { id: idA }), 'cli/commands/polytician.ts archive and the webapp archive route.');
  out.removedTools.push_to_memory_repo = exchange('push_to_memory_repo', await session.call('push_to_memory_repo', {}), 'cli/commands/polytician.ts push-all.');
  out.removedTools.pull_from_memory_repo = exchange('pull_from_memory_repo', await session.call('pull_from_memory_repo', {}), 'cli/commands/polytician.ts pull.');

  // --- vault_* while Polytician has no AgentVault configured ---

  out.vaultToolsWithoutAgentVault.vault_archive_concept = exchange('vault_archive_concept.unconfigured', await session.call('vault_archive_concept', { conceptId: idA }));
  out.vaultToolsWithoutAgentVault.vault_memory_push = exchange('vault_memory_push.unconfigured', await session.call('vault_memory_push', { conceptId: idA }));
  out.vaultToolsWithoutAgentVault.vault_memory_pull = exchange('vault_memory_pull.unconfigured', await session.call('vault_memory_pull', {}));
  out.vaultToolsWithoutAgentVault.vault_memory_repo_log = exchange('vault_memory_repo_log.unconfigured', await session.call('vault_memory_repo_log', {}));

  // --- Delete last, then show the id is gone ---

  out.calls.delete_concept = exchange('delete_concept', await session.call('delete_concept', { id: idB }));
  out.errors['read_concept.afterDelete'] = exchange('read_concept.afterDelete', await session.call('read_concept', { id: idB }));

  const exit = await session.close();
  out.handshake.stdinClosed = { exitCode: exit.code, signal: exit.signal, note: 'Closing stdin is enough to stop the server.' };
  out.handshake.nonJsonStdoutLines = session.nonJsonStdoutLines.length;
  out.relevantTools = tools.filter((t) => RELEVANT_TOOLS.includes(t.name)).map(toolEntry);
  return out;
}

const RELEVANT_TOOLS = ['save_concept', 'read_concept', 'delete_concept', 'list_concepts', 'search_concepts', 'get_stats', 'health_check'];
const VAULT_TOOLS = ['vault_archive_concept', 'vault_memory_push', 'vault_memory_pull', 'vault_memory_repo_log', 'vault_get_secret', 'vault_infer'];

async function captureProtocolVersions(opts) {
  const results = [];
  for (const version of PROBED_PROTOCOL_VERSIONS) {
    const isolated = isolatedEnv(opts);
    const session = new Session(opts.entry, isolated.env);
    const init = await session.request('initialize', initializeParams(version));
    timings.push({ label: `initialize ${version}`, ms: init.ms });
    const result = init.response?.result;
    results.push({
      requested: version,
      answered: result?.protocolVersion ?? null,
      error: init.response?.error ?? null,
    });
    await session.close();
  }
  return results;
}

async function captureWithoutInitialized(opts) {
  // What AgentVault's client does: initialize, never notifications/initialized.
  const isolated = isolatedEnv(opts);
  const session = new Session(opts.entry, isolated.env);
  const init = await session.request('initialize', initializeParams(AGENTVAULT_PROTOCOL_VERSION));
  const list = await session.request('tools/list', {});
  const call = await session.call('get_stats', {});
  await session.close();

  // No initialize at all.
  const bareEnv = isolatedEnv(opts);
  const bare = new Session(opts.entry, bareEnv.env);
  const bareList = await bare.request('tools/list', {});
  const bareCall = await bare.call('get_stats', {});
  await bare.close();

  return {
    initializeWithoutInitializedNotification: {
      note: 'initialize, then tools/list and tools/call with no notifications/initialized (AgentVault\'s client today).',
      initializeAnswered: Boolean(init.response?.result),
      toolsList: { request: list.request, toolCount: list.response?.result?.tools?.length ?? null, error: list.response?.error ?? null },
      toolsCall: exchange('get_stats.noInitializedNotification', call),
    },
    noInitialize: {
      note: 'tools/list and tools/call without any initialize request.',
      toolsList: { request: bareList.request, toolCount: bareList.response?.result?.tools?.length ?? null, error: bareList.response?.error ?? null },
      toolsCall: exchange('get_stats.noInitialize', bareCall),
    },
  };
}

async function captureStartupFailure(opts) {
  // A configuration error: the server exits before answering initialize.
  const isolated = isolatedEnv(opts, { POLYTICIAN_AV_API_URL: 'http://example.com' });
  const session = new Session(opts.entry, isolated.env);
  const init = await session.request('initialize', initializeParams(AGENTVAULT_PROTOCOL_VERSION), 20_000);
  const exit = await session.exited;
  return {
    note: 'POLYTICIAN_AV_API_URL=http://example.com (plain http off loopback) is a configuration error: the process exits before answering, so a client must fail pending requests when the process closes instead of waiting for its request timeout.',
    initializeRequest: init.request,
    initializeResponse: init.response,
    exitCode: exit.code,
    stdoutLines: session.nonJsonStdoutLines.length,
  };
}

async function captureVaultConfigured(opts, ids) {
  // AgentVault configured but unreachable (a closed loopback port), with
  // archival enabled so vault_archive_concept is registered. The dummy wallet
  // and the debounce keep the background archiver from running mid-capture.
  const port = await closedLoopbackPort();
  const configDir = makeTempDir('polytician-contract-config-');
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    agentVault: {
      apiBaseUrl: `http://127.0.0.1:${port}`,
      archival: {
        enabled: true,
        tagFilter: ['archive'],
        debounceMs: 600_000,
        arweaveJwk: JSON.stringify({ kty: 'RSA', n: 'contract-capture-dummy', e: 'AQAB' }),
      },
    },
  }, null, 2));
  const { session } = await openSession(opts, {
    POLYTICIAN_AV_API_TOKEN: 'contract-capture-dummy-token',
    POLYTICIAN_BACKUP_KEY: crypto.randomBytes(32).toString('hex'),
  }, ['--config', configPath]);

  const toolsList = await session.request('tools/list', {});
  const tools = toolsList.response.result.tools;

  const untagged = await session.call('save_concept', { markdown: '# Untagged\n\nNot in the archival tag filter.', tags: ['orchestration'] });
  ids.register(structured(untagged)?.id);
  const tagged = await session.call('save_concept', { markdown: '# Tagged\n\nCarries the archival tag.', tags: ['archive'] });
  ids.register(structured(tagged)?.id);
  const untaggedId = structured(untagged)?.id;
  const taggedId = structured(tagged)?.id;

  const calls = {
    'vault_archive_concept.v2Args': exchange('vault_archive_concept.v2Args', await session.call('vault_archive_concept', { id: taggedId }), 'AgentVault\'s archive argument name ({ id }) against the 3.0 tool.'),
    'vault_archive_concept.notTagged': exchange('vault_archive_concept.notTagged', await session.call('vault_archive_concept', { conceptId: untaggedId })),
    'vault_archive_concept.unreachable': exchange('vault_archive_concept.unreachable', await session.call('vault_archive_concept', { conceptId: taggedId })),
    'vault_memory_push.v2Args': exchange('vault_memory_push.v2Args', await session.call('vault_memory_push', {}), 'push-all today sends {}; vault_memory_push pushes one concept.'),
    'vault_memory_push.unreachable': exchange('vault_memory_push.unreachable', await session.call('vault_memory_push', { conceptId: untaggedId })),
    'vault_memory_pull.unreachable': exchange('vault_memory_pull.unreachable', await session.call('vault_memory_pull', {})),
    'vault_memory_repo_log.unreachable': exchange('vault_memory_repo_log.unreachable', await session.call('vault_memory_repo_log', {})),
  };
  await session.close();

  return {
    note: 'Polytician started with agentVault.apiBaseUrl at a closed loopback port, a dummy token, archival enabled (tagFilter ["archive"], a dummy Arweave wallet, a backup key). Shows the vault_* schemas and the errors an unreachable AgentVault produces. With archival or sync push enabled, the concept-writing tools report openWorldHint: true.',
    names: tools.map((t) => t.name).sort(),
    tools: tools.filter((t) => VAULT_TOOLS.includes(t.name)).map(toolEntry),
    calls,
    scrub: { port },
  };
}

// ---------------------------------------------------------------------------
// Volatile values
// ---------------------------------------------------------------------------

class IdMap {
  constructor() {
    this.map = new Map();
  }

  register(id) {
    if (typeof id !== 'string' || this.map.has(id)) return;
    const n = String(this.map.size + 1).padStart(12, '0');
    this.map.set(id, `11111111-1111-4111-8111-${n}`);
  }
}

const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

/**
 * Replace volatile values in the serialized document, so the same strings
 * inside content[0].text and error messages change with them.
 */
function scrub(document, ids, extraReplacements) {
  let text = JSON.stringify(document);
  for (const [real, stable] of ids.map) text = text.split(real).join(stable);
  for (const [real, stable] of extraReplacements) text = text.split(real).join(stable);
  // Ids the server generated but never stored (e.g. in a rejected save's error message).
  const unstored = new Map();
  const stable = new Set([UNKNOWN_ID, ...ids.map.values()]);
  text = text.replace(UUID_V4, (id) => {
    if (stable.has(id)) return id;
    if (!unstored.has(id)) unstored.set(id, `22222222-2222-4222-8222-${String(unstored.size + 1).padStart(12, '0')}`);
    return unstored.get(id);
  });
  // createdAt/updatedAt are epoch milliseconds, both as JSON and inside content[0].text.
  text = text.replace(/(\\?"(?:createdAt|updatedAt)\\?":\s*)\d{12,}/g, `$1${FIXED_EPOCH_MS}`);
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, FIXED_TIMESTAMP);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.models) log('POLYTICIAN_MODELS_DIR not set: the server will download the embedding model');
  const ids = new IdMap();

  log('main run');
  const primary = await captureMain(opts, ids);
  log('protocol versions');
  const protocolVersions = await captureProtocolVersions(opts);
  log('handshake variants');
  const withoutInitialized = await captureWithoutInitialized(opts);
  log('startup failure');
  const startupFailure = await captureStartupFailure(opts);
  log('vault_* with AgentVault configured but unreachable');
  const vault = await captureVaultConfigured(opts, ids);

  const serverInfo = primary.handshake.initialize.response.result.serverInfo;
  const document = {
    source: {
      polytician: serverInfo,
      captured: opts.date,
      capturedWith: 'tests/fixtures/polytician-3.0/capture.mjs: spawns the server over stdio (newline-delimited JSON-RPC 2.0), each run with a fresh temporary POLYTICIAN_DATA_DIR and HOME, no inherited POLYTICIAN_* settings, POLYTICIAN_NLP_PIPELINE=rule-based and the embedding model copied in from a local cache. The client identifies as AgentVault does (protocolVersion 2024-11-05, clientInfo agentvault 1.0.0).',
      command: 'node <polytician>/dist/index.js',
      volatile: {
        conceptIds: 'Concept ids (UUID v4) are replaced, everywhere including content[0].text and error messages, by stable UUIDs 11111111-1111-4111-8111-00000000000N in the order the concepts were created; ids the server generated but never stored (a rejected save) become 22222222-2222-4222-8222-00000000000N.',
        timestamps: `createdAt/updatedAt are epoch milliseconds (numbers, not ISO strings); they are replaced by ${FIXED_EPOCH_MS} (${FIXED_TIMESTAMP}), so list_concepts order (updatedAt descending) shows only in the array order.`,
        agentVaultPort: 'The closed loopback port the vault_* run points at is replaced by <agentvault-port>.',
        modelDependent: 'search scores and the embedding arrays in save_concept/read_concept responses are real Xenova/all-MiniLM-L6-v2 (q8) output: assert ranges, order and length (384), not exact floats.',
        runtimeDependent: 'UPSTREAM_ERROR messages for an unreachable AgentVault ("fetch failed") come from the Node.js fetch implementation.',
      },
    },
    handshake: {
      ...primary.handshake,
      protocolVersions,
      ...withoutInitialized,
      startupFailure,
    },
    toolsList: {
      request: primary.toolsList.request,
      names: primary.toolsList.names,
      namesWithAgentVault: vault.names,
      tools: primary.relevantTools,
      vaultTools: vault.tools,
    },
    calls: primary.calls,
    errors: primary.errors,
    removedTools: primary.removedTools,
    vaultToolsWithoutAgentVault: primary.vaultToolsWithoutAgentVault,
    vaultToolsWithUnreachableAgentVault: { note: vault.note, calls: vault.calls },
  };

  const result = scrub(document, ids, [
    [`127.0.0.1:${vault.scrub.port}`, '127.0.0.1:<agentvault-port>'],
    ...tempDirs.map((dir) => [dir, '<temp-dir>']),
  ]);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (opts.out) {
    fs.writeFileSync(opts.out, json);
    log(`wrote ${opts.out}`);
  } else {
    process.stdout.write(json);
  }
  for (const { label, ms } of timings) log(`  ${label}: ${ms} ms`);
}

try {
  await main();
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
