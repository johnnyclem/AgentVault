/**
 * Monitor Command
 *
 * Watches canister health and displays real-time metrics.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkHealth, generateHealthAlerts, getRecentAlerts } from '../../src/monitoring/index.js';
import type { MonitoringOptions } from '../../src/monitoring/types.js';

export function monitorCommand(): Command {
  const command = new Command('monitor');

  command
    .description('Watch canister health in real-time')
    .argument('<canister-id>', 'Canister ID to monitor')
    .option('-i, --interval <ms>', 'Polling interval (default: 10s)')
    .option('-t, --thresholds <json>', 'Health check thresholds as JSON')
    .option('-a, --alerts', 'Display all alerts (default: latest 10)');

  command
    .action(async (canisterId: string, options: MonitoringOptions = {}) => {
      const thresholds = options.thresholds ? JSON.parse(options.thresholds) : undefined;
      const monitoringOpts: MonitoringOptions = {
        canisterId,
        thresholds,
        pollInterval: options.interval ?? 10000,
        maxSnapshots: options.alerts ?? 10,
      };

      const spinner = ora(`Monitoring canister ${canisterId}...`).start();

      try {
        await checkHealth(canisterId, monitoringOpts);
        spinner.succeed(`Monitoring ${canisterId} started`);

        console.log(chalk.gray(`Press Ctrl+C to stop monitoring`));
        console.log(chalk.cyan(`Polling every ${(monitoringOpts.pollInterval / 1000).toFixed(1)}s`));

        while (true) {
          const statusInfo = await checkHealth(canisterId, monitoringOpts);

          if (statusInfo.health === 'stopped') {
            console.log(chalk.yellow('Canister stopped - stopping monitoring'));
            break;
          }

          displayStatus(statusInfo);

          if (monitoringOpts.generateAlerts !== false) {
            const alerts = await getRecentAlerts(canisterId, monitoringOpts.maxSnapshots);
            if (alerts.length > 0) {
              displayAlerts(alerts);
            }
          }

          await new Promise((resolve) => resolve(setTimeout(1000)));
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(chalk.gray('\nMonitoring stopped'));
          process.exit(0);
        } else {
          spinner.fail(`Monitoring error: ${error.message}`);
          throw error;
        }
      }
    });

  return command;
}

function displayStatus(statusInfo: any): void {
  console.log();
  console.log(chalk.cyan('Status:'), statusInfo.status);
  console.log(chalk.cyan('Memory:'), statusInfo.memorySize ? `${Number(statusInfo.memorySize) / (1024 * 1024)).toFixed(2)} MB` : 'N/A');
  console.log(chalk.cyan('Cycles:'), statusInfo.cycles ? statusInfo.cycles.toString() : 'N/A');
  console.log(chalk.cyan('Health:'), statusInfo.health);
}

function displayAlerts(alerts: any[]): void {
  console.log();
  console.log(chalk.cyan('Recent Alerts:'));
  for (const alert of alerts) {
    const severityColor =
      alert.severity === 'critical'
        ? chalk.red
        : alert.severity === 'warning'
          ? chalk.yellow
          : chalk.gray;

    const timestamp = new Date(alert.timestamp).toISOString();
    const truncatedMetric = alert.metric.length > 30 ? `${alert.metric.substring(0, 30)}...` : alert.metric;

    console.log(
      `  [${timestamp}]`,
      `  ${severityColor(alert.severity)} ${alert.severity.toUpperCase()}:`,
      `  Canister: ${alert.canisterId}`,
      `  ${truncatedMetric}`,
      `  Value: ${alert.value}`,
      `  Threshold: ${alert.threshold}`
    );
  }
}
