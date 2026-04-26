import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { mintGoogleAdkAgent, type GoogleAdkTemplate } from '../../src/mint/google-adk.js';

export interface MintAgentCommandOptions {
  output?: string;
  installAdk?: boolean;
  arweaveJwk?: string;
  googleAdkLoopAgent?: boolean;
  googleAdkWorkflowAgent?: boolean;
  googleAdkSequentialAgent?: boolean;
  googleAdkParallelAgent?: boolean;
}

function resolveTemplate(options: MintAgentCommandOptions): GoogleAdkTemplate | null {
  if (options.googleAdkLoopAgent) return 'loop-agent';
  if (options.googleAdkWorkflowAgent) return 'workflow-agent';
  if (options.googleAdkSequentialAgent) return 'sequential-agent';
  if (options.googleAdkParallelAgent) return 'parallel-agent';
  return null;
}

export function mintCmd(): Command {
  const command = new Command('mint')
    .description('Mint new scaffolded agents with immediate chain + archival bootstrap');

  command
    .command('agent')
    .description('Create a new agent scaffold with Google ADK/A2A compatibility')
    .argument('[name]', 'Agent name', 'google-adk-agent')
    .option('--google-adk-loop-agent', 'Scaffold a Google ADK loop agent')
    .option('--google-adk-workflow-agent', 'Scaffold a Google ADK workflow agent')
    .option('--google-adk-sequential-agent', 'Scaffold a Google ADK sequential agent')
    .option('--google-adk-parallel-agent', 'Scaffold a Google ADK parallel agent')
    .option('-o, --output <directory>', 'Output directory root', process.cwd())
    .option('--no-install-adk', 'Do not attempt to install Google ADK via pip')
    .option('--arweave-jwk <path>', 'Arweave wallet JWK path for immediate upload')
    .action(async (name: string, options: MintAgentCommandOptions) => {
      const template = resolveTemplate(options);
      if (!template) {
        console.error(chalk.red('Error: select one template flag: --google-adk-loop-agent | --google-adk-workflow-agent | --google-adk-sequential-agent | --google-adk-parallel-agent'));
        process.exit(1);
      }

      console.log(chalk.bold('\n  AgentVault Mint\n'));
      console.log(chalk.cyan('Agent:'), name);
      console.log(chalk.cyan('Template:'), template);
      console.log(chalk.cyan('Output:'), options.output);

      const spinner = ora('Scaffolding Google ADK/A2A agent...').start();

      try {
        const result = await mintGoogleAdkAgent({
          agentName: name,
          template,
          targetRoot: options.output,
          installAdk: options.installAdk !== false,
          arweaveJwkPath: options.arweaveJwk,
        });

        spinner.succeed(chalk.green('Google ADK agent minted successfully'));

        console.log();
        console.log(chalk.bold('Mint Summary'));
        console.log(chalk.gray('─'.repeat(48)));
        console.log(chalk.cyan('  Agent directory:      '), result.agentDir);
        console.log(chalk.cyan('  Provisioned canister: '), result.canisterId);
        console.log(chalk.cyan('  Birthday backup:      '), result.backupPath);

        if (result.archiveId) {
          console.log(chalk.cyan('  Arweave archive ID:   '), result.archiveId);
        }
        if (result.arweaveTransactionId) {
          console.log(chalk.cyan('  Arweave tx:           '), result.arweaveTransactionId);
        }

        console.log(chalk.cyan('  Google ADK available: '), result.adkInstalled ? chalk.green('yes') : chalk.yellow('no'));

        if (result.warnings.length > 0) {
          console.log();
          console.log(chalk.yellow('Warnings:'));
          for (const warning of result.warnings) {
            console.log(chalk.yellow(`  • ${warning}`));
          }
        }

        console.log();
        console.log(chalk.cyan('Next steps:'));
        console.log('  1. Open', chalk.bold(`${result.agentDir}/agent.py`), 'and implement your ADK business logic');
        console.log('  2. Install deps with', chalk.bold('python3 -m pip install -r requirements.txt'));
        console.log('  3. Add deployment wiring to a WASM canister and run', chalk.bold('agentvault deploy'));
      } catch (error) {
        spinner.fail(chalk.red('Mint failed'));
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(message));
        process.exit(1);
      }
    });

  return command;
}
