/**
 * Agent Deployer
 *
 * Main orchestrator for the ICP canister deployment pipeline.
 * Coordinates validation, client setup, and deployment operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DeployOptions,
  DeployResult,
  DeploymentError,
  CanisterInfo,
  NetworkType,
  DeploymentStatus,
} from './types.js';
import { createICPClient } from './icpClient.js';

/**
 * Extract agent name from WASM file path
 */
function extractAgentName(wasmPath: string): string {
  const basename = path.basename(wasmPath);
  // Remove .wasm extension
  return basename.replace(/\.wasm$/, '');
}

/**
 * Validate deployment options
 */
export function validateDeployOptions(options: DeployOptions): {
  valid: boolean;
  errors: DeploymentError[];
  warnings: string[];
} {
  const errors: DeploymentError[] = [];
  const warnings: string[] = [];

  // Validate WASM path using client
  const client = createICPClient({ network: options.network });
  const wasmValidation = client.validateWasmPath(options.wasmPath);
  if (!wasmValidation.valid) {
    errors.push({
      code: 'INVALID_WASM',
      message: wasmValidation.error!,
    });
  }

  // Validate network
  if (options.network !== 'local' && options.network !== 'ic') {
    errors.push({
      code: 'INVALID_NETWORK',
      message: `Invalid network: ${options.network}. Must be 'local' or 'ic'.`,
      network: options.network,
    });
  }

  // Warn about mainnet deployment
  if (options.network === 'ic' && !options.skipConfirmation) {
    warnings.push(
      'Deploying to IC mainnet will consume cycles. Ensure you have sufficient balance.'
    );
  }

  // Warn about upgrade without canister ID check
  if (options.canisterId) {
    warnings.push(`Upgrading existing canister: ${options.canisterId}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get deployment preview/summary
 *
 * Useful for dry-run functionality
 */
export function getDeploySummary(options: DeployOptions): {
  agentName: string;
  wasmPath: string;
  wasmHash: string;
  wasmSize: number;
  network: NetworkType;
  isUpgrade: boolean;
  canisterId?: string;
  validation: ReturnType<typeof validateDeployOptions>;
} {
  const validation = validateDeployOptions(options);

  // Calculate WASM hash if file exists
  let wasmHash = '';
  let wasmSize = 0;
  if (validation.valid) {
    try {
      const client = createICPClient({ network: options.network });
      wasmHash = client.calculateWasmHash(options.wasmPath);
      wasmSize = fs.statSync(options.wasmPath).size;
    } catch {
      // File doesn't exist or can't be read
    }
  }

  return {
    agentName: extractAgentName(options.wasmPath),
    wasmPath: options.wasmPath,
    wasmHash,
    wasmSize,
    network: options.network,
    isUpgrade: !!options.canisterId,
    canisterId: options.canisterId,
    validation,
  };
}

/**
 * Deploy an agent to ICP
 *
 * This is the main entry point for the deployment pipeline.
 *
 * @param options - Deployment options
 * @returns Deployment result with canister info
 */
export async function deployAgent(options: DeployOptions): Promise<DeployResult> {
  // Validate options
  const validation = validateDeployOptions(options);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => e.message).join('; ');
    throw new Error(`Deployment validation failed: ${errorMessages}`);
  }

  // Create ICP client
  const client = createICPClient({
    network: options.network,
    identity: options.identityPath,
  });

  // Check network connection
  const connectionCheck = await client.checkConnection();
  if (!connectionCheck.connected) {
    throw new Error(
      `Failed to connect to ${options.network} network: ${connectionCheck.error ?? 'Unknown error'}`
    );
  }

  // Deploy the WASM
  const deployResult = await client.deploy(options.wasmPath, options.canisterId);

  // Build canister info
  const canisterInfo: CanisterInfo = {
    canisterId: deployResult.canisterId,
    network: options.network,
    agentName: extractAgentName(options.wasmPath),
    deployedAt: new Date(),
    wasmHash: deployResult.wasmHash,
  };

  return {
    canister: canisterInfo,
    isUpgrade: deployResult.isUpgrade,
    cyclesUsed: deployResult.cyclesUsed,
    warnings: validation.warnings,
  };
}

/**
 * Check if a canister exists and get its status
 */
export async function getCanisterStatus(
  canisterId: string,
  network: NetworkType
): Promise<{
  exists: boolean;
  status?: DeploymentStatus;
  memorySize?: bigint;
  cycles?: bigint;
}> {
  const client = createICPClient({ network });

  try {
    const status = await client.getCanisterStatus(canisterId);
    return {
      exists: true,
      status: status.status,
      memorySize: status.memorySize,
      cycles: status.cycles,
    };
  } catch {
    return { exists: false };
  }
}
