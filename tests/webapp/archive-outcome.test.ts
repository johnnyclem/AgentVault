/**
 * What the agent page's archive dialog says when an archive run returns
 * (webapp/src/lib/proof/archive-outcome.ts). The run ends when the gateway
 * accepts the upload, before it is mined, so the dialog says the upload was
 * submitted, never that the archive completed, and points to the Evidence
 * page, where the browser checks the transaction.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

interface ArchiveOutcome {
  title: string;
  detail: string;
  submitted: boolean;
}

interface OutcomeModule {
  describeArchiveOutcome: (arweave?: { transactionId?: string; skippedReason?: string }) => ArchiveOutcome;
  evidenceHref: (agentId: string) => string;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'archive-outcome.ts');
let outcome: OutcomeModule;

beforeAll(async () => {
  outcome = (await import(MODULE)) as OutcomeModule;
});

describe('describeArchiveOutcome', () => {
  it('calls an upload with a transaction id submitted, and says it is confirmed only once mined', () => {
    expect(outcome.describeArchiveOutcome({ transactionId: 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U' })).toEqual({
      title: 'Submitted to Arweave',
      detail: 'Deployment finished. The Arweave upload was submitted; it counts as confirmed only once it is mined.',
      submitted: true,
    });
  });

  it('says nothing was uploaded when no transaction id came back', () => {
    const expected = {
      title: 'Deployment finished',
      detail: 'Deployment finished. Nothing was uploaded to Arweave.',
      submitted: false,
    };

    expect(outcome.describeArchiveOutcome({ skippedReason: 'No Arweave wallet' })).toEqual(expected);
    expect(outcome.describeArchiveOutcome({})).toEqual(expected);
    expect(outcome.describeArchiveOutcome(undefined)).toEqual(expected);
  });

  it('never calls the archive completed, successful or verified', () => {
    const text = [{ transactionId: 'tx' }, {}].map((arweave) => {
      const { title, detail } = outcome.describeArchiveOutcome(arweave);
      return `${title} ${detail}`;
    }).join(' ');

    expect(text).not.toMatch(/complete|success|verified|immutable|permanent/i);
  });
});

describe('evidenceHref', () => {
  it('links to the agent\'s Evidence page, escaping the id', () => {
    expect(outcome.evidenceHref('research-agent')).toBe('/vault/research-agent/proof');
    expect(outcome.evidenceHref('a/b c')).toBe('/vault/a%2Fb%20c/proof');
  });
});
