import { describe, it, expect, beforeEach } from 'vitest';
import {
  STATE_FORMAT_VERSION,
  STATE_MAGIC_BYTES,
  generateStateId,
  generateAgentId,
  parseVersion,
  isVersionCompatible,
  calculateChecksum,
  createStateHeader,
  createAgentIdentity,
  createSourceMetadata,
  calculateStateStats,
  createSerializedState,
  serializeStateToJson,
  deserializeStateFromJson,
  validateSerializedState,
  createBinaryHeader,
  parseBinaryHeader,
  serializeStateToBinary,
  deserializeStateFromBinary,
  createStateDelta,
  applyStateDelta,
  type SerializedStateV1,
  type RuntimeState,
} from '../../src/packaging/state-format.js';
import type { AgentConfig } from '../../src/packaging/types.js';
import type { Memory, Task } from '../../src/packaging/serializer.js';

describe('state-format', () => {
  // Test fixtures
  const mockConfig: AgentConfig = {
    name: 'test-agent',
    type: 'clawdbot',
    sourcePath: '/path/to/agent',
    entryPoint: 'index.ts',
    version: '1.0.0',
  };

  const mockMemory: Memory = {
    id: 'mem-1',
    type: 'fact',
    content: { key: 'value' },
    timestamp: Date.now(),
    importance: 5,
  };

  const mockTask: Task = {
    id: 'task-1',
    description: 'Test task',
    status: 'pending',
    timestamp: Date.now(),
  };

  const mockRuntimeState: RuntimeState = {
    initialized: true,
    memories: [mockMemory],
    tasks: [mockTask],
    context: { foo: 'bar', count: 42 },
  };

  describe('generateStateId', () => {
    it('should generate unique state IDs', () => {
      const id1 = generateStateId();
      const id2 = generateStateId();
      expect(id1).not.toBe(id2);
    });

    it('should generate IDs with correct prefix', () => {
      const id = generateStateId();
      expect(id).toMatch(/^state_[a-z0-9]+_[a-z0-9]+$/);
    });
  });

  describe('generateAgentId', () => {
    it('should generate agent ID from name and type', () => {
      const id = generateAgentId('My Agent', 'clawdbot');
      expect(id).toBe('clawdbot_my-agent');
    });

    it('should handle special characters', () => {
      const id = generateAgentId('Test@Agent#123', 'goose');
      expect(id).toBe('goose_test-agent-123');
    });

    it('should handle all agent types', () => {
      expect(generateAgentId('test', 'clawdbot')).toBe('clawdbot_test');
      expect(generateAgentId('test', 'goose')).toBe('goose_test');
      expect(generateAgentId('test', 'cline')).toBe('cline_test');
      expect(generateAgentId('test', 'generic')).toBe('generic_test');
    });
  });

  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const result = parseVersion('1.2.3');
      expect(result).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    it('should handle partial version strings', () => {
      expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2, patch: 0 });
      expect(parseVersion('1')).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    it('should handle empty/invalid strings', () => {
      expect(parseVersion('')).toEqual({ major: 1, minor: 0, patch: 0 });
    });
  });

  describe('isVersionCompatible', () => {
    it('should return true for same version', () => {
      expect(isVersionCompatible(STATE_FORMAT_VERSION)).toBe(true);
    });

    it('should return true for older minor versions', () => {
      const current = parseVersion(STATE_FORMAT_VERSION);
      if (current.minor > 0) {
        const olderVersion = `${current.major}.${current.minor - 1}.0`;
        expect(isVersionCompatible(olderVersion)).toBe(true);
      }
    });

    it('should return false for different major versions', () => {
      const current = parseVersion(STATE_FORMAT_VERSION);
      const newerMajor = `${current.major + 1}.0.0`;
      expect(isVersionCompatible(newerMajor)).toBe(false);
    });

    it('should return false for newer minor versions', () => {
      const current = parseVersion(STATE_FORMAT_VERSION);
      const newerMinor = `${current.major}.${current.minor + 1}.0`;
      expect(isVersionCompatible(newerMinor)).toBe(false);
    });
  });

  describe('calculateChecksum', () => {
    it('should calculate checksum for string data', async () => {
      const checksum = await calculateChecksum('test data');
      expect(checksum).toBeDefined();
      expect(typeof checksum).toBe('string');
      expect(checksum.length).toBeGreaterThan(0);
    });

    it('should calculate same checksum for same data', async () => {
      const checksum1 = await calculateChecksum('identical data');
      const checksum2 = await calculateChecksum('identical data');
      expect(checksum1).toBe(checksum2);
    });

    it('should calculate different checksums for different data', async () => {
      const checksum1 = await calculateChecksum('data one');
      const checksum2 = await calculateChecksum('data two');
      expect(checksum1).not.toBe(checksum2);
    });

    it('should handle Uint8Array input', async () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const checksum = await calculateChecksum(data);
      expect(checksum).toBeDefined();
    });
  });

  describe('createStateHeader', () => {
    it('should create header with correct version', async () => {
      const header = await createStateHeader('test payload');
      expect(header.version).toBe(STATE_FORMAT_VERSION);
    });

    it('should create header with checksum', async () => {
      const header = await createStateHeader('test payload');
      expect(header.checksum).toBeDefined();
      expect(header.checksum.length).toBeGreaterThan(0);
    });

    it('should create header with unique state ID', async () => {
      const header1 = await createStateHeader('payload 1');
      const header2 = await createStateHeader('payload 2');
      expect(header1.stateId).not.toBe(header2.stateId);
    });

    it('should include previous state ID when provided', async () => {
      const mockPreviousState = {
        header: {
          stateId: 'previous-state-id',
        },
      } as SerializedStateV1;
      const header = await createStateHeader('payload', {
        previousState: mockPreviousState,
      });
      expect(header.previousStateId).toBe('previous-state-id');
    });

    it('should set correct encoding', async () => {
      const header = await createStateHeader('payload', { encoding: 'cbor' });
      expect(header.encoding).toBe('cbor');
    });

    it('should default to json encoding', async () => {
      const header = await createStateHeader('payload');
      expect(header.encoding).toBe('json');
    });
  });

  describe('createAgentIdentity', () => {
    it('should create identity from config', () => {
      const identity = createAgentIdentity(mockConfig);
      expect(identity.name).toBe('test-agent');
      expect(identity.type).toBe('clawdbot');
      expect(identity.version).toBe('1.0.0');
      expect(identity.agentId).toBe('clawdbot_test-agent');
    });

    it('should default version to 1.0.0', () => {
      const configWithoutVersion = { ...mockConfig, version: undefined };
      const identity = createAgentIdentity(configWithoutVersion);
      expect(identity.version).toBe('1.0.0');
    });
  });

  describe('createSourceMetadata', () => {
    it('should create metadata from config', () => {
      const metadata = createSourceMetadata(mockConfig);
      expect(metadata.sourcePath).toBe('/path/to/agent');
      expect(metadata.entryPoint).toBe('index.ts');
    });

    it('should handle missing entry point', () => {
      const configWithoutEntry = { ...mockConfig, entryPoint: undefined };
      const metadata = createSourceMetadata(configWithoutEntry);
      expect(metadata.entryPoint).toBeUndefined();
    });
  });

  describe('calculateStateStats', () => {
    it('should calculate correct memory count', () => {
      const stats = calculateStateStats(mockRuntimeState);
      expect(stats.memoryCount).toBe(1);
    });

    it('should calculate correct task count', () => {
      const stats = calculateStateStats(mockRuntimeState);
      expect(stats.taskCount).toBe(1);
    });

    it('should calculate correct completed task count', () => {
      const stateWithCompletedTask: RuntimeState = {
        ...mockRuntimeState,
        tasks: [{ ...mockTask, status: 'completed' }],
      };
      const stats = calculateStateStats(stateWithCompletedTask);
      expect(stats.completedTaskCount).toBe(1);
    });

    it('should calculate correct context entry count', () => {
      const stats = calculateStateStats(mockRuntimeState);
      expect(stats.contextEntryCount).toBe(2);
    });

    it('should include timestamps', () => {
      const stats = calculateStateStats(mockRuntimeState);
      expect(stats.createdAt).toBeDefined();
      expect(stats.lastModifiedAt).toBeDefined();
    });
  });

  describe('createSerializedState', () => {
    it('should create complete serialized state', async () => {
      const serialized = await createSerializedState(mockConfig, mockRuntimeState);
      expect(serialized.header).toBeDefined();
      expect(serialized.agent).toBeDefined();
      expect(serialized.source).toBeDefined();
      expect(serialized.state).toBeDefined();
      expect(serialized.stats).toBeDefined();
    });

    it('should include state data', async () => {
      const serialized = await createSerializedState(mockConfig, mockRuntimeState);
      expect(serialized.state.memories).toHaveLength(1);
      expect(serialized.state.tasks).toHaveLength(1);
      expect(serialized.state.context).toEqual({ foo: 'bar', count: 42 });
    });
  });

  describe('serializeStateToJson / deserializeStateFromJson', () => {
    it('should serialize state to valid JSON', async () => {
      const json = await serializeStateToJson(mockConfig, mockRuntimeState);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should deserialize back to equivalent state', async () => {
      const json = await serializeStateToJson(mockConfig, mockRuntimeState);
      const deserialized = deserializeStateFromJson(json);
      expect(deserialized.agent.name).toBe(mockConfig.name);
      expect(deserialized.agent.type).toBe(mockConfig.type);
      expect(deserialized.state.memories).toHaveLength(1);
      expect(deserialized.state.tasks).toHaveLength(1);
    });

    it('should support pretty printing', async () => {
      const prettyJson = await serializeStateToJson(mockConfig, mockRuntimeState, {
        prettyPrint: true,
      });
      expect(prettyJson).toContain('\n');
      expect(prettyJson).toContain('  ');
    });

    it('should support compact output', async () => {
      const compactJson = await serializeStateToJson(mockConfig, mockRuntimeState, {
        prettyPrint: false,
      });
      expect(compactJson).not.toContain('\n');
    });
  });

  describe('validateSerializedState', () => {
    let validState: SerializedStateV1;

    beforeEach(async () => {
      validState = await createSerializedState(mockConfig, mockRuntimeState);
    });

    it('should validate correct state as valid', async () => {
      const result = await validateSerializedState(validState);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.checksumValid).toBe(true);
      expect(result.versionCompatible).toBe(true);
    });

    it('should detect missing agent name', async () => {
      const invalidState = { ...validState, agent: { ...validState.agent, name: '' } };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_AGENT_NAME')).toBe(true);
    });

    it('should detect missing agent type', async () => {
      const invalidState = {
        ...validState,
        agent: { ...validState.agent, type: '' as 'clawdbot' },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_AGENT_TYPE')).toBe(true);
    });

    it('should detect invalid agent type', async () => {
      const invalidState = {
        ...validState,
        agent: { ...validState.agent, type: 'invalid' as 'clawdbot' },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_AGENT_TYPE')).toBe(true);
    });

    it('should detect missing state ID', async () => {
      const invalidState = {
        ...validState,
        header: { ...validState.header, stateId: '' },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_STATE_ID')).toBe(true);
    });

    it('should detect checksum mismatch', async () => {
      const invalidState = {
        ...validState,
        header: { ...validState.header, checksum: 'invalid-checksum' },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.checksumValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'CHECKSUM_MISMATCH')).toBe(true);
    });

    it('should detect incompatible version', async () => {
      const invalidState = {
        ...validState,
        header: { ...validState.header, version: '99.0.0' },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.versionCompatible).toBe(false);
      expect(result.errors.some((e) => e.code === 'VERSION_INCOMPATIBLE')).toBe(true);
    });

    it('should detect missing memory ID', async () => {
      const invalidState = {
        ...validState,
        state: {
          ...validState.state,
          memories: [{ ...mockMemory, id: '' }],
        },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_MEMORY_ID')).toBe(true);
    });

    it('should detect invalid task status', async () => {
      const invalidState = {
        ...validState,
        state: {
          ...validState.state,
          tasks: [{ ...mockTask, status: 'invalid' as 'pending' }],
        },
      };
      const result = await validateSerializedState(invalidState);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_TASK_STATUS')).toBe(true);
    });

    it('should add warning for missing source hash', async () => {
      const result = await validateSerializedState(validState);
      expect(result.warnings.some((w) => w.includes('Source hash'))).toBe(true);
    });
  });

  describe('binary format', () => {
    describe('createBinaryHeader / parseBinaryHeader', () => {
      it('should create 64-byte header', async () => {
        const stateHeader = await createStateHeader('test payload');
        const binaryHeader = createBinaryHeader(stateHeader);
        expect(binaryHeader.length).toBe(64);
      });

      it('should include magic bytes', async () => {
        const stateHeader = await createStateHeader('test payload');
        const binaryHeader = createBinaryHeader(stateHeader);
        expect(binaryHeader.slice(0, 4)).toEqual(STATE_MAGIC_BYTES);
      });

      it('should parse back to same values', async () => {
        const stateHeader = await createStateHeader('test payload');
        const binaryHeader = createBinaryHeader(stateHeader);
        const parsed = parseBinaryHeader(binaryHeader);

        expect(parsed).not.toBeNull();
        expect(parsed!.versionMajor).toBe(1);
        expect(parsed!.versionMinor).toBe(0);
        expect(parsed!.versionPatch).toBe(0);
        expect(parsed!.encoding).toBe(0); // json
        expect(parsed!.compression).toBe(0); // none
      });

      it('should return null for invalid magic bytes', () => {
        const invalidData = new Uint8Array(64);
        invalidData.fill(0);
        const parsed = parseBinaryHeader(invalidData);
        expect(parsed).toBeNull();
      });

      it('should return null for insufficient data', () => {
        const shortData = new Uint8Array(32);
        const parsed = parseBinaryHeader(shortData);
        expect(parsed).toBeNull();
      });
    });

    describe('serializeStateToBinary / deserializeStateFromBinary', () => {
      it('should serialize to binary format', async () => {
        const binary = await serializeStateToBinary(mockConfig, mockRuntimeState);
        expect(binary).toBeInstanceOf(Uint8Array);
        expect(binary.length).toBeGreaterThan(64);
      });

      it('should include magic bytes at start', async () => {
        const binary = await serializeStateToBinary(mockConfig, mockRuntimeState);
        expect(binary.slice(0, 4)).toEqual(STATE_MAGIC_BYTES);
      });

      it('should deserialize back to same state', async () => {
        const binary = await serializeStateToBinary(mockConfig, mockRuntimeState);
        const deserialized = deserializeStateFromBinary(binary);

        expect(deserialized).not.toBeNull();
        expect(deserialized!.agent.name).toBe(mockConfig.name);
        expect(deserialized!.agent.type).toBe(mockConfig.type);
        expect(deserialized!.state.memories).toHaveLength(1);
        expect(deserialized!.state.tasks).toHaveLength(1);
      });

      it('should return null for invalid binary data', () => {
        const invalidData = new Uint8Array([1, 2, 3, 4]);
        const result = deserializeStateFromBinary(invalidData);
        expect(result).toBeNull();
      });
    });
  });

  describe('delta operations', () => {
    let baseState: SerializedStateV1;

    beforeEach(async () => {
      baseState = await createSerializedState(mockConfig, mockRuntimeState);
    });

    describe('createStateDelta', () => {
      it('should detect added memories', async () => {
        const newMemory: Memory = {
          id: 'mem-2',
          type: 'user_preference',
          content: 'new content',
          timestamp: Date.now(),
          importance: 3,
        };
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          memories: [...mockRuntimeState.memories, newMemory],
        });

        const delta = createStateDelta(baseState, newState);
        expect(delta.entries.some((e) => e.operation === 'add' && e.entryType === 'memory')).toBe(
          true
        );
      });

      it('should detect removed memories', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          memories: [],
        });

        const delta = createStateDelta(baseState, newState);
        expect(
          delta.entries.some((e) => e.operation === 'remove' && e.entryType === 'memory')
        ).toBe(true);
      });

      it('should detect added tasks', async () => {
        const newTask: Task = {
          id: 'task-2',
          description: 'New task',
          status: 'pending',
          timestamp: Date.now(),
        };
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          tasks: [...mockRuntimeState.tasks, newTask],
        });

        const delta = createStateDelta(baseState, newState);
        expect(delta.entries.some((e) => e.operation === 'add' && e.entryType === 'task')).toBe(
          true
        );
      });

      it('should detect updated tasks', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          tasks: [{ ...mockTask, status: 'completed' }],
        });

        const delta = createStateDelta(baseState, newState);
        expect(delta.entries.some((e) => e.operation === 'update' && e.entryType === 'task')).toBe(
          true
        );
      });

      it('should detect context changes', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          context: { foo: 'bar', count: 42, newKey: 'newValue' },
        });

        const delta = createStateDelta(baseState, newState);
        expect(delta.entries.some((e) => e.operation === 'add' && e.entryType === 'context')).toBe(
          true
        );
      });

      it('should detect context removals', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          context: { foo: 'bar' }, // removed 'count'
        });

        const delta = createStateDelta(baseState, newState);
        expect(
          delta.entries.some((e) => e.operation === 'remove' && e.entryType === 'context')
        ).toBe(true);
      });

      it('should include base and new state IDs', async () => {
        const newState = await createSerializedState(mockConfig, mockRuntimeState);
        const delta = createStateDelta(baseState, newState);

        expect(delta.baseStateId).toBe(baseState.header.stateId);
        expect(delta.newStateId).toBe(newState.header.stateId);
      });
    });

    describe('applyStateDelta', () => {
      it('should apply add memory delta', async () => {
        const newMemory: Memory = {
          id: 'mem-2',
          type: 'user_preference',
          content: 'new content',
          timestamp: Date.now(),
          importance: 3,
        };
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          memories: [...mockRuntimeState.memories, newMemory],
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.state.memories).toHaveLength(2);
        expect(applied.state.memories.some((m) => m.id === 'mem-2')).toBe(true);
      });

      it('should apply remove memory delta', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          memories: [],
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.state.memories).toHaveLength(0);
      });

      it('should apply task update delta', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          tasks: [{ ...mockTask, status: 'completed' }],
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.state.tasks[0]?.status).toBe('completed');
      });

      it('should apply context add delta', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          context: { foo: 'bar', count: 42, newKey: 'newValue' },
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.state.context['newKey']).toBe('newValue');
      });

      it('should apply context remove delta', async () => {
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          context: { foo: 'bar' },
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.state.context['count']).toBeUndefined();
      });

      it('should update header with delta info', async () => {
        const newState = await createSerializedState(mockConfig, mockRuntimeState);
        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.header.stateId).toBe(delta.newStateId);
        expect(applied.header.previousStateId).toBe(delta.baseStateId);
      });

      it('should update stats after applying delta', async () => {
        const newMemory: Memory = {
          id: 'mem-2',
          type: 'user_preference',
          content: 'new content',
          timestamp: Date.now(),
          importance: 3,
        };
        const newState = await createSerializedState(mockConfig, {
          ...mockRuntimeState,
          memories: [...mockRuntimeState.memories, newMemory],
        });

        const delta = createStateDelta(baseState, newState);
        const applied = applyStateDelta(baseState, delta);

        expect(applied.stats.memoryCount).toBe(2);
      });
    });
  });
});
