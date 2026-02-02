/**
 * Init command - Initialize a new AgentVault project
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { createConfig, readAgentConfig, listAgents, deleteAgentConfig } from '../../src/packaging/index.js';

export interface InitOptions {
  name?: string;
  yes?: boolean;
}

export interface InitAnswers {
  name: string;
  description: string;
  confirm: boolean;
}

export async function promptForInitOptions(options: InitOptions): Promise<InitAnswers | null> {
  // If --yes flag is provided, use defaults
  if (options.yes) {
    return {
      name: options.name ?? 'my-agent',
      description: 'An AgentVault agent',
      confirm: true,
    };
  }

  const answers = await inquirer.prompt<InitAnswers>([
    {
      type: 'input',
      name: 'name',
      message: 'What is the name of your agent?',
      default: options.name ?? 'my-agent',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Agent name is required';
        }
        if (!/^[a-z0-9-]+$/.test(input)) {
          return 'Agent name must be lowercase alphanumeric with hyphens only';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'description',
      message: 'Provide a description for your agent:',
      default: 'An AgentVault agent',
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Create agent with these settings?',
      default: true,
    },
  ]);

  return answers;
}

export async function executeInit(answers: InitAnswers): Promise<void> {
  const spinner = ora('Initializing AgentVault project...').start();

  // Simulate initialization work
  const config = createConfig(answers.name);

  // In a real implementation, this would create files, directories, etc.
  spinner.succeed('AgentVault project initialized successfully!');

  console.log();
  console.log(chalk.green('✓'), 'Created configuration for:', chalk.bold(config.name));
  console.log(chalk.green('✓'), 'Version:', chalk.bold(config.version));
  console.log(chalk.green('✓'), 'Description:', chalk.bold(answers.description));
  console.log();
  console.log(chalk.cyan('Next steps:'));
  console.log('  1. Run', chalk.bold('agentvault status'), 'to check your project');
  console.log('  2. Configure your agent in the generated files');
  console.log('  3. Deploy with', chalk.bold('agentvault deploy'));
}

export function initCommand(): Command {
  const command = new Command('init');

  command
    .description('Initialize a new AgentVault project')
    .option('-n, --name <name>', 'name of the agent')
    .option('-y, --yes', 'skip prompts and use defaults')
    .action(async (options: InitOptions) => {
      console.log(chalk.bold('\n🔐 AgentVault Project Initialization\n'));

      const answers = await promptForInitOptions(options);

      if (!answers || !answers.confirm) {
        console.log(chalk.yellow('Initialization cancelled.'));
        return;
      }

      await executeInit(answers);
    });

  return command;
}
