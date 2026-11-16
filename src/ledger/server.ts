/**
 * The ledger gateway: a small HTTP API an agent host writes its sealed
 * records to.
 *
 *   GET  /v1/health                               liveness and limits; no token
 *   GET  /v1/streams?after=&limit=                the streams, a page at a time
 *   POST /v1/streams/<stream>/entries             append { entries: [...] }
 *   GET  /v1/streams/<stream>                     the stream's head and anchored mark
 *   GET  /v1/streams/<stream>/entries?after=&limit=   read entries back
 *
 * Every route but health needs `Authorization: Bearer <token>`. The gateway
 * speaks plain HTTP and binds to loopback by default; put TLS in front of it
 * before exposing it beyond the host.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { anchorPending, type AnchorOptions, type LedgerAnchor } from './anchor.js';
import { LEDGER_FORMAT, MAX_APPEND_ENTRIES, MAX_PAYLOAD_BYTES, appendRequestSchema, isStreamId } from './format.js';
import { LedgerConflictError, LedgerCorruptError, type AnchorRecord, type LedgerStore } from './store.js';

/** The largest request body the gateway reads. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The shortest token the gateway accepts, so a guessable one cannot be configured by accident. */
export const MIN_TOKEN_LENGTH = 32;
const MAX_READ_LIMIT = 500;

export interface LedgerServerOptions {
  store: LedgerStore;
  /** The bearer token clients present. */
  token: string;
  /** Called with errors the client is only told about as a 500. */
  onError?: (error: unknown) => void;
}

const STREAM_ROUTE = /^\/v1\/streams\/([^/]+)(\/entries)?$/;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

/** The gateway's HTTP server, not yet listening. */
export function createLedgerServer(options: LedgerServerOptions): http.Server {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The ledger token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const expected = digest(options.token);
  const authorized = (request: http.IncomingMessage): boolean => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    return match !== null && timingSafeEqual(digest(match[1]!), expected);
  };

  return http.createServer((request, response) => {
    handle(request, response, options, authorized).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) send(response, 500, { error: 'internal' });
      else response.destroy();
    });
  });
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: LedgerServerOptions,
  authorized: (request: http.IncomingMessage) => boolean,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://ledger.invalid');
  if (url.pathname === '/v1/health') {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    return send(response, 200, {
      ok: true,
      format: LEDGER_FORMAT,
      limits: { maxBodyBytes: MAX_BODY_BYTES, maxPayloadBytes: MAX_PAYLOAD_BYTES, maxEntries: MAX_APPEND_ENTRIES },
    });
  }
  if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });

  if (url.pathname === '/v1/streams') {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    const after = url.searchParams.get('after') ?? '';
    const limit = wholeNumber(url.searchParams.get('limit') ?? String(DEFAULT_LIST_LIMIT));
    if ((after !== '' && !isStreamId(after)) || limit === null || limit < 1 || limit > MAX_LIST_LIMIT) {
      return send(response, 400, { error: 'invalid', message: `after must be a stream id and limit between 1 and ${MAX_LIST_LIMIT}` });
    }
    return send(response, 200, listStreams(options.store, after, limit));
  }

  const route = STREAM_ROUTE.exec(url.pathname);
  if (!route) return send(response, 404, { error: 'not_found' });
  const stream = decodeSegment(route[1]!);
  if (stream === null || !isStreamId(stream)) return send(response, 400, { error: 'invalid', message: 'Invalid stream id' });
  const { store } = options;

  if (!route[2]) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    const head = store.head(stream);
    if (!head) return send(response, 404, { error: 'not_found' });
    return send(response, 200, { head, anchored: { seq: store.anchoredSeq(stream) } });
  }

  if (request.method === 'GET') {
    const after = wholeNumber(url.searchParams.get('after') ?? '0');
    const limit = wholeNumber(url.searchParams.get('limit') ?? '100');
    if (after === null || limit === null || limit < 1 || limit > MAX_READ_LIMIT) {
      return send(response, 400, { error: 'invalid', message: `after must be a whole number and limit between 1 and ${MAX_READ_LIMIT}` });
    }
    return send(response, 200, { entries: store.read(stream, { after, limit, maxBytes: MAX_BODY_BYTES }), head: store.head(stream) });
  }
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });

  const body = await readBody(request);
  if (body === 'too_large') return send(response, 413, { error: 'too_large' });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return send(response, 400, { error: 'invalid', message: 'The body is not JSON' });
  }
  const parsed = appendRequestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return send(response, 400, { error: 'invalid', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid entries' });
  }
  try {
    const { head, appended } = store.append(stream, parsed.data.entries);
    return send(response, 200, { head, appended, anchored: { seq: store.anchoredSeq(stream) } });
  } catch (error) {
    if (error instanceof LedgerConflictError) {
      return send(response, 409, { error: error.reason, message: error.message, head: error.head });
    }
    throw error;
  }
}

/**
 * One page of streams after `after`, in id order. A stream whose file no longer reads back is
 * listed as corrupt rather than failing the page, so the healthy ones can still be found.
 */
function listStreams(store: LedgerStore, after: string, limit: number) {
  const ids = store.streams().filter((id) => id > after);
  const page = ids.slice(0, limit);
  const streams = page.map((stream) => {
    try {
      const head = store.head(stream);
      return { stream, head, anchored: { seq: store.anchoredSeq(stream) } };
    } catch (error) {
      if (error instanceof LedgerCorruptError) return { stream, head: null, corrupt: true };
      throw error;
    }
  });
  return { streams, next: ids.length > limit ? page.at(-1)! : null };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function wholeNumber(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request: http.IncomingMessage): Promise<string | 'too_large'> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    request.resume();
    return 'too_large';
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      return 'too_large';
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface AnchorSchedule {
  /** Anchors now, or joins the run already in flight. */
  run(): Promise<void>;
  /** Stops the timer and waits for a run in flight to finish. */
  stop(): Promise<void>;
}

/**
 * Anchors what is pending every `intervalMs`. A failed run is reported and
 * retried at the next interval: what it did not anchor is still in the store.
 */
export function startAnchorSchedule(
  store: LedgerStore,
  anchor: LedgerAnchor,
  options: AnchorOptions & {
    intervalMs: number;
    onAnchored?: (records: AnchorRecord[]) => void;
    onError?: (error: unknown) => void;
  },
): AnchorSchedule {
  let running: Promise<void> | undefined;
  const run = (): Promise<void> => {
    running ??= anchorPending(store, anchor, options)
      .then((records) => {
        if (records.length > 0) options.onAnchored?.(records);
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const timer = setInterval(() => void run(), options.intervalMs);
  timer.unref();
  return {
    run,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
