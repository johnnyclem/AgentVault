/**
 * `agentvault approve sign` records a named approval locally; no key is
 * involved and the signer name is not authenticated. Its output must say so
 * rather than claim the request was signed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakes = vi.hoisted(() => ({
  spinner: { succeed: [] as string[], fail: [] as string[] },
}));

vi.mock('../../../src/security/index.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../src/security/index.js');
  return {
    ...actual,
    signApprovalRequest: vi.fn(() => true),
    isApproved: vi.fn(() => false),
    getApprovalSummary: vi.fn(() => ({ approved: 1, required: 2 })),
  };
});

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

import { approveCmd } from '../../../cli/commands/approve.js';

beforeEach(() => {
  fakes.spinner.succeed = [];
  fakes.spinner.fail = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approve sign', () => {
  it('says an approval was recorded, local and unauthenticated, not that the request was signed', async () => {
    await approveCmd.parseAsync(['sign', 'req-1', 'alice'], { from: 'user' });

    expect(fakes.spinner.succeed).toEqual([expect.stringContaining('Approval recorded for alice (local, unauthenticated)')]);
    expect(fakes.spinner.succeed.join('\n')).not.toMatch(/signed by/i);
  });

  it('does not describe the command group as multi-signature', () => {
    expect(approveCmd.description()).toContain('not cryptographic multisig');
    expect(approveCmd.description()).not.toMatch(/multi-signature/i);
  });
});
