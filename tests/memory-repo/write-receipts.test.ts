/**
 * Receipts for the memory_repo writes the webapp signs, captured through the
 * real agent-js call path: the server's identity wrapped by recordCalls, the
 * agent createMemoryRepoAgent builds, and callWithReceipt. A local server
 * stands in for a replica that certifies its replies with a BLS root key
 * minted for the test (certifying-replica.ts), in both the v3 call path and
 * the v2 path that polls read_state.
 *
 * A receipt is only worth keeping if a third party can check it from its
 * bytes alone, so these tests check the captured receipts independently: the
 * request id recomputed from the recorded fields, the signature with
 * node:crypto, the principal derived from the key, and the certificate
 * against the test root key (and not against the IC's).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import {
  Cbor,
  Certificate,
  Endpoint,
  IC_ROOT_KEY,
  IC_REQUEST_DOMAIN_SEPARATOR,
  lookupResultToBuffer,
  requestIdOf,
  type HttpAgentRequest,
} from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  explainMemoryRepoWriteError,
  memoryRepoErrorText,
} from '../../src/canister/memory-repo-actor.js';
import {
  callWithReceipt,
  parseReceiptLine,
  receiptNetwork,
  recordCalls,
  type ReceiptedCall,
} from '../../src/canister/memory-repo-receipts.js';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';
import { identityFromPem } from '../../src/canister/identity.js';
import { ed25519Key, secp256k1Key, type TestKey } from '../fixtures/signing-identities.js';
import { startCertifyingReplica, type CertifyingReplica, type PostedCall } from './certifying-replica.js';

const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const NOT_AUTHORIZED = "Canister called `ic0.trap` with message: 'caller principal is not authorized'";
const ENTRIES = [
  { key: 'concepts/c1', data: '{"title":"t"}', tags: ['polytician'] },
  { key: 'concepts/c2', data: '{"title":"u"}' },
];
const COMMIT: ReceiptedCall = {
  kind: 'commit',
  args: ['polytician-main', 'push concept c1', JSON.stringify(ENTRIES), ['polytician']],
};

let replica: CertifyingReplica;

beforeAll(async () => {
  replica = await startCertifyingReplica();
});

afterAll(async () => {
  await replica.close();
});

beforeEach(() => {
  replica.mode = 'v3';
  replica.answer = () => ({ ok: 'commit-1' });
  replica.calls.length = 0;
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
// A copy, not a view into Node's shared Buffer pool, which agent-js's CBOR decoding does not expect
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));

async function signedWriter(key: TestKey) {
  const recorder = recordCalls(identityFromPem(key.pem).identity);
  const agent = await createMemoryRepoAgent(replica.host, recorder.identity);
  return { recorder, agent, context: { agent, canisterId: CANISTER_ID, recorder } };
}

/** The posted call a receipt names, found by recomputing each envelope's request id. */
function postedCallFor(receipt: IcpWriteReceipt): PostedCall {
  const posted = replica.calls.find((call) => hex(requestIdOf(call.envelope.content)) === receipt.id);
  expect(posted, `no posted call has request id ${receipt.id}`).toBeDefined();
  return posted!;
}

/** The checks a third party makes, from the receipt's bytes alone. */
async function checkIndependently(receipt: IcpWriteReceipt, rootKey: Uint8Array): Promise<{ requestId: string; status: string; reply: unknown }> {
  const content = {
    request_type: 'call',
    canister_id: Principal.fromText(receipt.request.canisterId),
    method_name: receipt.request.methodName,
    arg: bytes(receipt.request.arg),
    sender: Principal.fromText(receipt.request.sender),
    ingress_expiry: BigInt(receipt.request.ingressExpiry),
    ...(receipt.request.nonce === null ? {} : { nonce: bytes(receipt.request.nonce) }),
  };
  const requestId = requestIdOf(content);
  const signed = Buffer.concat([Buffer.from(IC_REQUEST_DOMAIN_SEPARATOR), Buffer.from(requestId)]);
  const publicKey = createPublicKey({ key: Buffer.from(receipt.senderPubkey, 'hex'), format: 'der', type: 'spki' });
  const signature = bytes(receipt.senderSig);
  const signatureValid = publicKey.asymmetricKeyType === 'ed25519'
    ? verify(null, signed, publicKey, signature)
    : verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  expect(signatureValid).toBe(true);
  expect(Principal.selfAuthenticating(bytes(receipt.senderPubkey)).toText()).toBe(receipt.request.sender);

  const certificate = await Certificate.create({
    certificate: bytes(receipt.certificate),
    rootKey,
    canisterId: Principal.fromText(receipt.request.canisterId),
    disableTimeVerification: true,
  });
  const leaf = (name: string) => lookupResultToBuffer(certificate.lookup_path(['request_status', requestId, name]));
  const [reply] = IDL.decode([IDL.Variant({ ok: IDL.Text, err: IDL.Text })], leaf('reply')!);
  return { requestId: hex(requestId), status: new TextDecoder().decode(leaf('status')), reply };
}

describe.each([
  ['Ed25519', ed25519Key],
  ['secp256k1', () => secp256k1Key()],
] as const)('a %s server identity', (_name, makeKey) => {
  describe.each(['v3', 'v2'] as const)('through the %s call path', (mode) => {
    it('returns the write result and a receipt holding the exact signed call and its certificate', async () => {
      replica.mode = mode;
      const key = makeKey();
      const { recorder, context } = await signedWriter(key);
      const recordedAt = new Date('2026-10-24T12:00:00.000Z');

      const { result, receipt, captureError } = await callWithReceipt({ ...context, now: () => recordedAt }, COMMIT);

      expect(result).toEqual({ ok: 'commit-1' });
      expect(captureError).toBeNull();
      expect(receipt).not.toBeNull();

      // v2 signs the call a second time after the v3 endpoint's 404; the
      // receipt is for the call the certificate answers
      expect(recorder.calls().size).toBe(mode === 'v2' ? 2 : 1);
      expect(replica.calls).toHaveLength(1);
      const { envelope } = postedCallFor(receipt!);

      expect(receipt).toMatchObject({
        version: 1,
        id: hex(requestIdOf(envelope.content)),
        recordedAt: recordedAt.toISOString(),
        // A loopback agent fetched its root key from the replica
        network: 'local',
        request: {
          canisterId: CANISTER_ID,
          methodName: 'commitToBranch',
          arg: hex(envelope.content.arg),
          sender: key.principal,
          ingressExpiry: String(envelope.content['ingress_expiry']),
          nonce: hex(envelope.content['nonce'] as Uint8Array),
        },
        senderPubkey: hex(envelope.sender_pubkey),
        senderSig: hex(envelope.sender_sig),
        result: { ok: 'commit-1' },
        summary: {
          kind: 'commit',
          branch: 'polytician-main',
          message: 'push concept c1',
          tags: ['polytician'],
          diffBytes: Buffer.byteLength(JSON.stringify(ENTRIES)),
          entryCount: 2,
          entryKeys: ['concepts/c1', 'concepts/c2'],
        },
      });

      const checked = await checkIndependently(receipt!, replica.rootKey);
      expect(checked).toEqual({ requestId: receipt!.id, status: 'replied', reply: { ok: 'commit-1' } });
    });

    it('a certificate from the test replica does not check out against the IC root key', async () => {
      replica.mode = mode;
      const { context } = await signedWriter(makeKey());
      const { receipt } = await callWithReceipt(context, COMMIT);

      await expect(checkIndependently(receipt!, bytes(IC_ROOT_KEY))).rejects.toThrow();
    });

    it('a certified reject throws exactly as the plain actor does, and leaves no receipt', async () => {
      replica.mode = mode;
      replica.answer = () => ({ reject: NOT_AUTHORIZED });
      const key = makeKey();
      const { agent, context } = await signedWriter(key);

      const captured = await callWithReceipt(context, COMMIT).catch((error: unknown) => error);
      const plain = await createMemoryRepoActor(CANISTER_ID, agent).commitToBranch(...COMMIT.args).catch((error: unknown) => error);

      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).constructor).toBe((plain as Error).constructor);
      expect(memoryRepoErrorText(captured)).toBe(memoryRepoErrorText(plain));
      expect(explainMemoryRepoWriteError(captured, key.principal)?.code).toBe('SIGNER_NOT_AUTHORIZED');
    });
  });
});

describe('callWithReceipt', () => {
  it('receipts createBranchFrom as a branch, with the reply text as its result', async () => {
    replica.answer = (method) => (method === 'createBranchFrom' ? { ok: "Branch 'polytician-main' created" } : { ok: 'x' });
    const key = ed25519Key();
    const { context } = await signedWriter(key);

    const { result, receipt, captureError } = await callWithReceipt(context, { kind: 'branch', args: ['polytician-main', 'main'] });

    expect(result).toEqual({ ok: "Branch 'polytician-main' created" });
    expect(captureError).toBeNull();
    expect(receipt!.request.methodName).toBe('createBranchFrom');
    expect(receipt!.result).toEqual({ ok: "Branch 'polytician-main' created" });
    expect(receipt!.summary).toEqual({ kind: 'branch', branch: 'polytician-main', baseBranch: 'main' });
    expect((await checkIndependently(receipt!, replica.rootKey)).reply).toEqual(result);
  });

  it('summarizes a tombstone by the key it deletes', async () => {
    const { context } = await signedWriter(ed25519Key());

    const { receipt } = await callWithReceipt(context, {
      kind: 'tombstone',
      args: ['polytician-main', 'tombstone: concepts/c1', JSON.stringify({ deleted: 'concepts/c1' }), ['tombstone']],
    });

    expect(receipt!.summary).toMatchObject({ kind: 'tombstone', entryCount: 1, entryKeys: ['concepts/c1'], tags: ['tombstone'] });
  });

  it('keeps at most 50 entry keys of at most 200 characters, and no entry fields for a diff it cannot read', async () => {
    const { context } = await signedWriter(ed25519Key());
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `${i}-${'k'.repeat(300)}`, data: '{}' }));

    const { receipt: large } = await callWithReceipt(context, { kind: 'commit', args: ['b', 'm', JSON.stringify(many), []] });
    expect(large!.summary.entryCount).toBe(60);
    expect(large!.summary.entryKeys).toHaveLength(50);
    expect(large!.summary.entryKeys!.every((key) => key.length === 200)).toBe(true);

    const { receipt: opaque } = await callWithReceipt(context, { kind: 'commit', args: ['b', 'm', 'not json', []] });
    expect(opaque!.summary).toEqual({ kind: 'commit', branch: 'b', message: 'm', tags: [], diffBytes: 8 });
  });

  it('an {err} reply is returned as it is, with no receipt and no capture error: nothing was written', async () => {
    replica.answer = () => ({ err: 'Too many tags (maximum 20)' });
    const { context } = await signedWriter(secp256k1Key());

    expect(await callWithReceipt(context, COMMIT)).toEqual({
      result: { err: 'Too many tags (maximum 20)' },
      receipt: null,
      captureError: null,
    });
  });

  it('when capture fails the write still succeeds, with the reason as captureError', async () => {
    const { recorder, context } = await signedWriter(ed25519Key());
    // The recorded copy is lost while the call is in flight
    replica.answer = () => {
      (recorder.calls() as Map<string, unknown>).clear();
      return { ok: 'commit-7' };
    };

    const { result, receipt, captureError } = await callWithReceipt(context, COMMIT);

    expect(result).toEqual({ ok: 'commit-7' });
    expect(receipt).toBeNull();
    expect(captureError).toMatch(/expected one recorded signed call answered by the certificate, found 0 of 0/);
  });

  it('never writes a verdict into a receipt', async () => {
    const { context } = await signedWriter(ed25519Key());
    const { receipt } = await callWithReceipt(context, COMMIT);

    const keys = JSON.stringify(receipt).match(/"[A-Za-z_]+":/g) ?? [];
    expect(keys.some((key) => /verified|valid|trusted|status/i.test(key))).toBe(false);
  });
});

describe('recordCalls', () => {
  it('signs exactly as the identity it wraps, and keeps only update calls', async () => {
    const { identity } = identityFromPem(ed25519Key().pem);
    const recorder = recordCalls(identity);
    const content = {
      request_type: 'call',
      canister_id: Principal.fromText(CANISTER_ID),
      method_name: 'commitToBranch',
      arg: new Uint8Array([1, 2, 3]),
      sender: identity.getPrincipal(),
      ingress_expiry: 1_800_000_000_000_000_000n,
    };
    const request = (endpoint: Endpoint) => ({ endpoint, request: {}, body: content }) as unknown as HttpAgentRequest;

    expect(Cbor.encode(await recorder.identity.transformRequest(request(Endpoint.Query))))
      .toEqual(Cbor.encode(await identity.transformRequest(request(Endpoint.Query))));
    await recorder.identity.transformRequest(request(Endpoint.ReadState));
    expect(recorder.calls().size).toBe(0);

    const signed = await recorder.identity.transformRequest(request(Endpoint.Call));
    expect(Cbor.encode(signed)).toEqual(Cbor.encode(await identity.transformRequest(request(Endpoint.Call))));
    expect([...recorder.calls().keys()]).toEqual([hex(requestIdOf(content))]);
    expect(recorder.identity.getPrincipal().toText()).toBe(identity.getPrincipal().toText());
  });

  it('passes on a signed request it cannot keep a copy of, unchanged', async () => {
    const { identity } = identityFromPem(ed25519Key().pem);
    const odd = { body: { content: 'not a call' } };
    const recorder = recordCalls(Object.assign(Object.create(identity), { transformRequest: async () => odd }));

    expect(await recorder.identity.transformRequest({ endpoint: Endpoint.Call } as unknown as HttpAgentRequest)).toBe(odd);
    expect(recorder.calls().size).toBe(0);
  });
});

describe('receiptNetwork', () => {
  it("is 'ic' only for the IC mainnet root key agent-js ships with", () => {
    expect(receiptNetwork(bytes(IC_ROOT_KEY))).toBe('ic');
    expect(receiptNetwork(replica.rootKey)).toBe('local');
    expect(receiptNetwork(null)).toBe('local');
  });
});

describe('parseReceiptLine', () => {
  async function capturedReceipt(): Promise<IcpWriteReceipt> {
    const { context } = await signedWriter(ed25519Key());
    return (await callWithReceipt(context, COMMIT)).receipt!;
  }

  it('reads back a stored receipt, keeping only the known fields', async () => {
    const receipt = await capturedReceipt();

    expect(parseReceiptLine(JSON.stringify(receipt))).toEqual(receipt);
    const withExtras = { ...receipt, rootKeyHex: 'aa', verified: true, request: { ...receipt.request, host: 'http://x' } };
    expect(parseReceiptLine(JSON.stringify(withExtras))).toEqual(receipt);
  });

  it('refuses anything that is not a receipt of this version', async () => {
    const receipt = await capturedReceipt();
    const variants: Array<[string, unknown]> = [
      ['another version', { ...receipt, version: 2 }],
      ['a short id', { ...receipt, id: 'abc' }],
      ['an unparseable time', { ...receipt, recordedAt: 'yesterday' }],
      ['an unknown network', { ...receipt, network: 'testnet' }],
      ['uppercase hex', { ...receipt, senderSig: receipt.senderSig.toUpperCase() }],
      ['odd-length hex', { ...receipt, certificate: `${receipt.certificate}0` }],
      ['an unknown method', { ...receipt, request: { ...receipt.request, methodName: 'commit' } }],
      ['a non-numeric expiry', { ...receipt, request: { ...receipt.request, ingressExpiry: '1e9' } }],
      ['a missing nonce', { ...receipt, request: { ...receipt.request, nonce: undefined } }],
      ['an {err} result', { ...receipt, result: { err: 'x' } }],
      ['a kind that does not match the method', { ...receipt, summary: { ...receipt.summary, kind: 'branch' } }],
      ['non-string tags', { ...receipt, summary: { ...receipt.summary, tags: [1] } }],
      ['a negative byte count', { ...receipt, summary: { ...receipt.summary, diffBytes: -1 } }],
      ['no summary', { ...receipt, summary: undefined }],
      ['an array', [receipt]],
    ];
    for (const [name, value] of variants) {
      expect(parseReceiptLine(JSON.stringify(value)), name).toBeNull();
    }
    expect(parseReceiptLine('{"version":1,')).toBeNull();
    expect(parseReceiptLine('')).toBeNull();
  });
});
