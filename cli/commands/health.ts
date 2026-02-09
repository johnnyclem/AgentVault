/**
 * Health Command
 *
 * Checks canister health and displays alerts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkHealth, getRecentAlerts } from '../../src/monitoring/index.js';
import type { MonitoringOptions } from '../../src/monitoring/types.js';

export function healthCommand(): Command {
  const command = new Command('health');

  command
    .description('Check canister health and display alerts')
    .argument('<canister-id>', 'Canister ID to check')
    .option('-t, --thresholds <json>', 'Health check thresholds as JSON')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds')
    .option('--max-alerts <n>', 'Maximum alerts to display')
    .option('--clear', 'Clear all alerts for canister')
    .option('-w, --watch', 'Watch canister health continuously');

  command
    .action(async (canisterId: string, options: any) => {
      const thresholds = options.thresholds ? JSON.parse(options.thresholds) : undefined;
      const monitoringOpts: MonitoringOptions = {
        canister: canisterId,
        thresholds,
        pollInterval: options.interval ? parseInt(options.interval) : undefined,
        maxSnapshots: options.maxAlerts ? parseInt(options.maxAlerts) : 10,
      };

      const spinner = ora('Checking canister health...').start();

      try {
        const statusInfo = await checkHealth(canisterId, monitoringOpts);
        spinner.succeed('Health check completed');
        displayHealth(statusInfo);

        const alerts = await getRecentAlerts(canisterId, monitoringOpts.maxSnapshots || 10);
        if (alerts.length > 0) {
          console.log();
          console.log(chalk.cyan('Recent Alerts:'));
          for (const alert of alerts) {
            const severityColor =
              alert.severity === 'critical'
                ? chalk.red
                : alert.severity === 'warning'
                ? chalk.yellow
                : chalk.gray;
            console.log(
              `  [${new Date(alert.timestamp).toISOString()}]`,
              `  ${severityColor(alert.severity)} ${alert.severity.toUpperCase()}:`,
              `  Canister: ${alert.canisterId}`,
              `  Metric: ${alert.metric}`,
              `  Value: ${alert.value}`,
              `  Threshold: ${alert.threshold}`
            );
          }
        } else {
          console.log(chalk.gray('No recent alerts'));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        spinner.fail(`Health check failed: ${message}`);
        throw error;
      }
    });

  return command;
}

function displayHealth(statusInfo: any): void {
  console.log();
  console.log(chalk.cyan('Canister Status:'), chalk.bold(statusInfo.status));
  console.log();
  console.log(chalk.cyan('Health Check:'), statusInfo.health === 'healthy' ? chalk.green('Passed') : chalk.red('Failed'));
  if (statusInfo.memorySize !== undefined) {
    const memoryMB = Number(statusInfo.memorySize) / ( 1024 * 1024);
    console.log(chalk.cyan('Memory:'), chalk.bold(`${memoryMB.toFixed(2)} MB`));
  }
  if (statusInfo.cycles !== undefined) {
    console.log(chalk.cyan('Cycles:'), chalk.bold(statusInfo.cycles.toString()));
  }
}
