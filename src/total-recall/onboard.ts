/**
 * Total Recall — onboarding core
 *
 * Everything `agentvault total-recall onboard` does that isn't asking
 * questions: find a volume, locate a ChatGPT export, write the MCP server
 * entry into an assistant's config without clobbering it, prove the server
 * works end to end, and apply a whole plan with progress reporting. The
 * wizard in cli/commands/total-recall-onboard.ts collects a plan and hands
 * it to `applyPlan`; keeping the two apart is what makes this testable.
 *
 * Two rules run through it. Setup is re-runnable: every step is idempotent
 * and nothing already archived is touched. And it never edits something it
 * can't first understand: an assistant config that isn't valid JSON is left
 * alone and reported, and an existing file gets a timestamped backup before
 * it changes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { DEFAULT_VOLUME_DIR, MEMORY_OPS, canonicalJson } from './format.js';
import { importChatGptConversationsAsync, importMemoryList, type ImportSummary } from './import-chatgpt.js';
import { getTotalRecallToolDefinitions } from './mcp-tools.js';
import type { TotalRecallPolicy } from './policy.js';
import { TotalRecallVolume } from './volume.js';

// ---------------------------------------------------------------------------
// Volume discovery
// ---------------------------------------------------------------------------

/** Where a person's archive lives when they don't say: next to the project, else in their home. */
export const HOME_VOLUME_DIR = path.join('.agentvault', 'total-recall');

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * The volume a command should use: an explicit flag, then the environment,
 * then the project's volume if one exists, then the home volume if one
 * exists, else the project default (where `init` would create one).
 */
export function resolveVolumeDir(
  options: { flag?: string; env?: string; cwd?: string; home?: string } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const explicit = options.flag ?? options.env;
  if (explicit) return path.resolve(cwd, expandHome(explicit, home));
  const project = path.resolve(cwd, DEFAULT_VOLUME_DIR);
  if (TotalRecallVolume.exists(project)) return project;
  const homeVolume = path.join(home, HOME_VOLUME_DIR);
  if (TotalRecallVolume.exists(homeVolume)) return homeVolume;
  return project;
}

// ---------------------------------------------------------------------------
// ChatGPT export discovery
// ---------------------------------------------------------------------------

/**
 * The conversation files of a ChatGPT data export. Accepts the file itself,
 * the unzipped folder, or a folder holding one unzipped export. Large
 * exports are sharded (`conversations-000.json`, `conversations-001.json`,
 * ...); all shards are returned in order.
 */
export function locateChatGptExport(input: string, home: string = os.homedir()): string[] {
  const target = path.resolve(expandHome(input.trim(), home));
  if (!fs.existsSync(target)) throw new Error(`Not found: ${target}`);
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.zip$/i.test(target)) {
      throw new Error(
        'That is the zip itself. Unzip it first (double-click it, or `unzip export.zip -d chatgpt-export`) and point me at the folder.',
      );
    }
    if (!/\.json$/i.test(target)) throw new Error(`Expected conversations.json or the export folder, got ${path.basename(target)}`);
    return [target];
  }
  const shardsIn = (dir: string): string[] =>
    fs
      .readdirSync(dir)
      .filter((f) => /^conversations(-\d+)?\.json$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  let found = shardsIn(target);
  if (found.length === 0) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      found = shardsIn(path.join(target, entry.name));
      if (found.length > 0) break;
    }
  }
  if (found.length === 0) {
    throw new Error(`No conversations.json in ${target}. In ChatGPT: Settings → Data controls → Export data, then unzip the email attachment.`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Assistant configs
// ---------------------------------------------------------------------------

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type ClientId = 'claude-code' | 'claude-desktop';

export interface ClientTarget {
  id: ClientId;
  label: string;
  /** The config file the server entry goes into */
  configPath: string;
  /** What reloads it */
  reload: string;
}

export const DEFAULT_SERVER_NAME = 'total-recall';

export function clientTargets(options: {
  projectDir: string;
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
}): ClientTarget[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  let desktop: string;
  if (platform === 'darwin') {
    desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'win32') {
    desktop = path.join(options.appData ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  } else {
    desktop = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      configPath: path.join(options.projectDir, '.mcp.json'),
      reload: 'Restart Claude Code in this folder and approve the server (or run /mcp).',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      configPath: desktop,
      reload: 'Quit Claude Desktop completely and reopen it.',
    },
  ];
}

function currentCliScript(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error('Cannot tell which agentvault CLI is running');
  return fs.realpathSync(argv1);
}

/**
 * The command an assistant should run to serve a volume. Absolute node and
 * script paths, on purpose: GUI apps such as Claude Desktop don't inherit a
 * shell's PATH, so `npx` or `agentvault` that works in your terminal often
 * isn't found there.
 */
export function buildServerEntry(options: { volumeDir: string; scriptPath?: string; nodePath?: string }): McpServerEntry {
  const script = path.resolve(options.scriptPath ?? currentCliScript());
  const tail = ['mcp', 'serve', '--total-recall', path.resolve(options.volumeDir)];
  if (/\.(c|m)?js$/.test(script)) return { command: options.nodePath ?? process.execPath, args: [script, ...tail] };
  // Running from source (tsx): fine for development, not portable.
  return { command: 'npx', args: ['tsx', script, ...tail] };
}

export interface MergeResult {
  config: Record<string, unknown>;
  /** The entry differs from what was there (or wasn't there) */
  changed: boolean;
  /** An entry under this name existed and was replaced */
  replaced: boolean;
}

/** `mcpServers[name] = entry`, leaving every other key and server alone. */
export function mergeMcpServer(existing: unknown, name: string, entry: McpServerEntry): MergeResult {
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('the config is not a JSON object');
  }
  const config = existing as Record<string, unknown>;
  const rawServers = config.mcpServers ?? {};
  if (rawServers === null || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    throw new Error('"mcpServers" in the config is not an object');
  }
  const servers = rawServers as Record<string, unknown>;
  const previous = servers[name];
  const same = previous !== undefined && canonicalJson(previous) === canonicalJson(entry);
  return {
    config: { ...config, mcpServers: { ...servers, [name]: entry } },
    changed: !same,
    replaced: previous !== undefined,
  };
}

export type ConfigAction = 'created' | 'added' | 'updated' | 'unchanged';

export interface WriteConfigResult {
  path: string;
  action: ConfigAction;
  /** Copy of the file as it was, when it existed and changed */
  backup?: string;
}

/**
 * Put the server entry into an assistant's config file. Creates the file
 * (and folders) if missing; merges into it if present, after backing it
 * up; refuses, touching nothing, when the file isn't valid JSON.
 */
export function writeClientConfig(configPath: string, name: string, entry: McpServerEntry): WriteConfigResult {
  let existing: unknown = {};
  let raw = '';
  const existed = fs.existsSync(configPath);
  if (existed) {
    raw = fs.readFileSync(configPath, 'utf8');
    if (raw.trim()) {
      try {
        existing = JSON.parse(raw);
      } catch {
        throw new Error(`${configPath} is not valid JSON, so I left it alone. Fix or remove it and run this again.`);
      }
    }
  }
  let merged: MergeResult;
  try {
    merged = mergeMcpServer(existing, name, entry);
  } catch (error) {
    throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}; left untouched.`);
  }
  if (!merged.changed) return { path: configPath, action: 'unchanged' };
  let backup: string | undefined;
  if (existed && raw.trim()) {
    backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(configPath, backup);
  }
  atomicWriteFileSync(configPath, JSON.stringify(merged.config, null, 2) + '\n', {
    mode: existed ? fs.statSync(configPath).mode & 0o777 : 0o600,
  });
  return { path: configPath, action: !existed ? 'created' : merged.replaced ? 'updated' : 'added', ...(backup ? { backup } : {}) };
}

// ---------------------------------------------------------------------------
// Self-test: start the real server and use it
// ---------------------------------------------------------------------------

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  ms: number;
}

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class StdioRpc {
  private readonly pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  private readonly child;
  private stderr = '';
  private nextId = 1;
  private dead: Error | null = null;

  constructor(entry: McpServerEntry) {
    this.child = spawn(entry.command, entry.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(entry.env ?? {}) },
      windowsHide: true,
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000);
    });
    this.child.stdin.on('error', () => {
      /* the exit handler reports it */
    });
    this.child.on('error', (error) => this.die(error));
    this.child.on('exit', (code, signal) => {
      const tail = this.stderr.trim().split('\n').slice(-3).join(' | ');
      this.die(new Error(`the server exited (${code ?? signal})${tail ? `: ${tail}` : ''}`));
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return; // stray stdout that isn't JSON-RPC
      }
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (waiter && message.id !== undefined) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    });
  }

  private die(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcMessage> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string): void {
    if (!this.dead) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  close(): void {
    this.dead ??= new Error('closed');
    this.child.kill();
  }
}

/** The JSON a tool call returned, or the error text it carried. */
function toolJson(message: RpcMessage): { ok: boolean; value: Record<string, unknown>; text: string } {
  const result = message.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? message.error?.message ?? '';
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* an error message, not JSON */
  }
  return { ok: Boolean(result) && !result?.isError, value, text };
}

/**
 * Start the server exactly as an assistant would and use it: initialize,
 * receive the guardrail, list the tools, write a probe memory, read it
 * back, verify the chain. Runs against a throwaway volume carrying the
 * real volume's policy (minus webhooks and hooks), so the append-only
 * archive never gets a probe in it.
 */
export async function selfTest(
  makeEntry: (volumeDir: string) => McpServerEntry,
  options: { policy?: Partial<TotalRecallPolicy>; timeoutMs?: number } = {},
): Promise<SelfTestResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const steps: SelfTestStep[] = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'total-recall-selftest-'));
  const volumeDir = path.join(scratch, 'volume');
  let rpc: StdioRpc | null = null;
  const record = (name: string, ok: boolean, detail: string): boolean => {
    steps.push({ name, ok, detail });
    return ok;
  };
  try {
    const volume = TotalRecallVolume.init(volumeDir, {
      policy: { ...(options.policy ?? {}), webhooks: [], hookCommand: undefined },
    });
    rpc = new StdioRpc(makeEntry(volumeDir));

    const init = await rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'total-recall-selftest', version: '1' } }, timeoutMs);
    if (!record('The server starts', Boolean(init.result), init.result ? 'answered initialize' : (init.error?.message ?? 'no result'))) {
      return { ok: false, steps, ms: Date.now() - started };
    }
    rpc.notify('notifications/initialized');

    const instructions = String((init.result as { instructions?: unknown }).instructions ?? '');
    if (volume.policy.recordMemories) {
      record('Assistants receive the guardrail', /GUARDRAIL/.test(instructions), /GUARDRAIL/.test(instructions) ? 'delivered as server instructions' : 'the server sent no instructions');
    }

    const listed = await rpc.request('tools/list', {}, timeoutMs);
    const names = new Set(((listed.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map((t) => t.name));
    const expected = getTotalRecallToolDefinitions().map((t) => t.name);
    const missing = expected.filter((n) => !names.has(n));
    record('The tools are available', missing.length === 0, missing.length === 0 ? `all ${expected.length} total_recall_* tools present` : `missing ${missing.join(', ')}`);

    const key = `selftest-${Date.now()}`;
    const wrote = toolJson(
      await rpc.request('tools/call', { name: 'total_recall_record', arguments: { op: 'created', key, content: 'Total Recall self-test probe', provider: 'selftest' } }, timeoutMs),
    );
    const pulled = toolJson(await rpc.request('tools/call', { name: 'total_recall_pull', arguments: { since_seq: 0 } }, timeoutMs));
    const events = (pulled.value.events as Array<{ memory?: { key?: string } }> | undefined) ?? [];
    const readBack = wrote.ok && events.some((e) => e.memory?.key === key);
    record('A memory written is a memory read back', readBack, readBack ? 'wrote a probe and pulled it by cursor' : (wrote.ok ? 'the probe was not in the pulled events' : wrote.text));

    const verified = toolJson(await rpc.request('tools/call', { name: 'total_recall_verify', arguments: {} }, timeoutMs));
    record('The hash chain verifies', verified.ok, verified.ok ? 'chain intact' : verified.text);
  } catch (error) {
    record('The server responds', false, error instanceof Error ? error.message : String(error));
  } finally {
    rpc?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type OnboardStep = 'archive' | 'history' | 'connect' | 'test';

export interface OnboardPlan {
  volumeDir: string;
  /** Unset keeps an existing volume's setting (off for a new one) */
  transcript?: 'off' | 'append';
  /** Unset keeps an existing volume's setting (on for a new one) */
  recordRecalls?: boolean;
  /** A ChatGPT export: conversations.json, its folder, or a folder holding it */
  chatgptExport?: string;
  /** Saved memories pasted from a provider's memory manager, one per line */
  memoriesText?: string;
  memoriesProvider?: string;
  connect?: ClientId[];
  /** Where Claude Code's .mcp.json goes (default: the working directory) */
  projectDir?: string;
  serverName?: string;
  /** Default true */
  runSelfTest?: boolean;
}

export interface OnboardDeps {
  /** The agentvault CLI script to point assistants at (default: the running one) */
  scriptPath?: string;
  platform?: NodeJS.Platform;
  home?: string;
  selfTest?: typeof selfTest;
}

export interface OnboardReporter {
  start(step: OnboardStep, label: string): void;
  /** Optional: a long step reports how far along it is */
  progress?(step: OnboardStep, detail: string): void;
  done(step: OnboardStep, detail: string): void;
  warn(step: OnboardStep, detail: string): void;
}

export interface OnboardResult {
  volume: { dir: string; volumeId: string; created: boolean; policy: TotalRecallPolicy; memoryEvents: number };
  history: {
    chatgpt?: ImportSummary & { files: number };
    memories?: { imported: number; skipped: number };
  };
  connected: Array<{ client: ClientId; label: string; reload: string } & WriteConfigResult>;
  /** The server entry, for anyone connecting an assistant by hand */
  entry: McpServerEntry;
  selfTest?: SelfTestResult;
  /** Things that went wrong without stopping the rest */
  problems: string[];
}

const SILENT: OnboardReporter = { start: () => undefined, done: () => undefined, warn: () => undefined };

function recordOpsFor(current: TotalRecallPolicy['recordOps'], recalls: boolean): TotalRecallPolicy['recordOps'] {
  return MEMORY_OPS.filter((op) => (op === 'recalled' ? recalls : current.includes(op)));
}

/**
 * Apply a plan. The archive step failing stops everything (nothing else
 * makes sense without a volume); any other step failing is reported in
 * `problems` and the remaining steps still run.
 */
export async function applyPlan(plan: OnboardPlan, reporter: OnboardReporter = SILENT, deps: OnboardDeps = {}): Promise<OnboardResult> {
  const problems: string[] = [];
  const serverName = plan.serverName ?? DEFAULT_SERVER_NAME;
  const home = deps.home ?? os.homedir();

  // 1. The archive
  reporter.start('archive', 'Preparing your archive');
  const existed = TotalRecallVolume.exists(plan.volumeDir);
  const volume = existed
    ? TotalRecallVolume.open(plan.volumeDir)
    : TotalRecallVolume.init(plan.volumeDir, {
        policy: {
          transcript: plan.transcript ?? 'off',
          recordOps: recordOpsFor(['created', 'recalled', 'updated', 'deleted'], plan.recordRecalls ?? true),
        },
      });
  if (existed) {
    const patch: Partial<TotalRecallPolicy> = {};
    if (plan.transcript !== undefined && plan.transcript !== volume.policy.transcript) patch.transcript = plan.transcript;
    if (plan.recordRecalls !== undefined) {
      const ops = recordOpsFor(volume.policy.recordOps, plan.recordRecalls);
      if (ops.join() !== volume.policy.recordOps.join()) patch.recordOps = ops;
    }
    if (Object.keys(patch).length > 0) volume.setPolicy(patch);
  }
  reporter.done('archive', existed ? `Using your existing archive (${volume.memoriesSeq()} memory events kept)` : `Created ${volume.volumeId}`);

  // 2. History
  const history: OnboardResult['history'] = {};
  if (plan.chatgptExport || plan.memoriesText) reporter.start('history', 'Bringing your history in');
  if (plan.chatgptExport) {
    try {
      const files = locateChatGptExport(plan.chatgptExport, home);
      const total: ImportSummary & { files: number } = { conversations: 0, messages: 0, skipped: 0, files: files.length };
      for (const [index, file] of files.entries()) {
        const summary = await importChatGptConversationsAsync(volume, file, {
          onProgress: (done, count) =>
            reporter.progress?.('history', `Reading ChatGPT conversations${files.length > 1 ? ` (file ${index + 1} of ${files.length})` : ''}: ${done.toLocaleString('en-US')} of ${count.toLocaleString('en-US')}`),
        });
        total.conversations += summary.conversations;
        total.messages += summary.messages;
        total.skipped += summary.skipped;
      }
      history.chatgpt = total;
      reporter.done('history', `${total.messages.toLocaleString('en-US')} messages from ${total.conversations.toLocaleString('en-US')} ChatGPT conversations${total.skipped ? ` (${total.skipped.toLocaleString('en-US')} already there)` : ''}`);
    } catch (error) {
      const message = `ChatGPT export: ${error instanceof Error ? error.message : String(error)}`;
      problems.push(message);
      reporter.warn('history', message);
    }
  }
  if (plan.memoriesText?.trim()) {
    try {
      const result = importMemoryList(volume, plan.memoriesText, { provider: (plan.memoriesProvider ?? 'chatgpt').toLowerCase() });
      history.memories = result;
      reporter.done('history', `${result.imported} saved memories${result.skipped ? ` (${result.skipped} already there)` : ''}`);
    } catch (error) {
      const message = `Saved memories: ${error instanceof Error ? error.message : String(error)}`;
      problems.push(message);
      reporter.warn('history', message);
    }
  }

  // 3. Connections
  const entry = buildServerEntry({ volumeDir: plan.volumeDir, scriptPath: deps.scriptPath });
  const connected: OnboardResult['connected'] = [];
  const targets = clientTargets({ projectDir: plan.projectDir ?? process.cwd(), platform: deps.platform, home });
  for (const id of plan.connect ?? []) {
    const target = targets.find((t) => t.id === id);
    if (!target) continue;
    reporter.start('connect', `Connecting ${target.label}`);
    try {
      const written = writeClientConfig(target.configPath, serverName, entry);
      connected.push({ client: id, label: target.label, reload: target.reload, ...written });
      reporter.done('connect', written.action === 'unchanged' ? `${target.label} was already connected` : `${target.label} connected`);
    } catch (error) {
      const message = `${target.label}: ${error instanceof Error ? error.message : String(error)}`;
      problems.push(message);
      reporter.warn('connect', message);
    }
  }

  // 4. Prove it
  let test: SelfTestResult | undefined;
  if (plan.runSelfTest !== false) {
    reporter.start('test', 'Starting the server the way an assistant would');
    test = await (deps.selfTest ?? selfTest)((dir) => buildServerEntry({ volumeDir: dir, scriptPath: deps.scriptPath }), { policy: volume.policy });
    if (test.ok) {
      reporter.done('test', `Everything works (${(test.ms / 1000).toFixed(1)}s)`);
    } else {
      const failed = test.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
      problems.push(...failed.map((f) => `Self-test: ${f}`));
      reporter.warn('test', failed.join('; '));
    }
  }

  return {
    volume: {
      dir: plan.volumeDir,
      volumeId: volume.volumeId,
      created: !existed,
      policy: volume.policy,
      memoryEvents: volume.memoriesSeq(),
    },
    history,
    connected,
    entry,
    ...(test ? { selfTest: test } : {}),
    problems,
  };
}

// ---------------------------------------------------------------------------
// Words for the person to carry between assistants
// ---------------------------------------------------------------------------

/** Paste into ChatGPT: gets the saved memories out verbatim. */
export const CHATGPT_MEMORY_EXPORT_PROMPT =
  'List every memory you have saved about me, one per line, exactly as stored. Include the date if you have one. Do not summarize, merge, reword or leave anything out. Output only the list.';

/** Paste into Claude once connected: ingests everything the archive holds. */
export const CLAUDE_INGEST_PROMPT =
  'Use the total-recall tools to learn what my other assistants know about me. Call total_recall_status, then call total_recall_pull with since_seq 0 and keep calling it with next_seq until more is false. Tell me what you learned in a short summary, ask me to confirm anything that looks outdated or contradictory, and from now on record every memory you create, recall or update with total_recall_record.';
