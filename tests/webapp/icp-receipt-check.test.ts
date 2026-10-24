/**
 * The browser check for signed memory_repo write receipts
 * (webapp/src/lib/proof/icp-receipt-check.ts). A receipt reads as verified
 * only when the request signature verifies over the request id recomputed
 * from the recorded call, the sender is the signing key's principal, the
 * call went to the memory_repo canister the server names, the certificate
 * chains to the root key the page trusts, it records this request as
 * replied, and the certified reply is the result the server recorded.
 * A receipt from a local replica is at most "not anchored", a receipt for
 * another canister (or when the server names none) is never verified, every
 * malformed input is a non-green state, a failed certificate is reported in
 * fixed words with the library's error text left to the console, and the
 * check never rejects.
 *
 * Envelopes are signed here with real Ed25519 and secp256k1 keys through
 * agent-js; certificates are signed with a BLS root key minted per run, so
 * the same receipt verifies against that key and fails against the IC's.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, type MockInstance } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { IC_REQUEST_DOMAIN_SEPARATOR } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';
import {
  CANISTER,
  COMMIT,
  COMMIT_ID,
  RANGES_WITH_CANISTER,
  SUBNET,
  blsKey,
  branchFromArg,
  commitArg,
  errReply,
  hex,
  mintCertificate,
  signedWrite,
  type BlsKey,
  type KeyKind,
  type SignedWrite,
} from '../fixtures/icp-receipts.js';

interface DecodedWrite {
  kind: 'commit' | 'tombstone' | 'branch';
  method: string;
  canisterId: string;
  sender: string;
  requestId: string;
  recordedResult: string;
  argReadable: boolean;
  branch?: string;
  message?: string;
  tags?: string[];
  diffBytes?: number;
  entryCount?: number;
  entryKeys?: string[];
  baseBranch?: string;
}

type CheckResult =
  | { state: 'verified'; keyType: KeyKind; write: DecodedWrite; certifiedAt: Date; subnetId: string | null }
  | { state: 'not-anchored'; keyType: KeyKind; write: DecodedWrite }
  | { state: 'other-canister'; keyType: KeyKind; write: DecodedWrite; expected: string }
  | { state: 'canister-unknown'; keyType: KeyKind; write: DecodedWrite }
  | { state: 'signature-invalid'; keyType: KeyKind }
  | { state: 'principal-mismatch'; recorded: string; derived: string }
  | { state: 'certificate-invalid'; reason: string }
  | { state: 'not-replied'; status: string; rejectCode?: number; rejectMessage?: string }
  | { state: 'reply-mismatch'; recorded: string; certified: { ok: string } | { err: string } | null }
  | { state: 'unsupported-key-type' }
  | { state: 'check-failed'; reason: string; signatureChecked?: true };

interface CheckModule {
  checkIcpReceipt: (receipt: unknown, expectedCanisterId: string | null, options?: { rootKey?: Uint8Array }) => Promise<CheckResult>;
  readReceipt: (receipt: unknown) => { write: DecodedWrite } | { error: string };
  IC_MAINNET_ROOT_KEY: Uint8Array;
  MAX_ARG_BYTES: number;
  MAX_CERT_BYTES: number;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'icp-receipt-check.ts');
/** A canister other than CANISTER, inside RANGES_WITH_CANISTER */
const OTHER_CANISTER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

let checker: CheckModule;
let root: BlsKey;
// The checker leaves library error text to the console; kept quiet here and looked at where it matters.
let debug: MockInstance<typeof console.debug>;

beforeAll(async () => {
  checker = (await import(MODULE)) as CheckModule;
  root = blsKey();
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  debug.mockRestore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Checked against the test root key, as a page would check a mainnet receipt against the IC's, for the canister the server names. */
function check(receipt: unknown, expectedCanisterId: string | null = CANISTER): Promise<CheckResult> {
  return checker.checkIcpReceipt(receipt, expectedCanisterId, { rootKey: root.der });
}

function withRequest(receipt: IcpWriteReceipt, fields: Record<string, unknown>): Record<string, unknown> {
  return { ...receipt, request: { ...receipt.request, ...fields } };
}

async function withCertificate(signed: SignedWrite, leaves: Parameters<typeof mintCertificate>[1]): Promise<IcpWriteReceipt> {
  return { ...signed.receipt, certificate: hex(await mintCertificate(signed.rid, leaves, { root })) };
}

function flipLastByte(hexText: string): string {
  return hexText.slice(0, -2) + (hexText.endsWith('00') ? '01' : '00');
}

describe.each(['ed25519', 'secp256k1'] as const)('checkIcpReceipt with a %s key', (kind) => {
  let signed: SignedWrite;
  let receipt: IcpWriteReceipt;
  const certifiedTime = 1_761_300_000_123_000_000n;

  beforeAll(async () => {
    signed = await signedWrite(kind, { root, time: certifiedTime });
    receipt = signed.receipt;
  });

  it('verifies a receipt whose certificate chains to the trusted root key, and decodes the signed call', async () => {
    const result = await check(receipt);

    expect(result).toEqual({
      state: 'verified',
      keyType: kind,
      certifiedAt: new Date(1_761_300_000_123),
      subnetId: null,
      write: {
        kind: 'commit',
        method: 'commitToBranch',
        canisterId: CANISTER,
        sender: signed.signer.getPrincipal().toText(),
        requestId: receipt.id,
        recordedResult: COMMIT_ID,
        argReadable: true,
        branch: COMMIT.branch,
        message: COMMIT.message,
        tags: COMMIT.tags,
        diffBytes: new TextEncoder().encode(COMMIT.diff).byteLength,
        entryCount: 1,
        entryKeys: ['concept/tides'],
      },
    });
  });

  it('verifies a certificate signed through a subnet delegation that covers the canister, and names the subnet', async () => {
    const delegated = await signedWrite(kind, { root, delegate: { subnet: blsKey(), ranges: RANGES_WITH_CANISTER } });

    expect(await check(delegated.receipt)).toMatchObject({ state: 'verified', subnetId: SUBNET });
  });

  it('rejects a delegation whose canister ranges leave out the canister, and says so in its own words', async () => {
    const outside = await signedWrite(kind, { root, delegate: { subnet: blsKey(), ranges: [['aaaaa-aa', 'aaaaa-aa']] } });

    expect(await check(outside.receipt)).toEqual({ state: 'certificate-invalid', reason: 'canister-not-covered' });
  });

  it('fails the same receipt against the IC mainnet root key, which pages use when given no key', async () => {
    expect(await checker.checkIcpReceipt(receipt, CANISTER)).toEqual({ state: 'certificate-invalid', reason: 'bad-signature' });
    expect((await checker.checkIcpReceipt(receipt, CANISTER, { rootKey: checker.IC_MAINNET_ROOT_KEY })).state).toBe('certificate-invalid');
    expect((await checker.checkIcpReceipt(receipt, CANISTER, { rootKey: blsKey().der })).state).toBe('certificate-invalid');
  });

  it('ignores a root key carried in the receipt', async () => {
    const offered = { ...receipt, rootKeyHex: hex(root.der), rootKey: hex(root.der) };

    expect((await checker.checkIcpReceipt(offered, CANISTER)).state).toBe('certificate-invalid');
  });

  it('never verifies a genuine write to a canister other than the one the server names', async () => {
    // Signed for and certified by OTHER_CANISTER's subnet: every other check would pass.
    const elsewhere = await signedWrite(kind, { root, canister: OTHER_CANISTER, delegate: { subnet: blsKey(), ranges: RANGES_WITH_CANISTER } });

    expect((await check(elsewhere.receipt, OTHER_CANISTER)).state).toBe('verified');
    expect(await check(elsewhere.receipt)).toMatchObject({
      state: 'other-canister',
      keyType: kind,
      expected: CANISTER,
      write: { canisterId: OTHER_CANISTER, branch: COMMIT.branch },
    });
  });

  it.each([
    ['names none', null],
    ['names an empty id', ''],
    ['names something that is not a principal', 'memory-repo'],
  ])('never verifies a receipt when the server %s', async (_label, named) => {
    expect(await check(receipt, named)).toMatchObject({ state: 'canister-unknown', keyType: kind, write: { canisterId: CANISTER } });
  });

  it('holds a local replica receipt to the named canister too', async () => {
    const local = { ...receipt, network: 'local' };

    expect((await check(local, OTHER_CANISTER)).state).toBe('other-canister');
    expect((await check(local, null)).state).toBe('canister-unknown');
  });

  it('verifies without the network', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('no network in this check')));
    vi.stubGlobal('fetch', fetch);

    expect((await check(receipt)).state).toBe('verified');
    expect(fetch).not.toHaveBeenCalled();
  });

  const tampered: Array<[string, (r: IcpWriteReceipt) => Record<string, unknown>]> = [
    ['the argument (another branch)', (r) => withRequest(r, { arg: hex(commitArg('main', COMMIT.message, COMMIT.diff, COMMIT.tags)) })],
    ['the method', (r) => withRequest(r, { methodName: 'createBranchFrom', arg: hex(branchFromArg('x', 'main')) })],
    ['the ingress expiry', (r) => withRequest(r, { ingressExpiry: (BigInt(r.request.ingressExpiry) + 1n).toString() })],
    ['the canister', (r) => withRequest(r, { canisterId: 'ryjl3-tyaaa-aaaaa-aaaba-cai' })],
    ['the nonce (dropped)', (r) => withRequest(r, { nonce: null })],
    ['one signature byte', (r) => ({ ...r, senderSig: flipLastByte(r.senderSig) })],
    ['the signature length', (r) => ({ ...r, senderSig: r.senderSig.slice(0, -2) })],
    ['the argument (valid Candid that was never signed)', (r) => withRequest(r, { arg: hex(new Uint8Array(IDL.encode([IDL.Nat], [1n]))) })],
  ];

  it.each(tampered)('reads a changed %s as a signature that does not match', async (_field, change) => {
    expect(await check(change(receipt))).toEqual({ state: 'signature-invalid', keyType: kind });
  });

  it('reads a sender swapped for another principal as a signature that does not match', async () => {
    const other = await signedWrite(kind, { root });

    expect((await check(withRequest(receipt, { sender: other.receipt.request.sender }))).state).toBe('signature-invalid');
  });

  it('reports a request signed by a key whose principal is not the recorded sender', async () => {
    const other = await signedWrite(kind, { root });
    const signature = await other.signer.sign(new Uint8Array([...IC_REQUEST_DOMAIN_SEPARATOR, ...signed.rid]));
    const forged = { ...receipt, senderPubkey: other.receipt.senderPubkey, senderSig: hex(new Uint8Array(signature)) };

    expect(await check(forged)).toEqual({
      state: 'principal-mismatch',
      recorded: receipt.request.sender,
      derived: other.receipt.request.sender,
    });
  });

  it('never anchors a local replica receipt, even with a certificate valid under the trusted key', async () => {
    const local = { ...receipt, network: 'local' };

    expect(await check(local)).toMatchObject({ state: 'not-anchored', keyType: kind, write: { branch: COMMIT.branch } });
  });

  it('does not check a local replica receipt’s certificate at all', async () => {
    const local = { ...receipt, network: 'local', certificate: 'ff00ff' };

    expect((await check(local)).state).toBe('not-anchored');
  });

  it('still checks the signature of a local replica receipt', async () => {
    const local = { ...receipt, network: 'local', senderSig: flipLastByte(receipt.senderSig) };

    expect((await check(local)).state).toBe('signature-invalid');
  });

  it('reports a recorded result the certified reply does not match', async () => {
    const changed = { ...receipt, result: { ok: 'c_1761300000000000000_43' } };

    expect(await check(changed)).toEqual({
      state: 'reply-mismatch',
      recorded: 'c_1761300000000000000_43',
      certified: { ok: COMMIT_ID },
    });
  });

  it('reports a certified error reply as a mismatch', async () => {
    const refused = await withCertificate(signed, { status: 'replied', reply: errReply('Repo is frozen') });

    expect(await check(refused)).toEqual({ state: 'reply-mismatch', recorded: COMMIT_ID, certified: { err: 'Repo is frozen' } });
  });

  it('reports a certified reply that is not the method’s result', async () => {
    const junk = await withCertificate(signed, { status: 'replied', reply: new Uint8Array([1, 2, 3]) });

    expect(await check(junk)).toEqual({ state: 'reply-mismatch', recorded: COMMIT_ID, certified: null });
  });

  it('reports a call the certificate shows was rejected, with its code and message', async () => {
    const rejected = await withCertificate(signed, { status: 'rejected', rejectCode: 5, rejectMessage: 'caller principal is not authorized' });

    expect(await check(rejected)).toEqual({
      state: 'not-replied',
      status: 'rejected',
      rejectCode: 5,
      rejectMessage: 'caller principal is not authorized',
    });
  });

  it.each(['received', 'processing', 'done'])('reports a call whose certified status is %s as not replied', async (status) => {
    expect(await check(await withCertificate(signed, { status }))).toEqual({ state: 'not-replied', status });
  });

  it('reports a replied status whose reply is not in the certificate as replied without its reply', async () => {
    expect(await check(await withCertificate(signed, { status: 'replied' }))).toEqual({
      state: 'not-replied',
      status: 'replied-without-reply',
    });
  });

  it('reports a status it does not know as unreadable', async () => {
    expect(await check(await withCertificate(signed, { status: 'finished' }))).toEqual({ state: 'not-replied', status: 'unreadable' });
  });

  it('reports a valid certificate that does not mention this request', async () => {
    expect(await check(await withCertificate(signed, null))).toEqual({ state: 'not-replied', status: 'absent' });
  });

  it.each([
    ['not CBOR', '1e', 'not-cbor'],
    ['empty', '', 'not-cbor'],
    ['CBOR that is not a certificate', 'ff00ff', 'malformed'],
    ['a CBOR number', '1864', 'malformed'],
  ])('reports a certificate that is %s as one that does not verify, with a fixed reason', async (_label, certificate, reason) => {
    expect(await check({ ...receipt, certificate })).toEqual({ state: 'certificate-invalid', reason });
  });

  it('reports a truncated certificate as one that does not verify', async () => {
    const result = await check({ ...receipt, certificate: receipt.certificate.slice(0, -40) });

    expect(result.state).toBe('certificate-invalid');
    expect(['not-cbor', 'bad-signature', 'malformed']).toContain((result as { reason: string }).reason);
  });

  it('leaves the library’s error text, with its stack, to the console and out of the result', async () => {
    debug.mockClear();
    const result = await checker.checkIcpReceipt(receipt, CANISTER);

    expect(result).toEqual({ state: 'certificate-invalid', reason: 'bad-signature' });
    expect(JSON.stringify(result)).not.toMatch(/http|file:|\bat |Error/);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]![1])).toMatch(/Invalid signature|Signature verification failed/);
  });
});

describe('checkIcpReceipt on the other writes the webapp records', () => {
  it('verifies a new branch and decodes its name and base', async () => {
    const branch = await signedWrite('ed25519', { root, method: 'createBranchFrom' });

    expect(await check(branch.receipt)).toMatchObject({
      state: 'verified',
      write: { kind: 'branch', method: 'createBranchFrom', branch: 'polytician-research', baseBranch: 'main', recordedResult: 'Branch created: polytician-research' },
    });
  });

  it('verifies a tombstone and names the deleted key', async () => {
    const arg = commitArg(COMMIT.branch, 'tombstone: concept/tides', '{"deleted":"concept/tides"}', ['tombstone']);
    const tombstone = await signedWrite('secp256k1', { root, arg });

    expect(await check(tombstone.receipt)).toMatchObject({
      state: 'verified',
      write: { kind: 'tombstone', branch: COMMIT.branch, entryCount: 1, entryKeys: ['concept/tides'] },
    });
  });

  it('cannot read a signed argument that is not the method’s Candid, and says its signature and sender passed', async () => {
    const unreadable = await signedWrite('ed25519', { root, arg: new Uint8Array(IDL.encode([IDL.Nat], [1n])) });

    expect(await check(unreadable.receipt)).toEqual({
      state: 'check-failed',
      reason: 'The signed argument is not a commitToBranch call this page can read.',
      signatureChecked: true,
    });
  });
});

describe('checkIcpReceipt on receipts it cannot read', () => {
  let receipt: IcpWriteReceipt;

  beforeAll(async () => {
    receipt = (await signedWrite('ed25519', { root })).receipt;
  });

  const malformed: Array<[string, (r: IcpWriteReceipt) => unknown]> = [
    ['null', () => null],
    ['an array', () => []],
    ['another version', (r) => ({ ...r, version: 2 })],
    ['an unknown network', (r) => ({ ...r, network: 'testnet' })],
    ['no request', (r) => ({ ...r, request: undefined })],
    ['an unknown request field', (r) => withRequest(r, { senderInfo: 'x' })],
    ['an unknown method', (r) => withRequest(r, { methodName: 'killCanister' })],
    ['a sender that is not a principal', (r) => withRequest(r, { sender: 'not-a-principal' })],
    ['a canister id in a non-canonical spelling', (r) => withRequest(r, { canisterId: CANISTER.toUpperCase() })],
    ['an argument that is not hex', (r) => withRequest(r, { arg: 'zz' })],
    ['an argument of odd length', (r) => withRequest(r, { arg: `${r.request.arg}0` })],
    ['an argument over 2 MiB', (r) => withRequest(r, { arg: '00'.repeat(checker.MAX_ARG_BYTES + 1) })],
    ['a negative ingress expiry', (r) => withRequest(r, { ingressExpiry: '-1' })],
    ['an ingress expiry that is a number', (r) => withRequest(r, { ingressExpiry: 1 })],
    ['a missing nonce', (r) => withRequest(r, { nonce: undefined })],
    ['a nonce that is not hex', (r) => withRequest(r, { nonce: 'xyz0' })],
    ['an uppercase hex signature', (r) => ({ ...r, senderSig: r.senderSig.toUpperCase() })],
    ['a public key that is not hex', (r) => ({ ...r, senderPubkey: 'not hex' })],
    ['no certificate', (r) => ({ ...r, certificate: null })],
    ['a base64 certificate', (r) => ({ ...r, certificate: Buffer.from(r.certificate, 'hex').toString('base64') })],
    ['no recorded result', (r) => ({ ...r, result: undefined })],
    ['a recorded error instead of a result', (r) => ({ ...r, result: { err: 'Repo is frozen' } })],
  ];

  it.each(malformed)('cannot check a receipt with %s', async (_label, change) => {
    const result = await check(change(receipt));

    expect(result.state).toBe('check-failed');
    expect(result).not.toHaveProperty('signatureChecked');
  });

  it('cannot check a certificate over 256 KiB, and says so', async () => {
    const oversize = { ...receipt, certificate: '00'.repeat(checker.MAX_CERT_BYTES + 1) };

    expect(await check(oversize)).toEqual({
      state: 'check-failed',
      reason: 'The receipt’s certificate is larger than the 256 KiB this page checks.',
    });
  });

  it('does not check a key type other than Ed25519 or secp256k1', async () => {
    const p256 = `3059301306072a8648ce3d020106082a8648ce3d03010703420004${'ab'.repeat(64)}`;

    expect(await check({ ...receipt, senderPubkey: p256 })).toEqual({ state: 'unsupported-key-type' });
  });
});

describe('readReceipt', () => {
  it('decodes the signed call for the row before its check finishes', async () => {
    const { receipt } = await signedWrite('ed25519', { root });
    const read = checker.readReceipt(receipt);

    expect('write' in read && read.write).toMatchObject({ kind: 'commit', branch: COMMIT.branch, requestId: receipt.id });
  });

  it('marks an argument that is not the method’s Candid as unreadable instead of guessing', async () => {
    const { receipt } = await signedWrite('ed25519', { root });
    const read = checker.readReceipt(withRequest(receipt, { arg: 'dead' }));

    expect('write' in read && read.write).toMatchObject({ kind: 'commit', argReadable: false });
    expect('write' in read && read.write.branch).toBeUndefined();
  });

  it('says why a receipt cannot be read', () => {
    expect(checker.readReceipt({ version: 1, network: 'ic' })).toEqual({ error: 'The receipt has no signed request.' });
  });
});

describe('checkIcpReceipt under single-character changes', () => {
  // A seeded generator, so a failure names a mutation that can be replayed.
  let seed = 1234567;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  it('never reports a changed receipt as verified, and never rejects', async () => {
    const fields = ['arg', 'nonce', 'senderPubkey', 'senderSig', 'certificate'] as const;
    for (const kind of ['ed25519', 'secp256k1'] as const) {
      const { receipt } = await signedWrite(kind, { root, delegate: { subnet: blsKey(), ranges: RANGES_WITH_CANISTER } });
      expect((await check(receipt)).state).toBe('verified');

      for (let i = 0; i < 60; i++) {
        const field = fields[next(fields.length)]!;
        const inRequest = field === 'arg' || field === 'nonce';
        const source = inRequest ? receipt.request[field]! : receipt[field];
        const at = next(source.length);
        const digits = '0123456789abcdef'.replace(source[at]!, '');
        const changed = source.slice(0, at) + digits[next(digits.length)] + source.slice(at + 1);
        const mutated = inRequest ? withRequest(receipt, { [field]: changed }) : { ...receipt, [field]: changed };

        const result = await check(mutated);
        expect(result.state, `${kind} ${field}@${at}`).not.toBe('verified');
      }
    }
  }, 60_000);
});

describe('the libraries the checker resolves', () => {
  // Locally the checker resolves packages from webapp/node_modules; in CI only
  // the root node_modules exists. Both must give the APIs it was written for.
  const resolveFrom = createRequire(MODULE);

  function versionOf(pkg: string, entry: string): string {
    const resolved = resolveFrom.resolve(entry).replace(/\\/g, '/');
    const marker = `/node_modules/${pkg}/`;
    const dir = resolved.slice(0, resolved.lastIndexOf(marker) + marker.length);
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  }

  it('finds @noble/curves 1.x at 1.9 or later, whose verify takes the prehash, lowS and format options', () => {
    const [major, minor] = versionOf('@noble/curves', '@noble/curves/secp256k1').split('.').map(Number);

    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(9);
  });

  it('finds @dfinity/agent 3.x', () => {
    expect(versionOf('@dfinity/agent', '@dfinity/agent').split('.')[0]).toBe('3');
  });
});
