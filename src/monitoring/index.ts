/**
 * Monitoring Module
 *
 * Provides canister health monitoring and alerting capabilities.
 */

// Health
export {
  determineHealthStatus,
  generateHealthAlerts,
  checkHealth,
  checkMultipleHealth,
} from './health.js';

// Info
export {
  getCanisterInfo,
} from './info.js';

// Alerting
export {
  loadAlerts,
  saveAlerts,
  appendAlert,
  clearAlerts,
  getRecentAlerts,
} from './alerting.js';

// Types
export type {
  CanisterHealthStatus,
  CanisterStatusInfo,
  HealthThresholds,
  MonitoringOptions,
  MonitoringAlert,
  AlertSeverity,
  ResourceUsageSnapshot,
} from './types.js';
