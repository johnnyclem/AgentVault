/**
 * Types for agent packaging
 */

/**
 * Supported agent types that can be packaged
 */
export type AgentType = 'clawdbot' | 'goose' | 'cline' | 'generic';

/**
 * Agent configuration as detected from the source directory
 */
export interface AgentConfig {
  /** Name of the agent */
  name: string;
  /** Detected agent type */
  type: AgentType;
  /** Source directory path */
  sourcePath: string;
  /** Entry point file (if detected) */
  entryPoint?: string;
  /** Agent version (if detected) */
  version?: string;
}

/**
 * Options for the packaging process
 */
export interface PackageOptions {
  /** Source directory containing the agent */
  sourcePath: string;
  /** Output directory for compiled artifacts */
  outputPath?: string;
  /** Force overwrite of existing output files */
  force?: boolean;
  /** Skip validation steps */
  skipValidation?: boolean;
}

/**
 * Result of a successful packaging operation
 */
export interface PackageResult {
  /** Detected agent configuration */
  config: AgentConfig;
  /** Path to the generated WASM file */
  wasmPath: string;
  /** Path to the generated WAT file (WebAssembly Text format) */
  watPath: string;
  /** Path to the serialized state JSON */
  statePath: string;
  /** Size of the WASM file in bytes */
  wasmSize: number;
  /** Timestamp of the packaging operation */
  timestamp: Date;
}

/**
 * Validation error that occurred during packaging
 */
export interface ValidationError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** File path related to the error (if applicable) */
  filePath?: string;
}

/**
 * Result of agent validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors (if any) */
  errors: ValidationError[];
  /** List of validation warnings */
  warnings: string[];
}
