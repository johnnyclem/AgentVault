import { describe, it, expect } from 'vitest';
import { idlFactory } from '../../src/canister/memory-repo-actor.idl.js';
import {
  createMemoryRepoActor,
  createAnonymousAgent,
  createAuthenticatedAgent,
} from '../../src/canister/memory-repo-actor.js';
import type {
  Commit,
  RepoStatus,
  OperationResult,
  RebaseResult,
  MergeStrategy,
  ConflictEntry,
  MergeResult,
  _SERVICE,
} from '../../src/canister/memory-repo-actor.js';

describe('MemoryRepo Actor Types', () => {
  describe('IDL Factory', () => {
    it('should export an idlFactory function', () => {
      expect(typeof idlFactory).toBe('function');
    });

    it('should produce a valid service when called with IDL mock', () => {
      // Minimal IDL mock to verify structure
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

      const service = idlFactory({ IDL: mockIDL }) as Record<string, unknown>;

      // PRD 1: Core methods
      expect(service).toHaveProperty('initRepo');
      expect(service).toHaveProperty('commit');
      expect(service).toHaveProperty('log');
      expect(service).toHaveProperty('getCurrentState');
      expect(service).toHaveProperty('getBranches');
      expect(service).toHaveProperty('createBranch');
      expect(service).toHaveProperty('switchBranch');
      expect(service).toHaveProperty('getCommit');
      expect(service).toHaveProperty('getRepoStatus');

      // PRD 3: Rebase
      expect(service).toHaveProperty('rebase');

      // PRD 4: Merge & Cherry-Pick
      expect(service).toHaveProperty('merge');
      expect(service).toHaveProperty('cherryPick');
    });
  });

  describe('TypeScript Types', () => {
    it('should have correct Commit type shape', () => {
      const commit: Commit = {
        id: 'c_123_0',
        timestamp: 1700000000,
        message: 'test commit',
        diff: 'some diff content',
        tags: ['tag1', 'tag2'],
        parent: ['c_122_0'],
        branch: 'main',
      };

      expect(commit.id).toBe('c_123_0');
      expect(commit.tags).toHaveLength(2);
      expect(commit.parent).toHaveLength(1);
    });

    it('should support empty parent for genesis commits', () => {
      const genesis: Commit = {
        id: 'c_100_0',
        timestamp: 1700000000,
        message: 'Genesis',
        diff: 'soul content',
        tags: ['genesis'],
        parent: [],
        branch: 'main',
      };

      expect(genesis.parent).toHaveLength(0);
    });

    it('should have correct RepoStatus type shape', () => {
      const status: RepoStatus = {
        initialized: true,
        currentBranch: 'main',
        totalCommits: 5,
        totalBranches: 2,
        owner: 'abc-123',
      };

      expect(status.initialized).toBe(true);
      expect(status.totalCommits).toBe(5);
    });

    it('should support OperationResult ok variant', () => {
      const result: OperationResult = { ok: 'success' };
      expect('ok' in result).toBe(true);
    });

    it('should support OperationResult err variant', () => {
      const result: OperationResult = { err: 'failure' };
      expect('err' in result).toBe(true);
    });

    it('should have correct RebaseResult type with ok variant', () => {
      const result: RebaseResult = {
        ok: { newBranch: 'rebase/123', commitsReplayed: 3 },
      };
      expect('ok' in result).toBe(true);
      if ('ok' in result) {
        expect(result.ok.commitsReplayed).toBe(3);
      }
    });

    it('should have correct MergeStrategy type', () => {
      const auto: MergeStrategy = { auto: null };
      const manual: MergeStrategy = { manual: null };
      expect('auto' in auto).toBe(true);
      expect('manual' in manual).toBe(true);
    });

    it('should have correct ConflictEntry type shape', () => {
      const conflict: ConflictEntry = {
        commitId: 'c_456_1',
        message: 'conflicting commit',
        tags: ['feature'],
        diff: 'conflicting diff',
      };
      expect(conflict.commitId).toBe('c_456_1');
    });

    it('should have correct MergeResult type variants', () => {
      const ok: MergeResult = { ok: { merged: 2, message: 'Merged 2 commits' } };
      const conflicts: MergeResult = { conflicts: [] };
      const err: MergeResult = { err: 'Branch not found' };

      expect('ok' in ok).toBe(true);
      expect('conflicts' in conflicts).toBe(true);
      expect('err' in err).toBe(true);
    });
  });

  describe('Actor Creation Functions', () => {
    it('should export createMemoryRepoActor function', () => {
      expect(typeof createMemoryRepoActor).toBe('function');
    });

    it('should export createAnonymousAgent function', () => {
      expect(typeof createAnonymousAgent).toBe('function');
    });

    it('should export createAuthenticatedAgent function', () => {
      expect(typeof createAuthenticatedAgent).toBe('function');
    });
  });

  describe('_SERVICE Interface', () => {
    it('should define all expected methods', () => {
      // Type-level check: ensure _SERVICE has all required methods
      const methodNames: (keyof _SERVICE)[] = [
        'initRepo',
        'commit',
        'getCommit',
        'log',
        'getCurrentState',
        'getRepoStatus',
        'getBranches',
        'createBranch',
        'switchBranch',
        'rebase',
        'merge',
        'cherryPick',
      ];

      expect(methodNames).toHaveLength(12);
    });
  });
});
