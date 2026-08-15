/**
 * Shamir's Secret Sharing — correctness and threshold-property tests
 *
 * Acceptance criteria:
 *   1. Any `t` of `n` shares reconstruct the secret exactly
 *   2. Fewer than `t` shares do not reveal the secret
 *   3. No individual share contains the secret
 *   4. Encoding round-trips and rejects malformed input
 *   5. Parameters are validated
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
  splitSecret,
  combineShares,
  encodeShare,
  decodeShare,
  MAX_SHARES,
  type ShamirShare,
} from '../../src/security/shamir.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Every k-sized subset of `items`. */
function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [
    ...combinations(rest, k - 1).map((c) => [head as T, ...c]),
    ...combinations(rest, k),
  ];
}

describe('splitSecret / combineShares', () => {
  it('reconstructs the secret from exactly `threshold` shares', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const shares = splitSecret(secret, 3, 5);

    expect(shares).toHaveLength(5);
    expect(combineShares(shares.slice(0, 3)).equals(secret)).toBe(true);
  });

  it('reconstructs from every possible t-of-n subset', () => {
    const secret = Buffer.from('threshold recovery must not depend on which shares', 'utf-8');
    const shares = splitSecret(secret, 3, 6);

    const subsets = combinations(shares, 3);
    expect(subsets.length).toBe(20); // C(6,3)

    for (const subset of subsets) {
      expect(combineShares(subset).equals(secret)).toBe(true);
    }
  });

  it('reconstructs from more than `threshold` shares', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const shares = splitSecret(secret, 3, 5);

    expect(combineShares(shares).equals(secret)).toBe(true);
    expect(combineShares(shares.slice(0, 4)).equals(secret)).toBe(true);
  });

  it('handles a 2-of-2 split', () => {
    const secret = Buffer.from('both halves required', 'utf-8');
    const shares = splitSecret(secret, 2, 2);

    expect(combineShares(shares).equals(secret)).toBe(true);
  });

  it('handles binary secrets including zero bytes', () => {
    const secret = Buffer.from([0x00, 0xff, 0x00, 0x42, 0x00, 0x00, 0x7f]);
    const shares = splitSecret(secret, 3, 4);

    expect(combineShares(shares.slice(1, 4)).equals(secret)).toBe(true);
  });

  it('handles a single-byte secret', () => {
    const secret = Buffer.from([0xab]);
    const shares = splitSecret(secret, 2, 3);

    expect(combineShares(shares.slice(0, 2)).equals(secret)).toBe(true);
  });

  it('handles a large secret', () => {
    const secret = crypto.randomBytes(4096);
    const shares = splitSecret(secret, 4, 7);

    expect(combineShares(shares.slice(2, 6)).equals(secret)).toBe(true);
  });

  it('supports the maximum share count', () => {
    const secret = Buffer.from('max fan-out', 'utf-8');
    const shares = splitSecret(secret, 2, MAX_SHARES);

    expect(shares).toHaveLength(MAX_SHARES);
    expect(combineShares([shares[0]!, shares[MAX_SHARES - 1]!]).equals(secret)).toBe(true);
  });
});

describe('Threshold property', () => {
  it('does not reveal the secret with fewer than `threshold` shares', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const shares = splitSecret(secret, 3, 5);

    // Any 2 of a 3-of-5 split interpolate to something other than the secret.
    for (const subset of combinations(shares, 2)) {
      expect(combineShares(subset).equals(secret)).toBe(false);
    }
  });

  it('no individual share contains the secret', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const shares = splitSecret(secret, 3, 5);

    for (const share of shares) {
      const encoded = encodeShare(share);
      expect(encoded).not.toContain(secret.toString('hex'));
      expect(Buffer.from(share.y).toString('utf-8')).not.toContain('abandon');
      // A share must not equal the secret bytes either.
      expect(Buffer.from(share.y).equals(secret)).toBe(false);
    }
  });

  it('produces different share bytes across independent splits', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const a = splitSecret(secret, 3, 5);
    const b = splitSecret(secret, 3, 5);

    expect(Buffer.from(a[0]!.y).equals(Buffer.from(b[0]!.y))).toBe(false);
  });

  it('gives each share a distinct x-coordinate starting at 1', () => {
    const shares = splitSecret(Buffer.from('xs'), 2, 4);

    expect(shares.map((s) => s.x)).toEqual([1, 2, 3, 4]);
  });
});

describe('encodeShare / decodeShare', () => {
  it('round-trips a share', () => {
    const [share] = splitSecret(Buffer.from(MNEMONIC, 'utf-8'), 2, 3);
    const decoded = decodeShare(encodeShare(share!));

    expect(decoded.x).toBe(share!.x);
    expect(Buffer.from(decoded.y).equals(Buffer.from(share!.y))).toBe(true);
  });

  it('reconstructs from encoded and re-decoded shares', () => {
    const secret = Buffer.from(MNEMONIC, 'utf-8');
    const encoded = splitSecret(secret, 3, 5).map(encodeShare);
    const decoded = encoded.slice(0, 3).map(decodeShare);

    expect(combineShares(decoded).equals(secret)).toBe(true);
  });

  it('rejects a share with no separator', () => {
    expect(() => decodeShare('deadbeef')).toThrow(/Malformed share/);
  });

  it('rejects a zero x-coordinate', () => {
    expect(() => decodeShare('00:deadbeef')).toThrow(/invalid x-coordinate/);
  });

  it('rejects non-hex y-values', () => {
    expect(() => decodeShare('01:nothex')).toThrow(/not valid hex/);
  });

  it('rejects an odd-length y-value', () => {
    expect(() => decodeShare('01:abc')).toThrow(/not valid hex/);
  });
});

describe('Parameter validation', () => {
  it('rejects a threshold below 2', () => {
    expect(() => splitSecret(Buffer.from('x'), 1, 3)).toThrow(/at least 2/);
  });

  it('rejects totalShares below threshold', () => {
    expect(() => splitSecret(Buffer.from('x'), 4, 3)).toThrow(/must be >= threshold/);
  });

  it('rejects more than the maximum share count', () => {
    expect(() => splitSecret(Buffer.from('x'), 2, MAX_SHARES + 1)).toThrow(/<= 255/);
  });

  it('rejects an empty secret', () => {
    expect(() => splitSecret(Buffer.alloc(0), 2, 3)).toThrow(/must not be empty/);
  });

  it('rejects non-integer parameters', () => {
    expect(() => splitSecret(Buffer.from('x'), 2.5, 3)).toThrow(/must be integers/);
  });

  it('rejects fewer than 2 shares when combining', () => {
    const shares = splitSecret(Buffer.from('x'), 2, 3);
    expect(() => combineShares([shares[0]!])).toThrow(/At least 2 shares/);
  });

  it('rejects duplicate x-coordinates when combining', () => {
    const shares = splitSecret(Buffer.from('x'), 2, 3);
    expect(() => combineShares([shares[0]!, shares[0]!])).toThrow(/Duplicate share/);
  });

  it('rejects shares of differing length', () => {
    const a = splitSecret(Buffer.from('short'), 2, 2);
    const b = splitSecret(Buffer.from('much longer secret'), 2, 2);

    expect(() => combineShares([a[0]!, { ...b[1]! } as ShamirShare])).toThrow(/same length/);
  });
});
