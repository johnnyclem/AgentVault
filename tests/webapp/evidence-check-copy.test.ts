/**
 * The words, tone and icon each receipt check state gets on the Evidence page
 * (webapp/src/lib/proof/describe-check.ts). Only a confirmed check may use
 * the success tone or the check icon. Failures are shown as failures,
 * anything that could not be checked stays neutral, and every state has its
 * own title and icon so none is told apart by colour alone. "Check again" is
 * offered only where another attempt could come out differently.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

type Check =
  | { state: 'checking' }
  | { state: 'confirmed'; confirmations: number; blockHeight: number; blockHash: string }
  | { state: 'pending' }
  | { state: 'not-found' }
  | { state: 'size-mismatch'; expected: number; actual: number }
  | { state: 'content-mismatch'; expected: string; actual: string }
  | { state: 'too-large'; maxBytes: number }
  | { state: 'check-failed'; reason: string; retryable: boolean };

interface CheckView {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  icon: string;
  title: string;
  detail: string;
  canRetry: boolean;
}

interface DescribeModule {
  describeCheck: (check: Check) => CheckView;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'describe-check.ts');
let copy: DescribeModule;

beforeAll(async () => {
  copy = (await import(MODULE)) as DescribeModule;
});

const EVERY_STATE: Check[] = [
  { state: 'checking' },
  { state: 'confirmed', confirmations: 12, blockHeight: 2_027_980, blockHash: 'h'.repeat(64) },
  { state: 'pending' },
  { state: 'not-found' },
  { state: 'size-mismatch', expected: 2048, actual: 10 },
  { state: 'content-mismatch', expected: 'a'.repeat(64), actual: 'b'.repeat(64) },
  { state: 'too-large', maxBytes: 5 * 1024 * 1024 },
  { state: 'check-failed', reason: 'The check did not finish: Failed to fetch', retryable: true },
];

describe('describeCheck', () => {
  it('uses the success tone for a confirmed check and for nothing else', () => {
    const success = EVERY_STATE.filter((check) => copy.describeCheck(check).tone === 'success');

    expect(success.map((check) => check.state)).toEqual(['confirmed']);
  });

  it('shows failures as failures and keeps anything unchecked neutral', () => {
    const tones = Object.fromEntries(EVERY_STATE.map((check) => [check.state, copy.describeCheck(check).tone]));

    expect(tones).toEqual({
      checking: 'neutral',
      confirmed: 'success',
      pending: 'warning',
      'not-found': 'danger',
      'size-mismatch': 'danger',
      'content-mismatch': 'danger',
      'too-large': 'neutral',
      'check-failed': 'neutral',
    });
  });

  it('gives every state its own title', () => {
    const titles = EVERY_STATE.map((check) => copy.describeCheck(check).title);

    expect(new Set(titles).size).toBe(EVERY_STATE.length);
  });

  it('gives the check icon to a confirmed check and to nothing else', () => {
    const checked = EVERY_STATE.filter((check) => copy.describeCheck(check).icon === 'check');

    expect(checked.map((check) => check.state)).toEqual(['confirmed']);
  });

  it('gives every state its own icon', () => {
    const icons = EVERY_STATE.map((check) => copy.describeCheck(check).icon);

    expect(new Set(icons).size).toBe(EVERY_STATE.length);
  });

  it('offers another attempt only where a later check could come out differently', () => {
    const retryable = EVERY_STATE.filter((check) => copy.describeCheck(check).canRetry).map((check) => check.state);

    // A gateway can briefly serve an incomplete body, so a mismatch may be asked again; re-hashing cannot turn it green.
    expect(retryable).toEqual(['pending', 'not-found', 'size-mismatch', 'content-mismatch', 'check-failed']);
  });

  it('offers no retry for a failed check that asking again cannot fix', () => {
    const malformed = copy.describeCheck({
      state: 'check-failed',
      reason: 'The recorded transaction id is not a valid Arweave id.',
      retryable: false,
    });

    expect(malformed).toMatchObject({ title: 'Could not check', canRetry: false });
  });

  it('says a mismatch that persists means the served content is not what was recorded', () => {
    const persists = 'If this persists, what arweave.net serves for this transaction is not what the server recorded uploading.';

    expect(copy.describeCheck({ state: 'content-mismatch', expected: 'a'.repeat(64), actual: 'b'.repeat(64) }).detail)
      .toBe(`The SHA-256 of the content arweave.net served does not match the hash recorded at upload. ${persists}`);
  });

  it('names the block and confirmations of a confirmed check, and says the hash matched', () => {
    const one = copy.describeCheck({ state: 'confirmed', confirmations: 1, blockHeight: 2_027_980, blockHash: 'h'.repeat(64) });

    expect(one.detail).toBe(
      'Mined in block #2,027,980 with 1 confirmation. The SHA-256 of the content matches the hash recorded at upload.',
    );
  });

  it('shows why a check failed, and the sizes that differ', () => {
    expect(copy.describeCheck({ state: 'check-failed', reason: 'The check did not finish: Failed to fetch', retryable: true }).detail)
      .toBe('The check did not finish: Failed to fetch');
    expect(copy.describeCheck({ state: 'size-mismatch', expected: 2048, actual: 1 }).detail).toBe(
      'arweave.net served 1 byte; the server recorded 2,048 bytes. ' +
        'If this persists, what arweave.net serves for this transaction is not what the server recorded uploading.',
    );
  });

  it('never calls anything immutable, permanent or proven', () => {
    const text = EVERY_STATE.map((check) => {
      const view = copy.describeCheck(check);
      return `${view.title} ${view.detail}`;
    }).join(' ');

    expect(text).not.toMatch(/immutable|permanent|proof|proven|verified|compliant/i);
  });
});
