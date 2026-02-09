/**
 * Types for ICP tool integration (ic-wasm, icp-cli)
 *
 * Provides TypeScript interfaces for all external tool operations.
 */

// ─── Tool Detection ────────────────────────────────────────────────────────

/** Names of external tools that can be detected */
export type ToolName = 'ic-wasm' | 'icp' | 'dfx';

/** Result of detecting a single tool */
export interface ToolInfo {
  /** Tool name */
  name: ToolName;
  /** Whether the tool is installed and reachable */
  available: boolean;
  /** Absolute path to the binary (if found) */
  path?: string;
  /** Semver version string (if available) */
  version?: string;
}

/** Combined detection result for all tools */
export interface ToolchainStatus {
  icWasm: ToolInfo;
  icp: ToolInfo;
  dfx: ToolInfo;
  /** Preferred deployment tool based on availability */
  preferredDeployTool: 'icp' | 'dfx' | null;
  /** Whether ic-wasm optimization is available */
  canOptimize: boolean;
}

// ─── ic-wasm Types ─────────────────────────────────────────────────────────

/** Optimization level for ic-wasm optimize (maps to wasm-opt levels) */
export type IcWasmOptLevel = 'O0' | 'O1' | 'O2' | 'O3' | 'O4' | 'Os' | 'Oz';

/** Options for ic-wasm optimize command */
export interface IcWasmOptimizeOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
  /** Optimization level */
  level?: IcWasmOptLevel;
}

/** Options for ic-wasm shrink command */
export interface IcWasmShrinkOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
}

/** Options for ic-wasm resource command */
export interface IcWasmResourceOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
  /** Resource limit name */
  name: string;
  /** Resource limit value */
  value: string;
}

/** Metadata visibility */
export type MetadataVisibility = 'public' | 'private';

/** Options for ic-wasm metadata command */
export interface IcWasmMetadataOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path (for set operations, file data via -d) */
  output?: string;
  /** Metadata key name */
  name: string;
  /** Metadata value (for set operations, string data via -d) */
  data?: string;
  /** Metadata file path (for set operations, file data via -f) */
  file?: string;
  /** Metadata visibility */
  visibility?: MetadataVisibility;
}

/** Options for ic-wasm check-endpoints command */
export interface IcWasmCheckEndpointsOptions {
  /** Input WASM file path */
  input: string;
  /** Path to Candid .did interface file */
  candidInterface: string;
}

/** Options for ic-wasm instrument command */
export interface IcWasmInstrumentOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
}

/** Result of an ic-wasm command execution */
export interface IcWasmResult {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/** Result of an ic-wasm info command */
export interface IcWasmInfo {
  /** Raw info output text */
  raw: string;
  /** Parsed sections (best effort) */
  sections?: Record<string, string>;
}

// ─── icp-cli Types ────────────────────────────────────────────────────

/** Environment name for icp-cli */
export type IcpEnvironment = 'local' | 'ic' | string;

/** Deploy mode for icp deploy */
export type IcpDeployMode = 'auto' | 'install' | 'reinstall' | 'upgrade';

/**
 * Result of an icp-cli command execution
 */
export interface IcpCliResult {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Result of an ic-wasm command execution
 */
export interface IcWasmResult {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

/**
 * Options for icp build command */
export interface IcpBuildOptions extends IcpCommonOptions {
  /** Canister names to build (omit for all) */
  canisters?: string[];
}

/**
 * Options for icp deploy command */
export interface IcpDeployOptions extends IcpCommonOptions {
  /** Deploy mode */
  mode?: IcpDeployMode;
  /** Canister names to deploy (omit for all) */
  canisters?: string[];
}

/**
 * Options for icp canister status */
export interface IcpCanisterStatusOptions extends IcpCommonOptions {
  /** Canister ID or name */
  canister: string;
}

/**
 * Options for icp canister call */
export interface IcpCanisterCallOptions extends IcpCommonOptions {
  /** Canister ID or name */
  canister: string;
  /** Method name */
  method: string;
  /** Arguments (Candid text format) */
  args?: string;
}

/**
 * Options for icp canister list */
export interface IcpCommonOptions {}

/**
 * Result of an icp-cli command execution */
export interface IcpCliResult {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Exit code */
  exitCode: number;
}

// ─── Optimization Types ─────────────────────────────────────────────────────

/** Options for ic-wasm shrink command */
export interface IcWasmShrinkOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
}

/** Options for ic-wasm resource command */
export interface IcWasmResourceOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
  /** Resource limit name */
  name: string;
  /** Resource limit value */
  value: string;
}

/** Combined optimization pipeline options */
export interface IcWasmOptimizeOptions {}

/** Result of an optimization operation with metrics */
export interface IcWasmOptimizationResult {
  /** Whether optimization succeeded */
  success: boolean;
  /** Path to the optimized WASM */
  outputPath: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Optimized file size in bytes */
  optimizedSize: number;
  /** Size reduction as a percentage (0-100) */
  reductionPercent: number;
  /** Duration of the optimization in milliseconds */
  durationMs: number;
  /** Any warnings from the tool */
  warnings: string[];
}

/** Combined optimization pipeline options */
export interface IcWasmOptimizationPipelineOptions {
  /** Input WASM file path */
  input: string;
  /** Output WASM file path */
  output: string;
  /** Run ic-wasm optimize (default true if ic-wasm available) */
  optimize?: boolean;
  /** Optimization level for wasm-opt (0-3, Os, Oz) */
  optimizeLevel?: IcWasmOptLevel;
  /** Run ic-wasm shrink (default true) */
  shrink?: boolean;
  /** Set resource limits */
  resourceLimits?: Record<string, string>;
  /** Validate against Candid interface */
  candidInterface?: string;
  /** Inject metadata */
  metadata?: Array<{ name: string; data: string; visibility?: MetadataVisibility }>;
}

/** Result of the full optimization pipeline */
export interface IcWasmOptimizationPipelineResult {
  /** Whether the entire pipeline succeeded */
  success: boolean;
  /** Path to the final optimized WASM */
  outputPath: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Final file size in bytes */
  finalSize: number;
  /** Size reduction as a percentage (0-100) */
  reductionPercent: number;
  /** Total duration in milliseconds */
  totalDurationMs: number;
  /** Per-step results */
  steps: Array<{
    step: string;
    success: boolean;
    durationMs: number;
    sizeAfter?: number;
    error?: string;
  }>;
  /** Validation result (if Candid interface was provided) */
  validationPassed?: boolean;
  /** Collected warnings */
  warnings: string[];
}

// ─── Cycles Types ─────────────────────────────────────────────────────────────

/** Options for icp cycles balance */
export interface IcpCyclesBalanceOptions extends IcpCommonOptions {
  /** Canister ID or name */
  canister: string;
}

/** Options for icp cycles mint */
export interface IcpCyclesMintOptions extends IcpCommonOptions {
  /** Amount to mint */
  amount: string;
}

/** Options for icp cycles transfer */
export interface IcpCyclesTransferOptions extends IcpCommonOptions {
  /** Amount to transfer */
  amount: string;
  /** Recipient principal or canister ID */
  to: string;
}

// ─── Token Types ─────────────────────────────────────────────────────────────

/** Options for icp token balance */
export interface IcpTokenBalanceOptions extends IcpCommonOptions {
  /** Token canister ID */
  canister: string;
}

/** Options for icp token transfer */
export interface IcpTokenTransferOptions extends IcpCommonOptions {
  /** Amount to transfer */
  amount: string;
  /** Recipient principal or account */
  to: string;
}

// ─── Identity Types ─────────────────────────────────────────────────────────────

/** Options for icp identity list */
export interface IcpIdentityListOptions extends IcpCommonOptions {}

/** Options for icp identity new */
export interface IcpIdentityNewOptions extends IcpCommonOptions {
  /** Identity name */
  name?: string;
}

/** Options for icp identity export */
export interface IcpIdentityExportOptions extends IcpCommonOptions {
  /** Identity name */
  name?: string;
  /** Output PEM file path */
  output?: string;
}

/** Options for icp identity import */
export interface IcpIdentityImportOptions extends IcpCommonOptions {
  /** Identity name */
  name?: string;
  /** PEM file path */
  pemFile?: string;
}

// ─── Network Types ─────────────────────────────────────────────────────────────

/** Options for icp network start */
export interface IcpNetworkStartOptions extends IcpCommonOptions {
  /** Network name */
  network?: string;
}

/** Options for icp network stop */
export interface IcpNetworkStopOptions extends IcpCommonOptions {
  /** Network name */
  network?: string;
}

// ─── Sync Types ─────────────────────────────────────────────────────────────

/** Options for icp sync */
export interface IcpSyncOptions extends IcpCommonOptions {
  /** Network name */
  network?: string;
}

// ─── Environment Types ─────────────────────────────────────────────────────

/** Options for icp environment list */
export interface IcpEnvironmentListOptions extends IcpCommonOptions {}

// ─── Network Config ─────────────────────────────────────────────────────────────

/** Network configuration for deployment */
export interface IcpNetworkConfig {
  /** Network name (local, ic, staging) */
  name: string;
  /** Network URL */
  url: string;
  /** Whether this is a local network */
  isLocal: boolean;
  /** Cycles wallet principal (if any) */
  walletPrincipal?: string;
}

// ─── Cycles Config ─────────────────────────────────────────────────────────────

/** Cycles configuration for a project */
export interface IcpCyclesConfig {
  /** Minimum cycles to maintain */
  minCycles?: bigint;
  /** Top-up amount when cycles fall below minimum */
  topUpAmount?: bigint;
  /** Whether to automatically top up */
  autoTopUp?: boolean;
}

// ─── Environment Config ─────────────────────────────────────────────────────

/** Environment configuration */
export interface IcpEnvironmentConfig {
  /** Environment name */
  name: string;
  /** Network to use */
  network: string;
  /** Cycles configuration */
  cycles?: IcpCyclesConfig;
  /** Optimization configuration */
  optimization?: IcpOptimizationConfig;
}

// ─── Optimization Config ─────────────────────────────────────────────────────

/** Optimization configuration for builds */
export interface IcpOptimizationConfig {
  /** Whether to enable WASM optimization */
  enabled: boolean;
  /** Optimization level */
  level?: IcWasmOptLevel;
  /** Whether to shrink the WASM */
  shrink?: boolean;
}

// ─── Project Config ─────────────────────────────────────────────────────────────

/** Project configuration loaded from .icprc.json */
export interface IcpProjectConfig {
  /** Project name */
  name: string;
  /** Default environment */
  defaultEnvironment: string;
  /** Environments */
  environments: Record<string, IcpEnvironmentConfig>;
  /** Cycles configuration */
  cycles?: IcpCyclesConfig;
  /** Optimization configuration */
  optimization?: IcpOptimizationConfig;
}
