/**
 * Total Recall — event fan-out
 *
 * When a memory event lands, the writer tells whoever asked to hear about
 * it: webhooks (one POST per event, loopback-only unless the sink opts in
 * with `allowRemote`, the same boundary stenographer draws) and a hook
 * command (argv, the event as JSON on stdin — the "notification hook" a
 * Claude-side ingester can plug a script into). Delivery is best-effort:
 * a sink that fails is reported, never retried, and never blocks the write
 * that already happened.
 */

import { spawn } from 'node:child_process';
import type { MemoryEvent } from './format.js';
import type { TotalRecallPolicy, WebhookConfig } from './policy.js';

export interface DeliveryResult {
  sink: string;
  ok: boolean;
  error?: string;
}

export interface NotifyOptions {
  /** Per-sink timeout in ms (default 3000) */
  timeoutMs?: number;
  /** Test seam */
  fetchImpl?: typeof fetch;
  /** Volume identity included in the payload */
  volumeId?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
  } catch {
    return false;
  }
}

/** The JSON body every sink receives. */
export function eventPayload(event: MemoryEvent, volumeId?: string): Record<string, unknown> {
  return { type: 'total_recall.memory', volumeId: volumeId ?? null, event };
}

async function postWebhook(
  webhook: WebhookConfig,
  body: string,
  options: NotifyOptions,
): Promise<DeliveryResult> {
  const sink = `webhook:${webhook.url}`;
  if (!webhook.allowRemote && !isLoopbackUrl(webhook.url)) {
    return { sink, ok: false, error: 'refused: non-loopback webhook without allowRemote' };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (webhook.bearerToken) headers.authorization = `Bearer ${webhook.bearerToken}`;
    const res = await fetchImpl(webhook.url, { method: 'POST', headers, body, signal: controller.signal });
    return res.ok ? { sink, ok: true } : { sink, ok: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { sink, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function runHook(argv: string[], body: string, options: NotifyOptions): Promise<DeliveryResult> {
  const sink = `hook:${argv.join(' ')}`;
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ sink, ok: false, error: 'empty hook command' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: DeliveryResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false });
    } catch (error) {
      done({ sink, ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      done({ sink, ok: false, error: 'timed out' });
    }, options.timeoutMs ?? 3000);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ sink, ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? { sink, ok: true } : { sink, ok: false, error: `exit ${code}${stderr ? `: ${stderr.trim()}` : ''}` });
    });
    child.stdin?.on('error', () => {
      /* the hook closed stdin early; its exit code decides */
    });
    child.stdin?.end(body);
  });
}

/** Deliver one event to every sink the policy names. */
export async function notifyEvent(
  policy: Pick<TotalRecallPolicy, 'webhooks' | 'hookCommand'>,
  event: MemoryEvent,
  options: NotifyOptions = {},
): Promise<DeliveryResult[]> {
  const body = JSON.stringify(eventPayload(event, options.volumeId));
  const jobs: Promise<DeliveryResult>[] = policy.webhooks.map((w) => postWebhook(w, body, options));
  if (policy.hookCommand && policy.hookCommand.length > 0) jobs.push(runHook(policy.hookCommand, body, options));
  return Promise.all(jobs);
}

export function hasSinks(policy: Pick<TotalRecallPolicy, 'webhooks' | 'hookCommand'>): boolean {
  return policy.webhooks.length > 0 || Boolean(policy.hookCommand && policy.hookCommand.length > 0);
}
