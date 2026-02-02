/**
 * Agent Packaging Module
 *
 * Exports all packaging-related functionality.
 */

// Types
export type {
  AgentType,
  AgentConfig,
  PackageOptions,
  PackageResult,
  ValidationError,
  ValidationResult,
  ParsedAgentConfig,
  ConfigFilePath,
} from './types.js';

// Detection
export { detectAgent, detectAgentType, validateSourcePath } from './detector.js';

// Compilation
export {
  compileToWasm,
  generateWasm,
  generateWat,
  generateStateJson,
  validateWasmFile,
} from './compiler.js';

// Serialization
export {
  serializeState,
  deserializeState,
  writeStateFile,
  readStateFile,
  createEmptyState,
  mergeStates,
  validateState,
} from './serializer.js';

export type {
  Memory,
  Task,
  AgentState,
  SerializedAgentState,
  SerializationOptions,
} from './serializer.js';

// State Format (v1.0.0)
export {
  STATE_FORMAT_VERSION,
  STATE_MAGIC_BYTES,
  SCHEMA_URL_PATTERN,
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
} from './state-format.js';

export type {
  StateEncoding,
  StateEntryType,
  StateHeader,
  AgentIdentity,
  SourceMetadata,
  RuntimeState,
  StateStats,
  DeltaOperation,
  DeltaEntry,
  StateDelta,
  SerializedStateV1,
  BinaryStateHeader,
  StateFormatOptions,
  StateValidationResult,
  StateValidationError,
} from './state-format.js';

// Parsers
export {
  parseClawdbotConfig,
  findClawdbotConfigs,
} from './parsers/index.js';

// Config Persistence
export {
  getConfigPath,
  writeAgentConfig,
  readAgentConfig,
  listAgents,
  deleteAgentConfig,
} from './config-persistence.js';

// Config Schemas
export {
  DEFAULT_CLAWDBOT_SETTINGS,
  DEFAULT_GOOSE_CONFIG,
  DEFAULT_CLINE_CONFIG,
} from './config-schemas.js';

// Packager
export {
  packageAgent,
  getPackageSummary,
  validateAgent,
} from './packager.js';

// WASM Compiler
export {
  WasmCompiler,
  compileAgentToWasm,
  validateWasmBinary,
  getSupportedTargets,
  isTargetFullySupported,
} from './wasm-compiler.js';

export type {
  CompilationTarget,
  WasmCompilationOptions,
  WasmMemoryConfig,
  WasmCompilationResult,
  WasmCompilationMetadata,
} from './wasm-compiler.js';
