/**
 * cycles / tokens positional argument wiring
 *
 * Regression: the mint and transfer handlers declared `.argument()` values but
 * destructured them off an `options` object. Commander passes declared
 * arguments positionally, ahead of options, so `amount` and `to` were always
 * undefined and the underlying icp helpers were invoked with undefined.
 *
 * These drive the real Commander programs, so they fail if the wiring regresses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const checkBalance = vi.fn().mockResolvedValue({ stdout: 'ok' });
const mintCycles = vi.fn().mockResolvedValue({ stdout: 'minted' });
const transferCycles = vi.fn().mockResolvedValue({ stdout: 'transferred' });
const transferTokens = vi.fn().mockResolvedValue({ stdout: 'transferred' });

vi.mock('../../../src/icp/cycles.js', () => ({
  checkBalance: (...args: unknown[]) => checkBalance(...args),
  mintCycles: (...args: unknown[]) => mintCycles(...args),
  transferCycles: (...args: unknown[]) => transferCycles(...args),
}));

vi.mock('../../../src/icp/tokens.js', () => ({
  checkBalance: (...args: unknown[]) => checkBalance(...args),
  transferTokens: (...args: unknown[]) => transferTokens(...args),
}));

const { cyclesCommand } = await import('../../../cli/commands/cycles.js');
const { tokensCommand } = await import('../../../cli/commands/tokens.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cycles command arguments', () => {
  it('passes the amount to mintCycles', async () => {
    await cyclesCommand().parseAsync(['mint', '5000000'], { from: 'user' });

    expect(mintCycles).toHaveBeenCalledWith('5000000');
  });

  it('passes amount and recipient to transferCycles', async () => {
    await cyclesCommand().parseAsync(
      ['transfer', '1000', 'ryjl3-tyaaa-aaaaa-aaaba-cai'],
      { from: 'user' },
    );

    expect(transferCycles).toHaveBeenCalledWith('1000', 'ryjl3-tyaaa-aaaaa-aaaba-cai');
  });

  it('still reads the canister id from an option for balance', async () => {
    await cyclesCommand().parseAsync(
      ['balance', '--canister', 'ryjl3-tyaaa-aaaaa-aaaba-cai'],
      { from: 'user' },
    );

    expect(checkBalance).toHaveBeenCalledWith('ryjl3-tyaaa-aaaaa-aaaba-cai');
  });
});

describe('tokens command arguments', () => {
  it('passes amount and recipient to transferTokens', async () => {
    await tokensCommand().parseAsync(
      ['transfer', '25', 'ryjl3-tyaaa-aaaaa-aaaba-cai'],
      { from: 'user' },
    );

    expect(transferTokens).toHaveBeenCalledWith('25', 'ryjl3-tyaaa-aaaaa-aaaba-cai');
  });

  it('never passes undefined for a required argument', async () => {
    await tokensCommand().parseAsync(
      ['transfer', '25', 'ryjl3-tyaaa-aaaaa-aaaba-cai'],
      { from: 'user' },
    );

    for (const arg of transferTokens.mock.calls[0] ?? []) {
      expect(arg).toBeDefined();
    }
  });
});
