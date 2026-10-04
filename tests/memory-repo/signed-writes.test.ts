/**
 * memory_repo writes leave AgentVault signed. A local HTTP server stands in
 * for the replica: it serves a root key, captures the CBOR envelope of each
 * update call, and rejects it the way the canister rejects a caller that is
 * neither the owner nor authorized.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Cbor, requestIdOf, IC_REQUEST_DOMAIN_SEPARATOR } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import {
  createMemoryRepoActor,
  createMemoryRepoAgent,
  explainMemoryRepoWriteError,
  isLocalReplicaHost,
} from '../../src/canister/memory-repo-actor.js';
import { identityFromPem } from '../../src/canister/identity.js';
import { ed25519Key, secp256k1Key } from '../fixtures/signing-identities.js';

const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const NOT_AUTHORIZED =
  `Error from Canister ${CANISTER_ID}: Canister called \`ic0.trap\` with message: 'caller principal is not authorized'.`;

interface CallEnvelope {
  content: Record<string, unknown> & { sender: Uint8Array; method_name: string; canister_id: Uint8Array };
  sender_pubkey?: Uint8Array;
  sender_sig?: Uint8Array;
}

let server: http.Server;
let host: string;
const requests: Array<{ method: string; url: string; body: Buffer }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks) });
      res.setHeader('content-type', 'application/cbor');
      if (req.url === '/api/v2/status') {
        res.end(Buffer.from(Cbor.encode({ ic_api_version: '0.18.0', root_key: new Uint8Array(133) })));
        return;
      }
      res.end(Buffer.from(Cbor.encode({ reject_code: 5, reject_message: NOT_AUTHORIZED, error_code: 'IC0503' })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

function capturedCalls(): CallEnvelope[] {
  return requests
    .filter((r) => r.method === 'POST' && /\/call$/.test(r.url))
    .map((r) => Cbor.decode<CallEnvelope>(new Uint8Array(r.body)));
}

/** The bytes a request signature covers: the domain separator and the request id. */
function signedBytes(envelope: CallEnvelope): Buffer {
  return Buffer.concat([Buffer.from(IC_REQUEST_DOMAIN_SEPARATOR), Buffer.from(requestIdOf(envelope.content))]);
}

describe('signed memory_repo writes', () => {
  it('an Ed25519 identity signs the call envelope as its principal', async () => {
    const key = ed25519Key();
    const { identity } = identityFromPem(key.pem);
    const agent = await createMemoryRepoAgent(host, identity);
    const actor = createMemoryRepoActor(CANISTER_ID, agent);

    await expect(actor.commit('remember', '{"k":"v"}', ['polytician'])).rejects.toThrow(/caller principal is not authorized/);

    // A local host: the root key was fetched from the replica.
    expect(requests.some((r) => r.url === '/api/v2/status')).toBe(true);

    const [envelope] = capturedCalls();
    expect(envelope).toBeDefined();
    expect(envelope!.content.method_name).toBe('commit');
    expect(Principal.fromUint8Array(envelope!.content.canister_id).toText()).toBe(CANISTER_ID);
    expect(Principal.fromUint8Array(envelope!.content.sender).toText()).toBe(key.principal);
    expect(envelope!.sender_pubkey).toBeInstanceOf(Uint8Array);
    expect(envelope!.sender_sig).toBeInstanceOf(Uint8Array);

    // The signature verifies against the public key in the envelope.
    const publicKey = createPublicKey({ key: Buffer.from(envelope!.sender_pubkey!), format: 'der', type: 'spki' });
    expect(verify(null, signedBytes(envelope!), publicKey, Buffer.from(envelope!.sender_sig!))).toBe(true);
  });

  it('a secp256k1 identity signs the call envelope as its principal', async () => {
    const key = secp256k1Key();
    const { identity } = identityFromPem(key.pem);
    const actor = createMemoryRepoActor(CANISTER_ID, await createMemoryRepoAgent(host, identity));

    await expect(actor.switchBranch('polytician')).rejects.toThrow(/caller principal is not authorized/);

    const [envelope] = capturedCalls();
    expect(Principal.fromUint8Array(envelope!.content.sender).toText()).toBe(key.principal);
    const publicKey = createPublicKey({ key: Buffer.from(envelope!.sender_pubkey!), format: 'der', type: 'spki' });
    expect(
      verify('sha256', signedBytes(envelope!), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(envelope!.sender_sig!)),
    ).toBe(true);
  });

  it('without an identity the call goes out anonymous and unsigned', async () => {
    const actor = createMemoryRepoActor(CANISTER_ID, await createMemoryRepoAgent(host));

    await expect(actor.commit('remember', '{}', [])).rejects.toThrow();

    const [envelope] = capturedCalls();
    expect(Principal.fromUint8Array(envelope!.content.sender).toText()).toBe('2vxsx-fae');
    expect(envelope!.sender_pubkey).toBeUndefined();
    expect(envelope!.sender_sig).toBeUndefined();
  });

  it("explains the canister's authorization traps with the signer's principal", async () => {
    const key = ed25519Key();
    const { identity } = identityFromPem(key.pem);
    const actor = createMemoryRepoActor(CANISTER_ID, await createMemoryRepoAgent(host, identity));
    const error = await actor.commit('remember', '{}', []).catch((e: unknown) => e);

    const explained = explainMemoryRepoWriteError(error, key.principal);
    expect(explained?.code).toBe('SIGNER_NOT_AUTHORIZED');
    expect(explained?.message).toContain(key.principal);
    expect(explained?.message).toContain(`agentvault memory authorize ${key.principal}`);

    const notOwner = explainMemoryRepoWriteError(
      new Error("Reject text: Canister called `ic0.trap` with message: 'only the canister owner may call this function'"),
      key.principal,
    );
    expect(notOwner?.code).toBe('SIGNER_NOT_OWNER');
    expect(notOwner?.message).toContain(key.principal);

    expect(explainMemoryRepoWriteError(new Error('Reject text: canister is frozen — call manualUnlock() first'), key.principal)?.code)
      .toBe('REPO_FROZEN');
    expect(explainMemoryRepoWriteError(new Error('Reject text: canister killed — call reviveCanister() to restore'), key.principal)?.code)
      .toBe('REPO_KILLED');
    expect(explainMemoryRepoWriteError(new Error('connection refused'), key.principal)).toBeNull();
  });
});

describe('isLocalReplicaHost', () => {
  it('is true only for loopback hosts', () => {
    for (const local of ['http://localhost:4943', 'http://127.0.0.1:4943', 'http://[::1]:4943', 'http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:4943']) {
      expect(isLocalReplicaHost(local), local).toBe(true);
    }
    for (const remote of ['https://ic0.app', 'https://icp0.io', 'https://icp-api.io', 'https://example.com', 'http://localhost.example.com', 'not a url']) {
      expect(isLocalReplicaHost(remote), remote).toBe(false);
    }
  });
});
