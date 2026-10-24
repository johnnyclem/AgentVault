/**
 * Receipts for the memory_repo writes the webapp server signs.
 *
 * A receipt keeps the exact call the server signed (its content, the
 * signature and the signer's public key) with the certificate the Internet
 * Computer returned for the reply. From those bytes alone a browser can
 * recompute the request id, check the signature, and check the certificate
 * against the IC root key, so it does not have to take the server's word.
 *
 * Capture rides along with a write and must never change it. The canister
 * call runs exactly as the plain actor's would, and its errors propagate
 * unchanged; anything that goes wrong while building the receipt comes back
 * as `captureError`, beside the write's own result, for the caller to log.
 * Nothing here touches the filesystem or Next.js, so the CLI can reuse it;
 * storing receipts is the caller's job.
 */

import {
  Actor,
  Cbor,
  Endpoint,
  IC_ROOT_KEY,
  lookupResultToBuffer,
  requestIdOf,
  type CallRequest,
  type Certificate,
  type HttpAgent,
  type HttpAgentRequest,
  type Identity,
  type SignIdentity,
} from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { idlFactory } from './memory-repo-actor.idl.js';
import type { OperationResult, _SERVICE } from './memory-repo-actor.js';
import {
  RECEIPT_VERSION,
  type IcpWriteReceipt,
  type ReceiptKind,
  type ReceiptedMethod,
} from './memory-repo-receipts-types.js';

/** One signed update call, as the identity signed it. */
export interface RecordedCall {
  content: CallRequest;
  /** DER SubjectPublicKeyInfo of the signing key */
  senderPubkey: Uint8Array;
  senderSig: Uint8Array;
}

export interface CallRecorder {
  /** Signs exactly as the wrapped identity does; give it to the agent in place of that identity. */
  identity: Identity & Pick<SignIdentity, 'getPublicKey' | 'sign'>;
  /** The signed update calls made through `identity` so far, by request id (lowercase hex). */
  calls(): ReadonlyMap<string, RecordedCall>;
}

/**
 * Wraps a signing identity so every update call it signs is kept, by request
 * id, for a receipt to be built from. Queries and read_state requests are not
 * kept: they change nothing.
 *
 * It is a plain object that delegates, not a subclass, and tests no agent-js
 * class with instanceof: the repository root and the webapp each install
 * their own copy of @dfinity/agent, and Next.js loads it as an external, so
 * class identity cannot be relied on across them.
 */
export function recordCalls(inner: SignIdentity): CallRecorder {
  const calls = new Map<string, RecordedCall>();
  const identity = {
    getPrincipal: () => inner.getPrincipal(),
    getPublicKey: () => inner.getPublicKey(),
    sign: (blob: Uint8Array) => inner.sign(blob),
    async transformRequest(request: HttpAgentRequest): Promise<unknown> {
      const signed = await inner.transformRequest(request);
      if (request.endpoint === Endpoint.Call) {
        try {
          keepSignedCall(calls, signed);
        } catch {
          // Keeping a copy must never affect the call. A call that was not
          // kept has no receipt, and callWithReceipt reports that.
        }
      }
      return signed;
    },
  };
  return { identity, calls: () => calls };
}

function keepSignedCall(calls: Map<string, RecordedCall>, signed: unknown): void {
  const body = isRecord(signed) && isRecord(signed['body']) ? signed['body'] : null;
  if (!body || !isRecord(body['content'])) return;
  const { sender_pubkey: senderPubkey, sender_sig: senderSig } = body;
  if (!(senderPubkey instanceof Uint8Array) || !(senderSig instanceof Uint8Array)) return;
  const content = body['content'] as CallRequest;
  calls.set(toHex(requestIdOf(content)), {
    content,
    senderPubkey: new Uint8Array(senderPubkey),
    senderSig: new Uint8Array(senderSig),
  });
}

/** A write whose reply can be receipted; the kind decides the canister method. */
export type ReceiptedCall =
  | { kind: 'commit' | 'tombstone'; args: Parameters<_SERVICE['commitToBranch']> }
  | { kind: 'branch'; args: Parameters<_SERVICE['createBranchFrom']> };

export interface ReceiptContext {
  /** An agent whose identity is `recorder.identity` */
  agent: HttpAgent;
  canisterId: string;
  recorder: CallRecorder;
  /** The capture time; the server clock unless a test fixes it */
  now?: () => Date;
}

export interface CallWithReceipt {
  /** The write's own result, exactly as the plain actor returns it */
  result: OperationResult;
  /** Null when the reply was {err} (nothing was written) or capture failed */
  receipt: IcpWriteReceipt | null;
  /** Why an {ok} reply has no receipt; null otherwise */
  captureError: string | null;
}

/**
 * The receipted methods as the extended actor sees them. agent-js takes a
 * method's return type as its reply type, so these name the decoded reply,
 * not a promise of it as _SERVICE does.
 */
interface ReceiptedService {
  commitToBranch: (...args: Parameters<_SERVICE['commitToBranch']>) => OperationResult;
  createBranchFrom: (...args: Parameters<_SERVICE['createBranchFrom']>) => OperationResult;
}

const OperationResultType = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
const COMMIT_TO_BRANCH_ARGS = [IDL.Text, IDL.Text, IDL.Text, IDL.Vec(IDL.Text)];
const CREATE_BRANCH_FROM_ARGS = [IDL.Text, IDL.Text];

/** Keys kept in a commit's summary, and how long each may be, so a huge diff cannot bloat the record. */
const MAX_SUMMARY_KEYS = 50;
const MAX_SUMMARY_KEY_LENGTH = 200;

/**
 * Makes the write and, when the canister replied {ok}, builds its receipt.
 *
 * The call goes through an actor that also hands back the certificate the
 * agent verified the reply with: the same agent-js call path as the plain
 * actor, so rejects, traps and transport errors throw exactly as they would
 * without capture. Nothing after the call can throw.
 */
export async function callWithReceipt(ctx: ReceiptContext, call: ReceiptedCall): Promise<CallWithReceipt> {
  const actor = Actor.createActorWithExtendedDetails<ReceiptedService>(
    idlFactory,
    { agent: ctx.agent, canisterId: ctx.canisterId },
    { certificate: true },
  );
  const { result, certificate } =
    call.kind === 'branch' ? await actor.createBranchFrom(...call.args) : await actor.commitToBranch(...call.args);

  try {
    // An {err} reply wrote nothing, so there is nothing to receipt
    if (!('ok' in result)) return { result, receipt: null, captureError: null };
    if (!certificate) throw new Error('the agent returned no certificate for the reply');
    return { result, receipt: buildReceipt(ctx, call.kind, result.ok, certificate), captureError: null };
  } catch (error) {
    return { result, receipt: null, captureError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The receipt for the one recorded call the certificate answers. The checks
 * here are sanity checks on what capture saw, not a verdict: the browser
 * repeats every check that matters on the stored bytes. They exist so a
 * receipt that could never verify (a missed envelope, a future agent-js that
 * signs fields this record does not keep) is reported instead of stored.
 */
function buildReceipt(ctx: ReceiptContext, kind: ReceiptKind, ok: string, certificate: Certificate): IcpWriteReceipt {
  // Found by the request id the certificate answers, not by the agent's
  // untyped request details. A v3 call the replica does not support is
  // signed again for v2, so two calls can be recorded for one write.
  const recorded = [...ctx.recorder.calls()];
  const answered = recorded.filter(([rid]) => statusLeaf(certificate, rid) !== undefined);
  const match = answered.length === 1 ? answered[0] : undefined;
  if (!match) {
    throw new Error(`expected one recorded signed call answered by the certificate, found ${answered.length} of ${recorded.length}`);
  }
  const [rid, { content, senderPubkey, senderSig }] = match;

  const status = new TextDecoder().decode(statusLeaf(certificate, rid));
  if (status !== 'replied') throw new Error(`the certificate shows request ${rid} as ${status}, not replied`);
  const reply = lookupResultToBuffer(certificate.lookup_path(['request_status', fromHex(rid), 'reply']));
  if (!reply) throw new Error(`the certificate holds no reply for request ${rid}`);
  const [certified] = IDL.decode([OperationResultType], reply) as OperationResult[];
  if (!certified || !('ok' in certified) || certified.ok !== ok) {
    throw new Error(`the certified reply for request ${rid} is not the result the call returned`);
  }

  const methodName = methodFor(kind);
  if (content.method_name !== methodName) {
    throw new Error(`request ${rid} called ${content.method_name}, not ${methodName}`);
  }

  const receipt: IcpWriteReceipt = {
    version: RECEIPT_VERSION,
    id: rid,
    recordedAt: (ctx.now?.() ?? new Date()).toISOString(),
    network: receiptNetwork(ctx.agent.rootKey),
    request: {
      canisterId: Principal.from(content.canister_id).toText(),
      methodName,
      arg: toHex(content.arg),
      sender: principalOf(content.sender).toText(),
      ingressExpiry: content.ingress_expiry.toBigInt().toString(),
      nonce: content.nonce ? toHex(content.nonce) : null,
    },
    senderPubkey: toHex(senderPubkey),
    senderSig: toHex(senderSig),
    // The BLS signature covers the root hash rebuilt from the tree, not these
    // bytes, so re-encoding the certificate agent-js decoded keeps it valid
    certificate: toHex(Cbor.encode(certificate.cert)),
    result: { ok },
    summary: summarize(kind, content.arg),
  };

  // The browser rebuilds the call from these fields alone, so they must give
  // back the same request id
  if (toHex(requestIdOf(contentOf(receipt))) !== rid) {
    throw new Error(`request ${rid} cannot be rebuilt from the recorded fields: the call carried a field this receipt does not keep`);
  }
  // A delegated signature (sender_delegation) is made by a session key whose
  // principal is not the sender's, which this record cannot show
  if (Principal.selfAuthenticating(senderPubkey).toText() !== receipt.request.sender) {
    throw new Error(`request ${rid} was not signed by the sender's own key`);
  }
  return receipt;
}

function statusLeaf(certificate: Certificate, rid: string): Uint8Array | undefined {
  return lookupResultToBuffer(certificate.lookup_path(['request_status', fromHex(rid), 'status']));
}

function methodFor(kind: ReceiptKind): ReceiptedMethod {
  return kind === 'branch' ? 'createBranchFrom' : 'commitToBranch';
}

/**
 * 'ic' when the agent checked the reply against the IC mainnet root key
 * agent-js ships with; 'local' for any other key, such as the one an agent
 * fetches from a local replica. The browser never trusts the latter.
 */
export function receiptNetwork(rootKey: Uint8Array | null | undefined): 'ic' | 'local' {
  return rootKey != null && toHex(rootKey) === IC_ROOT_KEY.toLowerCase() ? 'ic' : 'local';
}

/** The call content rebuilt from a receipt, the way the browser rebuilds it to recompute the request id. */
function contentOf(receipt: IcpWriteReceipt): Record<string, unknown> {
  const { request } = receipt;
  return {
    request_type: 'call',
    canister_id: Principal.fromText(request.canisterId),
    method_name: request.methodName,
    arg: fromHex(request.arg),
    sender: Principal.fromText(request.sender),
    ingress_expiry: BigInt(request.ingressExpiry),
    ...(request.nonce === null ? {} : { nonce: fromHex(request.nonce) }),
  };
}

/** The server's own decode of the signed argument, for operators reading the stored receipts. */
function summarize(kind: ReceiptKind, arg: Uint8Array): IcpWriteReceipt['summary'] {
  if (kind === 'branch') {
    const [branch, baseBranch] = IDL.decode(CREATE_BRANCH_FROM_ARGS, arg) as [string, string];
    return { kind, branch, baseBranch };
  }
  const [branch, message, diff, tags] = IDL.decode(COMMIT_TO_BRANCH_ARGS, arg) as [string, string, string, string[]];
  return {
    kind,
    branch,
    message,
    tags,
    diffBytes: new TextEncoder().encode(diff).length,
    ...diffEntries(diff),
  };
}

/**
 * The entries a diff names: the commits route writes a JSON array of
 * {key, data, tags}, the tombstone route {deleted: key}. Any other diff, or
 * one that is not JSON, gets no entry fields rather than a guess.
 */
function diffEntries(diff: string): { entryCount?: number; entryKeys?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(diff);
  } catch {
    return {};
  }
  let keys: unknown[];
  if (Array.isArray(parsed)) {
    keys = parsed.map((entry) => (isRecord(entry) ? entry['key'] : undefined));
  } else if (isRecord(parsed) && typeof parsed['deleted'] === 'string') {
    keys = [parsed['deleted']];
  } else {
    return {};
  }
  const entryKeys = keys
    .filter((key): key is string => typeof key === 'string')
    .slice(0, MAX_SUMMARY_KEYS)
    .map((key) => key.slice(0, MAX_SUMMARY_KEY_LENGTH));
  return { entryCount: keys.length, entryKeys };
}

const REQUEST_ID = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const NANOSECONDS = /^[0-9]{1,20}$/;

/**
 * One stored line read back as a receipt, or null when it is not JSON or
 * not a receipt of this version. Only the known fields are kept, so nothing
 * else in a line can reach the browser.
 */
export function parseReceiptLine(line: string): IcpWriteReceipt | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['version'] !== RECEIPT_VERSION) return null;
  const { id, recordedAt, network, request, senderPubkey, senderSig, certificate, result, summary } = value;
  if (
    !matches(id, REQUEST_ID) ||
    typeof recordedAt !== 'string' ||
    Number.isNaN(Date.parse(recordedAt)) ||
    (network !== 'ic' && network !== 'local') ||
    !matches(senderPubkey, HEX) ||
    !matches(senderSig, HEX) ||
    !matches(certificate, HEX) ||
    !isRecord(result) ||
    typeof result['ok'] !== 'string'
  ) {
    return null;
  }
  const parsedRequest = readRequest(request);
  const parsedSummary = readSummary(summary);
  if (!parsedRequest || !parsedSummary || parsedRequest.methodName !== methodFor(parsedSummary.kind)) return null;
  return {
    version: RECEIPT_VERSION,
    id,
    recordedAt,
    network,
    request: parsedRequest,
    senderPubkey,
    senderSig,
    certificate,
    result: { ok: result['ok'] },
    summary: parsedSummary,
  };
}

function readRequest(value: unknown): IcpWriteReceipt['request'] | null {
  if (!isRecord(value)) return null;
  const { canisterId, methodName, arg, sender, ingressExpiry, nonce } = value;
  if (
    typeof canisterId !== 'string' ||
    (methodName !== 'commitToBranch' && methodName !== 'createBranchFrom') ||
    !matches(arg, HEX) ||
    typeof sender !== 'string' ||
    !matches(ingressExpiry, NANOSECONDS) ||
    (nonce !== null && !matches(nonce, HEX))
  ) {
    return null;
  }
  return { canisterId, methodName, arg, sender, ingressExpiry, nonce };
}

function readSummary(value: unknown): IcpWriteReceipt['summary'] | null {
  if (!isRecord(value)) return null;
  const { kind, branch, message, tags, diffBytes, entryCount, entryKeys, baseBranch } = value;
  if ((kind !== 'commit' && kind !== 'tombstone' && kind !== 'branch') || typeof branch !== 'string') return null;
  const summary: IcpWriteReceipt['summary'] = { kind, branch };
  if (message !== undefined) {
    if (typeof message !== 'string') return null;
    summary.message = message;
  }
  if (tags !== undefined) {
    if (!isStringArray(tags)) return null;
    summary.tags = tags;
  }
  if (diffBytes !== undefined) {
    if (!isCount(diffBytes)) return null;
    summary.diffBytes = diffBytes;
  }
  if (entryCount !== undefined) {
    if (!isCount(entryCount)) return null;
    summary.entryCount = entryCount;
  }
  if (entryKeys !== undefined) {
    if (!isStringArray(entryKeys)) return null;
    summary.entryKeys = entryKeys;
  }
  if (baseBranch !== undefined) {
    if (typeof baseBranch !== 'string') return null;
    summary.baseBranch = baseBranch;
  }
  return summary;
}

function principalOf(sender: Uint8Array | Principal): Principal {
  return sender instanceof Uint8Array ? Principal.fromUint8Array(sender) : Principal.from(sender);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
