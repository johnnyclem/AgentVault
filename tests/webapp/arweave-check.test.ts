/**
 * The Evidence page's browser check (webapp/src/lib/proof/arweave-check.ts).
 * A receipt reads as confirmed only when the gateway reports the transaction
 * mined with at least one confirmation AND the SHA-256 of the bytes it serves
 * equals the checksum the server recorded. Every other outcome, including bad
 * input, an unreadable answer, a network error or an exception, is some other
 * state, and the check never rejects.
 *
 * The gateway is a stubbed fetch; hashing uses node's real WebCrypto unless a
 * test swaps in its own SubtleCrypto. A failed check says whether asking
 * again could change the answer, and a gateway that never answers ends the
 * check after a time limit instead of leaving it waiting.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

type ReceiptCheckResult =
  | { state: 'confirmed'; confirmations: number; blockHeight: number; blockHash: string }
  | { state: 'pending' }
  | { state: 'not-found' }
  | { state: 'size-mismatch'; expected: number; actual: number }
  | { state: 'content-mismatch'; expected: string; actual: string }
  | { state: 'too-large'; maxBytes: number }
  | { state: 'check-failed'; reason: string; retryable: boolean };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface SubtleLike {
  digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
}

interface CheckOptions {
  fetch: FetchLike;
  subtle: SubtleLike | undefined;
  gateway?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface CheckModule {
  checkReceipt: (receipt: Record<string, unknown>, options: CheckOptions) => Promise<ReceiptCheckResult>;
  isTxId: (value: unknown) => boolean;
  DEFAULT_MAX_BYTES: number;
  DEFAULT_TIMEOUT_MS: number;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'arweave-check.ts');
let check: CheckModule;

beforeAll(async () => {
  check = (await import(MODULE)) as CheckModule;
});

const TX = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';
const BLOCK_HASH = 'tjMxHhuJoob_MksfJZ4lQSyVKP4ab4TeoGPZ-8-Fe7s-MHOGN2JzY8vaV0I0rhgk';
const CONTENT = JSON.stringify({ agentId: 'research-agent', canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', note: 'café' });
const BYTES = new TextEncoder().encode(CONTENT);
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');
const STATUS_URL = `https://arweave.net/tx/${TX}/status`;
const RAW_URL = `https://arweave.net/raw/${TX}`;
const subtle = globalThis.crypto.subtle as unknown as SubtleLike;

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    archiveId: 'archive-1761300000000-1a2b3c4d',
    txId: TX,
    checksum: CHECKSUM,
    sizeBytes: BYTES.byteLength,
    recordedAt: '2026-10-22T10:00:00.000Z',
    recordedStatus: 'submitted',
    ...overrides,
  };
}

function mined(confirmations = 12, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    block_height: 2_027_980,
    block_indep_hash: BLOCK_HASH,
    number_of_confirmations: confirmations,
    ...overrides,
  });
}

function bytes(body: Uint8Array | string = BYTES): Response {
  return new Response(body, { status: 200 });
}

/** A stand-in gateway: each route builds a fresh Response, and every request is recorded. */
function gateway(routes: { status?: () => Response; raw?: () => Response } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    if (url.endsWith('/status') && routes.status) return routes.status();
    if (url.includes('/raw/') && routes.raw) return routes.raw();
    return new Response('Not Found.', { status: 404 });
  });
  return { fetch, requests, urls: () => requests.map((request) => request.url) };
}

async function run(
  routes: Parameters<typeof gateway>[0],
  overrides: Record<string, unknown> = {},
  options: Partial<CheckOptions> = {},
) {
  const stub = gateway(routes);
  const result = await check.checkReceipt(receipt(overrides), { fetch: stub.fetch, subtle, ...options });
  return { result, ...stub };
}

describe('checkReceipt: confirmed', () => {
  it('confirms a mined transaction whose served bytes hash to the recorded checksum', async () => {
    const { result, urls, requests } = await run({ status: () => mined(12), raw: () => bytes() });

    expect(result).toEqual({ state: 'confirmed', confirmations: 12, blockHeight: 2_027_980, blockHash: BLOCK_HASH });
    expect(urls()).toEqual([STATUS_URL, RAW_URL]);
    // The gateway caches status responses; a retry must ask again rather than reuse one.
    expect(requests[0]?.init).toMatchObject({ cache: 'no-store' });
  });

  it('needs only one confirmation', async () => {
    const { result } = await run({ status: () => mined(1), raw: () => bytes() });

    expect(result.state).toBe('confirmed');
  });

  it('asks the gateway it is given, without doubling a trailing slash', async () => {
    const { result, urls } = await run(
      { status: () => mined(), raw: () => bytes() },
      {},
      { gateway: 'https://ar-io.dev/' },
    );

    expect(result.state).toBe('confirmed');
    expect(urls()).toEqual([`https://ar-io.dev/tx/${TX}/status`, `https://ar-io.dev/raw/${TX}`]);
  });

  it('calls fetch as a plain function, as a browser\'s window.fetch requires', async () => {
    const strictFetch = async function (this: unknown, url: string): Promise<Response> {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return url.endsWith('/status') ? mined() : bytes();
    };

    const result = await check.checkReceipt(receipt(), { fetch: strictFetch, subtle });

    expect(result.state).toBe('confirmed');
  });
});

describe('checkReceipt: not mined, or not there', () => {
  it('reports 202 as pending without downloading the content', async () => {
    const { result, urls } = await run({ status: () => new Response('Pending', { status: 202 }), raw: () => bytes() });

    expect(result).toEqual({ state: 'pending' });
    expect(urls()).toEqual([STATUS_URL]);
  });

  it('reports a 200 with zero confirmations as pending, never confirmed', async () => {
    const { result, urls } = await run({ status: () => mined(0), raw: () => bytes() });

    expect(result).toEqual({ state: 'pending' });
    expect(urls()).toEqual([STATUS_URL]);
  });

  it('reports 404 as not found', async () => {
    const { result } = await run({ status: () => new Response('Not Found.', { status: 404 }), raw: () => bytes() });

    expect(result).toEqual({ state: 'not-found' });
  });

  it.each([400, 429, 500, 503])('reports any other status (%i) as a failed check', async (status) => {
    const { result } = await run({ status: () => new Response('nope', { status }), raw: () => bytes() });

    expect(result).toEqual({
      state: 'check-failed',
      reason: `The gateway answered the status request with HTTP ${status}.`,
      retryable: true,
    });
  });
});

describe('checkReceipt: answers it cannot read', () => {
  const unreadable: Array<[string, () => Response]> = [
    ['a body that is not JSON', () => new Response('<html>gateway error</html>', { status: 200 })],
    ['JSON null', () => Response.json(null)],
    ['a JSON array', () => Response.json([1, 2, 3])],
    ['confirmations as a string', () => mined(12, { number_of_confirmations: '12' })],
    ['negative confirmations', () => mined(-1)],
    ['fractional confirmations', () => mined(1.5)],
    ['no block height', () => mined(12, { block_height: undefined })],
    ['a malformed block hash', () => mined(12, { block_indep_hash: 'not a hash' })],
    ['an empty body', () => new Response('', { status: 200 })],
  ];

  it.each(unreadable)('fails the check on %s and never downloads the content', async (_label, status) => {
    const { result, urls } = await run({ status, raw: () => bytes() });

    expect(result).toEqual({
      state: 'check-failed',
      reason: 'The gateway sent a transaction status this page cannot read.',
      retryable: true,
    });
    expect(urls()).toEqual([STATUS_URL]);
  });

  it('fails the check when the content request does not answer 200', async () => {
    const { result } = await run({ status: () => mined(), raw: () => new Response('Not Found.', { status: 404 }) });

    expect(result).toEqual({
      state: 'check-failed',
      reason: 'The gateway answered the content request with HTTP 404.',
      retryable: true,
    });
  });
});

describe('checkReceipt: content and size', () => {
  it('reports different bytes of the same length as a content mismatch, with both hashes', async () => {
    const tampered = CONTENT.replace('research-agent', 'research-agenT');
    const { result } = await run({ status: () => mined(), raw: () => bytes(tampered) });

    expect(result).toEqual({
      state: 'content-mismatch',
      expected: CHECKSUM,
      actual: createHash('sha256').update(tampered).digest('hex'),
    });
  });

  it('reports a content mismatch when SubtleCrypto returns a different digest', async () => {
    const wrongDigest: SubtleLike = { digest: async () => new Uint8Array(32).buffer };
    const { result } = await run({ status: () => mined(), raw: () => bytes() }, {}, { subtle: wrongDigest });

    expect(result).toEqual({ state: 'content-mismatch', expected: CHECKSUM, actual: '0'.repeat(64) });
  });

  it('reports fewer or more bytes than recorded as a size mismatch', async () => {
    const short = await run({ status: () => mined(), raw: () => bytes(BYTES.slice(0, 10)) });
    const long = await run({ status: () => mined(), raw: () => bytes(`${CONTENT} `) });

    expect(short.result).toEqual({ state: 'size-mismatch', expected: BYTES.byteLength, actual: 10 });
    expect(long.result).toEqual({ state: 'size-mismatch', expected: BYTES.byteLength, actual: BYTES.byteLength + 1 });
  });

  it('counts bytes, not characters, so multi-byte text is measured as uploaded', async () => {
    expect(BYTES.byteLength).toBeGreaterThan(CONTENT.length);

    const { result } = await run({ status: () => mined(), raw: () => bytes(CONTENT) });

    expect(result.state).toBe('confirmed');
  });

  it('does not download content whose recorded size is over the limit', async () => {
    const { result, urls } = await run({ status: () => mined(), raw: () => bytes() }, {}, { maxBytes: BYTES.byteLength - 1 });

    expect(result).toEqual({ state: 'too-large', maxBytes: BYTES.byteLength - 1 });
    expect(urls()).toEqual([STATUS_URL]);
  });

  it('downloads content exactly at the limit', async () => {
    const { result } = await run({ status: () => mined(), raw: () => bytes() }, {}, { maxBytes: BYTES.byteLength });

    expect(result.state).toBe('confirmed');
  });

  it('stops reading once the gateway sends more than the limit, whatever the receipt says', async () => {
    const chunk = new Uint8Array(1024);
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const { result } = await run(
      { status: () => mined(), raw: () => new Response(endless, { status: 200 }) },
      { sizeBytes: 2048 },
      { maxBytes: 4096 },
    );

    expect(result).toEqual({ state: 'too-large', maxBytes: 4096 });
    expect(cancelled).toBe(true);
    // The fifth chunk crosses the limit; a stream may pre-pull a little, never the whole thing.
    expect(pulls).toBeLessThan(10);
  });

  it('uses a 5 MB limit by default', () => {
    expect(check.DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

// Asking again cannot fix these, so they are not offered as retryable.
describe('checkReceipt: bad input never reaches the network', () => {
  const badTxIds: unknown[] = [
    '',
    TX.slice(1),
    `${TX}A`,
    `${TX.slice(0, 40)}../`,
    `${TX.slice(0, 42)}/`,
    `${TX.slice(0, 42)}?`,
    `${TX.slice(0, 42)}=`,
    undefined,
    42,
  ];

  it.each(badTxIds)('fails the check for transaction id %j', async (txId) => {
    const { result, fetch } = await run({ status: () => mined(), raw: () => bytes() }, { txId });

    expect(result).toEqual({
      state: 'check-failed',
      reason: 'The recorded transaction id is not a valid Arweave id.',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  const badChecksums: unknown[] = [
    '',
    CHECKSUM.toUpperCase(),
    CHECKSUM.slice(1),
    `${CHECKSUM}0`,
    `sha256-${CHECKSUM}`,
    `${CHECKSUM.slice(0, 63)}g`,
    undefined,
  ];

  it.each(badChecksums)('fails the check for checksum %j', async (checksum) => {
    const { result, fetch } = await run({ status: () => mined(), raw: () => bytes() }, { checksum });

    expect(result).toEqual({
      state: 'check-failed',
      reason: 'The recorded checksum is not a SHA-256 hex digest.',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12', undefined])('fails the check for size %j', async (sizeBytes) => {
    const { result, fetch } = await run({ status: () => mined(), raw: () => bytes() }, { sizeBytes });

    expect(result).toEqual({ state: 'check-failed', reason: 'The recorded size is not a byte count.', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails the check where the browser has no WebCrypto, before asking the gateway', async () => {
    const { result, fetch } = await run({ status: () => mined(), raw: () => bytes() }, {}, { subtle: undefined });

    expect(result).toMatchObject({ state: 'check-failed', reason: expect.stringMatching(/WebCrypto/), retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('checkReceipt: errors', () => {
  it('turns a network error on the status request into a failed check', async () => {
    const result = await check.checkReceipt(receipt(), {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      subtle,
    });

    expect(result).toEqual({ state: 'check-failed', reason: 'The check did not finish: Failed to fetch', retryable: true });
  });

  it('turns a network error on the content request into a failed check', async () => {
    const { result } = await run({
      status: () => mined(),
      raw: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    expect(result).toEqual({ state: 'check-failed', reason: 'The check did not finish: Failed to fetch', retryable: true });
  });

  it('turns a body that breaks mid-download into a failed check', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const { result } = await run({ status: () => mined(), raw: () => new Response(broken, { status: 200 }) });

    expect(result).toEqual({ state: 'check-failed', reason: 'The check did not finish: connection reset', retryable: true });
  });

  it('turns a hashing error into a failed check', async () => {
    const throwing: SubtleLike = {
      digest: async () => {
        throw new Error('NotSupportedError');
      },
    };
    const { result } = await run({ status: () => mined(), raw: () => bytes() }, {}, { subtle: throwing });

    expect(result).toEqual({ state: 'check-failed', reason: 'The check did not finish: NotSupportedError', retryable: true });
  });

  it('turns an aborted check into a failed check', async () => {
    const controller = new AbortController();
    const result = await check.checkReceipt(receipt(), {
      fetch: async (_url, init) => {
        controller.abort();
        init?.signal?.throwIfAborted();
        return mined();
      },
      subtle,
      signal: controller.signal,
    });

    expect(result.state).toBe('check-failed');
  });

  it('never rejects and never confirms when something goes wrong, whatever it is', async () => {
    const failures: Array<() => Promise<ReceiptCheckResult>> = [
      () => check.checkReceipt(receipt(), { fetch: () => Promise.reject(new Error('boom')), subtle }),
      () => check.checkReceipt(receipt(), { fetch: () => Promise.reject('a string, not an Error'), subtle }),
      () => check.checkReceipt(receipt(), { fetch: async () => ({}) as Response, subtle }),
      () => check.checkReceipt(receipt(), { fetch: async () => null as unknown as Response, subtle }),
      () => check.checkReceipt(receipt(), {
        fetch: async (url) => (url.endsWith('/status') ? mined() : ({ status: 200, body: 'nope' } as unknown as Response)),
        subtle,
      }),
      () => check.checkReceipt(receipt(), {
        fetch: async (url) => (url.endsWith('/status') ? mined() : bytes()),
        subtle: {} as SubtleLike,
      }),
      () => check.checkReceipt(null as unknown as Record<string, unknown>, { fetch: async () => mined(), subtle }),
    ];

    for (const failure of failures) {
      const result = await failure();
      expect(result.state).toBe('check-failed');
    }
  });
});

describe('checkReceipt: a gateway that does not answer', () => {
  const TIMED_OUT = { state: 'check-failed', reason: 'The gateway did not answer within 0.02 seconds.', retryable: true };

  it('gives up on a status request that never answers, even one that ignores the abort', async () => {
    const never = vi.fn((): Promise<Response> => new Promise(() => {}));

    const result = await check.checkReceipt(receipt(), { fetch: never, subtle, timeoutMs: 20 });

    expect(result).toEqual(TIMED_OUT);
    expect(never).toHaveBeenCalledTimes(1);
  });

  it('aborts the request it gave up on, and reports the time limit rather than the abort', async () => {
    let signal: AbortSignal | undefined;
    const honoursAbort = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });

    const result = await check.checkReceipt(receipt(), { fetch: honoursAbort, subtle, timeoutMs: 20 });

    expect(result).toEqual(TIMED_OUT);
    expect(signal?.aborted).toBe(true);
  });

  it('gives up on content that stops arriving part way', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, 10));
      },
    });

    const { result } = await run(
      { status: () => mined(), raw: () => new Response(stalled, { status: 200 }) },
      {},
      { timeoutMs: 20 },
    );

    expect(result).toEqual(TIMED_OUT);
  });

  it('does not cut short a check that finishes in time', async () => {
    const { result } = await run({ status: () => mined(), raw: () => bytes() }, {}, { timeoutMs: 1_000 });

    expect(result.state).toBe('confirmed');
  });

  it('still ends when the caller aborts, before the time limit', async () => {
    const controller = new AbortController();
    const honoursAbort = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });

    const pending = check.checkReceipt(receipt(), { fetch: honoursAbort, subtle, signal: controller.signal, timeoutMs: 60_000 });
    controller.abort();

    expect(await pending).toEqual({
      state: 'check-failed',
      reason: 'The check did not finish: This operation was aborted',
      retryable: true,
    });
  });

  it('waits 20 seconds by default', () => {
    expect(check.DEFAULT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('isTxId', () => {
  it('accepts 43 base64url characters only', () => {
    expect(check.isTxId(TX)).toBe(true);
    expect(check.isTxId(`${TX.slice(0, 42)}-`)).toBe(true);
    expect(check.isTxId(`${TX.slice(0, 42)}+`)).toBe(false);
    expect(check.isTxId(TX.slice(1))).toBe(false);
    expect(check.isTxId(null)).toBe(false);
  });
});
