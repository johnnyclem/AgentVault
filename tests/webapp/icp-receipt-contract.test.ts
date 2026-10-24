/**
 * The two halves of a signed memory write receipt meet: a receipt captured
 * through the real agent-js call path (src/canister/memory-repo-receipts.ts,
 * against a local server standing in for a certifying replica) is exactly
 * what the browser checker (webapp/src/lib/proof/icp-receipt-check.ts) needs.
 *
 * As captured, the receipt is from a local replica and reads as not anchored.
 * Labelled mainnet and checked against the replica's own root key, it reads
 * as verified, which shows the captured bytes are complete. Against the IC's
 * real root key it fails, as anything from a local replica must.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createMemoryRepoAgent } from '../../src/canister/memory-repo-actor.js';
import { callWithReceipt, recordCalls } from '../../src/canister/memory-repo-receipts.js';
import { identityFromPem } from '../../src/canister/identity.js';
import { ed25519Key, secp256k1Key } from '../fixtures/signing-identities.js';
import { startCertifyingReplica, type CertifyingReplica } from '../memory-repo/certifying-replica.js';

interface CheckModule {
  checkIcpReceipt: (
    receipt: unknown,
    expectedCanisterId: string | null,
    options?: { rootKey?: Uint8Array },
  ) => Promise<{ state: string; [field: string]: unknown }>;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'icp-receipt-check.ts');
const CANISTER_ID = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

let checker: CheckModule;
let replica: CertifyingReplica;

beforeAll(async () => {
  checker = (await import(MODULE)) as CheckModule;
  replica = await startCertifyingReplica();
});

afterAll(async () => {
  await replica.close();
});

describe.each([
  ['Ed25519', () => ed25519Key()],
  ['secp256k1', () => secp256k1Key()],
] as const)('a receipt captured for a %s server identity', (_name, makeKey) => {
  it.each(['v3', 'v2'] as const)('through the %s call path is what the browser checker reads', async (mode) => {
    replica.mode = mode;
    replica.answer = () => ({ ok: 'commit-1' });
    const recorder = recordCalls(identityFromPem(makeKey().pem).identity);
    const agent = await createMemoryRepoAgent(replica.host, recorder.identity);
    const diff = JSON.stringify([{ key: 'concepts/c1', data: '{"title":"t"}' }]);

    const { receipt } = await callWithReceipt(
      { agent, canisterId: CANISTER_ID, recorder },
      { kind: 'commit', args: ['polytician-main', 'push concept c1', diff, ['polytician']] },
    );
    // As stored on disk and sent to the browser: plain JSON.
    const sent = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;

    expect(await checker.checkIcpReceipt(sent, CANISTER_ID)).toMatchObject({ state: 'not-anchored', write: { branch: 'polytician-main' } });
    expect(await checker.checkIcpReceipt({ ...sent, network: 'ic' }, CANISTER_ID, { rootKey: replica.rootKey })).toMatchObject({
      state: 'verified',
      write: { kind: 'commit', branch: 'polytician-main', recordedResult: 'commit-1', entryKeys: ['concepts/c1'] },
    });
    expect((await checker.checkIcpReceipt({ ...sent, network: 'ic' }, CANISTER_ID)).state).toBe('certificate-invalid');
  });
});
