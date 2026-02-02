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
