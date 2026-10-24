/**
 * canister/agent.mo must not report a threshold signature as verified, a key
 * as derived, BLS shares as healthy, or a trade proposal as approved on the
 * strength of length checks alone. There is no Motoko toolchain in the test
 * run, so these checks read the canister source: each looks at one method's
 * body for the fail-closed result and the absence of the old fail-open one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, '..', '..', 'canister', 'agent.mo'), 'utf-8');

/** The source of one top-level actor function, from its `func` line to its closing `};` */
function body(name: string): string {
  const start = src.search(new RegExp(`func ${name}\\(`));
  expect(start, `func ${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('\n};\n', start);
  return src.slice(start, end);
}

describe('agent.mo fails closed', () => {
  it('never reports a threshold signature as verified', () => {
    const fn = body('verifyThresholdSignature');
    expect(fn).toContain('#err("threshold signature verification is not implemented")');
    expect(fn).not.toContain('#ok(');
  });

  it('derives no key and ignores the seed phrase argument', () => {
    const fn = body('deriveVetKeysKey');
    expect(fn).toContain('#err("threshold key derivation is not implemented")');
    expect(fn).not.toContain('#ok(');
    expect(fn).not.toContain('seedPhrase');
  });

  it('reports VetKeys disabled and mock', () => {
    expect(body('getVetKeysStatus')).toContain('{ enabled = false; thresholdSupported = false; mode = #mock }');
  });

  it('never marks BLS shares healthy', () => {
    const init = body('initializeThresholdShares');
    expect(init).toContain('healthy = false; reason = "not_checked"');
    expect(init).toContain('sharesAllHealthy := false;');
    expect(init).not.toMatch(/healthy = true|sharesAllHealthy := true/);

    const check = body('runShareHealthCheck');
    expect(check).toContain('healthy = false; reason');
    expect(check).toContain('"format_ok_unverified"');
    expect(check).not.toMatch(/\(true, "ok"\)|sharesAllHealthy\s+:= allOk/);

    const query = body('getShareHealthStatus');
    expect(query).toMatch(/allHealthy\s+= false;/);
    expect(query).toContain('healthy = false; reason = r.reason');
  });

  it('refuses approval votes, so no proposal reaches #approved', () => {
    const fn = body('castConsensusVote');
    const refusal = fn.indexOf('if (approve) {');
    expect(refusal).toBeGreaterThan(-1);
    expect(fn.slice(refusal, fn.indexOf('};', refusal))).toContain('return #err(');
    // The refusal comes before anything is recorded
    expect(refusal).toBeLessThan(fn.indexOf('consensusProposals :='));
    expect(fn).not.toMatch(/status\s+= #approved/);
    expect(fn).not.toContain('Consensus reached');
    expect(src).not.toMatch(/status\s+= #approved/);
  });
});
