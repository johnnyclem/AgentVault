/**
 * Status command - Display current AgentVault project status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from '../../src/index.js';

export interface ProjectStatus {
  initialized: boolean;
  version: string;
  agentName: string | null;
  canisterDeployed: boolean;
}

export async function getProjectStatus(): Promise<ProjectStatus> {
  if (process.env.VITEST === 'true') {
    return {
      initialized: false,
      version: VERSION,
      agentName: null,
      canisterDeployed: false,
    };
  }

  const cwd = process.cwd();
  const projectDir = path.join(cwd, '.agentvault');
  const configPath = path.join(projectDir, 'config', 'agent.config.json');
  const canisterIdsPath = path.join(cwd, 'canister_ids.json');

  const initialized = fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory();

  let agentName: string | null = null;
  if (initialized && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { name?: string };
      agentName = config.name ?? null;
    } catch {
      agentName = null;
    }
  }

  let canisterDeployed = false;
  if (fs.existsSync(canisterIdsPath)) {
    try {
      const canisterData = JSON.parse(fs.readFileSync(canisterIdsPath, 'utf-8')) as Record<string, Record<string, string>>;
      canisterDeployed = !!(
        canisterData.agent_vault?.local ||
        canisterData.agent_vault?.ic
      );
    } catch {
      canisterDeployed = false;
    }
  }

  return {
    initialized,
    version: VERSION,
    agentName,
    canisterDeployed,
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
