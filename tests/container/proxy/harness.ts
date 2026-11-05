/**
 * Shared helpers for the credential-proxy tests: a recording fake upstream, a
 * proxy on an ephemeral loopback port, and two ways to talk to it (node's http
 * client, and raw bytes for requests node's client refuses to build).
 *
 * Not a test file (no .test.ts suffix), so vitest does not collect it.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createCredentialProxy } from '../../../src/container/proxy/credential-proxy.js';
import type { AuditEntry, CreateCredentialProxyOptions } from '../../../src/container/proxy/credential-proxy.js';
import type { CredentialProxyConfig, ProxyInjection, ProxyRoute } from '../../../src/container/types.js';

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects with `message` if `promise` has not settled in time: turns a hang into a clear failure. */
export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${message}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function waitUntil(condition: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms: ${message}`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Fake upstream
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  /** True once the whole request body arrived. */
  ended: boolean;
  /** Body bytes received so far. */
  bytes: number;
}

export type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse, recorded: RecordedRequest) => void | Promise<void>;

export interface FakeUpstream {
  server: http.Server;
  port: number;
  /** http://127.0.0.1:<port> */
  url: string;
  requests: RecordedRequest[];
  /** TCP connections accepted so far / currently open. */
  connections: { opened: number; open: number };
  setHandler(handler: UpstreamHandler): void;
  close(): Promise<void>;
}

const respondOk: UpstreamHandler = (req, res) => {
  req.resume();
  req.on('end', () => {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
};

export async function startUpstream(handler: UpstreamHandler = respondOk): Promise<FakeUpstream> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body: Buffer.alloc(0),
      ended: false,
      bytes: 0,
    };
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      parts.push(chunk);
      recorded.bytes += chunk.length;
    });
    req.on('end', () => {
      recorded.body = Buffer.concat(parts);
      recorded.ended = true;
    });
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    requests.push(recorded);
    void Promise.resolve(current(req, res, recorded)).catch(() => res.destroy());
  });
  const connections = { opened: 0, open: 0 };
  server.on('connection', (socket) => {
    connections.opened++;
    connections.open++;
    socket.on('close', () => connections.open--);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    connections,
    setHandler(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// Proxy under test
// ---------------------------------------------------------------------------

export function route(name: string, upstream: string | FakeUpstream, inject: ProxyInjection[] = []): ProxyRoute {
  return {
    name,
    pathPrefix: `/${name}`,
    upstream: typeof upstream === 'string' ? upstream : upstream.url,
    inject,
    allowInsecureUpstream: true,
  };
}

export interface ProxyHarness {
  server: http.Server;
  port: number;
  /** Audit entries received by the log sink. */
  logs: AuditEntry[];
  /** The live secrets object the proxy reads: mutate it to simulate a secret going missing. */
  secrets: Record<string, string | undefined>;
  close(): Promise<void>;
}

export interface StartProxyOptions {
  routes: ProxyRoute[];
  secrets?: Record<string, string | undefined>;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  now?: () => number;
  timeouts?: CreateCredentialProxyOptions['timeouts'];
}

export async function startProxy(options: StartProxyOptions): Promise<ProxyHarness> {
  const config: CredentialProxyConfig = {
    version: 1,
    listenPort: 0,
    routes: options.routes,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? 5_000,
  };
  const logs: AuditEntry[] = [];
  const secrets = options.secrets ?? {};
  const server = createCredentialProxy({
    config,
    secrets,
    log: (entry) => logs.push(entry),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    logs,
    secrets,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface SendOptions {
  port: number;
  method?: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  text: string;
}

/** One request on its own connection (agent: false), body fully collected. */
export function send(options: SendOptions): Promise<Reply> {
  return within(
    new Promise<Reply>((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { ...options.headers };
      const framed = Object.keys(headers).some((k) => ['content-length', 'transfer-encoding'].includes(k.toLowerCase()));
      // node's client sends a DELETE/OPTIONS body with no framing at all unless told the length.
      if (options.body !== undefined && !framed) headers['content-length'] = Buffer.byteLength(options.body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: options.port,
          method: options.method ?? 'GET',
          path: options.path,
          headers,
          agent: false,
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(parts);
            resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body, text: body.toString('utf8') });
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end(options.body);
    }),
    options.timeoutMs ?? 5_000,
    `${options.method ?? 'GET'} ${options.path}`
  );
}

/**
 * Write exact bytes and read until the server closes the connection. For
 * request-targets node's own client would refuse to send or would normalise.
 */
export function rawExchange(port: number, request: string | Buffer, timeoutMs = 3_000): Promise<string> {
  return within(
    new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      socket.on('connect', () => socket.write(request));
    }),
    timeoutMs,
    'raw exchange did not finish (server kept the connection open)'
  );
}

export function rawRequest(target: string, extraHeaders = '', method = 'GET'): string {
  return `${method} ${target} HTTP/1.1\r\nHost: proxy.test\r\nConnection: close\r\n${extraHeaders}\r\n`;
}

export function statusOf(rawResponse: string): number {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(rawResponse);
  return match ? Number(match[1]) : 0;
}

/** Number of header lines named `name` (case-insensitive) in a rawHeaders array. */
export function countHeader(rawHeaders: string[], name: string): number {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === name.toLowerCase()) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The bundled script as a real process
// ---------------------------------------------------------------------------

export interface SidecarProcess {
  child: ChildProcess;
  /** Complete stdout lines so far. */
  lines: string[];
  stderr(): string;
  /** Resolves with the port from the `listening` line; rejects if the process exits first. */
  listening(ms?: number): Promise<number>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Run `node --input-type=module -e <script>` the way the sidecar container does,
 * with a scrubbed environment: only PATH and what the caller passes. Nothing from
 * the test runner (NODE_OPTIONS, CA bundles, proxy variables) leaks in.
 */
export function spawnSidecar(script: string, env: Record<string, string>, cwd?: string): SidecarProcess {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    ...(cwd ? { cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let pending = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      lines.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    lines,
    stderr: () => stderr,
    exited,
    kill: (signal = 'SIGKILL') => {
      child.kill(signal);
    },
    listening: (ms = 10_000) =>
      within(
        (async () => {
          let exitedFirst = false;
          void exited.then(() => (exitedFirst = true));
          for (;;) {
            const line = lines.find((l) => l.includes('"event":"listening"'));
            if (line) return (JSON.parse(line) as { port: number }).port;
            if (exitedFirst) throw new Error(`sidecar exited before listening. stderr: ${stderr}`);
            await sleep(10);
          }
        })(),
        ms,
        'sidecar never printed its listening line'
      ),
  };
}
