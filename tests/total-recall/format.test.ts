import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  contentId,
  lineHash,
  sha256Hex,
  verifyChain,
} from '../../src/total-recall/format.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x', null], c: undefined } })).toBe('{"a":{"d":[1,"x",null]},"b":1}');
  });

  it('is stable across key order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ d: new Date() })).toThrow();
  });
});

describe('lineHash / contentId', () => {
  it('ignores the hash field itself', () => {
    const line = { seq: 1, prevHash: null, body: 'x' };
    const hash = lineHash(line);
    expect(hash).toBe(sha256Hex(canonicalJson(line)));
    expect(lineHash({ ...line, hash })).toBe(hash);
  });

  it('length-prefixes parts so concatenations do not collide', () => {
    expect(contentId('m', 'ab', 'c')).not.toBe(contentId('m', 'a', 'bc'));
    expect(contentId('m', 'ab', 'c')).toMatch(/^m_[0-9a-f]{32}$/);
  });
});

describe('verifyChain', () => {
  type L = { seq: number; prevHash: string | null; hash: string; v: string };
  const parse = (x: unknown): L => x as L;
  const build = (values: string[]): string[] => {
    const lines: string[] = [];
    let prev: string | null = null;
    values.forEach((v, i) => {
      const unhashed = { seq: i + 1, prevHash: prev, v };
      const line = { ...unhashed, hash: lineHash(unhashed) };
      prev = line.hash;
      lines.push(JSON.stringify(line));
    });
    return lines;
  };

  it('accepts a well-formed chain and reports its head', () => {
    const lines = build(['a', 'b', 'c']);
    const check = verifyChain(lines, parse);
    expect(check.valid).toBe(true);
    expect(check.count).toBe(3);
    expect(check.head).toBe((JSON.parse(lines[2]!) as L).hash);
  });

  it('detects an edited line, a deleted line and a reordered line', () => {
    const lines = build(['a', 'b', 'c']);
    const edited = [...lines];
    edited[1] = edited[1]!.replace('"v":"b"', '"v":"B"');
    expect(verifyChain(edited, parse).errors.join('\n')).toMatch(/line 2: hash mismatch/);

    const deleted = [lines[0]!, lines[2]!];
    expect(verifyChain(deleted, parse).errors.join('\n')).toMatch(/line 2: seq 3/);

    const reordered = [lines[1]!, lines[0]!, lines[2]!];
    expect(verifyChain(reordered, parse).valid).toBe(false);
  });

  it('reports an unreadable line instead of skipping it', () => {
    const check = verifyChain(['not json'], parse);
    expect(check.valid).toBe(false);
    expect(check.errors[0]).toMatch(/unreadable/);
  });
});
