import { describe, expect, it } from 'vitest';
import { Cbor } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { assessCanister, decodeControllers, type CanisterFacts, type Finding } from '../../src/ledger/index.js';

const OWNER = '6jysz-sm42g-x3wyq-zmffd-cflwg-tjxv2-kjkh5-6w7q4-bnfps-u6zmj-fqe';
const GATEWAY = 'yzoj6-sgrt2-fa25n-xcseg-7gr7y-7nciu-cuqts-edigf-s5vts-cwigu-jae';
const OTHER = 'ow3or-2k67g-rbtii-spc67-yi6b3-wydvu-kwtx2-3vpdm-btyl7-apsmi-zqe';

/** A canister set up the way an owner keeps it: they control it and they authorized one writer. */
function facts(overrides: Partial<CanisterFacts> = {}): CanisterFacts {
  return {
    canisterId: 'aaaaa-aa',
    initialized: true,
    owner: OWNER,
    frozen: false,
    killed: false,
    authorizedCount: 1,
    control: { controllers: [OWNER], moduleHash: 'ab'.repeat(32) },
    ...overrides,
  };
}

const levels = (findings: Finding[]) => findings.map((finding) => finding.level);
const find = (findings: Finding[], level: Finding['level']) => findings.find((finding) => finding.level === level)?.text;

describe('assessCanister', () => {
  it('is content when only the owner controls the canister and the gateway has a key of its own', () => {
    const findings = assessCanister(facts(), GATEWAY);
    expect(levels(findings)).toEqual(['ok', 'note', 'note']);
    expect(find(findings, 'ok')).toContain(`Only the repository owner (${OWNER}) controls the canister`);
  });

  it('warns when anyone besides the owner can replace the canister, and names the gateway when it is one', () => {
    const other = assessCanister(facts({ control: { controllers: [OWNER, OTHER], moduleHash: null } }), GATEWAY);
    expect(find(other, 'warn')).toBe(`The canister is also controlled by ${OTHER}, who can replace its code or delete it, and everything anchored here with it.`);
    expect(levels(other)).not.toContain('ok');

    const gateway = assessCanister(facts({ control: { controllers: [OWNER, GATEWAY], moduleHash: null } }), GATEWAY);
    expect(find(gateway, 'warn')).toContain(`${GATEWAY} (the gateway)`);
  });

  it('warns when the repository owner does not control the canister at all', () => {
    const findings = assessCanister(facts({ control: { controllers: [OTHER], moduleHash: null } }), GATEWAY);
    expect(find(findings, 'warn')).toBe(
      `The repository owner (${OWNER}) does not control the canister. ${OTHER} control it, who can replace its code or delete it, and everything anchored here with it.`,
    );
  });

  it('says so when nothing controls the canister', () => {
    const findings = assessCanister(facts({ control: { controllers: [], moduleHash: null } }), GATEWAY);
    expect(find(findings, 'note')).toContain('No one controls this canister');
    expect(levels(findings)).not.toContain('warn');
  });

  it('is a problem, and says what to run, when there is no repository yet', () => {
    const findings = assessCanister(facts({ initialized: false, owner: '', authorizedCount: 0 }), GATEWAY);
    expect(find(findings, 'problem')).toContain('`agentvault memory init`');
    // It does not claim an owner that does not exist.
    expect(findings.map((finding) => finding.text).join('\n')).not.toContain('repository owner');
  });

  it('is a problem when the canister is switched off, and a warning when writes are frozen', () => {
    expect(find(assessCanister(facts({ killed: true }), GATEWAY), 'problem')).toContain('reviveCanister');
    expect(find(assessCanister(facts({ frozen: true }), GATEWAY), 'warn')).toContain('manualUnlock');
  });

  it('warns when the gateway signs as the owner', () => {
    const findings = assessCanister(facts(), OWNER);
    expect(find(findings, 'warn')).toContain('holds the owner');
    expect(find(findings, 'note')).not.toContain('can write only if');
  });

  it('is a problem, with the exact command, when nobody is authorized for the gateway', () => {
    const findings = assessCanister(facts({ authorizedCount: 0 }), GATEWAY);
    expect(find(findings, 'problem')).toBe(`Nobody is authorized to write here, so ${GATEWAY} will be refused. The owner can allow it with \`agentvault memory authorize ${GATEWAY}\`.`);
  });

  it('cannot tell which writer is authorized, and does not pretend to', () => {
    const one = assessCanister(facts({ authorizedCount: 1 }), GATEWAY);
    expect(one.find((finding) => finding.text.includes('can write only if'))?.text).toContain('lists 1 authorized writer but not which');
    const two = assessCanister(facts({ authorizedCount: 2 }), GATEWAY);
    expect(two.find((finding) => finding.text.includes('can write only if'))?.text).toContain('lists 2 authorized writers but not which');
  });

  it('counts the writers when no gateway is named, and lists the worst findings first', () => {
    const findings = assessCanister(facts({ authorizedCount: 2, killed: true, control: { controllers: [OWNER, OTHER], moduleHash: 'cd'.repeat(32) } }));
    expect(findings.map((finding) => finding.text).find((text) => text.startsWith('2 writers'))).toBe('2 writers are authorized besides the owner.');
    expect(levels(findings)).toEqual(['problem', 'warn', 'note', 'note']);
    expect(findings.at(-1)?.text).toBe(`Installed code: ${'cd'.repeat(32)}`);
  });
});

describe('decodeControllers', () => {
  it('reads the certified list of controllers, as the subnet encodes it', () => {
    const leaf = Cbor.encode([Principal.fromText(OWNER).toUint8Array(), Principal.fromText(GATEWAY).toUint8Array()]);
    expect(decodeControllers(new Uint8Array(leaf))).toEqual([OWNER, GATEWAY]);
    expect(decodeControllers(new Uint8Array(Cbor.encode([])))).toEqual([]);
  });

  it('refuses a leaf that is not a list of principals', () => {
    expect(() => decodeControllers(new Uint8Array(Cbor.encode('nope')))).toThrow(/shape this version does not read/);
    expect(() => decodeControllers(new Uint8Array(Cbor.encode([1, 2])))).toThrow(/not a principal/);
  });
});
