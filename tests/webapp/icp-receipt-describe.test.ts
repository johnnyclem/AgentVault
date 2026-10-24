/**
 * The words, tone and icon each signed memory write check state gets
 * (webapp/src/lib/proof/describe-icp-check.ts), and the "What was checked"
 * ledger. Only a verified receipt may use the success tone or the
 * shield-check icon; a check that ran and failed is shown as a failure;
 * anything not checked, or not confirmed, stays neutral, down to its step.
 * No text claims what a receipt cannot show: who asked for a write, that the
 * list is whole, or that anything is permanent, and no library error text
 * reaches the page. And no page code hands the checker a root key of its own.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

interface Write {
  kind: 'commit' | 'tombstone' | 'branch';
  method: 'commitToBranch' | 'createBranchFrom';
  canisterId: string;
  sender: string;
  requestId: string;
  recordedResult: string;
  argReadable: boolean;
  branch?: string;
  baseBranch?: string;
  tags?: string[];
}

type Check =
  | { state: 'checking' }
  | { state: 'large-unchecked'; argBytes: number }
  | { state: 'verified'; keyType: 'ed25519' | 'secp256k1'; write: Write; certifiedAt: Date; subnetId: string | null }
  | { state: 'not-anchored'; keyType: 'ed25519' | 'secp256k1'; write: Write }
  | { state: 'other-canister'; keyType: 'ed25519' | 'secp256k1'; write: Write; expected: string }
  | { state: 'canister-unknown'; keyType: 'ed25519' | 'secp256k1'; write: Write }
  | { state: 'signature-invalid'; keyType: 'ed25519' | 'secp256k1' }
  | { state: 'principal-mismatch'; recorded: string; derived: string }
  | { state: 'certificate-invalid'; reason: string }
  | { state: 'not-replied'; status: string; rejectCode?: number; rejectMessage?: string }
  | { state: 'reply-mismatch'; recorded: string; certified: { ok: string } | { err: string } | null }
  | { state: 'unsupported-key-type' }
  | { state: 'check-failed'; reason: string; signatureChecked?: true };

interface View {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  icon: string;
  title: string;
  detail: string;
}

interface Step {
  id: string;
  label: string;
  outcome: 'passed' | 'failed' | 'not-confirmed' | 'not-checked';
  detail: string;
}

interface DescribeModule {
  describeIcpCheck: (check: Check) => View;
  describeIcpSteps: (check: Check) => Step[];
  summarizeWrite: (write: Write) => string;
  shortPrincipal: (principal: string) => string;
}

interface CopyModule {
  SIGNED_WRITES_COPY: Record<string, string | ((count: number) => string)>;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const WEBAPP_SRC = join(import.meta.dirname, '..', '..', 'webapp', 'src');
const PROOF = join(WEBAPP_SRC, 'lib', 'proof');
let copy: DescribeModule;
let pageCopy: CopyModule;

beforeAll(async () => {
  copy = (await import(join(PROOF, 'describe-icp-check.ts'))) as DescribeModule;
  pageCopy = (await import(join(PROOF, 'signed-writes.ts'))) as CopyModule;
});

const WRITE: Write = {
  kind: 'commit',
  method: 'commitToBranch',
  canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
  sender: 'w7x7r-cok77-xa5xc-6cgek-kd2nq-wbjcf-2gvjy-ahz2e-ncr27-yzgs4-2qe',
  requestId: 'ab'.repeat(32),
  recordedResult: 'c_1761300000000000000_42',
  argReadable: true,
  branch: 'polytician-main',
  tags: ['ocean'],
};

const NAMED_CANISTER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

const EVERY_STATE: Check[] = [
  { state: 'checking' },
  { state: 'verified', keyType: 'ed25519', write: WRITE, certifiedAt: new Date(1_761_300_000_000), subnetId: null },
  { state: 'not-anchored', keyType: 'secp256k1', write: WRITE },
  { state: 'signature-invalid', keyType: 'ed25519' },
  { state: 'principal-mismatch', recorded: WRITE.sender, derived: 'aaaaa-aa' },
  { state: 'certificate-invalid', reason: 'bad-signature' },
  { state: 'not-replied', status: 'rejected', rejectCode: 5, rejectMessage: 'caller principal is not authorized' },
  { state: 'not-replied', status: 'absent' },
  { state: 'not-replied', status: 'processing' },
  { state: 'reply-mismatch', recorded: WRITE.recordedResult, certified: { err: 'Repo is frozen' } },
  { state: 'unsupported-key-type' },
  { state: 'check-failed', reason: 'This page cannot read this version of receipt.' },
  { state: 'other-canister', keyType: 'ed25519', write: WRITE, expected: NAMED_CANISTER },
  { state: 'canister-unknown', keyType: 'secp256k1', write: WRITE },
  { state: 'large-unchecked', argBytes: 1_048_576 },
];

const NOT_REPLIED_STATUSES = ['rejected', 'absent', 'received', 'processing', 'done', 'replied-without-reply', 'unreadable'];

const CERTIFICATE_FAILURES = ['not-cbor', 'bad-signature', 'canister-not-covered', 'malformed'];

function find(state: Check['state']): Check {
  return EVERY_STATE.find((check) => check.state === state)!;
}

function label(check: Check): string {
  return check.state === 'not-replied' ? `not-replied ${check.status}` : check.state;
}

describe('describeIcpCheck', () => {
  it('uses the success tone and the shield-check icon for a verified receipt and for nothing else', () => {
    const states = [...EVERY_STATE, ...NOT_REPLIED_STATUSES.map((status): Check => ({ state: 'not-replied', status }))];

    expect(states.filter((check) => copy.describeIcpCheck(check).tone === 'success').map(label)).toEqual(['verified']);
    expect(states.filter((check) => copy.describeIcpCheck(check).icon === 'shield-check').map(label)).toEqual(['verified']);
  });

  it('shows checks that failed as failures and keeps anything not checked neutral', () => {
    const tones = Object.fromEntries(EVERY_STATE.map((check) => [label(check), copy.describeIcpCheck(check).tone]));

    expect(tones).toEqual({
      checking: 'neutral',
      verified: 'success',
      'not-anchored': 'neutral',
      'signature-invalid': 'danger',
      'principal-mismatch': 'danger',
      'certificate-invalid': 'danger',
      'not-replied rejected': 'danger',
      'not-replied absent': 'danger',
      'not-replied processing': 'neutral',
      'reply-mismatch': 'danger',
      'unsupported-key-type': 'neutral',
      'check-failed': 'neutral',
      'other-canister': 'neutral',
      'canister-unknown': 'neutral',
      'large-unchecked': 'neutral',
    });
  });

  it.each(['received', 'done', 'replied-without-reply', 'unreadable'])('keeps a certificate without the answer (%s) neutral', (status) => {
    expect(copy.describeIcpCheck({ state: 'not-replied', status })).toMatchObject({ tone: 'neutral', title: 'Answer not in the certificate' });
  });

  it('gives every state its own title', () => {
    const titles = EVERY_STATE.map((check) => copy.describeIcpCheck(check).title);

    expect(new Set(titles).size).toBe(EVERY_STATE.length);
  });

  it('calls a local replica receipt checked but not anchored, never verified', () => {
    const view = copy.describeIcpCheck({ state: 'not-anchored', keyType: 'secp256k1', write: WRITE });

    expect(view.title).toBe('Signature checked, not anchored to the Internet Computer');
    expect(view.detail).toContain('The secp256k1 signature is valid for principal w7x7r-…-2qe.');
    expect(view.detail).toContain('nothing here shows that the Internet Computer accepted it');
  });

  it('names the principal, the full canister id and the certified commit of a verified receipt', () => {
    const view = copy.describeIcpCheck(EVERY_STATE[1]!);

    expect(view.detail).toBe(
      'Signed by principal w7x7r-…-2qe. An Internet Computer certificate, checked against the Internet Computer root key ' +
        'built into this page, shows canister rrkah-fqaaa-aaaaa-aaaaq-cai, the memory_repo canister this server names, ' +
        'accepted this call and replied with commit c_1761300000000000000_42.',
    );
  });

  it('names both canisters for a write to another canister, and says nothing more was checked', () => {
    const view = copy.describeIcpCheck(find('other-canister'));

    expect(view.title).toBe('Written to another canister');
    expect(view.detail).toContain(`went to canister ${WRITE.canisterId}, not ${NAMED_CANISTER}, the memory_repo canister this server names`);
    expect(view.detail).toContain('It was not checked further.');
  });

  it('says why a receipt cannot be matched when the server names no canister', () => {
    const view = copy.describeIcpCheck(find('canister-unknown'));

    expect(view.title).toBe('Canister not confirmed');
    expect(view.detail).toContain(`this server names no memory_repo canister, so this page cannot tell whether canister ${WRITE.canisterId}`);
  });

  it('offers a large write’s check instead of running it, and gives its size', () => {
    const view = copy.describeIcpCheck(find('large-unchecked'));

    expect(view.title).toBe('Not checked yet (large write)');
    expect(view.detail).toBe('This write’s signed argument is 1,024 KiB, so it is not checked automatically. Select Check to check it in your browser.');
  });

  it('quotes the rejection and what the server recorded instead', () => {
    expect(copy.describeIcpCheck(EVERY_STATE[6]!).detail).toBe(
      'The certificate shows the call was rejected: “caller principal is not authorized”. The server recorded it as a successful write.',
    );
    expect(copy.describeIcpCheck(EVERY_STATE[9]!).detail).toBe(
      'The server recorded “c_1761300000000000000_42”; the certified reply is an error, “Repo is frozen”.',
    );
  });

  it('only ever says verified in the verified title', () => {
    const others = EVERY_STATE.filter((check) => check.state !== 'verified').map((check) => {
      const view = copy.describeIcpCheck(check);
      return `${view.title} ${view.detail}`;
    });

    expect(others.join(' ')).not.toMatch(/\bverified\b/i);
    expect(copy.describeIcpCheck(EVERY_STATE[1]!).detail).not.toMatch(/\bverified\b/i);
  });
});

describe('describeIcpSteps', () => {
  function outcomes(check: Check): string[] {
    return copy.describeIcpSteps(check).map((step) => step.outcome);
  }

  it('lists the six checks in the order they run', () => {
    expect(copy.describeIcpSteps({ state: 'checking' }).map((step) => step.label)).toEqual([
      'Request signature',
      'Sender principal',
      'Canister',
      'Internet Computer certificate',
      'Call answered',
      'Reply matches the record',
    ]);
  });

  it('passes all six only for a verified receipt', () => {
    const allPassed = EVERY_STATE.filter((check) => outcomes(check).every((outcome) => outcome === 'passed'));

    expect(allPassed.map(label)).toEqual(['verified']);
  });

  it('passes the signature, sender and canister of a local replica receipt and leaves the rest unchecked, saying why', () => {
    const steps = copy.describeIcpSteps(EVERY_STATE[2]!);

    expect(steps.map((step) => step.outcome)).toEqual(['passed', 'passed', 'passed', 'not-checked', 'not-checked', 'not-checked']);
    expect(steps[3]!.detail).toBe('Not checked: this server recorded the write as going to a local replica.');
  });

  it.each([
    ['signature-invalid', 0],
    ['principal-mismatch', 1],
    ['certificate-invalid', 3],
    ['not-replied', 4],
    ['reply-mismatch', 5],
  ] as const)('marks the checks before %s passed, its own failed and the rest not checked', (state, at) => {
    expect(outcomes(find(state))).toEqual([0, 1, 2, 3, 4, 5].map((i) => (i < at ? 'passed' : i === at ? 'failed' : 'not-checked')));
  });

  it.each(['other-canister', 'canister-unknown'] as const)(
    'passes the signature and sender of %s, leaves its canister not confirmed, and checks nothing after',
    (state) => {
      expect(outcomes(find(state))).toEqual(['passed', 'passed', 'not-confirmed', 'not-checked', 'not-checked', 'not-checked']);
    },
  );

  it('names both canisters in the canister step of a write to another canister', () => {
    expect(copy.describeIcpSteps(find('other-canister'))[2]!.detail).toBe(
      `The call went to canister ${WRITE.canisterId}; this server names ${NAMED_CANISTER} as its memory_repo canister.`,
    );
  });

  it.each(['checking', 'unsupported-key-type', 'check-failed', 'large-unchecked'] as const)('checks nothing for %s', (state) => {
    expect(outcomes(find(state))).toEqual(Array(6).fill('not-checked'));
  });

  it('passes the signature and sender of an argument it could not read, which were checked before it stopped', () => {
    const unreadable: Check = { state: 'check-failed', reason: 'The signed argument is not a commitToBranch call this page can read.', signatureChecked: true };

    expect(outcomes(unreadable)).toEqual(['passed', 'passed', 'not-checked', 'not-checked', 'not-checked', 'not-checked']);
  });

  it('fails the status step only for a rejected call or a certificate about another request', () => {
    const statusStep = (status: string) => copy.describeIcpSteps({ state: 'not-replied', status })[4]!;

    expect(NOT_REPLIED_STATUSES.filter((status) => statusStep(status).outcome === 'failed')).toEqual(['rejected', 'absent']);
    for (const status of ['received', 'processing', 'done', 'replied-without-reply', 'unreadable']) {
      expect(statusStep(status).outcome, status).toBe('not-confirmed');
    }
  });

  it('says a certificate that leaves out the reply records the call as replied, not done', () => {
    expect(copy.describeIcpSteps({ state: 'not-replied', status: 'replied-without-reply' })[4]!.detail).toBe(
      'The certificate records this request as replied but leaves out the reply.',
    );
  });

  it('names the subnet a delegated certificate chains through', () => {
    const delegated: Check = { ...(EVERY_STATE[1] as Check & { state: 'verified' }), subnetId: 'tdb26-jop6k-aogll-7ltgs-eruif-6kk7m-qpktf-gdiqx-mxtrf-vb5e6-eqe' };

    expect(copy.describeIcpSteps(delegated)[3]!.detail).toBe(
      'Chains to the Internet Computer root key built into this page, through subnet tdb26-…-eqe, which hosts this canister.',
    );
  });

  it('gives the reason a certificate failed in its own words, and the reject code of a rejected call', () => {
    expect(copy.describeIcpSteps(EVERY_STATE[5]!)[3]!.detail).toBe(
      'Does not chain to the Internet Computer root key built into this page: its signature does not verify.',
    );
    expect(copy.describeIcpSteps(EVERY_STATE[6]!)[4]!.detail).toBe('The certificate records this request as rejected (reject code 5).');
  });

  it.each(CERTIFICATE_FAILURES)('words a certificate that fails as %s without any library text', (reason) => {
    const check: Check = { state: 'certificate-invalid', reason };
    const text = [copy.describeIcpCheck(check).detail, ...copy.describeIcpSteps(check).map((step) => step.detail)].join('\n');

    expect(copy.describeIcpSteps(check)[3]!.detail).toMatch(/^[A-Z][^()]+\.$/);
    expect(text).not.toMatch(/http|file:|\n\s+at |Error|undefined/);
  });
});

describe('summarizeWrite', () => {
  it.each([
    [WRITE, 'Commit to polytician-main'],
    [{ ...WRITE, kind: 'tombstone' }, 'Deletion marker on polytician-main'],
    [{ ...WRITE, kind: 'branch', method: 'createBranchFrom', branch: 'polytician-research', baseBranch: 'main' }, 'New branch polytician-research from main'],
    [{ ...WRITE, argReadable: false, branch: undefined }, 'Commit (argument not readable)'],
    [{ ...WRITE, kind: 'branch', method: 'createBranchFrom', argReadable: false, branch: undefined }, 'New branch (argument not readable)'],
  ] as Array<[Write, string]>)('summarizes %j as "%s"', (write, summary) => {
    expect(copy.summarizeWrite(write)).toBe(summary);
  });

  it('shortens a principal to its first and last groups, and leaves a short one alone', () => {
    expect(copy.shortPrincipal(WRITE.sender)).toBe('w7x7r-…-2qe');
    expect(copy.shortPrincipal('aaaaa-aa')).toBe('aaaaa-aa');
  });
});

describe('what the signed writes text claims', () => {
  // A receipt shows what the server's key signed and, on mainnet, what the IC
  // certified. It says nothing about agents or people, or that the list is whole.
  const OVERCLAIM =
    /signed by (the |this |an |your )?agent|agent action|vetkey|threshold|immutable|tamper|\bcomplete\b|all (memory )?writes|audit trail|proof|proven|guarantee|permanent|score|trustless|on-chain/i;

  it('never overclaims in a state, a step or the page copy', () => {
    const states = [...EVERY_STATE, ...NOT_REPLIED_STATUSES.map((status): Check => ({ state: 'not-replied', status }))];
    const text = [
      ...states.flatMap((check) => {
        const view = copy.describeIcpCheck(check);
        return [view.title, view.detail, ...copy.describeIcpSteps(check).map((step) => step.detail)];
      }),
      ...Object.values(pageCopy.SIGNED_WRITES_COPY).map((value) => (typeof value === 'function' ? value(3) : value)),
    ];

    for (const line of text) expect(line).not.toMatch(OVERCLAIM);
  });

  it('says on the page that the list may be incomplete and does not identify who asked for a write', () => {
    const { limits, scope } = pageCopy.SIGNED_WRITES_COPY;

    expect(limits).toContain('this list may be incomplete');
    expect(limits).toContain('It does not show which agent or person asked this server to write.');
    expect(scope).toContain('Nothing here links a write to an agent.');
  });

  it('says at the top of the page, not only below the list, that the list may be incomplete', () => {
    expect(pageCopy.SIGNED_WRITES_COPY.scope).toContain('This server keeps the list, so it may be incomplete.');
  });

  it('claims a verified write only for the memory_repo canister this server names', () => {
    const { limits, method } = pageCopy.SIGNED_WRITES_COPY;

    expect(limits).toContain('signed this exact write to the memory_repo canister this server names');
    expect(method).toContain('that the call went to the memory_repo canister this server names');
  });
});

describe('the root key the checker trusts', () => {
  /** The argument list of each checkIcpReceipt(...) call, split at its top-level commas */
  function checkerCalls(source: string): string[][] {
    const calls: string[][] = [];
    for (const match of source.matchAll(/checkIcpReceipt\(/g)) {
      const args: string[] = [''];
      let depth = 0;
      for (const char of source.slice(match.index + match[0].length)) {
        if (char === ')' && depth === 0) break;
        if ('([{'.includes(char)) depth++;
        if (')]}'.includes(char)) depth--;
        if (char === ',' && depth === 0) args.push('');
        else args[args.length - 1] += char;
      }
      calls.push(args.map((arg) => arg.trim()).filter(Boolean));
    }
    return calls;
  }

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('is never chosen by page code: nothing outside the checker names a root key or passes the checker options', () => {
    const checker = join(PROOF, 'icp-receipt-check.ts');
    const offenders: string[] = [];

    for (const file of sourceFiles(WEBAPP_SRC)) {
      if (file === checker) continue;
      const source = readFileSync(file, 'utf8');
      if (/rootKey/.test(source)) offenders.push(`${relative(WEBAPP_SRC, file)} names rootKey`);
      for (const args of checkerCalls(source)) {
        // The receipt and the canister id the server names; a third argument would be options.
        if (args.length !== 2) offenders.push(`${relative(WEBAPP_SRC, file)} calls checkIcpReceipt(${args.join(', ')})`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds the one call the page makes, in its worker, so the guard above is not vacuous', () => {
    const calls = sourceFiles(WEBAPP_SRC)
      .filter((file) => !file.endsWith('icp-receipt-check.ts'))
      .flatMap((file) => checkerCalls(readFileSync(file, 'utf8')).map((args) => [relative(WEBAPP_SRC, file), ...args]));

    expect(calls).toEqual([[join('lib', 'proof', 'icp-receipt-worker.ts'), 'receipt', 'expectedCanisterId']]);
  });

  it('is loaded by page code only through its worker, so its curve code stays out of the pages’ bundles', () => {
    const importers = sourceFiles(WEBAPP_SRC)
      .filter((file) => /^import(?! type)[^']*from '[^']*icp-receipt-check'/m.test(readFileSync(file, 'utf8')))
      .map((file) => relative(WEBAPP_SRC, file));

    expect(importers).toEqual([join('lib', 'proof', 'icp-receipt-worker.ts')]);
  });
});
