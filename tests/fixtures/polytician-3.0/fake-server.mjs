#!/usr/bin/env node
/**
 * A stand-in for Polytician 3.0's stdio MCP server, built from contract.json,
 * so AgentVault's client can be tested without the real server or its
 * embedding model.
 *
 * It speaks newline-delimited JSON-RPC 2.0 like the real server, answers
 * initialize with the versions the real server accepted, lists the captured
 * tools, and validates every tools/call against the captured inputSchema
 * (strict: unknown keys are rejected, required keys enforced), producing the
 * real server's VALIDATION_ERROR messages. Valid calls get the recorded
 * responses: the two recorded concepts can be read, listed, searched (with
 * their recorded scores) and deleted; save_concept answers the recorded stored
 * concept with the request's markdown and tags. get_stats and health_check
 * answer their recorded results.
 *
 * State is kept per namespace, as in the real server: the recorded concepts
 * live in one namespace ("default" unless --seed-namespace says otherwise), a
 * call that names no namespace addresses "default", and a concept is found,
 * listed, searched, counted, pushed or archived only in its own namespace.
 * save_concept stores the concept in the namespace it names (under the
 * recorded id, or a new one when that id lives in another namespace).
 *
 * Options:
 *   --vault off|unreachable|ok|auto
 *                               off (default): the 14 tools Polytician registers
 *                               without AgentVault, so vault_* calls get "Tool
 *                               ... not found". unreachable: the vault_* tools are
 *                               listed and answer the recorded UPSTREAM_ERROR. ok:
 *                               they succeed with synthesized results that are
 *                               checked against the captured outputSchema. auto:
 *                               like ok when the real server would register them
 *                               (POLYTICIAN_AV_API_URL set, or agentVault in the
 *                               --config file; vault_archive_concept only with
 *                               agentVault.archival.enabled), else like off
 *   --config <file>             Polytician's config file, read as the real server
 *                               reads it (for --vault auto)
 *   --startup-log <file>        append one JSON line per start: the arguments, the
 *                               POLYTICIAN_AV_* environment the server got, and
 *                               which of AgentVault's secrets it got (as "<present>")
 *   --seed-namespace <ns>       the namespace the recorded concepts live in (default "default")
 *   --require-namespace <ns>    every call to a tool that takes a namespace must
 *                               name exactly this one, else VALIDATION_ERROR
 *   --namespaces <a,b|*>        POLYTICIAN_NAMESPACES: a namespace outside the list
 *                               (the default one included) gets NAMESPACE_DENIED
 *   --log <file>                append every message received, one JSON per line
 *   --fail <tool>               that tool answers { error: "simulated failure", code: "INTERNAL_ERROR" }
 *   --protocol <version>        answer initialize with this protocolVersion
 *   --exit-on-start             write a configuration error to stderr and exit 1
 *                               without answering (contract handshake.startupFailure)
 *   --ping                      before answering a tools/call, send the client a
 *                               ping request that reuses that call's id
 *   --split-utf8                write every message in two writes, 50 ms apart, split
 *                               inside its last multi-byte UTF-8 character (in a tool
 *                               result, that is in structuredContent)
 *   --empty                     start with no concepts
 *   --forget <id>               that concept cannot be read (NOT_FOUND) but search
 *                               still returns it, as if deleted after the search
 *   --hang <tool>               never answer calls to that tool
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.join(here, 'contract.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const opts = {
  vault: 'off',
  log: null,
  fail: new Set(),
  protocol: null,
  exitOnStart: false,
  ping: false,
  splitUtf8: false,
  empty: false,
  forget: new Set(),
  hang: new Set(),
  config: null,
  startupLog: null,
  seedNamespace: 'default',
  requireNamespace: null,
  namespaces: null,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    const next = argv[++i];
    if (next === undefined) die(`${arg} needs a value`);
    return next;
  };
  if (arg === '--vault') opts.vault = value();
  else if (arg === '--log') opts.log = value();
  else if (arg === '--fail') opts.fail.add(value());
  else if (arg === '--protocol') opts.protocol = value();
  else if (arg === '--exit-on-start') opts.exitOnStart = true;
  else if (arg === '--ping') opts.ping = true;
  else if (arg === '--split-utf8') opts.splitUtf8 = true;
  else if (arg === '--empty') opts.empty = true;
  else if (arg === '--forget') opts.forget.add(value());
  else if (arg === '--hang') opts.hang.add(value());
  else if (arg === '--config') opts.config = value();
  else if (arg === '--startup-log') opts.startupLog = value();
  else if (arg === '--seed-namespace') opts.seedNamespace = value();
  else if (arg === '--require-namespace') opts.requireNamespace = value();
  else if (arg === '--namespaces') {
    const list = value();
    opts.namespaces = list === '*' ? '*' : list.split(',').map((n) => n.trim()).filter(Boolean);
  } else die(`unknown argument ${arg}`);
}
if (!['off', 'unreachable', 'ok', 'auto'].includes(opts.vault)) die(`--vault must be off, unreachable, ok or auto, got ${opts.vault}`);

// AgentVault's own secrets, which it must not pass to Polytician: logged as present, never by value
const AGENTVAULT_SECRETS = [
  'AGENTVAULT_ICP_IDENTITY_PEM',
  'AGENTVAULT_ICP_IDENTITY_PEM_FILE',
  'AGENTVAULT_MNEMONIC',
  'AGENTVAULT_PRIVATE_KEY',
  'AGENTVAULT_PASSWORD',
  'AGENTVAULT_BUNDLE_SECRET',
];

if (opts.startupLog) {
  const env = Object.fromEntries([
    ...['POLYTICIAN_AV_API_URL', 'POLYTICIAN_AV_API_TOKEN', 'MCP_MODE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
    ...AGENTVAULT_SECRETS.filter((name) => process.env[name] !== undefined).map((name) => [name, '<present>']),
  ]);
  fs.appendFileSync(opts.startupLog, `${JSON.stringify({ argv: process.argv.slice(2), env })}\n`);
}

function die(message) {
  process.stderr.write(`fake-polytician: ${message}\n`);
  process.exit(2);
}

if (opts.exitOnStart) {
  process.stderr.write('Configuration error: POLYTICIAN_AV_API_URL must use https (plain http only for localhost)\n');
  process.exit(1);
}

// --vault auto: register the vault_* tools when the real server would. A
// config file that is missing or not JSON stops the real server too.
if (opts.vault === 'auto') {
  let agentVault;
  if (opts.config) {
    if (!fs.existsSync(opts.config)) {
      process.stderr.write(`Configuration error: Config file not found: ${path.resolve(opts.config)}\n`);
      process.exit(1);
    }
    try {
      agentVault = JSON.parse(fs.readFileSync(opts.config, 'utf8')).agentVault;
    } catch {
      process.stderr.write(`Configuration error: Config file ${path.resolve(opts.config)} is not valid JSON\n`);
      process.exit(1);
    }
  }
  const configured = Boolean(process.env.POLYTICIAN_AV_API_URL || agentVault);
  opts.vault = configured ? 'ok' : 'off';
  opts.archival = configured && agentVault?.archival?.enabled === true;
}

// ---------------------------------------------------------------------------
// Captured contract
// ---------------------------------------------------------------------------

const toolNames = opts.vault === 'off'
  ? contract.toolsList.names
  : contract.toolsList.namesWithAgentVault.filter((name) => name !== 'vault_archive_concept' || opts.archival !== false);
const toolDefs = new Map([...contract.toolsList.tools, ...contract.toolsList.vaultTools].map((t) => [t.name, t]));

const acceptedVersions = contract.handshake.protocolVersions
  .filter((v) => v.answered === v.requested)
  .map((v) => v.requested);
const latestVersion = contract.handshake.protocolVersions.find((v) => !acceptedVersions.includes(v.requested))?.answered
  ?? acceptedVersions[acceptedVersions.length - 1];

const structured = (key) => contract.calls[key].response.result.structuredContent;

/** A concept as read_concept returns it: metadata first, then the representations it has. */
function stored(saved) {
  const { markdown, thoughtform, embedding, ...meta } = saved;
  return {
    ...meta,
    ...(markdown === null || markdown === undefined ? {} : { markdown }),
    ...(thoughtform === null || thoughtform === undefined ? {} : { thoughtform }),
    ...(embedding === null || embedding === undefined ? {} : { embedding }),
  };
}

// The two concepts the capture stored, in the seed namespace.
const concepts = new Map();
for (const saved of [structured('save_concept'), structured('save_concept.second')]) {
  concepts.set(saved.id, stored({ ...saved, namespace: opts.seedNamespace }));
}
if (opts.empty) concepts.clear();
for (const id of opts.forget) concepts.delete(id);
const recordedIds = new Set([structured('save_concept').id, structured('save_concept.second').id]);
const recordedSearch = structured('search_concepts').results;
const recordedList = structured('list_concepts').concepts;

// ---------------------------------------------------------------------------
// JSON Schema subset (what the captured input schemas use), with the messages
// Polytician's validator produces
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function receivedType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  return typeof value;
}

function matchesType(type, value) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function resolveRef(root, ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root);
}

function validate(schema, value, at, root, issues) {
  if (schema.$ref) return validate(resolveRef(root, schema.$ref), value, at, root, issues);

  if (schema.anyOf) {
    const ok = schema.anyOf.some((option) => {
      const optionIssues = [];
      validate(option, value, at, root, optionIssues);
      return optionIssues.length === 0;
    });
    if (!ok) issues.push({ message: 'Invalid input', at });
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      const expected = types.find((t) => t !== 'null') ?? types[0];
      if (expected === 'integer' && typeof value === 'number') {
        issues.push({ message: 'Expected integer, received float', at });
      } else {
        issues.push({ message: `Expected ${expected === 'integer' ? 'number' : expected}, received ${receivedType(value)}`, at });
      }
      return;
    }
  }

  if ('const' in schema && value !== schema.const) {
    issues.push({ message: `Invalid literal value, expected ${JSON.stringify(schema.const)}`, at });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    const expected = schema.enum.map((v) => `'${v}'`).join(' | ');
    issues.push({ message: `Invalid enum value. Expected ${expected}, received '${value}'`, at });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ message: `String must contain at least ${schema.minLength} character(s)`, at });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ message: `String must contain at most ${schema.maxLength} character(s)`, at });
    }
    if (schema.format === 'uuid' && !UUID.test(value)) issues.push({ message: 'Invalid uuid', at });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push({ message: 'Invalid', at });
  }

  if (typeof value === 'number') {
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) {
      issues.push({ message: `Number must be greater than ${schema.exclusiveMinimum}`, at });
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ message: `Number must be greater than or equal to ${schema.minimum}`, at });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ message: `Number must be less than or equal to ${schema.maximum}`, at });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ message: `Array must contain at least ${schema.minItems} element(s)`, at });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ message: `Array must contain at most ${schema.maxItems} element(s)`, at });
    }
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, [...at, i], root, issues));
  }

  if (matchesType('object', value) && (schema.properties || schema.additionalProperties !== undefined)) {
    const properties = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (value[key] === undefined) {
        if (schema.required?.includes(key)) issues.push({ message: 'Required', at: [...at, key] });
      } else {
        validate(propSchema, value[key], [...at, key], root, issues);
      }
    }
    const extra = Object.keys(value).filter((key) => !(key in properties));
    if (schema.additionalProperties === false && extra.length > 0) {
      issues.push({ message: `Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(', ')}`, at });
    } else if (typeof schema.additionalProperties === 'object' && Object.keys(schema.additionalProperties).length > 0) {
      for (const key of extra) validate(schema.additionalProperties, value[key], [...at, key], root, issues);
    }
  }
}

function schemaIssues(schema, value) {
  const issues = [];
  validate(schema, value, [], schema, issues);
  return issues.map(({ message, at }) => (at.length > 0 ? `${message} at ${at.join('.')}` : message));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const notFound = (id) => new ToolError(`Concept '${id}' not found`, 'NOT_FOUND');
let syntheticCount = 0;
let savedCount = 0;

/** The namespace a call addresses (as resolveNamespace in the real server). */
function namespaceOf(args) {
  return args.namespace ?? 'default';
}

function inNamespace(args, id) {
  return concepts.get(id)?.namespace === namespaceOf(args);
}

function conceptsIn(namespace) {
  return [...concepts.values()].filter((c) => c.namespace === namespace);
}

function statsOf(namespace) {
  const list = conceptsIn(namespace);
  const count = (key) => list.filter((c) => c[key] !== undefined).length;
  return {
    conceptCount: list.length,
    vectorCount: count('embedding'),
    representationCounts: { markdown: count('markdown'), thoughtform: count('thoughtform'), vector: count('embedding') },
  };
}

function summaryOf(concept) {
  return {
    id: concept.id,
    namespace: concept.namespace,
    version: concept.version,
    createdAt: concept.createdAt,
    updatedAt: concept.updatedAt,
    tags: concept.tags,
    representations: {
      vector: concept.embedding !== undefined,
      markdown: concept.markdown !== undefined,
      thoughtform: concept.thoughtform !== undefined,
    },
    assertionStatus: concept.assertionStatus,
  };
}

function readConcept(args) {
  const concept = concepts.get(args.id);
  if (!concept || !inNamespace(args, args.id)) throw notFound(args.id);
  if (!args.representations) return concept;
  const { markdown, thoughtform, embedding, ...meta } = concept;
  const wanted = new Set(args.representations);
  return {
    ...meta,
    ...(wanted.has('markdown') && markdown !== undefined ? { markdown } : {}),
    ...(wanted.has('thoughtform') && thoughtform !== undefined ? { thoughtform } : {}),
    ...(wanted.has('vector') && embedding !== undefined ? { embedding } : {}),
  };
}

function synthesized(tool, result) {
  const issues = schemaIssues(toolDefs.get(tool).outputSchema, result);
  if (issues.length > 0) throw new ToolError(`fake server: synthesized ${tool} result breaks its outputSchema: ${issues.join('; ')}`, 'INTERNAL_ERROR');
  return result;
}

// The vault_* tools do not check archival tags here. Valid calls fail like an
// unreachable AgentVault (before the concept is looked up, as the recorded
// calls name concepts of another capture run), or succeed with synthesized
// results once a push or archive finds its concept in the namespace it names.
function vaultTool(tool, args) {
  if (opts.vault === 'unreachable') throw new ToolError('fetch failed', 'UPSTREAM_ERROR');
  if ((tool === 'vault_memory_push' || tool === 'vault_archive_concept') && !inNamespace(args, args.conceptId)) {
    throw notFound(args.conceptId);
  }
  syntheticCount += 1;
  const sha = `commit_${String(syntheticCount).padStart(6, '0')}`;
  switch (tool) {
    case 'vault_memory_push':
      return synthesized(tool, { pushed: true, sha });
    case 'vault_memory_pull':
      return synthesized(tool, { pulled: true, branch: 'polytician-main', headSha: sha, imported: 0, skipped: [] });
    case 'vault_archive_concept':
      return synthesized(tool, {
        archived: true,
        encrypted: true,
        txId: `fake-arweave-tx-${syntheticCount}`,
        url: `https://arweave.net/fake-arweave-tx-${syntheticCount}`,
        size: 1024,
      });
    case 'vault_memory_repo_log':
      return synthesized(tool, { branch: 'polytician-main', headSha: sha, entryCount: 0, conceptKeys: [] });
    default:
      throw new ToolError(`fake server: no synthesized result for ${tool}`, 'INTERNAL_ERROR');
  }
}

function runTool(tool, args) {
  switch (tool) {
    case 'save_concept': {
      if (args.markdown === undefined && args.thoughtform === undefined && args.embedding === undefined) {
        return { error: contract.errors['save_concept.noRepresentation'].response.result };
      }
      const namespace = namespaceOf(args);
      const recorded = [structured('save_concept'), structured('save_concept.second')]
        .find((saved) => saved.markdown === args.markdown) ?? structured('save_concept');
      const taken = concepts.has(recorded.id) && concepts.get(recorded.id).namespace !== namespace;
      savedCount += taken ? 1 : 0;
      const id = taken ? `33333333-3333-4333-8333-${String(savedCount).padStart(12, '0')}` : recorded.id;
      const saved = { ...recorded, id, namespace, tags: args.tags ?? [], markdown: args.markdown ?? null };
      concepts.set(id, stored(saved));
      return { result: saved };
    }
    case 'read_concept':
      return { result: readConcept(args) };
    case 'delete_concept':
      if (!inNamespace(args, args.id)) throw notFound(args.id);
      concepts.delete(args.id);
      return { result: { deleted: args.id } };
    case 'search_concepts': {
      const namespace = namespaceOf(args);
      const results = recordedSearch
        .filter((r) => inNamespace(args, r.id) || (opts.forget.has(r.id) && namespace === opts.seedNamespace))
        .map((r) => ({ ...r, namespace }));
      return { result: { results: results.slice(0, args.k ?? 10) } };
    }
    case 'list_concepts': {
      const namespace = namespaceOf(args);
      // Concepts saved here first (newest), then the recorded ones in their recorded order
      const all = [
        ...conceptsIn(namespace).filter((c) => !recordedIds.has(c.id)).reverse().map(summaryOf),
        ...recordedList.filter((c) => inNamespace(args, c.id)).map((c) => ({ ...c, namespace })),
      ];
      const offset = args.offset ?? 0;
      return { result: { concepts: all.slice(offset, offset + (args.limit ?? 50)), total: all.length } };
    }
    case 'get_stats':
      return { result: statsOf(namespaceOf(args)) };
    case 'health_check':
      return { result: { ...structured('health_check'), database: statsOf(namespaceOf(args)) } };
    default:
      if (tool.startsWith('vault_')) return { result: vaultTool(tool, args) };
      throw new ToolError(`fake server: no recorded response for ${tool}`, 'INTERNAL_ERROR');
  }
}

function errorResult(message, code) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }], isError: true };
}

function callTool(params) {
  const tool = params?.name;
  const args = params?.arguments ?? {};
  if (!toolNames.includes(tool)) return errorResult(`Tool ${tool} not found`, 'NOT_FOUND');
  if (opts.fail.has(tool)) return errorResult('simulated failure', 'INTERNAL_ERROR');

  const def = toolDefs.get(tool);
  if (!def) return errorResult(`fake server: ${tool} was not captured`, 'INTERNAL_ERROR');
  const issues = schemaIssues(def.inputSchema, args);
  if (issues.length > 0) {
    return errorResult(`Input validation error: Invalid arguments for tool ${tool}: ${issues.join('\n')}`, 'VALIDATION_ERROR');
  }

  if ('namespace' in (def.inputSchema.properties ?? {})) {
    if (opts.requireNamespace !== null && args.namespace !== opts.requireNamespace) {
      return errorResult(
        `fake server: ${tool} must name namespace ${JSON.stringify(opts.requireNamespace)}, got ${JSON.stringify(args.namespace) ?? 'none'}`,
        'VALIDATION_ERROR',
      );
    }
    const namespace = namespaceOf(args);
    if (opts.namespaces !== null && opts.namespaces !== '*' && !opts.namespaces.includes(namespace)) {
      return errorResult(`Namespace '${namespace}' is not in this server's POLYTICIAN_NAMESPACES allowlist`, 'NAMESPACE_DENIED');
    }
  }

  try {
    const outcome = runTool(tool, args);
    if (outcome.error) return outcome.error;
    return { content: [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }], structuredContent: outcome.result };
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.message, error.code);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

// With --split-utf8, writes are queued so that a split message is not interleaved with the next one.
let writes = Promise.resolve();

function send(message) {
  const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  if (!opts.splitUtf8) {
    process.stdout.write(line);
    return;
  }
  // A continuation byte (10xxxxxx) is inside a multi-byte character.
  const split = line.findLastIndex((byte) => (byte & 0xc0) === 0x80);
  writes = writes.then(async () => {
    if (split < 0) {
      process.stdout.write(line);
      return;
    }
    process.stdout.write(line.subarray(0, split));
    await sleep(50);
    process.stdout.write(line.subarray(split));
  });
}

function handle(message) {
  if (opts.log) fs.appendFileSync(opts.log, `${JSON.stringify(message)}\n`);
  const { id, method, params } = message;
  if (method === undefined || id === undefined) return; // a notification, or the client's answer to our ping

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = opts.protocol ?? (acceptedVersions.includes(requested) ? requested : latestVersion);
      send({ jsonrpc: '2.0', id, result: { ...contract.handshake.initialize.response.result, protocolVersion } });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list': {
      const tools = toolNames.map((name) => toolDefs.get(name) ?? { name, inputSchema: { type: 'object' } });
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    case 'tools/call':
      if (opts.hang.has(params?.name)) return;
      if (opts.ping) send({ jsonrpc: '2.0', id, method: 'ping' });
      send({ jsonrpc: '2.0', id, result: callTool(params) });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
      continue;
    }
    // Anything else that goes wrong is a bug in the fake: let it crash loudly.
    handle(message);
  }
});
// Like the real server: closing stdin stops it.
process.stdin.on('end', () => process.exit(0));
