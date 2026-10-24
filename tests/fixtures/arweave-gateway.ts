/**
 * A stand-in Arweave gateway for tests that drive the real arweave library.
 * arweave-js talks to its gateway through the global fetch, so a test installs
 * this with vi.stubGlobal('fetch', gateway.fetch) and nothing leaves the
 * process. It answers what an upload asks for (tx_anchor, price, POST /tx),
 * keeps every posted transaction with its data decoded, takes chunks posted
 * to /chunk (data over 256 KiB goes up that way), serves posted data back
 * through the chunk endpoints, and answers /tx/{id}/status from `statuses`
 * (404 for any id not listed, as arweave.net does). A route listed in `hang`
 * ('tx' for POST /tx, 'chunk' for POST /chunk) never answers.
 */

import { createHash, generateKeyPairSync, type JsonWebKey } from 'node:crypto';

export interface PostedTransaction {
  id: string;
  owner: string;
  signature: string;
  /** The transaction's data, decoded from the base64url the client posted. */
  data: Buffer;
  /** The data_size field the client signed. */
  dataSize: number;
  /** Tags, decoded from base64url. */
  tags: Record<string, string>;
}

export interface PostedChunk {
  dataRoot: string;
  offset: number;
  chunk: Buffer;
}

export interface FakeGateway {
  fetch: typeof fetch;
  posted: PostedTransaction[];
  /** The HTTP status POST /tx answers with. */
  postStatus: number;
  /** Every POST /chunk, accepted or not, in order. */
  chunks: PostedChunk[];
  /** The HTTP status POST /chunk answers with. */
  chunkStatus: number;
  /** Routes that never answer: 'tx' (POST /tx) and/or 'chunk' (POST /chunk). */
  hang: Set<'tx' | 'chunk'>;
  /** Each request left unanswered because its route is in `hang`. */
  hung: Array<'tx' | 'chunk'>;
  /** Answers for /tx/{id}/status, by transaction id. */
  statuses: Map<string, { status: number; body: string }>;
}

// Any 43+ character base64url string passes arweave-js's anchor check.
const ANCHOR = 'A'.repeat(64);

export function fakeArweaveGateway(): FakeGateway {
  const offsets = new Map<string, { start: number; data: Buffer }>();
  let nextOffset = 1;

  const gateway: FakeGateway = {
    posted: [],
    postStatus: 200,
    chunks: [],
    chunkStatus: 200,
    hang: new Set(),
    hung: [],
    statuses: new Map(),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const route = url.pathname.replace(/^\/+/, '');
      const method = init?.method ?? 'GET';

      if (method === 'POST' && (route === 'tx' || route === 'chunk') && gateway.hang.has(route)) {
        gateway.hung.push(route);
        return new Promise<Response>(() => {});
      }

      if (method === 'POST' && route === 'chunk') {
        const raw = JSON.parse(String(init?.body)) as Record<string, string>;
        gateway.chunks.push({
          dataRoot: String(raw['data_root']),
          offset: Number(raw['offset']),
          chunk: Buffer.from(String(raw['chunk']), 'base64url'),
        });
        return gateway.chunkStatus === 200
          ? new Response('OK')
          : Response.json({ error: 'timeout' }, { status: gateway.chunkStatus });
      }

      if (method === 'POST' && route === 'tx') {
        const raw = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const tx: PostedTransaction = {
          id: String(raw['id']),
          owner: String(raw['owner']),
          signature: String(raw['signature']),
          data: Buffer.from(String(raw['data']), 'base64url'),
          dataSize: Number(raw['data_size']),
          tags: Object.fromEntries(
            (raw['tags'] as Array<{ name: string; value: string }>).map((tag) => [
              Buffer.from(tag.name, 'base64url').toString('utf8'),
              Buffer.from(tag.value, 'base64url').toString('utf8'),
            ]),
          ),
        };
        gateway.posted.push(tx);
        if (gateway.postStatus >= 200 && gateway.postStatus < 300) {
          offsets.set(tx.id, { start: nextOffset, data: tx.data });
          nextOffset += tx.data.length;
        }
        return new Response(gateway.postStatus < 300 ? 'OK' : 'Rejected', { status: gateway.postStatus });
      }

      if (route === 'tx_anchor') {
        return new Response(ANCHOR);
      }
      if (route.startsWith('price/')) {
        return new Response('1000');
      }

      const status = /^tx\/([^/]+)\/status$/.exec(route);
      if (status) {
        const answer = gateway.statuses.get(status[1]!) ?? { status: 404, body: 'Not Found.' };
        return new Response(answer.body, { status: answer.status });
      }

      const offset = /^tx\/([^/]+)\/offset$/.exec(route);
      const stored = offset ? offsets.get(offset[1]!) : undefined;
      if (stored) {
        return Response.json({
          size: String(stored.data.length),
          offset: String(stored.start + stored.data.length - 1),
        });
      }

      const chunk = /^chunk\/(\d+)$/.exec(route);
      const chunkOf = chunk ? [...offsets.values()].find((entry) => entry.start === Number(chunk[1])) : undefined;
      if (chunkOf) {
        return Response.json({ chunk: chunkOf.data.toString('base64url') });
      }

      return new Response('Not Found.', { status: 404 });
    },
  };

  return gateway;
}

/**
 * A throwaway RSA key in the JWK form Arweave wallets use. 2048 bits keeps
 * the tests fast; mainnet wallets are 4096 bits, which changes nothing here.
 */
export function arweaveTestJwk(): JsonWebKey {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  return privateKey.export({ format: 'jwk' });
}

/** A transaction id is the base64url SHA-256 of its signature bytes. */
export function transactionIdOf(signature: string): string {
  return createHash('sha256').update(Buffer.from(signature, 'base64url')).digest('base64url');
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
