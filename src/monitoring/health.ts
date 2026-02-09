/**
 * Health Monitoring
 *
 * Performs health checks on canisters and determines overall health status
 * based on resource usage thresholds.
 */

import { getCanisterInfo } from './info.js';
import type {
  CanisterHealthStatus,
  CanisterStatusInfo,
  HealthThresholds,
  MonitoringOptions,
  MonitoringAlert,
  AlertSeverity,
} from './types.js';

/**
 * Determine health status based on resource metrics.
 *
 * @param statusInfo - Canister status information
 * @param thresholds - Health check thresholds
 * @returns Health status
 */
export function determineHealthStatus(
  statusInfo: CanisterStatusInfo,
  thresholds: HealthThresholds = {},
): CanisterHealthStatus {
  // Check cycles
  const cycles = statusInfo.cycles;
  if (cycles !== undefined) {
    if (thresholds.cyclesCritical && cycles < thresholds.cyclesCritical) {
      return 'critical';
    } else if (thresholds.cyclesWarning && cycles < thresholds.cyclesWarning) {
      return 'warning';
    }
  }

  // Check memory
  const memoryBytes = statusInfo.memorySize;
  if (memoryBytes !== undefined) {
    const memoryMB = Number(memoryBytes) / (1024 * 1024);
    if (thresholds.memoryCriticalPercent && memoryMB > 1024 * thresholds.memoryCriticalPercent) {
      return 'critical';
    } else if (thresholds.memoryWarningPercent && memoryMB > 1024 * thresholds.memoryWarningPercent) {
      return 'warning';
    }
  }

  // Check canister status
  const status = statusInfo.status?.toLowerCase() ?? '';
  if (status === 'stopped') {
    return 'critical';
  } else if (status === 'stopping') {
    return 'warning';
  }

  return 'healthy';
}

/**
 * Generate alerts based on health status.
 *
 * @param statusInfo - Canister status information
 * @param thresholds - Health check thresholds
 * @param currentHealth - Current health status
 * @returns Generated alerts
 */
export function generateHealthAlerts(
  statusInfo: CanisterStatusInfo,
  thresholds: HealthThresholds = {},
  currentHealth: CanisterHealthStatus = 'healthy',
): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = [];

  const cycles = statusInfo.cycles;
  if (cycles !== undefined && thresholds.cyclesCritical !== undefined) {
    if (cycles < thresholds.cyclesCritical) {
      alerts.push({
        severity: 'critical',
        message: `Cycle balance critically low: ${formatCycles(cycles)}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: formatCycles(cycles),
        threshold: formatCycles(thresholds.cyclesCritical),
        timestamp: new Date(),
      });
    } else if (thresholds.cyclesWarning !== undefined && cycles < thresholds.cyclesWarning) {
      alerts.push({
        severity: 'warning',
        message: `Cycle balance low: ${formatCycles(cycles)}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: formatCycles(cycles),
        threshold: formatCycles(thresholds.cyclesWarning),
        timestamp: new Date(),
      });
    }
  }

  const memoryBytes = statusInfo.memorySize;
  if (memoryBytes !== undefined) {
    const memoryMB = Number(memoryBytes) / (1024 * 1024);
    if (thresholds.memoryCriticalPercent !== undefined && memoryMB > 1024 * thresholds.memoryCriticalPercent) {
      alerts.push({
        severity: 'critical',
        message: `Memory usage critically high: ${memoryMB.toFixed(2)} MB`,
        canisterId: statusInfo.canisterId,
        metric: 'memory',
        value: `${memoryMB.toFixed(2)} MB`,
        threshold: `${thresholds.memoryCriticalPercent}%`,
        timestamp: new Date(),
      });
    } else if (thresholds.memoryWarningPercent !== undefined && memoryMB > 1024 * thresholds.memoryWarningPercent) {
      alerts.push({
        severity: 'warning',
        message: `Memory usage high: ${memoryMB.toFixed(2)} MB`,
        canisterId: statusInfo.canisterId,
        metric: 'memory',
        value: `${memoryMB.toFixed(2)} MB`,
        threshold: `${thresholds.memoryWarningPercent}%`,
        timestamp: new Date(),
      });
    }
  }

  if (currentHealth !== 'healthy') {
    alerts.push({
      severity: 'warning',
      message: `Canister status: ${status}`,
      canisterId: statusInfo.canisterId,
      metric: 'status',
      value: status,
      threshold: 'healthy',
      timestamp: new Date(),
    });
  }

  return alerts;
}

/**
 * Format cycles bigint to human-readable string.
 */
function formatCycles(cycles: bigint): string {
  if (cycles >= BigInt(1_000_000_000_000)) {
    const value = Number(cycles) / 1_000_000_000_000_000;
    return `${value.toFixed(2)} T`;
  }
  return cycles.toString();
}

/**
 * Perform a one-time health check.
 *
 * @param options - Monitoring options
 * @returns Canister status with health status
 */
export async function checkHealth(
  options: MonitoringOptions,
): Promise<CanisterStatusInfo> {
  const statusInfo = await getCanisterInfo(options.canisterId, options);

  const health = determineHealthStatus(statusInfo, options.thresholds ?? {});

  return {
    ...statusInfo,
    health,
  };
}

/**
 * Check multiple canisters' health status.
 *
 * @param canisterIds - Array of canister IDs to check
 * @param options - Monitoring options applied to all
 * @returns Array of canister status info
 */
export async function checkMultipleHealth(
  canisterIds: string[],
  options: MonitoringOptions = {},
): Promise<CanisterStatusInfo[]> {
  const results = await Promise.all(
    canisterIds.map((id) => getCanisterInfo(id, options))
  );

  return results.map((statusInfo) => ({
    ...statusInfo,
    health: determineHealthStatus(statusInfo, options.thresholds ?? {}),
  }));
}
