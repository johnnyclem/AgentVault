/**
 * VetKeys Threshold — BDD Feature Tests
 *
 * Feature: Threshold-secure secrets with production VetKeys
 *   As a vault admin
 *   I want real multi-party key shares
 *   So that no single canister or node can access secrets
 *
 * Scenarios covered:
 *   1. Share generation on deploy   (3-of-5 BLS key shares via init hook)
 *   2. Threshold signing            (3 shares → valid signature; single share insufficient)
 *   3. Heartbeat share health check (healthy shares pass; corrupted share reported)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import {
  generateBlsThresholdShares,
  verifyBlsShare,
  computePartialSignature,
  combinePartialSignatures,
  verifyBlsSignature,
  checkShareHealth,
  deriveMasterSecretFromSeedPhrase,
} from '../../src/security/bls-threshold.js';
import type {
  BlsThresholdKeySet,
  BlsPartialSignature,
  BlsShareHealthReport,
} from '../../src/security/bls-threshold.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const THRESHOLD     = 3;
const TOTAL_PARTIES = 5;
const TEST_MESSAGE  = new TextEncoder().encode('AgentVault threshold signing test');
const TEST_SEED     = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let keySet: BlsThresholdKeySet;
let masterSecret: Uint8Array;

beforeAll(async () => {
  masterSecret = await deriveMasterSecretFromSeedPhrase(TEST_SEED);
  keySet = generateBlsThresholdShares(masterSecret, THRESHOLD, TOTAL_PARTIES);
});

// ─── Scenario 1: Share generation on deploy ───────────────────────────────────
//
//   Given canister deployment with icp-vetkd crate
//   When the initialization hook runs
//   Then BLS key shares are generated and distributed (3-of-5 example)

describe('Scenario 1: Share generation on deploy', () => {
  it('generates exactly n=5 shares from the initialization hook', () => {
    expect(keySet.shares).toHaveLength(TOTAL_PARTIES);
  });

  it('sets threshold=3 and totalParties=5 on the key set', () => {
    expect(keySet.threshold).toBe(THRESHOLD);
    expect(keySet.totalParties).toBe(TOTAL_PARTIES);
  });

  it('assigns consecutive 1-based indices to all shares', () => {
    const indices = keySet.shares.map((s) => s.index);
    expect(indices).toEqual([1, 2, 3, 4, 5]);
  });

  it('produces a non-empty compressed G1 master public key (≥96 hex chars)', () => {
    expect(keySet.masterPublicKey).toBeTruthy();
    expect(keySet.masterPublicKey.length).toBeGreaterThanOrEqual(96);
  });

  it('produces exactly threshold=3 Feldman VSS commitments', () => {
    expect(keySet.vssCommitments).toHaveLength(THRESHOLD);
    for (const c of keySet.vssCommitments) {
      expect(c.length).toBeGreaterThanOrEqual(96);
    }
  });

  it('first VSS commitment equals the master public key (C_0 = a0 · G1)', () => {
    expect(keySet.vssCommitments[0]).toBe(keySet.masterPublicKey);
  });

  it('produces a 64-char SHA-256 group commitment digest', () => {
    expect(keySet.groupCommitment).toHaveLength(64);
  });

  it('each share has a non-empty private scalar', () => {
    for (const share of keySet.shares) {
      expect(typeof share.shareScalar).toBe('bigint');
      expect(share.shareScalar).toBeGreaterThan(0n);
    }
  });

  it('each share has a compressed G1 partial public key (≥96 hex chars)', () => {
    for (const share of keySet.shares) {
      expect(share.publicKey.length).toBeGreaterThanOrEqual(96);
    }
  });

  it('each share has a 64-char SHA-256 integrity commitment', () => {
    for (const share of keySet.shares) {
      expect(share.commitment).toHaveLength(64);
    }
  });

  it('all shares pass Feldman VSS verification (share_i · G1 == Σ C_k · i^k)', () => {
    for (const share of keySet.shares) {
      expect(verifyBlsShare(share, keySet.vssCommitments)).toBe(true);
    }
  });

  it('is deterministic from the same master secret', () => {
    const keySet2 = generateBlsThresholdShares(masterSecret, THRESHOLD, TOTAL_PARTIES);
    // Master public key must match (same a0 derived from same secret)
    expect(keySet2.masterPublicKey).toBe(keySet.masterPublicKey);
    // VSS C_0 must also match
    expect(keySet2.vssCommitments[0]).toBe(keySet.vssCommitments[0]);
  });

  it('produces different random polynomials for different master secrets', () => {
    const anotherSecret = new Uint8Array(32).fill(42);
    const keySet2 = generateBlsThresholdShares(anotherSecret, THRESHOLD, TOTAL_PARTIES);
    expect(keySet2.masterPublicKey).not.toBe(keySet.masterPublicKey);
  });

  it('deriveMasterSecretFromSeedPhrase returns 32 bytes', async () => {
    const secret = await deriveMasterSecretFromSeedPhrase(TEST_SEED);
    expect(secret).toHaveLength(32);
  });

  it('deriveMasterSecretFromSeedPhrase is deterministic for the same seed', async () => {
    const s1 = await deriveMasterSecretFromSeedPhrase(TEST_SEED);
    const s2 = await deriveMasterSecretFromSeedPhrase(TEST_SEED);
    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
  });

  it('rejects threshold < 2', () => {
    expect(() =>
      generateBlsThresholdShares(masterSecret, 1, TOTAL_PARTIES)
    ).toThrow(/Invalid threshold/);
  });

  it('rejects threshold > totalParties', () => {
    expect(() =>
      generateBlsThresholdShares(masterSecret, 6, TOTAL_PARTIES)
    ).toThrow(/Invalid threshold/);
  });

  it('rejects masterSecret shorter than 32 bytes', () => {
    expect(() =>
      generateBlsThresholdShares(new Uint8Array(16), THRESHOLD, TOTAL_PARTIES)
    ).toThrow(/masterSecret must be at least 32 bytes/);
  });
});

// ─── Scenario 2: Threshold signing ────────────────────────────────────────────
//
//   Given at least 3 valid shares
//   When a message requires signing
//   Then the threshold signature is produced successfully
//    And no single share can reconstruct the secret

describe('Scenario 2: Threshold signing', () => {
  let partials: BlsPartialSignature[];
  let combinedSignature: string;

  beforeAll(async () => {
    // Compute partial signatures from shares 1, 2, 3 (exactly threshold)
    partials = await Promise.all(
      keySet.shares.slice(0, THRESHOLD).map(async (share) => ({
        index: share.index,
        signature: await computePartialSignature(share, TEST_MESSAGE),
      }))
    );
    combinedSignature = combinePartialSignatures(partials, THRESHOLD);
  });

  it('produces a partial signature for each of the 3 threshold shares', () => {
    expect(partials).toHaveLength(THRESHOLD);
  });

  it('each partial signature is a non-empty hex string (≥96 chars for compressed G2)', () => {
    for (const p of partials) {
      expect(typeof p.signature).toBe('string');
      expect(p.signature.length).toBeGreaterThanOrEqual(96);
    }
  });

  it('combines 3-of-5 partial signatures into a single BLS signature', () => {
    expect(typeof combinedSignature).toBe('string');
    expect(combinedSignature.length).toBeGreaterThanOrEqual(96);
  });

  it('verifies the combined signature against the master public key', async () => {
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      combinedSignature
    );
    expect(valid).toBe(true);
  });

  it('produces the same combined signature from any 3-of-5 share subset', async () => {
    // Use shares 2, 3, 4 instead of 1, 2, 3
    const altPartials = await Promise.all(
      keySet.shares.slice(1, THRESHOLD + 1).map(async (share) => ({
        index: share.index,
        signature: await computePartialSignature(share, TEST_MESSAGE),
      }))
    );
    const altCombined = combinePartialSignatures(altPartials, THRESHOLD);
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      altCombined
    );
    expect(valid).toBe(true);
  });

  it('verifies using all 5 shares (superset of threshold)', async () => {
    const allPartials = await Promise.all(
      keySet.shares.map(async (share) => ({
        index: share.index,
        signature: await computePartialSignature(share, TEST_MESSAGE),
      }))
    );
    // combinePartialSignatures uses only the first `threshold` entries
    const supersetCombined = combinePartialSignatures(allPartials, THRESHOLD);
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      supersetCombined
    );
    expect(valid).toBe(true);
  });

  it('rejects a signature verified against the wrong public key', async () => {
    const wrongKeySet = generateBlsThresholdShares(
      new Uint8Array(32).fill(99),
      THRESHOLD,
      TOTAL_PARTIES
    );
    const valid = await verifyBlsSignature(
      wrongKeySet.masterPublicKey,
      TEST_MESSAGE,
      combinedSignature
    );
    expect(valid).toBe(false);
  });

  it('rejects a signature verified against a different message', async () => {
    const otherMsg = new TextEncoder().encode('different message');
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      otherMsg,
      combinedSignature
    );
    expect(valid).toBe(false);
  });

  it('rejects a corrupted signature', async () => {
    // Flip one byte in the signature
    const badSig = Buffer.from(combinedSignature, 'hex');
    badSig[0] ^= 0xff;
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      badSig.toString('hex')
    );
    expect(valid).toBe(false);
  });

  // ── "No single share can reconstruct the secret" ──────────────────────────
  //
  // A single share sitting on the BLS12-381 polynomial is indistinguishable
  // from a random point for an adversary who does not hold t-1 other shares.
  // We verify this computationally: combining fewer than threshold partials
  // must NOT produce a signature that verifies against the master public key.

  it('single partial signature does NOT verify against the master public key (threshold > 1)', async () => {
    const [singlePartial] = partials;
    // "combine" 1 share with threshold=1 — this is just the partial itself,
    // which equals share_i · H(msg), not master_key · H(msg)
    const singleCombined = combinePartialSignatures([singlePartial], 1);
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      singleCombined
    );
    expect(valid).toBe(false);
  });

  it('two partial signatures (below threshold=3) do NOT verify against master key', async () => {
    const twoPartials = partials.slice(0, 2);
    const twoCombined = combinePartialSignatures(twoPartials, 2);
    const valid = await verifyBlsSignature(
      keySet.masterPublicKey,
      TEST_MESSAGE,
      twoCombined
    );
    expect(valid).toBe(false);
  });

  it('throws when fewer than threshold partials are provided to combinePartialSignatures', () => {
    expect(() =>
      combinePartialSignatures(partials.slice(0, THRESHOLD - 1), THRESHOLD)
    ).toThrow(/Insufficient partial signatures/);
  });
});

// ─── Scenario 3: Heartbeat share health check ──────────────────────────────────
//
//   Given periodic heartbeat
//   When share validity is verified
//   Then all shares are confirmed healthy
//    And any corrupted share is reported

describe('Scenario 3: Heartbeat share health check', () => {
  it('reports all 5 shares as healthy for a freshly generated key set', () => {
    const report: BlsShareHealthReport = checkShareHealth(keySet);

    expect(report.totalShares).toBe(TOTAL_PARTIES);
    expect(report.healthyShares).toBe(TOTAL_PARTIES);
    expect(report.corruptedShares).toBe(0);
    expect(report.corruptedIndices).toHaveLength(0);
    expect(report.allHealthy).toBe(true);
    expect(report.checkedAt).toBeTruthy();
  });

  it('includes an ISO-8601 timestamp in the health report', () => {
    const report = checkShareHealth(keySet);
    expect(() => new Date(report.checkedAt).toISOString()).not.toThrow();
  });

  it('reports a share as corrupted when its scalar is tampered', () => {
    // Deep-clone the key set and corrupt share 3's scalar
    const corruptedKeySet: BlsThresholdKeySet = {
      ...keySet,
      shares: keySet.shares.map((s) =>
        s.index === 3
          ? { ...s, shareScalar: s.shareScalar ^ 0xdeadbeefn }
          : s
      ),
    };

    const report = checkShareHealth(corruptedKeySet);

    expect(report.corruptedShares).toBe(1);
    expect(report.corruptedIndices).toContain(3);
    expect(report.allHealthy).toBe(false);
    expect(report.healthyShares).toBe(TOTAL_PARTIES - 1);
  });

  it('reports multiple corrupted shares when multiple scalars are tampered', () => {
    const corruptedKeySet: BlsThresholdKeySet = {
      ...keySet,
      shares: keySet.shares.map((s) =>
        s.index === 1 || s.index === 5
          ? { ...s, shareScalar: 0n }          // zero scalar → invalid point
          : s
      ),
    };

    const report = checkShareHealth(corruptedKeySet);

    expect(report.corruptedShares).toBe(2);
    expect(report.corruptedIndices).toContain(1);
    expect(report.corruptedIndices).toContain(5);
    expect(report.allHealthy).toBe(false);
  });

  it('returns allHealthy=false when VSS commitments are tampered', async () => {
    // Replace C_1 with the generator point (random valid point, wrong commitment)
    const { bls12_381 } = await import('@noble/curves/bls12-381');
    const wrongCommit = bls12_381.G1.ProjectivePoint.BASE.toHex(true);

    const tamperedKeySet: BlsThresholdKeySet = {
      ...keySet,
      vssCommitments: keySet.vssCommitments.map((c, k) =>
        k === 1 ? wrongCommit : c
      ),
    };

    const report = checkShareHealth(tamperedKeySet);
    // All shares fail because they were evaluated against the original polynomial,
    // but now C_1 is wrong so Feldman check fails for all i ≠ 0
    expect(report.allHealthy).toBe(false);
    expect(report.corruptedShares).toBeGreaterThan(0);
  });

  it('still reports the healthy shares correctly when only one is corrupted', () => {
    const corruptedKeySet: BlsThresholdKeySet = {
      ...keySet,
      shares: keySet.shares.map((s) =>
        s.index === 2
          ? { ...s, shareScalar: s.shareScalar + 1n }
          : s
      ),
    };

    const report = checkShareHealth(corruptedKeySet);

    expect(report.healthyShares).toBe(TOTAL_PARTIES - 1);
    expect(report.corruptedIndices).not.toContain(1);
    expect(report.corruptedIndices).toContain(2);
    expect(report.corruptedIndices).not.toContain(3);
    expect(report.corruptedIndices).not.toContain(4);
    expect(report.corruptedIndices).not.toContain(5);
  });

  it('handles an empty share list without throwing', () => {
    const emptyKeySet: BlsThresholdKeySet = {
      ...keySet,
      shares: [],
    };
    const report = checkShareHealth(emptyKeySet);
    expect(report.totalShares).toBe(0);
    expect(report.allHealthy).toBe(true); // vacuously true
  });

  it('verifyBlsShare returns false for a share with zero scalar', () => {
    const zeroShare = { ...keySet.shares[0], shareScalar: 0n };
    expect(verifyBlsShare(zeroShare, keySet.vssCommitments)).toBe(false);
  });

  it('verifyBlsShare returns false for a share against wrong VSS commitments', () => {
    // Use keySet2's commitments to verify keySet's share 1 — should fail
    const otherSecret = new Uint8Array(32).fill(7);
    const keySet2 = generateBlsThresholdShares(otherSecret, THRESHOLD, TOTAL_PARTIES);
    expect(
      verifyBlsShare(keySet.shares[0], keySet2.vssCommitments)
    ).toBe(false);
  });
});
