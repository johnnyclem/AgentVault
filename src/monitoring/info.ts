/**
 * Canister Information
 *
 * Queries canister status and metrics using icp-cli.
 */

import { icpcli } from '../icp/icpcli.js';
import type { CanisterStatusInfo, MonitoringOptions } from './types.js';

/**
 * Get detailed canister information.
 *
 * @param canisterId - Canister ID to query
 * @param options - Monitoring options
 * @returns Canister status information
 */
export async function getCanisterInfo(
  canisterId: string,
  options: MonitoringOptions = {},
): Promise<CanisterStatusInfo> {
  const result = await icpcli.canisterStatus({ canister });

  const statusInfo: CanisterStatusInfo = {
    canisterId,
    status: result.success ? (result.stdout.match(/Status:\s*(\w+)/)?.[1] ?? 'unknown') : 'unknown',
    memorySize: parseMemorySize(result.stdout),
    cycles: parseCycles(result.stdout),
    moduleHash: extractModuleHash(result.stdout),
    health: 'healthy',
    timestamp: new Date(),
  };

  return statusInfo;
}

/**
 * Monitoring query options
 */
export interface MonitoringOptions {
  /** Canister ID to query */
  canisterId: string;
  /** Alert thresholds */
  thresholds?: Partial<HealthThresholds>;
  /** How often to poll (milliseconds) */
  pollInterval?: number;
  /** Maximum number of snapshots to keep */
  maxSnapshots?: number;
  /** Whether to generate alerts */
  generateAlerts?: boolean;
}
  return undefined;
}

/**
 * Parse cycle balance from icp-cli output.
 */
function parseCycles(output: string): bigint | undefined {
  const match = output.match(/Cycles:\s*([\d,.]+(?:T|B|M|K|G|μ)/);
  if (match) {
    const value = match[1].replace(/,/g, '');
    const units = match[2];
    return parseCycleValue(value, units);
  }
  return undefined;
}

/**
 * Parse a cycle value with units to bigint cycles.
 */
function parseCycleValue(value: string, units: string): bigint {
  const numeric = parseFloat(value);

  if (units === 'T') {
    return BigInt(Math.round(numeric * 1_000_000_000_000));
  } else if (units === 'B') {
    return BigInt(Math.round(numeric * 1_000_000_000));
  } else if (units === 'M') {
    return BigInt(Math.round(numeric * 1_000_000_000_000));
  } else if (units === 'K') {
    return BigInt(Math.round(numeric * 1_000_000_000_000_000));
  } else if (units === 'G') {
    return BigInt(Math.round(numeric * 1_000_000_000));
  } else {
    return BigInt(Math.round(numeric * 1_000));
  }
}

/**
 * Extract module hash from icp-cli output.
 */
function extractModuleHash(output: string): string | undefined {
  const match = output.match(/Hash:\s*([a-f0-9]{64})/);
  if (match) {
    return match[1];
  }
  return undefined;
}
