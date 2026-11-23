import { describe, expect, it } from 'vitest';
import { MAX_PROVISION_TRILLIONS, MIN_PROVISION_TRILLIONS, parseProvisionCycles } from '../../src/canister/provision.js';

describe('what a created canister may be funded with', () => {
  it('reads trillions as cycles, exactly', () => {
    expect(parseProvisionCycles('1')).toBe(1_000_000_000_000n);
    expect(parseProvisionCycles('1.5')).toBe(1_500_000_000_000n);
    expect(parseProvisionCycles('0.7500000001')).toBe(750_000_000_100n);
  });

  it('accepts the floor and the ceiling themselves', () => {
    expect(parseProvisionCycles(String(MIN_PROVISION_TRILLIONS))).toBe(750_000_000_000n);
    expect(parseProvisionCycles(String(MAX_PROVISION_TRILLIONS))).toBe(20_000_000_000_000n);
  });

  it('keeps the floor above what the network takes for creating a canister', () => {
    // One canister created on the Internet Computer with 1T held 0.498T afterwards: about 0.5T went on
    // creating it. A floor at or under that leaves a canister with nothing to run on.
    expect(MIN_PROVISION_TRILLIONS).toBeGreaterThanOrEqual(0.75);
    expect(MIN_PROVISION_TRILLIONS - 0.5).toBeGreaterThanOrEqual(0.25);
  });

  it.each(['0.2', '0.5', '0.74', '0.7499', '0', '-1', '20.0001', '21', '100'])('refuses %s, naming the range', (text) => {
    expect(() => parseProvisionCycles(text)).toThrow(`from ${MIN_PROVISION_TRILLIONS} to ${MAX_PROVISION_TRILLIONS}`);
  });

  it.each(['', '  ', 'abc', 'NaN', 'Infinity', '-Infinity', '1T', '1,5'])('refuses %j, which is not a number of trillions', (text) => {
    expect(() => parseProvisionCycles(text)).toThrow(/trillions of cycles per canister/);
  });
});
