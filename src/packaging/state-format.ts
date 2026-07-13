/**
 * State Serialization Format
 *
 * This module defines the canonical state serialization format for AgentVault.
 * It supports versioning, integrity verification, and efficient storage in ICP canisters.
 *
 * Design Goals:
 * - Deterministic serialization for reproducible builds
 * - Schema versioning for forward/backward compatibility
 * - Integrity verification via checksums
 * - Efficient binary encoding for canister storage
 * - Support for incremental state updates (deltas)
 */

import type { AgentConfig, AgentType } from './types.js';
import type { Memory, Task } from './serializer.js';

/**
 * Current format version following semver
 * Major: Breaking changes to format structure
 * Minor: Backward-compatible additions
 * Patch: Bug fixes in serialization logic
 */
export const STATE_FORMAT_VERSION = '1.0.0';

/**
 * Schema URL pattern for JSON Schema validation
 */
export const SCHEMA_URL_PATTERN = 'https://agentvault.dev/schemas/state-v{version}.json';

/**
 * Magic bytes to identify AgentVault state files
 * "AVST" in ASCII (AgentVault STate)
 */
export const STATE_MAGIC_BYTES = new Uint8Array([0x41, 0x56, 0x53, 0x54]);

/**
 * Supported encoding formats for state data
 */
export type StateEncoding = 'json' | 'cbor' | 'msgpack';

/**
 * State entry types for typed state data
 */
export type StateEntryType =
  | 'memory'
  | 'task'
  | 'context'
  | 'config'
  | 'checkpoint'
  | 'custom';

/**
 * State header containing metadata about the serialized state
 */
export interface StateHeader {
  /** Format version (semver) */
  version: string;
  /** Schema URL for validation */
  schema: string;
  /** Encoding format used for the payload */
  encoding: StateEncoding;
  /** SHA-256 checksum of the payload (hex) */
  checksum: string;
  /** Timestamp of serialization (ISO 8601) */
  timestamp: string;
  /** Unique state ID for tracking */
  stateId: string;
  /** Previous state ID for delta chains (optional) */
  previousStateId?: string;
  /** Compression algorithm used (optional) */
  compression?: 'none' | 'gzip' | 'lz4';
  /** Original size before compression (bytes) */
  originalSize: number;
  /** Compressed size (bytes, same as originalSize if no compression) */
  compressedSize: number;
}

/**
 * Agent identity information
 */
export interface AgentIdentity {
  /** Agent name */
  name: string;
  /** Agent type */
  type: AgentType;
  /** Agent version */
  version: string;
  /** Unique agent ID (derived from name and type) */
  agentId: string;
  /** Optional description */
  description?: string;
}

/**
 * Source metadata for reconstruction
 */
export interface SourceMetadata {
  /** Original source path */
  sourcePath: string;
  /** Entry point file */
  entryPoint?: string;
  /** Source files hash for verification */
  sourceHash?: string;
  /** Git commit hash if available */
  gitCommit?: string;
  /** Git branch if available */
  gitBranch?: string;
}

/**
 * Runtime state data
 */
export interface RuntimeState {
  /** Whether the agent has been initialized */
  initialized: boolean;
  /** Agent memories */
  memories: Memory[];
  /** Agent task queue */
  tasks: Task[];
  /** Runtime context key-value pairs */
  context: Record<string, unknown>;
  /** Custom state extensions */
  extensions?: Record<string, unknown>;
}

/**
 * State statistics for monitoring
 */
export interface StateStats {
  /** Total number of memories */
  memoryCount: number;
  /** Total number of tasks */
  taskCount: number;
  /** Number of completed tasks */
  completedTaskCount: number;
  /** Number of context entries */
  contextEntryCount: number;
  /** Total state size in bytes */
  totalSize: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last modification timestamp */
  lastModifiedAt: string;
}

/**
 * Delta operation types for incremental updates
 */
export type DeltaOperation = 'add' | 'update' | 'remove';

/**
 * Delta entry for incremental state updates
 */
export interface DeltaEntry {
  /** Type of operation */
  operation: DeltaOperation;
  /** Path to the changed field (dot notation) */
  path: string;
  /** Entry type being modified */
  entryType: StateEntryType;
  /** New value (for add/update) */
  value?: unknown;
  /** Previous value (for update/remove) */
  previousValue?: unknown;
  /** Timestamp of the change */
  timestamp: string;
}

/**
 * Delta state for incremental updates
 */
export interface StateDelta {
  /** Base state ID this delta applies to */
  baseStateId: string;
  /** New state ID after applying delta */
  newStateId: string;
  /** List of changes */
  entries: DeltaEntry[];
  /** Timestamp of delta creation */
  timestamp: string;
}

/**
 * Complete serialized state format (JSON representation)
 */
export interface SerializedStateV1 {
  /** State header with metadata */
  header: StateHeader;
  /** Agent identity */
  agent: AgentIdentity;
  /** Source metadata for reconstruction */
  source: SourceMetadata;
  /** Runtime state data */
  state: RuntimeState;
  /** Statistics about the state */
  stats: StateStats;
}

/**
 * Binary state format header (fixed 64 bytes)
 * Used for canister storage optimization
 */
export interface BinaryStateHeader {
  /** Magic bytes (4 bytes) */
  magic: Uint8Array;
  /** Version major (2 bytes) */
  versionMajor: number;
  /** Version minor (2 bytes) */
  versionMinor: number;
  /** Version patch (2 bytes) */
  versionPatch: number;
  /** Encoding type (1 byte): 0=json, 1=cbor, 2=msgpack */
  encoding: number;
  /** Compression type (1 byte): 0=none, 1=gzip, 2=lz4 */
  compression: number;
  /** Flags (4 bytes): bit flags for options */
  flags: number;
  /** Checksum (32 bytes): SHA-256 of payload */
  checksum: Uint8Array;
  /** Payload size (8 bytes): uint64 */
  payloadSize: bigint;
  /** Reserved (8 bytes): for future use */
  reserved: Uint8Array;
}

/**
 * State format options for serialization
 */
export interface StateFormatOptions {
  /** Encoding format (default: 'json') */
  encoding?: StateEncoding;
  /** Compression algorithm (default: 'none') */
  compression?: 'none' | 'gzip' | 'lz4';
  /** Pretty print JSON (default: false for efficiency) */
  prettyPrint?: boolean;
  /** Include statistics (default: true) */
  includeStats?: boolean;
  /** Include source metadata (default: true) */
  includeSource?: boolean;
  /** Generate delta from previous state */
  previousState?: SerializedStateV1;
}

/**
 * State validation result
 */
export interface StateValidationResult {
  /** Whether the state is valid */
  valid: boolean;
  /** Validation errors */
  errors: StateValidationError[];
  /** Validation warnings */
  warnings: string[];
  /** Checksum verified */
  checksumValid: boolean;
  /** Version compatible */
  versionCompatible: boolean;
}

/**
 * State validation error
 */
export interface StateValidationError {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Path to the invalid field */
  path?: string;
  /** Expected value or type */
  expected?: string;
  /** Actual value or type */
  actual?: string;
}

/**
 * Generate a unique state ID
 */
export function generateStateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `state_${timestamp}_${random}`;
}

/**
 * Generate an agent ID from name and type
 */
export function generateAgentId(name: string, type: AgentType): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `${type}_${normalized}`;
}

/**
 * Parse version string into components
 */
export function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const parts = version.split('.');
  return {
    major: parseInt(parts[0] || '1', 10),
    minor: parseInt(parts[1] || '0', 10),
    patch: parseInt(parts[2] || '0', 10),
  };
}

/**
 * Check if a version is compatible with the current format
 * Compatible if major version matches and minor version is <= current
 */
export function isVersionCompatible(version: string): boolean {
  const current = parseVersion(STATE_FORMAT_VERSION);
  const target = parseVersion(version);

  // Major version must match
  if (target.major !== current.major) {
    return false;
  }

  // Minor version must be <= current (forward compatible)
  if (target.minor > current.minor) {
    return false;
  }

  return true;
}

/**
 * Calculate SHA-256 checksum of data
 */
export async function calculateChecksum(data: string | Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = typeof data === 'string' ? encoder.encode(data) : data;

  // Use Web Crypto API if available, otherwise return placeholder
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback for environments without crypto.subtle (Node.js)
  try {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return hash.digest('hex');
  } catch {
    // Last resort fallback - simple hash for testing
    let hash = 0;
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(64, '0');
  }
}

/**
 * Create state header
 */
export async function createStateHeader(
  payload: string,
  options: StateFormatOptions = {}
): Promise<StateHeader> {
  const encoding = options.encoding ?? 'json';
  const compression = options.compression ?? 'none';
  const checksum = await calculateChecksum(payload);

  return {
    version: STATE_FORMAT_VERSION,
    schema: SCHEMA_URL_PATTERN.replace('{version}', STATE_FORMAT_VERSION),
    encoding,
    checksum,
    timestamp: new Date().toISOString(),
    stateId: generateStateId(),
    previousStateId: options.previousState?.header.stateId,
    compression,
    originalSize: new TextEncoder().encode(payload).length,
    compressedSize: new TextEncoder().encode(payload).length, // Same when no compression
  };
}

/**
 * Create agent identity from config
 */
export function createAgentIdentity(config: AgentConfig): AgentIdentity {
  return {
    name: config.name,
    type: config.type,
    version: config.version ?? '1.0.0',
    agentId: generateAgentId(config.name, config.type),
    description: undefined,
  };
}

/**
 * Create source metadata from config
 */
export function createSourceMetadata(config: AgentConfig): SourceMetadata {
  return {
    sourcePath: config.sourcePath,
    entryPoint: config.entryPoint,
    sourceHash: undefined,
    gitCommit: undefined,
    gitBranch: undefined,
  };
}

/**
 * Calculate state statistics
 */
export function calculateStateStats(state: RuntimeState): StateStats {
  const now = new Date().toISOString();
  const completedTasks = state.tasks.filter((t) => t.status === 'completed').length;
  const contextEntryCount = Object.keys(state.context).length;

  // Estimate size (rough calculation)
  const estimatedSize =
    JSON.stringify(state.memories).length +
    JSON.stringify(state.tasks).length +
    JSON.stringify(state.context).length;

  return {
    memoryCount: state.memories.length,
    taskCount: state.tasks.length,
    completedTaskCount: completedTasks,
    contextEntryCount,
    totalSize: estimatedSize,
    createdAt: now,
    lastModifiedAt: now,
  };
}

/**
 * Create a serialized state object
 */
export async function createSerializedState(
  config: AgentConfig,
  runtimeState: RuntimeState,
  options: StateFormatOptions = {}
): Promise<SerializedStateV1> {
  const agent = createAgentIdentity(config);
  const source = options.includeSource !== false ? createSourceMetadata(config) : {
    sourcePath: config.sourcePath,
  };
  const stats = options.includeStats !== false ? calculateStateStats(runtimeState) : {
    memoryCount: 0,
    taskCount: 0,
    completedTaskCount: 0,
    contextEntryCount: 0,
    totalSize: 0,
    createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
  };

  // Create a temporary payload to calculate checksum
  const tempPayload = JSON.stringify({
    agent,
    source,
    state: runtimeState,
    stats,
  });

  const header = await createStateHeader(tempPayload, options);

  return {
    header,
    agent,
    source,
    state: runtimeState,
    stats,
  };
}

/**
 * Serialize state to JSON string
 */
export async function serializeStateToJson(
  config: AgentConfig,
  runtimeState: RuntimeState,
  options: StateFormatOptions = {}
): Promise<string> {
  const serialized = await createSerializedState(config, runtimeState, options);
  return JSON.stringify(serialized, null, options.prettyPrint ? 2 : 0);
}

/**
 * Deserialize state from JSON string
 */
export function deserializeStateFromJson(json: string): SerializedStateV1 {
  const parsed = JSON.parse(json) as SerializedStateV1;
  return parsed;
}

/**
 * Validate a serialized state
 */
export async function validateSerializedState(
  state: SerializedStateV1
): Promise<StateValidationResult> {
  const errors: StateValidationError[] = [];
  const warnings: string[] = [];

  // Check version compatibility
  const versionCompatible = isVersionCompatible(state.header.version);
  if (!versionCompatible) {
    errors.push({
      code: 'VERSION_INCOMPATIBLE',
      message: `State version ${state.header.version} is not compatible with format version ${STATE_FORMAT_VERSION}`,
      expected: STATE_FORMAT_VERSION,
      actual: state.header.version,
    });
  }

  // Verify checksum
  const payload = JSON.stringify({
    agent: state.agent,
    source: state.source,
    state: state.state,
    stats: state.stats,
  });
  const calculatedChecksum = await calculateChecksum(payload);
  const checksumValid = calculatedChecksum === state.header.checksum;
  if (!checksumValid) {
    errors.push({
      code: 'CHECKSUM_MISMATCH',
      message: 'State checksum does not match calculated checksum',
      expected: state.header.checksum,
      actual: calculatedChecksum,
    });
  }

  // Validate required fields
  if (!state.header.stateId) {
    errors.push({
      code: 'MISSING_STATE_ID',
      message: 'State ID is required',
      path: 'header.stateId',
    });
  }

  if (!state.agent.name) {
    errors.push({
      code: 'MISSING_AGENT_NAME',
      message: 'Agent name is required',
      path: 'agent.name',
    });
  }

  if (!state.agent.type) {
    errors.push({
      code: 'MISSING_AGENT_TYPE',
      message: 'Agent type is required',
      path: 'agent.type',
    });
  }

  // Validate agent type
  const validTypes: AgentType[] = ['clawdbot', 'goose', 'cline', 'generic'];
  if (!validTypes.includes(state.agent.type)) {
    errors.push({
      code: 'INVALID_AGENT_TYPE',
      message: `Invalid agent type: ${state.agent.type}`,
      path: 'agent.type',
      expected: validTypes.join(', '),
      actual: state.agent.type,
    });
  }

  // Validate memories
  for (let i = 0; i < state.state.memories.length; i++) {
    const memory = state.state.memories[i];
    if (memory && !memory.id) {
      errors.push({
        code: 'MISSING_MEMORY_ID',
        message: `Memory at index ${i} is missing an ID`,
        path: `state.memories[${i}].id`,
      });
    }
  }

  // Validate tasks
  for (let i = 0; i < state.state.tasks.length; i++) {
    const task = state.state.tasks[i];
    if (task && !task.id) {
      errors.push({
        code: 'MISSING_TASK_ID',
        message: `Task at index ${i} is missing an ID`,
        path: `state.tasks[${i}].id`,
      });
    }
    const validStatuses = ['pending', 'running', 'completed', 'failed'];
    if (task && !validStatuses.includes(task.status)) {
      errors.push({
        code: 'INVALID_TASK_STATUS',
        message: `Task at index ${i} has invalid status: ${task.status}`,
        path: `state.tasks[${i}].status`,
        expected: validStatuses.join(', '),
        actual: task.status,
      });
    }
  }

  // Add warnings for optional missing data
  if (!state.source.sourceHash) {
    warnings.push('Source hash not provided - cannot verify source integrity');
  }

  if (state.state.memories.length === 0 && state.state.tasks.length === 0) {
    warnings.push('State has no memories or tasks - agent may not be initialized');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checksumValid,
    versionCompatible,
  };
}

/**
 * Create binary state header (64 bytes fixed size)
 */
export function createBinaryHeader(header: StateHeader): Uint8Array {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  const array = new Uint8Array(buffer);

  // Magic bytes (offset 0, 4 bytes)
  array.set(STATE_MAGIC_BYTES, 0);

  // Version (offset 4, 6 bytes)
  const version = parseVersion(header.version);
  view.setUint16(4, version.major, false); // big-endian
  view.setUint16(6, version.minor, false);
  view.setUint16(8, version.patch, false);

  // Encoding (offset 10, 1 byte)
  const encodingMap: Record<StateEncoding, number> = {
    json: 0,
    cbor: 1,
    msgpack: 2,
  };
  view.setUint8(10, encodingMap[header.encoding]);

  // Compression (offset 11, 1 byte)
  const compressionMap: Record<string, number> = {
    none: 0,
    gzip: 1,
    lz4: 2,
  };
  const compressionType = header.compression ?? 'none';
  view.setUint8(11, compressionMap[compressionType] ?? 0);

  // Flags (offset 12, 4 bytes)
  view.setUint32(12, 0, false); // Reserved for future flags

  // Checksum (offset 16, 32 bytes)
  const checksumBytes = new Uint8Array(32);
  for (let i = 0; i < 32 && i * 2 < header.checksum.length; i++) {
    checksumBytes[i] = parseInt(header.checksum.substring(i * 2, i * 2 + 2), 16);
  }
  array.set(checksumBytes, 16);

  // Payload size (offset 48, 8 bytes)
  view.setBigUint64(48, BigInt(header.compressedSize), false);

  // Reserved (offset 56, 8 bytes) - zero filled by default

  return array;
}

/**
 * Parse binary state header (64 bytes)
 */
export function parseBinaryHeader(data: Uint8Array): BinaryStateHeader | null {
  if (data.length < 64) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, 64);

  // Verify magic bytes
  const magic = data.slice(0, 4);
  if (!magic.every((b, i) => b === STATE_MAGIC_BYTES[i])) {
    return null;
  }

  return {
    magic,
    versionMajor: view.getUint16(4, false),
    versionMinor: view.getUint16(6, false),
    versionPatch: view.getUint16(8, false),
    encoding: view.getUint8(10),
    compression: view.getUint8(11),
    flags: view.getUint32(12, false),
    checksum: data.slice(16, 48),
    payloadSize: view.getBigUint64(48, false),
    reserved: data.slice(56, 64),
  };
}

/**
 * Serialize state to binary format (header + JSON payload)
 */
export async function serializeStateToBinary(
  config: AgentConfig,
  runtimeState: RuntimeState,
  options: StateFormatOptions = {}
): Promise<Uint8Array> {
  const serialized = await createSerializedState(config, runtimeState, options);
  const jsonPayload = JSON.stringify(serialized);
  const payloadBytes = new TextEncoder().encode(jsonPayload);

  // Update header with actual payload size for binary serialization
  const headerWithSize: StateHeader = {
    ...serialized.header,
    originalSize: payloadBytes.length,
    compressedSize: payloadBytes.length,
  };
  const header = createBinaryHeader(headerWithSize);

  // Combine header and payload
  const result = new Uint8Array(64 + payloadBytes.length);
  result.set(header, 0);
  result.set(payloadBytes, 64);

  return result;
}

/**
 * Deserialize state from binary format
 */
export function deserializeStateFromBinary(data: Uint8Array): SerializedStateV1 | null {
  const header = parseBinaryHeader(data);
  if (!header) {
    return null;
  }

  const payloadStart = 64;
  const payloadEnd = payloadStart + Number(header.payloadSize);
  const payloadBytes = data.slice(payloadStart, payloadEnd);
  const jsonPayload = new TextDecoder().decode(payloadBytes);

  return JSON.parse(jsonPayload) as SerializedStateV1;
}

/**
 * Create a delta between two states
 */
export function createStateDelta(
  oldState: SerializedStateV1,
  newState: SerializedStateV1
): StateDelta {
  const entries: DeltaEntry[] = [];
  const timestamp = new Date().toISOString();

  // Compare memories
  const oldMemoryIds = new Set(oldState.state.memories.map((m) => m.id));
  const newMemoryIds = new Set(newState.state.memories.map((m) => m.id));

  // Added memories
  for (const memory of newState.state.memories) {
    if (!oldMemoryIds.has(memory.id)) {
      entries.push({
        operation: 'add',
        path: `state.memories.${memory.id}`,
        entryType: 'memory',
        value: memory,
        timestamp,
      });
    }
  }

  // Removed memories
  for (const memory of oldState.state.memories) {
    if (!newMemoryIds.has(memory.id)) {
      entries.push({
        operation: 'remove',
        path: `state.memories.${memory.id}`,
        entryType: 'memory',
        previousValue: memory,
        timestamp,
      });
    }
  }

  // Compare tasks
  const oldTaskIds = new Set(oldState.state.tasks.map((t) => t.id));
  const newTaskIds = new Set(newState.state.tasks.map((t) => t.id));

  // Added tasks
  for (const task of newState.state.tasks) {
    if (!oldTaskIds.has(task.id)) {
      entries.push({
        operation: 'add',
        path: `state.tasks.${task.id}`,
        entryType: 'task',
        value: task,
        timestamp,
      });
    }
  }

  // Removed tasks
  for (const task of oldState.state.tasks) {
    if (!newTaskIds.has(task.id)) {
      entries.push({
        operation: 'remove',
        path: `state.tasks.${task.id}`,
        entryType: 'task',
        previousValue: task,
        timestamp,
      });
    }
  }

  // Updated tasks (status changes)
  for (const newTask of newState.state.tasks) {
    const oldTask = oldState.state.tasks.find((t) => t.id === newTask.id);
    if (oldTask && JSON.stringify(oldTask) !== JSON.stringify(newTask)) {
      entries.push({
        operation: 'update',
        path: `state.tasks.${newTask.id}`,
        entryType: 'task',
        value: newTask,
        previousValue: oldTask,
        timestamp,
      });
    }
  }

  // Compare context
  const oldContextKeys = new Set(Object.keys(oldState.state.context));
  const newContextKeys = new Set(Object.keys(newState.state.context));

  for (const key of newContextKeys) {
    if (!oldContextKeys.has(key)) {
      entries.push({
        operation: 'add',
        path: `state.context.${key}`,
        entryType: 'context',
        value: newState.state.context[key],
        timestamp,
      });
    } else if (
      JSON.stringify(oldState.state.context[key]) !==
      JSON.stringify(newState.state.context[key])
    ) {
      entries.push({
        operation: 'update',
        path: `state.context.${key}`,
        entryType: 'context',
        value: newState.state.context[key],
        previousValue: oldState.state.context[key],
        timestamp,
      });
    }
  }

  for (const key of oldContextKeys) {
    if (!newContextKeys.has(key)) {
      entries.push({
        operation: 'remove',
        path: `state.context.${key}`,
        entryType: 'context',
        previousValue: oldState.state.context[key],
        timestamp,
      });
    }
  }

  return {
    baseStateId: oldState.header.stateId,
    newStateId: newState.header.stateId,
    entries,
    timestamp,
  };
}

/**
 * Apply a delta to a state
 */
export function applyStateDelta(
  baseState: SerializedStateV1,
  delta: StateDelta
): SerializedStateV1 {
  // Deep clone the base state
  const newState: SerializedStateV1 = JSON.parse(JSON.stringify(baseState));

  // Update header
  newState.header.stateId = delta.newStateId;
  newState.header.previousStateId = delta.baseStateId;
  newState.header.timestamp = delta.timestamp;

  for (const entry of delta.entries) {
    switch (entry.entryType) {
      case 'memory':
        if (entry.operation === 'add') {
          newState.state.memories.push(entry.value as Memory);
        } else if (entry.operation === 'remove') {
          const memoryId = entry.path.split('.').pop();
          newState.state.memories = newState.state.memories.filter(
            (m) => m.id !== memoryId
          );
        }
        break;

      case 'task':
        if (entry.operation === 'add') {
          newState.state.tasks.push(entry.value as Task);
        } else if (entry.operation === 'remove') {
          const taskId = entry.path.split('.').pop();
          newState.state.tasks = newState.state.tasks.filter(
            (t) => t.id !== taskId
          );
        } else if (entry.operation === 'update') {
          const updateTaskId = entry.path.split('.').pop();
          const index = newState.state.tasks.findIndex(
            (t) => t.id === updateTaskId
          );
          if (index !== -1) {
            newState.state.tasks[index] = entry.value as Task;
          }
        }
        break;

      case 'context': {
        const contextKey = entry.path.split('.').pop()!;
        if (entry.operation === 'add' || entry.operation === 'update') {
          newState.state.context[contextKey] = entry.value;
        } else if (entry.operation === 'remove') {
          delete newState.state.context[contextKey];
        }
        break;
      }
    }
  }

  // Update stats
  newState.stats = calculateStateStats(newState.state);

  return newState;
}
