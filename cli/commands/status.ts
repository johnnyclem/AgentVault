/**
 * Status command - Display current AgentVault project status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { VERSION } from '../../src/index.js';

export interface ProjectStatus {
  initialized: boolean;
  version: string;
  agentName: string | null;
  canisterDeployed: boolean;
}

export async function getProjectStatus(): Promise<ProjectStatus> {
  // In a real implementation, this would check for configuration files,
  // deployed canisters, etc.
  return {
    initialized: false,
    version: VERSION,
    agentName: null,
    canisterDeployed: false,
  };
}

export async function displayStatus(status: ProjectStatus): Promise<void> {
  console.log(chalk.bold('\n📊 AgentVault Project Status\n'));

  console.log(chalk.cyan('Version:'), status.version);
  console.log();

  if (!status.initialized) {
    console.log(chalk.yellow('⚠'), 'No AgentVault project found in current directory.');
    console.log();
    console.log('Run', chalk.bold('agentvault init'), 'to create a new project.');
    return;
  }

  console.log(chalk.green('✓'), 'Project initialized');
  console.log(chalk.cyan('Agent:'), status.agentName ?? 'Not configured');
  console.log(
    chalk.cyan('Canister:'),
    status.canisterDeployed ? chalk.green('Deployed') : chalk.yellow('Not deployed')
  );
}

export function statusCommand(): Command {
  const command = new Command('status');

  command
    .description('Display current AgentVault project status')
    .option('-j, --json', 'output status as JSON')
    .action(async (options: { json?: boolean }) => {
      const spinner = ora('Checking project status...').start();

      const status = await getProjectStatus();

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      await displayStatus(status);
    });

  return command;
}
