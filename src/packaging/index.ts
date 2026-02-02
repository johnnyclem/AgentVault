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

// Parsers
export {
  parseClawdbotConfig,
  findClawdbotConfigs,
} from './parsers/index.js';

import type {
  AgentType,
  AgentConfig,
  PackageOptions,
  PackageResult,
  ValidationError,
  ValidationResult,
} from './types.js';

import {
  compileToWasm,
  generateWasm,
  generateWat,
  generateStateJson,
  validateWasmFile,
} from './compiler.js';

import {
  serializeState,
  deserializeState,
  writeStateFile,
  readStateFile,
  createEmptyState,
  mergeStates,
  validateState,
} from './serializer.js';

import {
  parseClawdbotConfig,
  findClawdbotConfigs,
} from './parsers/index.js';

import {
  getConfigPath,
  writeAgentConfig,
  readAgentConfig,
  listAgents,
  deleteAgentConfig,
} from './config-persistence.js';

import {
  DEFAULT_CLAWDBOT_SETTINGS,
  DEFAULT_GOOSE_CONFIG,
  DEFAULT_CLINE_CONFIG,
} from './config-schemas.js';

import { detectAgent, detectAgentType, validateSourcePath } from './detector.js';

export type { AgentType, AgentConfig, PackageOptions, PackageResult };
export type { ValidationError, ValidationResult, ParsedAgentConfig, ConfigFilePath };
export {
  compileToWasm,
  generateWasm,
  generateWat,
  generateStateJson,
  validateWasmFile,
};
export {
  serializeState,
  deserializeState,
  writeStateFile,
  readStateFile,
  createEmptyState,
  mergeStates,
  validateState,
};
export { parseClawdbotConfig, findClawdbotConfigs, getConfigPath, writeAgentConfig, readAgentConfig, listAgents, deleteAgentConfig };
export { DEFAULT_CLAWDBOT_SETTINGS, DEFAULT_GOOSE_CONFIG, DEFAULT_CLINE_CONFIG };

// Parsers
export {
  parseClawdbotConfig,
  findClawdbotConfigs,
} from './parsers/index.js';

// Config Schemas
export {
  DEFAULT_CLAWDBOT_SETTINGS,
  DEFAULT_GOOSE_CONFIG,
  DEFAULT_CLINE_CONFIG,
} from './config-schemas.js';

export type {
  Memory,
  Task,
  AgentState,
  SerializedAgentState,
  SerializationOptions,
} from './serializer.js';
