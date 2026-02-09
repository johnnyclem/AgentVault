/**
 * Monitoring Module
 *
 * Provides canister health monitoring and alerting capabilities.
 */

// Types
export {
  determineHealthStatus,
  generateHealthAlerts,
  checkHealth,
} from './types.js';

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
} from './types.js';
