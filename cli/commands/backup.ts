import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  exportBackup,
  previewBackup,
  importBackup,
  listBackups,
  deleteBackup,
  formatBackupSize,
} from '../../src/backup/index.js';

const backupCmd = new Command('backup');

backupCmd
  .description('Export and import agent backups')
  .action(async () => {
    console.log(chalk.yellow('Please specify a subcommand: export, import, list, delete, or preview'));
    console.log(chalk.gray(`\nExamples:
  ${chalk.cyan('agentvault backup export <agent-name> --output backup.json')}${chalk.gray('    Export agent config to file')}
  ${chalk.cyan('agentvault backup import <file>')}${chalk.gray('           Import agent from backup file')}
  ${chalk.cyan('agentvault backup list')}${chalk.gray('                 List all backups')}
  ${chalk.cyan('agentvault backup delete <backup-path>')}${chalk.gray('      Delete a backup')}
  ${chalk.cyan('agentvault backup preview <backup-path>')}${chalk.gray('       Preview backup contents')}`));
  });

backupCmd
  .command('export')
  .description('Export agent configuration and data to a backup file')
  .argument('<agent-name>', 'Agent name to backup')
  .option('-o, --output <path>', 'Output file path', './backup.json')
  .option('-c, --canister-id <id>', 'Canister ID to include live canister state')
  .option('--no-canister-state', 'Skip fetching canister state even if canister ID provided')
  .action(async (agentName, options) => {
    const outputPath = options.output.endsWith('.json') ? options.output : `${options.output}.json`;
    const includeCanisterState = options.canisterId ? options.canisterState !== false : false;
    const spinner = ora(`Exporting backup for ${agentName}...`).start();

    try {
      const result = await exportBackup({
        agentName,
        outputPath,
        includeConfig: true,
        canisterId: options.canisterId,
        includeCanisterState,
      });

      if (result.success && result.path && result.manifest) {
        spinner.succeed(chalk.green(`Backup exported to ${result.path}`));
        const sizeBytes = result.sizeBytes || result.manifest.size;
        console.log(chalk.gray(`Size: ${formatBackupSize(sizeBytes)}`));
        console.log(chalk.gray(`Components: ${result.manifest.components.join(', ')}`));
      } else {
        spinner.fail(chalk.red('Backup export failed'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Backup export failed'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

backupCmd
  .command('import')
  .description('Import agent configuration from a backup file')
  .argument('<file>', 'Backup file path to import')
  .option('--name <name>', 'New agent name (defaults to original)')
  .option('--overwrite', 'Overwrite existing agent configuration')
  .action(async (filePath, options) => {
    const spinner = ora(`Importing backup from ${filePath}...`).start();

    try {
      const result = await importBackup({
        inputPath: filePath,
        targetAgentName: options.name,
        overwrite: options.overwrite,
      });

      if (result.success) {
        spinner.succeed(chalk.green(`Backup imported for ${result.agentName}`));
        if (result.components.length > 0) {
          console.log(chalk.gray(`Components imported: ${result.components.join(', ')}`));
        }
        if (result.warnings.length > 0) {
          console.log(chalk.yellow('Warnings:'));
          for (const warning of result.warnings) {
            console.log(chalk.yellow(`  - ${warning}`));
          }
        }
      } else {
        spinner.fail(chalk.red('Backup import failed'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Backup import failed'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

backupCmd
  .command('list')
  .description('List all agent backups')
  .option('--agent <name>', 'Filter by agent name')
  .action(async (options) => {
    const spinner = ora('Listing backups...').start();

    try {
      const backups = await listBackups(options.agent);
      spinner.succeed(chalk.green(`Found ${backups.length} backup(s)`));

      if (backups.length === 0) {
        console.log(chalk.gray('No backups found'));
        return;
      }

      for (const backup of backups) {
        console.log(chalk.cyan(JSON.stringify(backup, null, 2)));
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list backups'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

backupCmd
  .command('delete')
  .description('Delete a backup file')
  .argument('<backup-path>', 'Backup file path to delete')
  .action(async (filePath) => {
    const spinner = ora(`Deleting backup ${filePath}...`).start();

    try {
      const success = await deleteBackup(filePath);

      if (success) {
        spinner.succeed(chalk.green(`Backup deleted: ${filePath}`));
      } else {
        spinner.fail(chalk.red('Failed to delete backup'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to delete backup'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

backupCmd
  .command('preview')
  .description('Preview backup contents without importing')
  .argument('<backup-path>', 'Backup file path to preview')
  .action(async (filePath) => {
    const spinner = ora('Previewing backup...').start();

    try {
      const manifest = await previewBackup(filePath);
      if (!manifest) {
        spinner.fail(chalk.red('Invalid backup file'));
        process.exit(1);
      }
      spinner.succeed(chalk.green('Backup manifest preview:'));

      console.log(chalk.bold(`Agent: ${manifest.agentName}`));
      console.log(chalk.gray(`Created: ${new Date(manifest.created).toLocaleString()}`));
      console.log(chalk.gray(`Components: ${manifest.components.join(', ')}`));
    } catch (error) {
      spinner.fail(chalk.red('Failed to preview backup'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

export { backupCmd };
