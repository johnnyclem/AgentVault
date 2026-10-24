/**
 * The record kept for each memory_repo write the webapp server signs, the
 * same on disk (one JSON line per receipt) and on the wire to the browser.
 *
 * This file holds types and one constant and imports nothing, so the webapp
 * and the tests can import it by path without pulling agent-js or Node APIs
 * into the browser bundle.
 *
 * A receipt carries the signed call and the Internet Computer's certificate
 * for its reply, so a browser can check it from these bytes alone. It has no
 * verified, valid or trusted field, and must never gain one: the server does
 * not vouch for its own receipts, and any verdict is worked out in the browser.
 */

/** Bumped whenever the record's fields or their meaning change, so a reader can refuse a record it does not understand. */
export const RECEIPT_VERSION = 1;

/** What the write did, from the route that made it: a commit, a tombstone (a delete), or a new branch. */
export type ReceiptKind = 'commit' | 'tombstone' | 'branch';

/** The memory_repo update methods whose replies are receipted: commitToBranch for commits and tombstones, createBranchFrom for branches. */
export type ReceiptedMethod = 'commitToBranch' | 'createBranchFrom';

export interface IcpWriteReceipt {
  version: typeof RECEIPT_VERSION;
  /**
   * The request id (64 lowercase hex) as the server computed it. It is a list
   * key, not evidence: the checker recomputes it from `request`.
   */
  id: string;
  /** ISO time from the server clock at capture. It is not certified; only the certificate's own time is. */
  recordedAt: string;
  /**
   * Where the server's agent got the root key it checked the reply against.
   * 'ic' when that key equals the IC mainnet root key built into agent-js;
   * 'local' when the agent fetched the key from the replica it was talking
   * to, as it does for loopback hosts. The checker never trusts a key that
   * came from the server, so a 'local' receipt can never be anchored.
   */
  network: 'ic' | 'local';
  /**
   * Every field of the signed call content, so the browser can rebuild it and
   * recompute the request id. request_type is always 'call' and is not stored.
   */
  request: {
    /** Principal text */
    canisterId: string;
    methodName: ReceiptedMethod;
    /** Candid argument bytes, lowercase hex */
    arg: string;
    /** Principal text */
    sender: string;
    /** Nanoseconds since the epoch, decimal */
    ingressExpiry: string;
    /** Lowercase hex; null when the call carried no nonce, and then left out when the content is rebuilt */
    nonce: string | null;
  };
  /** DER SubjectPublicKeyInfo, lowercase hex (44 bytes for Ed25519, 88 for secp256k1) */
  senderPubkey: string;
  /** The 64-byte request signature, lowercase hex, exactly as sent on the wire */
  senderSig: string;
  /** CBOR certificate {tree, signature, delegation?}, lowercase hex. Capture never writes a receipt without one. */
  certificate: string;
  /**
   * The reply the server decoded: the commit id for commitToBranch, the reply
   * text for createBranchFrom. Only {ok} replies are receipted, because an
   * {err} reply means nothing was written.
   */
  result: { ok: string };
  /**
   * The server's own decode of the argument, for operators reading the JSONL.
   * The page shows the browser's decode of the signed bytes, never this.
   */
  summary: {
    kind: ReceiptKind;
    branch: string;
    /** commitToBranch only */
    message?: string;
    /** commitToBranch only */
    tags?: string[];
    /** commitToBranch only: the diff's length in UTF-8 bytes */
    diffBytes?: number;
    /** commitToBranch only: entries in the diff */
    entryCount?: number;
    /** commitToBranch only: keys named in the diff, at most 50, each at most 200 characters */
    entryKeys?: string[];
    /** createBranchFrom only: the branch the new one was created from */
    baseBranch?: string;
  };
}
