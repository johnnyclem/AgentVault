/**
 * `agentvault wallet vetkeys` must run the operation the user picked (the
 * prompt returns each choice's `value`), and must not say the canister's
 * VetKeys status was fetched when the canister could not be asked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakes = vi.hoisted(() => ({
  spinner: { succeed: [] as string[], fail: [] as string[] },
  getStatus: vi.fn(),
  createActor: vi.fn(),
}));

// Answer a list prompt the way inquirer does: return the `value` of the
// choice whose displayed `name` the user picked.
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(async (questions: Array<{ name: string; choices?: Array<{ name: string; value: string }> }>) => {
      const q = questions[0]!;
      if (q.name === 'operation') {
        return { operation: q.choices?.find((c) => c.name === 'Get VetKeys status')?.value };
      }
      return { canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai' };
    }),
  },
}));

vi.mock('ora', () => ({
  default: () => {
    const spinner = {
      start: () => spinner,
      succeed: (text: string) => { fakes.spinner.succeed.push(text); return spinner; },
      fail: (text: string) => { fakes.spinner.fail.push(text); return spinner; },
    };
    return spinner;
  },
}));

vi.mock('../../../src/canister/actor.js', () => ({
  createActor: fakes.createActor,
}));

import { walletCommand } from '../../../cli/commands/wallet.js';

let printed: string[];

beforeEach(() => {
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
  fakes.spinner.succeed = [];
  fakes.spinner.fail = [];
  fakes.getStatus.mockReset();
  fakes.createActor.mockReset().mockReturnValue({ getVetKeysStatus: fakes.getStatus });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wallet vetkeys status', () => {
  it('shows the status the canister reported', async () => {
    fakes.getStatus.mockResolvedValue({ enabled: false, thresholdSupported: false, mode: { mock: null } });

    await walletCommand().parseAsync(['vetkeys'], { from: 'user' });

    expect(fakes.createActor).toHaveBeenCalledWith('rrkah-fqaaa-aaaaa-aaaaq-cai');
    expect(fakes.spinner.succeed).toEqual(['VetKeys status fetched']);
    const output = printed.join('\n');
    expect(output).toMatch(/Enabled:\s+.*no/);
    expect(output).toMatch(/Threshold Support:\s+.*no/);
    expect(output).toMatch(/Mode:\s+mock/);
  });

  it('reports a failure instead of a status when the canister cannot be asked', async () => {
    fakes.getStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await walletCommand().parseAsync(['vetkeys'], { from: 'user' });

    expect(fakes.spinner.succeed).toEqual([]);
    expect(fakes.spinner.fail).toEqual([
      'Failed to fetch status: Could not read VetKeys status from canister rrkah-fqaaa-aaaaa-aaaaq-cai: connect ECONNREFUSED',
    ]);
    expect(printed.join('\n')).not.toContain('VetKeys Status:');
  });
});
