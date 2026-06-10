import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deserializeCommit,
  readLocalBundle,
  mergeEntries,
  rebaseCommand,
} from '../../../cli/commands/rebase.js';
import type { Bundle, BundleEntry, ThoughtForm } from '../../../cli/commands/rebase.js';
import type { Commit } from '../../../src/canister/memory-repo-actor.js';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
  },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('rebase command', () => {
  describe('rebaseCommand()', () => {
    it('should create a Commander command named "rebase"', () => {
      const cmd = rebaseCommand();
      expect(cmd).toBeDefined();
      expect(cmd.name()).toBe('rebase');
    });

    it('should have --branch option (required)', () => {
      const cmd = rebaseCommand();
      const opt = cmd.options.find(o => o.long === '--branch');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });

    it('should have --canister option (required)', () => {
      const cmd = rebaseCommand();
      const opt = cmd.options.find(o => o.long === '--canister');
      expect(opt).toBeDefined();
      expect(opt!.required).toBe(true);
    });

    it('should have --output option with default', () => {
      const cmd = rebaseCommand();
      const opt = cmd.options.find(o => o.long === '--output');
      expect(opt).toBeDefined();
      expect(opt!.defaultValue).toBe('local_bundle.json');
    });

    it('should have --host option', () => {
      const cmd = rebaseCommand();
      const opt = cmd.options.find(o => o.long === '--host');
      expect(opt).toBeDefined();
    });
  });

  describe('deserializeCommit()', () => {
    it('should convert a canister Commit to a ThoughtForm', () => {
      const commit: Commit = {
        id: 'abc123',
        timestamp: BigInt(1_700_000_000_000_000_000), // nanoseconds
        message: 'test commit',
        diff: '{"key":"value"}',
        tags: ['memory', 'chat'],
        branch: 'main',
        parent: ['parent-id'],
      };

      const tf = deserializeCommit(commit);

      expect(tf.id).toBe('abc123');
      expect(tf.timestamp).toBe(1_700_000_000_000); // milliseconds
      expect(tf.message).toBe('test commit');
      expect(tf.diff).toBe('{"key":"value"}');
      expect(tf.tags).toEqual(['memory', 'chat']);
      expect(tf.branch).toBe('main');
      expect(tf.parent).toBe('parent-id');
    });

    it('should handle commits with no parent', () => {
      const commit: Commit = {
        id: 'genesis',
        timestamp: BigInt(1_000_000_000_000_000),
        message: 'genesis',
        diff: '',
        tags: [],
        branch: 'main',
        parent: [],
      };

      const tf = deserializeCommit(commit);
      expect(tf.parent).toBeNull();
    });
  });

  describe('readLocalBundle()', () => {
    it('should return null when file does not exist', () => {
      const result = readLocalBundle('/tmp/nonexistent_bundle_xyz.json');
      expect(result).toBeNull();
    });

    it('should parse a valid bundle file', () => {
      const bundle: Bundle = {
        version: 1,
        canisterId: 'aaaaa-bbbbb-ccccc-ddddd-eeeee',
        branch: 'main',
        updatedAt: '2024-01-01T00:00:00.000Z',
        entries: [],
      };
      const tmpFile = path.join('/tmp', `test_bundle_${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(bundle), 'utf-8');

      try {
        const result = readLocalBundle(tmpFile);
        expect(result).not.toBeNull();
        expect(result!.version).toBe(1);
        expect(result!.branch).toBe('main');
        expect(result!.entries).toEqual([]);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe('mergeEntries()', () => {
    const makeLocal = (id: string, ts: number): BundleEntry => ({
      id,
      timestamp: ts,
      message: `local ${id}`,
      diff: `local-diff-${id}`,
      tags: ['local'],
      branch: 'main',
      parent: null,
      source: 'local',
    });

    const makeOnChain = (id: string, ts: number): ThoughtForm => ({
      id,
      timestamp: ts,
      message: `chain ${id}`,
      diff: `chain-diff-${id}`,
      tags: ['chain'],
      branch: 'main',
      parent: null,
    });

    it('should keep local-only entries', () => {
      const local = [makeLocal('a', 100)];
      const merged = mergeEntries(local, []);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.id).toBe('a');
      expect(merged[0]!.source).toBe('local');
    });

    it('should add on-chain-only entries', () => {
      const onChain = [makeOnChain('b', 200)];
      const merged = mergeEntries([], onChain);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.id).toBe('b');
      expect(merged[0]!.source).toBe('on-chain');
    });

    it('should prefer on-chain when timestamps are equal (conflict)', () => {
      const local = [makeLocal('c', 300)];
      const onChain = [makeOnChain('c', 300)];
      const merged = mergeEntries(local, onChain);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.source).toBe('on-chain');
      expect(merged[0]!.message).toBe('chain c');
    });

    it('should prefer on-chain when on-chain is newer', () => {
      const local = [makeLocal('d', 100)];
      const onChain = [makeOnChain('d', 200)];
      const merged = mergeEntries(local, onChain);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.source).toBe('on-chain');
    });

    it('should keep local when local timestamp is strictly newer', () => {
      const local = [makeLocal('e', 500)];
      const onChain = [makeOnChain('e', 300)];
      const merged = mergeEntries(local, onChain);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.source).toBe('local');
      expect(merged[0]!.message).toBe('local e');
    });

    it('should combine disjoint entries and sort by timestamp', () => {
      const local = [makeLocal('x', 300), makeLocal('y', 100)];
      const onChain = [makeOnChain('z', 200)];
      const merged = mergeEntries(local, onChain);

      expect(merged).toHaveLength(3);
      expect(merged.map(e => e.id)).toEqual(['y', 'z', 'x']);
    });

    it('should not lose any data during merge', () => {
      const local = [makeLocal('a', 1), makeLocal('b', 2), makeLocal('c', 3)];
      const onChain = [makeOnChain('b', 2), makeOnChain('d', 4)];
      const merged = mergeEntries(local, onChain);

      // a (local-only) + b (conflict, on-chain wins) + c (local-only) + d (on-chain-only)
      expect(merged).toHaveLength(4);
      const ids = merged.map(e => e.id).sort();
      expect(ids).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});
