/**
 * Shamir's Secret Sharing over GF(2^8)
 *
 * Splits a secret into `n` shares such that any `t` of them reconstruct it and
 * any `t - 1` reveal nothing about it (information-theoretic security).
 *
 * The secret is processed byte-wise: for each byte we build a random polynomial
 * of degree `t - 1` whose constant term is the secret byte, then evaluate it at
 * x = 1..n. Reconstruction is Lagrange interpolation at x = 0.
 *
 * Field arithmetic uses the AES irreducible polynomial (0x11b) with generator 3.
 */

import * as crypto from 'node:crypto';

/** Maximum number of shares — x-coordinates must be non-zero bytes. */
export const MAX_SHARES = 255;

/** A single share: an x-coordinate and one y-value per secret byte. */
export interface ShamirShare {
  /** x-coordinate, 1..255. Never 0 — that is where the secret lives. */
  x: number;
  /** y-values, one per byte of the secret. */
  y: Uint8Array;
}

// ─── GF(2^8) tables ──────────────────────────────────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator 3: x*3 == xtime(x) ^ x
    const shifted = ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
    x = shifted ^ x;
  }
  // Duplicate the cycle so index sums up to 508 need no modulo.
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP[LOG[a]! - LOG[b]! + 255]!;
}

/** Evaluate a polynomial (coefficients low-order first) at `x` using Horner. */
function gfEvaluate(coefficients: Uint8Array, x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ coefficients[i]!;
  }
  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Split `secret` into `totalShares` shares, any `threshold` of which suffice to
 * reconstruct it.
 *
 * @param secret       - Secret bytes to protect
 * @param threshold    - Shares required to reconstruct (t), >= 2
 * @param totalShares  - Shares to produce (n), >= t and <= 255
 */
export function splitSecret(
  secret: Buffer | Uint8Array,
  threshold: number,
  totalShares: number,
): ShamirShare[] {
  if (!Number.isInteger(threshold) || !Number.isInteger(totalShares)) {
    throw new Error('threshold and totalShares must be integers');
  }
  if (threshold < 2) {
    throw new Error('threshold must be at least 2 (a 1-of-n split is not secret sharing)');
  }
  if (totalShares < threshold) {
    throw new Error(`totalShares (${totalShares}) must be >= threshold (${threshold})`);
  }
  if (totalShares > MAX_SHARES) {
    throw new Error(`totalShares must be <= ${MAX_SHARES}`);
  }
  if (secret.length === 0) {
    throw new Error('secret must not be empty');
  }

  const shares: ShamirShare[] = [];
  for (let x = 1; x <= totalShares; x++) {
    shares.push({ x, y: new Uint8Array(secret.length) });
  }

  // Each byte gets its own independent polynomial.
  const coefficients = new Uint8Array(threshold);
  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    // Constant term is the secret byte; the rest are fresh random coefficients.
    coefficients[0] = secret[byteIndex]!;
    const random = crypto.randomBytes(threshold - 1);
    for (let i = 1; i < threshold; i++) {
      coefficients[i] = random[i - 1]!;
    }

    // A leading coefficient of 0 would silently lower the polynomial degree,
    // weakening the threshold for this byte. Resample until it is non-zero.
    while (coefficients[threshold - 1] === 0) {
      coefficients[threshold - 1] = crypto.randomBytes(1)[0]!;
    }

    for (const share of shares) {
      share.y[byteIndex] = gfEvaluate(coefficients, share.x);
    }
  }

  return shares;
}

/**
 * Reconstruct a secret from shares via Lagrange interpolation at x = 0.
 *
 * Supplying fewer than the original threshold returns a well-formed but
 * incorrect result — that is the point of the scheme, so callers that need to
 * detect it should verify the reconstructed secret against a commitment.
 */
export function combineShares(shares: ShamirShare[]): Buffer {
  if (shares.length < 2) {
    throw new Error('At least 2 shares are required to reconstruct a secret');
  }

  const seenX = new Set<number>();
  for (const share of shares) {
    if (!Number.isInteger(share.x) || share.x < 1 || share.x > MAX_SHARES) {
      throw new Error(`Invalid share x-coordinate: ${share.x}`);
    }
    if (seenX.has(share.x)) {
      throw new Error(`Duplicate share x-coordinate: ${share.x}`);
    }
    seenX.add(share.x);
  }

  const length = shares[0]!.y.length;
  if (shares.some((s) => s.y.length !== length)) {
    throw new Error('All shares must cover a secret of the same length');
  }

  const secret = Buffer.alloc(length);

  for (let byteIndex = 0; byteIndex < length; byteIndex++) {
    let accumulator = 0;

    for (let i = 0; i < shares.length; i++) {
      const xi = shares[i]!.x;
      const yi = shares[i]!.y[byteIndex]!;

      // Lagrange basis polynomial evaluated at 0:
      //   prod over j != i of  xj / (xi ^ xj)
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = shares[j]!.x;
        basis = gfMul(basis, gfDiv(xj, xi ^ xj));
      }

      accumulator ^= gfMul(yi, basis);
    }

    secret[byteIndex] = accumulator;
  }

  return secret;
}

/** Encode a share as `xx:hex` for transport/storage. */
export function encodeShare(share: ShamirShare): string {
  return `${share.x.toString(16).padStart(2, '0')}:${Buffer.from(share.y).toString('hex')}`;
}

/** Parse a share produced by {@link encodeShare}. */
export function decodeShare(encoded: string): ShamirShare {
  const separator = encoded.indexOf(':');
  if (separator === -1) {
    throw new Error('Malformed share: expected "<x-hex>:<y-hex>"');
  }

  const x = Number.parseInt(encoded.slice(0, separator), 16);
  if (!Number.isInteger(x) || x < 1 || x > MAX_SHARES) {
    throw new Error(`Malformed share: invalid x-coordinate "${encoded.slice(0, separator)}"`);
  }

  const yHex = encoded.slice(separator + 1);
  if (yHex.length === 0 || yHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(yHex)) {
    throw new Error('Malformed share: y-values are not valid hex');
  }

  return { x, y: new Uint8Array(Buffer.from(yHex, 'hex')) };
}
