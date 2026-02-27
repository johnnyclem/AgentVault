/**
 * BLS12-381 Threshold Key Shares — Production VetKeys
 *
 * Implements production-grade threshold key derivation using BLS12-381.
 * Uses Shamir's Secret Sharing (SSS) over the BLS12-381 scalar field (Fr)
 * with Feldman Verifiable Secret Sharing (VSS) commitments.
 *
 * Security properties:
 *   - No single share reveals the master secret (information-theoretic security
 *     holds for any subset of fewer than `threshold` shares)
 *   - Any t-of-n shares suffice to reconstruct the master key or combine signatures
 *   - Share validity is verifiable against public Feldman VSS commitments without
 *     revealing any secret material
 *   - BLS signatures are aggregatable; partial sigs combine via Lagrange interpolation
 *
 * Protocol (3-of-5 default):
 *   1. Dealer picks random polynomial f(x) = a0 + a1·x + a2·x² (degree t-1)
 *      where a0 = master_secret_scalar ∈ Fr
 *   2. Share_i = f(i)  for i = 1 … n
 *   3. Feldman VSS commitments: C_k = a_k · G1  for k = 0 … t-1
 *      (C_0 is the master public key)
 *   4. Partial signature_i = Share_i · H(msg)   (G2 point)
 *   5. Combined = Lagrange(partial_1 … partial_t) = a0 · H(msg) = master_sig
 *
 * References:
 *   - Feldman VSS: "A Practical Scheme for Non-interactive Verifiable Secret Sharing", 1987
 *   - BLS threshold signatures: Boldyreva 2003
 *   - ICP VetKD: https://internetcomputer.org/docs/current/references/vetkeys-overview
 */

import { bls12_381 } from '@noble/curves/bls12-381';
import * as crypto from 'node:crypto';

const Fr = bls12_381.fields.Fr;
const G1 = bls12_381.G1;
const G2 = bls12_381.G2;

// Domain-separation tag matching the ICP VetKD BLS signature scheme
const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_';

// ─── Public Types ─────────────────────────────────────────────────────────────

/**
 * A single BLS12-381 key share for one participant.
 */
export interface BlsKeyShare {
  /** 1-based participant index (x-value for polynomial evaluation) */
  index: number;
  /** f(index) mod r — the private share scalar (MUST remain secret) */
  shareScalar: bigint;
  /** Hex-encoded compressed G1 point: shareScalar · G1.BASE (partial public key) */
  publicKey: string;
  /** SHA-256 commitment: H(index ‖ shareScalar_bytes) for canister integrity checks */
  commitment: string;
}

/**
 * Complete threshold key set produced by the dealer.
 * The `shares[i].shareScalar` values are secret; everything else is public.
 */
export interface BlsThresholdKeySet {
  threshold: number;
  totalParties: number;
  /** Master public key = a0 · G1.BASE (hex-encoded compressed G1 point) */
  masterPublicKey: string;
  /**
   * Feldman VSS commitments: C_k = a_k · G1  for k = 0 … threshold-1
   * C_0 equals masterPublicKey.
   */
  vssCommitments: string[];
  /** All shares (one per participant, index 1-based) */
  shares: BlsKeyShare[];
  /** SHA-256 digest of all vssCommitments concatenated (canister integrity tag) */
  groupCommitment: string;
  createdAt: string;
}

/**
 * A single partial signature produced by one share-holder.
 */
export interface BlsPartialSignature {
  /** 1-based participant index */
  index: number;
  /** Hex-encoded compressed G2 point: shareScalar · H(msg) */
  signature: string;
}

/**
 * Health report for all shares in a threshold key set.
 */
export interface BlsShareHealthReport {
  totalShares: number;
  healthyShares: number;
  corruptedShares: number;
  /** 1-based indices of shares that failed the Feldman VSS check */
  corruptedIndices: number[];
  allHealthy: boolean;
  checkedAt: string;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

// Fr.create() is the noble-curves v1.x API for modular reduction.
// We alias it to avoid confusion with the legacy Fr.mod name.
const frReduce = (n: bigint): bigint => Fr.create(n);

/**
 * Sample a uniformly-random non-zero scalar in Fr using rejection sampling
 * over 64 random bytes (512-bit reduction gives negligible bias).
 */
function randomScalar(): bigint {
  let s = 0n;
  while (s === 0n) {
    const bytes = crypto.randomBytes(64);
    s = frReduce(BigInt('0x' + bytes.toString('hex')));
  }
  return s;
}

/**
 * Evaluate the dealer polynomial at x:
 *   f(x) = Σ coefficients[k] · x^k  mod r
 */
function evalPoly(coefficients: bigint[], x: bigint): bigint {
  let result = 0n;
  let xPow = 1n;
  for (const a of coefficients) {
    result = Fr.add(result, Fr.mul(a, xPow));
    xPow = Fr.mul(xPow, x);
  }
  return result;
}

/**
 * Lagrange basis coefficient λ_i for x = 0, given a set of participant indices.
 *
 *   λ_i = ∏_{j ≠ i}  j / (j - i)   mod r
 */
function lagrangeCoeff(indices: bigint[], targetIndex: bigint): bigint {
  let num = 1n;
  let den = 1n;
  for (const j of indices) {
    if (j === targetIndex) continue;
    num = Fr.mul(num, j);
    den = Fr.mul(den, Fr.sub(j, targetIndex));
  }
  return Fr.mul(num, Fr.inv(den));
}

/**
 * Build the per-share SHA-256 commitment tag:
 *   commitment = SHA-256( index_byte ‖ shareScalar_32_bytes )
 */
function buildShareCommitment(index: number, shareScalar: bigint): string {
  const idxBuf = Buffer.allocUnsafe(4);
  idxBuf.writeUInt32BE(index, 0);
  const scalarHex = shareScalar.toString(16).padStart(64, '0');
  return crypto
    .createHash('sha256')
    .update(idxBuf)
    .update(Buffer.from(scalarHex, 'hex'))
    .digest('hex');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a BLS12-381 threshold key set using Feldman VSS.
 *
 * The master secret is derived from `masterSecret` (≥32 bytes).
 * Call this once per canister deployment — the resulting `shares[i]` are
 * distributed to participants; only public fields (`publicKey`, `commitment`,
 * `vssCommitments`, `masterPublicKey`) are uploaded to the canister.
 *
 * @param masterSecret - ≥32-byte secret seed (e.g. from BIP39 entropy)
 * @param threshold    - minimum shares required to sign / reconstruct (t)
 * @param totalParties - total number of shares issued (n)
 * @returns Complete threshold key set
 */
export function generateBlsThresholdShares(
  masterSecret: Uint8Array,
  threshold: number,
  totalParties: number
): BlsThresholdKeySet {
  if (threshold < 2 || threshold > totalParties) {
    throw new Error(
      `Invalid threshold: need 2 ≤ threshold(${threshold}) ≤ totalParties(${totalParties})`
    );
  }
  if (masterSecret.length < 32) {
    throw new Error('masterSecret must be at least 32 bytes');
  }

  // Reduce the first 32 bytes of masterSecret to a valid non-zero Fr element.
  // We hash with a domain separator so the polynomial secret is independent
  // of any wallet-level key material.
  const domainSep = Buffer.from('agentvault-vetkd-v1:master', 'utf8');
  const secretBytes = crypto
    .createHash('sha256')
    .update(domainSep)
    .update(Buffer.from(masterSecret.slice(0, 32)))
    .digest();
  const secretScalar = frReduce(BigInt('0x' + secretBytes.toString('hex'))) || 1n;

  // Dealer polynomial: degree t-1, constant term = secretScalar
  const coefficients: bigint[] = [secretScalar];
  for (let k = 1; k < threshold; k++) {
    coefficients.push(randomScalar());
  }

  // Feldman VSS commitments: C_k = a_k · G1.BASE
  const vssCommitments: string[] = coefficients.map((a) =>
    G1.ProjectivePoint.BASE.multiply(a).toHex(true) // compressed
  );
  const masterPublicKey = vssCommitments[0];

  // Evaluate polynomial at i = 1 … n
  const shares: BlsKeyShare[] = [];
  for (let i = 1; i <= totalParties; i++) {
    const shareScalar = evalPoly(coefficients, BigInt(i));
    const publicKey = G1.ProjectivePoint.BASE.multiply(shareScalar).toHex(true);
    const commitment = buildShareCommitment(i, shareScalar);
    shares.push({ index: i, shareScalar, publicKey, commitment });
  }

  // Group commitment = SHA-256( all VSS commitment strings concatenated )
  const groupCommitment = crypto
    .createHash('sha256')
    .update(vssCommitments.join(''))
    .digest('hex');

  return {
    threshold,
    totalParties,
    masterPublicKey,
    vssCommitments,
    shares,
    groupCommitment,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Verify that a share is consistent with the Feldman VSS commitments.
 *
 * Checks:  shareScalar · G1 == Σ C_k · index^k
 *
 * This proves the share lies on the dealer's polynomial without revealing
 * the polynomial itself or any other share.
 *
 * @param share          - The key share to verify
 * @param vssCommitments - Feldman commitment array (C_0 … C_{t-1})
 * @returns true if the share is valid
 */
export function verifyBlsShare(
  share: BlsKeyShare,
  vssCommitments: string[]
): boolean {
  try {
    // LHS: shareScalar · G1
    const lhs = G1.ProjectivePoint.BASE.multiply(share.shareScalar);

    // RHS: Σ C_k · index^k
    let rhs = G1.ProjectivePoint.ZERO;
    let iPow = 1n;
    for (const commitHex of vssCommitments) {
      const C = G1.ProjectivePoint.fromHex(commitHex);
      rhs = rhs.add(C.multiply(iPow));
      iPow = Fr.mul(iPow, BigInt(share.index));
    }

    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

/**
 * Compute a partial BLS signature for `message` using one key share.
 *
 *   partial_i = shareScalar · H(msg)   (G2 point)
 *
 * @param share   - Participant's key share
 * @param message - Raw message bytes to sign
 * @returns Hex-encoded compressed G2 partial signature
 */
export async function computePartialSignature(
  share: BlsKeyShare,
  message: Uint8Array
): Promise<string> {
  const msgPoint = await G2.hashToCurve(message, { DST });
  const partial = msgPoint.multiply(share.shareScalar);
  return partial.toHex(true); // compressed
}

/**
 * Combine t-of-n partial BLS signatures using Lagrange interpolation.
 *
 *   combined = Σ λ_i · partial_i = master_key · H(msg)
 *
 * Requires exactly `threshold` or more partial signatures.
 * Only the first `threshold` entries are used.
 *
 * @param partials  - Partial signature array (at least `threshold` entries)
 * @param threshold - Minimum required partial signatures
 * @returns Hex-encoded compressed G2 combined signature
 */
export function combinePartialSignatures(
  partials: BlsPartialSignature[],
  threshold: number
): string {
  if (partials.length < threshold) {
    throw new Error(
      `Insufficient partial signatures: ${partials.length} < threshold(${threshold})`
    );
  }

  const selected = partials.slice(0, threshold);
  const indices = selected.map((p) => BigInt(p.index));

  let combined = G2.ProjectivePoint.ZERO;
  for (const partial of selected) {
    const lambda = lagrangeCoeff(indices, BigInt(partial.index));
    const sigPoint = G2.ProjectivePoint.fromHex(partial.signature);
    combined = combined.add(sigPoint.multiply(lambda));
  }

  return combined.toHex(true); // compressed
}

/**
 * Verify a combined BLS signature against the master public key.
 *
 * Pairing check:  e(G1.BASE, sig) == e(masterPK, H(msg))
 *
 * @param masterPublicKey - Hex-encoded compressed G1 master public key (C_0)
 * @param message         - Original message bytes
 * @param signature       - Hex-encoded compressed G2 combined signature
 * @returns true if the signature is valid
 */
export async function verifyBlsSignature(
  masterPublicKey: string,
  message: Uint8Array,
  signature: string
): Promise<boolean> {
  try {
    const pubKey = G1.ProjectivePoint.fromHex(masterPublicKey);
    const sig = G2.ProjectivePoint.fromHex(signature);
    const msgPoint = await G2.hashToCurve(message, { DST });

    // e(G1.BASE, sig) ?= e(pubKey, H(msg))
    const lhs = bls12_381.pairing(G1.ProjectivePoint.BASE, sig);
    const rhs = bls12_381.pairing(pubKey, msgPoint);
    return bls12_381.fields.Fp12.eql(lhs, rhs);
  } catch {
    return false;
  }
}

/**
 * Run a Feldman VSS health check across all shares in a threshold key set.
 *
 * Each share is verified against `vssCommitments`. Shares that fail the
 * elliptic-curve check are reported as corrupted.  Intended to be called
 * periodically (e.g. from a canister heartbeat shim or an off-chain cron job).
 *
 * @param keySet - Full threshold key set (shares must still hold their scalars)
 * @returns Health report with per-share status
 */
export function checkShareHealth(keySet: BlsThresholdKeySet): BlsShareHealthReport {
  const corruptedIndices: number[] = [];

  for (const share of keySet.shares) {
    const valid = verifyBlsShare(share, keySet.vssCommitments);
    if (!valid) {
      corruptedIndices.push(share.index);
    }
  }

  return {
    totalShares: keySet.shares.length,
    healthyShares: keySet.shares.length - corruptedIndices.length,
    corruptedShares: corruptedIndices.length,
    corruptedIndices,
    allHealthy: corruptedIndices.length === 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Derive a 32-byte master secret from a BIP39 seed phrase suitable for
 * use as input to `generateBlsThresholdShares`.
 *
 * @param seedPhrase - BIP39 mnemonic string
 * @returns 32-byte Uint8Array master secret
 */
export async function deriveMasterSecretFromSeedPhrase(
  seedPhrase: string
): Promise<Uint8Array> {
  const bip39 = await import('bip39');
  const seed = await bip39.mnemonicToSeed(seedPhrase);
  // HKDF-style derivation using PBKDF2 with a VetKD-specific label
  const masterSecret = crypto.pbkdf2Sync(
    seed,
    'agentvault-vetkd-v1:bls-master',
    100_000,
    32,
    'sha256'
  );
  return new Uint8Array(masterSecret);
}
