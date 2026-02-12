/**
 * Init command - Initialize a new AgentVault project
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';


export interface InitOptions {
  name?: string;
  yes?: boolean;
  verbose?: boolean;
  v?: boolean;
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

export async function executeInit(answers: InitAnswers, _options: InitOptions, sourcePath: string): Promise<void> {
  const spinner = ora('Initializing AgentVault project...').start();

  const projectDir = path.resolve(sourcePath, '.agentvault');

  const agentDir = path.join(projectDir, 'agent');
  const canisterDir = path.join(projectDir, 'canister');
  const configDir = path.join(projectDir, 'config');
  const srcDir = path.join(projectDir, 'src');
  const canisterWasmDir = path.join(canisterDir, 'wasm');

  const directories = [agentDir, canisterDir, configDir, srcDir, canisterWasmDir];
  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const configPath = path.join(configDir, 'agent.config.json');
  const configContent = {
    name: answers.name,
    type: 'generic',
    version: '1.0.0',
    createdAt: Date.now(),
    description: answers.description || 'An AgentVault agent',
  };
  fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2), 'utf-8');

  const gitignorePath = path.join(projectDir, '.gitignore');
  const gitignoreContent = `# AgentVault dependencies
node_modules/
dist/
*.log
.env
*.local
.DS_Store

# AgentVault generated files
*.wasm
*.backup
*.state.json

# AgentVault project structure
.agentvault/
src/
canister/
config/
`;
  fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');

  spinner.succeed('AgentVault project initialized successfully!');

  console.log();
  console.log(chalk.green('✓'), 'Project initialized at:', chalk.bold(projectDir));
  console.log(chalk.cyan('Directory structure:'));
  console.log('  ├── src/', chalk.yellow('(agent source code)'));
  console.log('  ├── canister/', chalk.yellow('(WASM files)'));
  console.log('  ├── config/', chalk.yellow('(agent config)'));
  console.log('  └── .gitignore', chalk.yellow('(git ignore file)'));
  console.log();
  console.log(chalk.cyan('Configuration:'));
  console.log('  ├── Name:', chalk.bold(configContent.name));
  console.log('  ├── Type:', chalk.bold(configContent.type));
  console.log('  ├── Version:', chalk.bold(configContent.version));
  console.log('  ├── Description:', chalk.bold(configContent.description));
  console.log();
  console.log(chalk.cyan('Next steps:'));
  console.log('  1. Run', chalk.bold('agentvault status'), 'to check your project');
  console.log('  2. Configure your agent in', chalk.bold('agent.config.json'), '(add agent type, description, etc.)');
  console.log('  3. Compile agent with', chalk.bold('agentvault package'), 'to prepare for deployment');
  console.log('  4. Deploy with', chalk.bold('agentvault deploy'), 'to upload to ICP');
}

export function initCommand(): Command {
  const command = new Command('init');

  command
    .description('Initialize a new AgentVault project')
    .argument('[source]', 'path to agent source directory', '.')
    .option('-n, --name <name>', 'name of the agent')
    .option('-y, --yes', 'skip prompts and use defaults')
    .option('-v, --verbose', 'display detailed configuration information')
    .option('--vv', 'extra verbose mode for debugging')
    .action(async (source: string, options: InitOptions) => {
      console.log(chalk.bold('\n🔐 AgentVault Project Initialization\n'));

      const answers = await promptForInitOptions(options);

      if (!answers || !answers.confirm) {
        console.log(chalk.yellow('Initialization cancelled.'));
        return;
      }

      await executeInit(answers, options, source);
    });

  return command;
}
