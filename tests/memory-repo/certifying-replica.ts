/**
 * A local HTTP server that stands in for a replica which certifies its
 * replies, for the write receipt tests. It serves a BLS root key minted for
 * the test on /api/v2/status (so a loopback agent fetches and trusts it), and
 * answers each update call with a certificate signed by that key, the way a
 * subnet does:
 *
 * - v3 mode: POST /api/v3/canister/<id>/call answers at once with
 *   { status: 'replied', certificate }.
 * - v2 mode: the v3 endpoint answers 404, so agent-js signs the call again
 *   for /api/v2/.../call, which answers 202; the certificate then comes from
 *   POST /api/v2/canister/<id>/read_state, as when polling a real replica.
 *
 * What each call returns is set by `answer`: an {ok} or {err} reply, or a
 * certified reject with the message given. Every call envelope is kept as
 * posted, so tests can compare a receipt with the bytes on the wire.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Cbor, reconstruct, domain_sep, requestIdOf, type HashTree } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { bls12_381 } from '@noble/curves/bls12-381';

export type ReplicaAnswer = { ok: string } | { err: string } | { reject: string };

export interface PostedCall {
  url: string;
  /** The CBOR body exactly as posted */
  body: Uint8Array;
  envelope: {
    content: Record<string, unknown> & { method_name: string; arg: Uint8Array };
    sender_pubkey: Uint8Array;
    sender_sig: Uint8Array;
  };
}

export interface CertifyingReplica {
  host: string;
  /** The DER BLS root key the replica serves and signs certificates with */
  rootKey: Uint8Array;
  mode: 'v3' | 'v2';
  answer: (methodName: string, arg: Uint8Array) => ReplicaAnswer;
  /** Every call envelope posted, oldest first */
  calls: PostedCall[];
  close(): Promise<void>;
}

/** The DER prefix of an IC BLS12-381 G2 public key, followed by the 96-byte key. */
const BLS_ROOT_KEY_DER_PREFIX = Buffer.from(
  '308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100',
  'hex',
);

const OperationResult = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
const encoder = new TextEncoder();

export async function startCertifyingReplica(): Promise<CertifyingReplica> {
  const secretKey = bls12_381.utils.randomPrivateKey();
  const rootKey = new Uint8Array([...BLS_ROOT_KEY_DER_PREFIX, ...bls12_381.getPublicKeyForShortSignatures(secretKey)]);
  // The certified outcome of each call, by request id, for read_state to certify again in v2 mode
  const statuses = new Map<string, HashTree>();

  async function certificateFor(requestId: Uint8Array): Promise<Uint8Array> {
    const status = statuses.get(Buffer.from(requestId).toString('hex'));
    if (!status) throw new Error('no call with this request id');
    const tree = fork(
      labeled('request_status', labeled(requestId, status)),
      labeled('time', leaf(leb128(BigInt(Date.now()) * 1_000_000n))),
    );
    const message = new Uint8Array([...domain_sep('ic-state-root'), ...(await reconstruct(tree))]);
    return Cbor.encode({ tree, signature: bls12_381.signShortSignature(message, secretKey) });
  }

  const replica: CertifyingReplica = {
    host: '',
    rootKey,
    mode: 'v3',
    answer: () => ({ ok: 'commit-1' }),
    calls: [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void respond(req.url ?? '', new Uint8Array(Buffer.concat(chunks)), res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
    });
  });

  async function respond(url: string, body: Uint8Array, res: http.ServerResponse): Promise<void> {
    res.setHeader('content-type', 'application/cbor');
    if (url === '/api/v2/status') {
      res.end(Buffer.from(Cbor.encode({ ic_api_version: '0.18.0', root_key: rootKey })));
      return;
    }
    if (/\/call$/.test(url)) {
      if (replica.mode === 'v2' && url.includes('/api/v3/')) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const envelope = Cbor.decode<PostedCall['envelope']>(body);
      replica.calls.push({ url, body, envelope });
      const requestId = requestIdOf(envelope.content);
      statuses.set(
        Buffer.from(requestId).toString('hex'),
        statusTree(replica.answer(envelope.content.method_name, envelope.content.arg)),
      );
      if (replica.mode === 'v2') {
        res.statusCode = 202;
        res.end();
        return;
      }
      res.end(Buffer.from(Cbor.encode({ status: 'replied', certificate: await certificateFor(requestId) })));
      return;
    }
    if (/\/read_state$/.test(url)) {
      const { content } = Cbor.decode<{ content: { paths: Uint8Array[][] } }>(body);
      const requestId = content.paths[0]?.[1];
      if (!requestId) throw new Error('read_state without a request id');
      res.end(Buffer.from(Cbor.encode({ certificate: await certificateFor(requestId) })));
      return;
    }
    res.statusCode = 400;
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  replica.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return replica;
}

/** A certified outcome: a reply, or a reject as the canister's trap gives it. Labels sorted, as the tree requires. */
function statusTree(answer: ReplicaAnswer): HashTree {
  if ('reject' in answer) {
    return fork(
      fork(labeled('error_code', leaf(encoder.encode('IC0503'))), labeled('reject_code', leaf(new Uint8Array([5])))),
      fork(labeled('reject_message', leaf(encoder.encode(answer.reject))), labeled('status', leaf(encoder.encode('rejected')))),
    );
  }
  return fork(
    labeled('reply', leaf(new Uint8Array(IDL.encode([OperationResult], [answer])))),
    labeled('status', leaf(encoder.encode('replied'))),
  );
}

// HashTree nodes: [1, left, right] fork, [2, label, subtree] labeled, [3, value] leaf
function fork(left: HashTree, right: HashTree): HashTree {
  return [1, left, right] as unknown as HashTree;
}
function labeled(label: string | Uint8Array, subtree: HashTree): HashTree {
  return [2, typeof label === 'string' ? encoder.encode(label) : label, subtree] as unknown as HashTree;
}
function leaf(value: Uint8Array): HashTree {
  return [3, value] as unknown as HashTree;
}

function leb128(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return new Uint8Array(bytes);
}
