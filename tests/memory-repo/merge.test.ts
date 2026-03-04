import { describe, it, expect } from 'vitest';
import { idlFactory } from '../../src/canister/memory-repo-actor.idl.js';
import type {
  MergeResult,
  MergeStrategy,
  ConflictEntry,
  Commit,
} from '../../src/canister/memory-repo-actor.js';

describe('MemoryRepo Merge & Cherry-Pick', () => {
  describe('IDL', () => {
    const mockIDL = {
      Service: (methods: Record<string, unknown>) => methods,
      Func: (args: unknown[], ret: unknown[], modes: string[]) => ({ args, ret, modes }),
      Text: 'Text',
      Int: 'Int',
      Nat: 'Nat',
      Bool: 'Bool',
      Null: 'Null',
      Opt: (t: unknown) => ({ opt: t }),
      Vec: (t: unknown) => ({ vec: t }),
      Record: (fields: Record<string, unknown>) => ({ record: fields }),
      Variant: (fields: Record<string, unknown>) => ({ variant: fields }),
      Tuple: (...args: unknown[]) => ({ tuple: args }),
    };

    it('should include merge method in service definition', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, any>;
      expect(service).toHaveProperty('merge');
      expect(service.merge.args).toHaveLength(2); // (fromBranch, strategy)
      expect(service.merge.modes).toEqual([]);     // not a query
    });

    it('should include cherryPick method in service definition', () => {
      const service = idlFactory({ IDL: mockIDL }) as Record<string, any>;
      expect(service).toHaveProperty('cherryPick');
      expect(service.cherryPick.args).toHaveLength(1); // (commitId)
      expect(service.cherryPick.modes).toEqual([]);     // not a query
    });
  });

  describe('MergeStrategy Type', () => {
    it('should support auto strategy', () => {
      const auto: MergeStrategy = { auto: null };
      expect('auto' in auto).toBe(true);
    });

    it('should support manual strategy', () => {
      const manual: MergeStrategy = { manual: null };
      expect('manual' in manual).toBe(true);
    });
  });

  describe('MergeResult Type', () => {
    it('should support ok variant with merge count and message', () => {
      const result: MergeResult = {
        ok: { merged: 3, message: "Merged 3 commit(s) from 'feature'" },
      };
      expect('ok' in result).toBe(true);
      if ('ok' in result) {
        expect(result.ok.merged).toBe(3);
        expect(result.ok.message).toContain('3 commit');
      }
    });

    it('should support conflicts variant', () => {
      const result: MergeResult = {
        conflicts: [
          {
            commitId: 'c_123_1',
            message: 'Conflicting update',
            tags: ['config'],
            diff: 'new config value',
          },
        ],
      };
      expect('conflicts' in result).toBe(true);
      if ('conflicts' in result) {
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]!.commitId).toBe('c_123_1');
      }
    });

    it('should support err variant', () => {
      const result: MergeResult = { err: "Branch 'nonexistent' does not exist" };
      expect('err' in result).toBe(true);
    });
  });

  describe('ConflictEntry Type', () => {
    it('should have all required fields', () => {
      const conflict: ConflictEntry = {
        commitId: 'c_456_2',
        message: 'Update preferences',
        tags: ['preferences', 'config'],
        diff: 'language=en',
      };
      expect(conflict.commitId).toBe('c_456_2');
      expect(conflict.message).toBe('Update preferences');
      expect(conflict.tags).toHaveLength(2);
      expect(conflict.diff).toBe('language=en');
    });
  });

  describe('Conflict Detection (Type-Level)', () => {
    it('should identify conflicts when commits share tags but differ in diff', () => {
      const sourceCommit: Commit = {
        id: 'c_src_1',
        timestamp: 1700000000,
        message: 'Update config',
        diff: 'theme=dark',
        tags: ['config'],
        parent: ['c_src_0'],
        branch: 'feature',
      };

      const targetCommit: Commit = {
        id: 'c_tgt_1',
        timestamp: 1700000001,
        message: 'Set config',
        diff: 'theme=light',
        tags: ['config'],
        parent: ['c_tgt_0'],
        branch: 'main',
      };

      // Tags overlap + different diffs = conflict
      const tagsOverlap = sourceCommit.tags.some(t => targetCommit.tags.includes(t));
      const diffsDiffer = sourceCommit.diff !== targetCommit.diff;
      expect(tagsOverlap && diffsDiffer).toBe(true);
    });

    it('should not flag conflict when diffs are identical', () => {
      const source: Commit = {
        id: 'c_1',
        timestamp: 1700000000,
        message: 'Update',
        diff: 'same content',
        tags: ['config'],
        parent: [],
        branch: 'feature',
      };

      const target: Commit = {
        id: 'c_2',
        timestamp: 1700000001,
        message: 'Update',
        diff: 'same content',
        tags: ['config'],
        parent: [],
        branch: 'main',
      };

      const tagsOverlap = source.tags.some(t => target.tags.includes(t));
      const diffsDiffer = source.diff !== target.diff;
      expect(tagsOverlap && diffsDiffer).toBe(false);
    });

    it('should not flag conflict when tags do not overlap', () => {
      const source: Commit = {
        id: 'c_1',
        timestamp: 1700000000,
        message: 'Update',
        diff: 'different content',
        tags: ['chat'],
        parent: [],
        branch: 'feature',
      };

      const target: Commit = {
        id: 'c_2',
        timestamp: 1700000001,
        message: 'Update',
        diff: 'other content',
        tags: ['config'],
        parent: [],
        branch: 'main',
      };

      const tagsOverlap = source.tags.some(t => target.tags.includes(t));
      expect(tagsOverlap).toBe(false);
    });
  });

  describe('Cherry-Pick (Type-Level)', () => {
    it('should model cherry-picked commits with cherry-picked tag', () => {
      const original: Commit = {
        id: 'c_old_5',
        timestamp: 1700000000,
        message: 'Important fix',
        diff: 'fix content',
        tags: ['bugfix'],
        parent: ['c_old_4'],
        branch: 'feature',
      };

      const picked: Commit = {
        id: 'c_new_3',
        timestamp: 1700000005,
        message: 'cherry-pick: ' + original.message,
        diff: original.diff,
        tags: [...original.tags, 'cherry-picked'],
        parent: ['c_main_2'],
        branch: 'main',
      };

      expect(picked.message).toContain('cherry-pick:');
      expect(picked.diff).toBe(original.diff);
      expect(picked.tags).toContain('cherry-picked');
      expect(picked.tags).toContain('bugfix');
      expect(picked.branch).toBe('main');
    });
  });
});
