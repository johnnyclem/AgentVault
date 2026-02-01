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
} from './types.js';

// Detection
export { detectAgent, detectAgentType, validateSourcePath } from './detector.js';

// Compilation
export {
  compileToWasm,
  generateStubWasm,
  generateStubWat,
  generateStateJson,
  validateWasmFile,
} from './compiler.js';

// Packager
export { packageAgent, validateAgent, getPackageSummary } from './packager.js';
