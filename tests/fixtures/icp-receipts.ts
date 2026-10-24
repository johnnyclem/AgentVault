/**
 * Signed memory_repo write receipts for the browser checker's tests, made
 * the way the webapp server makes them: a real call envelope signed through
 * identityFromPem (the server's signer) with agent-js's own transformRequest,
 * and an Internet Computer certificate for its reply. The certificates are
 * signed with a BLS root key minted here, optionally through a subnet
 * delegation as mainnet application subnets do, so a test can check a receipt
 * as verified without mainnet, and check that the real IC root key rejects it.
 *
 * Only strings and bytes leave this file. The checker loads its own copy of
 * agent-js (webapp/node_modules locally, the root one in CI), so nothing here
 * may reach it as an object whose class it would test with instanceof.
 */

import { Cbor, domain_sep, reconstruct, requestIdOf, type HttpAgentRequest, type SignIdentity } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { bls12_381 } from '@noble/curves/bls12-381';
import { identityFromPem } from '../../src/canister/identity.js';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';
import { ed25519Key, secp256k1Key } from './signing-identities.js';

export const CANISTER = 'rrkah-fqaaa-aaaaa-aaaaq-cai';

/** A mainnet subnet id, for certificates signed through a delegation. */
export const SUBNET = 'tdb26-jop6k-aogll-7ltgs-eruif-6kk7m-qpktf-gdiqx-mxtrf-vb5e6-eqe';

/** Canister ranges that include CANISTER. */
export const RANGES_WITH_CANISTER: Array<[string, string]> = [['rwlgt-iiaaa-aaaaa-aaaaa-cai', 'renrk-eyaaa-aaaaa-aaada-cai']];

/** The DER prefix of an IC BLS12-381 public key, as agent-js expects a root key. */
const BLS_DER_PREFIX = fromHex('308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100');

const TEXT_RESULT = IDL.Variant({ ok: IDL.Text, err: IDL.Text });

export type KeyKind = 'ed25519' | 'secp256k1';

export interface BlsKey {
  secret: Uint8Array;
  /** The public key in the DER form a root key takes */
  der: Uint8Array;
}

export function blsKey(): BlsKey {
  const secret = bls12_381.utils.randomSecretKey();
  return { secret, der: concat(BLS_DER_PREFIX, bls12_381.getPublicKeyForShortSignatures(secret)) };
}

/** The Candid reply of a memory_repo write: { ok } */
export function okReply(text: string): Uint8Array {
  return new Uint8Array(IDL.encode([TEXT_RESULT], [{ ok: text }]));
}

/** The Candid reply of a refused memory_repo write: { err } */
export function errReply(text: string): Uint8Array {
  return new Uint8Array(IDL.encode([TEXT_RESULT], [{ err: text }]));
}

export function commitArg(branch: string, message: string, diff: string, tags: string[]): Uint8Array {
  return new Uint8Array(IDL.encode([IDL.Text, IDL.Text, IDL.Text, IDL.Vec(IDL.Text)], [branch, message, diff, tags]));
}

export function branchFromArg(name: string, base: string): Uint8Array {
  return new Uint8Array(IDL.encode([IDL.Text, IDL.Text], [name, base]));
}

/** The request_status leaves a certificate holds for one request id. */
export interface StatusLeaves {
  status: string;
  reply?: Uint8Array;
  rejectCode?: number;
  rejectMessage?: string;
}

export interface CertOptions {
  root: BlsKey;
  /** Sign with a subnet key that root delegates to, for the canister ranges given */
  delegate?: { subnet: BlsKey; ranges: Array<[string, string]> };
  /** Nanoseconds since the epoch */
  time?: bigint;
}

type Tree = unknown[];

/**
 * A certificate for request id `rid` holding `leaves`, or, with null, one
 * that holds another request's status and nothing for `rid`.
 */
export async function mintCertificate(rid: Uint8Array, leaves: StatusLeaves | null, options: CertOptions): Promise<Uint8Array> {
  const time = options.time ?? BigInt(Date.now()) * 1_000_000n;
  // A hash tree's labels are sorted: reject_code < reject_message < reply < status.
  const status: Tree[] = [];
  if (leaves?.rejectCode !== undefined) status.push(labeled('reject_code', leaf(leb(BigInt(leaves.rejectCode)))));
  if (leaves?.rejectMessage !== undefined) status.push(labeled('reject_message', leaf(utf8(leaves.rejectMessage))));
  if (leaves?.reply) status.push(labeled('reply', leaf(leaves.reply)));
  if (leaves) status.push(labeled('status', leaf(utf8(leaves.status))));
  const request = leaves
    ? labeled(rid, forkAll(status))
    : labeled(new Uint8Array(32).fill(9), labeled('status', leaf(utf8('replied'))));
  const tree = fork(labeled('request_status', request), labeled('time', leaf(leb(time))));

  if (!options.delegate) {
    return new Uint8Array(Cbor.encode({ tree, signature: await signTree(tree, options.root) }));
  }

  const subnetId = Principal.fromText(SUBNET).toUint8Array();
  const ranges = options.delegate.ranges.map(([start, end]) => [
    Principal.fromText(start).toUint8Array(),
    Principal.fromText(end).toUint8Array(),
  ]);
  const subnetTree = fork(
    labeled(
      'subnet',
      labeled(
        subnetId,
        fork(
          labeled('canister_ranges', leaf(new Uint8Array(Cbor.encode(ranges)))),
          labeled('public_key', leaf(options.delegate.subnet.der)),
        ),
      ),
    ),
    labeled('time', leaf(leb(time))),
  );
  const delegation = {
    subnet_id: subnetId,
    certificate: new Uint8Array(Cbor.encode({ tree: subnetTree, signature: await signTree(subnetTree, options.root) })),
  };
  return new Uint8Array(Cbor.encode({ tree, signature: await signTree(tree, options.delegate.subnet), delegation }));
}

export interface WriteOptions {
  /** Signs the certificate; it is checked against this key only when a test passes it as the root key */
  root: BlsKey;
  delegate?: CertOptions['delegate'];
  time?: bigint;
  method?: 'commitToBranch' | 'createBranchFrom';
  /** The Candid argument; defaults to a commit, or to a new branch for createBranchFrom */
  arg?: Uint8Array;
  /** The reply the server records and the certificate holds */
  result?: string;
  /** The canister the call goes to; CANISTER unless given */
  canister?: string;
}

export interface SignedWrite {
  /** A receipt as the capture code records it, labelled 'ic' */
  receipt: IcpWriteReceipt;
  rid: Uint8Array;
  signer: SignIdentity;
}

export const COMMIT = {
  branch: 'polytician-main',
  message: 'concept: tides',
  diff: JSON.stringify([{ key: 'concept/tides', data: '{"note":"the tide turns at dawn"}', tags: ['ocean'] }]),
  tags: ['ocean'],
};

export const COMMIT_ID = 'c_1761300000000000000_42';

/**
 * A memory_repo write signed by a fresh key of `kind`, exactly as HttpAgent
 * sends it, with a certificate showing the canister replied { ok: result }.
 */
export async function signedWrite(kind: KeyKind, options: WriteOptions): Promise<SignedWrite> {
  const signer = identityFromPem(kind === 'ed25519' ? ed25519Key().pem : secp256k1Key().pem).identity;
  const method = options.method ?? 'commitToBranch';
  const arg =
    options.arg ??
    (method === 'commitToBranch'
      ? commitArg(COMMIT.branch, COMMIT.message, COMMIT.diff, COMMIT.tags)
      : branchFromArg('polytician-research', 'main'));
  const result = options.result ?? (method === 'commitToBranch' ? COMMIT_ID : 'Branch created: polytician-research');
  const canister = options.canister ?? CANISTER;
  const nonce = new Uint8Array(16).fill(5);
  const ingressExpiry = (BigInt(Date.now()) + 240_000n) * 1_000_000n;
  const content = {
    request_type: 'call',
    canister_id: Principal.fromText(canister),
    method_name: method,
    arg,
    sender: signer.getPrincipal(),
    ingress_expiry: ingressExpiry,
    nonce,
  };
  const request = { endpoint: 'call', request: { headers: {} }, body: content } as unknown as HttpAgentRequest;
  const signed = (await signer.transformRequest(request)) as { body: { sender_pubkey: Uint8Array; sender_sig: Uint8Array } };
  const rid = requestIdOf(content);
  const certificate = await mintCertificate(
    rid,
    { status: 'replied', reply: okReply(result) },
    { root: options.root, delegate: options.delegate, time: options.time },
  );

  return {
    rid,
    signer,
    receipt: {
      version: 1,
      id: hex(rid),
      recordedAt: new Date().toISOString(),
      network: 'ic',
      request: {
        canisterId: canister,
        methodName: method,
        arg: hex(arg),
        sender: signer.getPrincipal().toText(),
        ingressExpiry: ingressExpiry.toString(),
        nonce: hex(nonce),
      },
      senderPubkey: hex(signed.body.sender_pubkey),
      senderSig: hex(signed.body.sender_sig),
      certificate: hex(certificate),
      result: { ok: result },
      summary:
        method === 'commitToBranch'
          ? { kind: 'commit', branch: COMMIT.branch, message: COMMIT.message, tags: COMMIT.tags }
          : { kind: 'branch', branch: 'polytician-research', baseBranch: 'main' },
    },
  };
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  return new Uint8Array([...a, ...b]);
}

// Hash tree nodes as agent-js reads them: [1, left, right] fork, [2, label, subtree] labeled, [3, value] leaf.
function leaf(value: Uint8Array): Tree {
  return [3, value];
}

function labeled(label: string | Uint8Array, subtree: Tree): Tree {
  return [2, typeof label === 'string' ? utf8(label) : label, subtree];
}

function fork(left: Tree, right: Tree): Tree {
  return [1, left, right];
}

function forkAll(trees: Tree[]): Tree {
  const [first, ...rest] = trees;
  if (!first) throw new Error('A request status needs at least one leaf');
  return rest.length ? fork(first, forkAll(rest)) : first;
}

async function signTree(tree: Tree, key: BlsKey): Promise<Uint8Array> {
  const root = await reconstruct(tree as Parameters<typeof reconstruct>[0]);
  return bls12_381.signShortSignature(concat(domain_sep('ic-state-root'), root), key.secret);
}

/** Unsigned LEB128, as certificates encode times and reject codes. */
function leb(value: bigint): Uint8Array {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return new Uint8Array(out);
}
