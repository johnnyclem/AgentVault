/**
 * Package command - Compile agent to WASM for deployment
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import {
  packageAgent,
  getPackageSummary,
  type PackageOptions,
  type PackageResult,
} from '../../src/packaging/index.js';

export interface PackageCommandOptions {
  output?: string;
  force?: boolean;
  skipValidation?: boolean;
  dryRun?: boolean;
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Display package preview (dry-run)
 */
export function displayPreview(sourcePath: string): void {
  const { config, validation } = getPackageSummary(sourcePath);

  console.log(chalk.bold('\nPackage Preview\n'));
  console.log(chalk.cyan('Agent Configuration:'));
  console.log(`  Name:        ${chalk.bold(config.name)}`);
  console.log(`  Type:        ${chalk.bold(config.type)}`);
  console.log(`  Source:      ${config.sourcePath}`);
  console.log(`  Entry Point: ${config.entryPoint ?? chalk.yellow('not detected')}`);
  console.log(`  Version:     ${config.version ?? chalk.yellow('not specified')}`);

  console.log();

  if (validation.warnings.length > 0) {
    console.log(chalk.yellow('Warnings:'));
    for (const warning of validation.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
    console.log();
  }

  if (validation.errors.length > 0) {
    console.log(chalk.red('Errors:'));
    for (const error of validation.errors) {
      console.log(chalk.red(`  ✖ ${error.message}`));
    }
    console.log();
  }

  console.log(chalk.cyan('Output Files:'));
  console.log(`  ${config.name}.wasm      - Compiled WebAssembly module`);
  console.log(`  ${config.name}.wat       - WebAssembly text format`);
  console.log(`  ${config.name}.state.json - Initial agent state`);
}

/**
 * Display package result
 */
export function displayResult(result: PackageResult): void {
  console.log();
  console.log(chalk.green('✓'), 'Agent packaged successfully!');
  console.log();
  console.log(chalk.cyan('Output Files:'));
  console.log(`  WASM:  ${result.wasmPath} (${formatSize(result.wasmSize)})`);
  console.log(`  WAT:   ${result.watPath}`);
  console.log(`  State: ${result.statePath}`);
  console.log();
  console.log(chalk.cyan('Next steps:'));
  console.log('  1. Review the generated files');
  console.log('  2. Run', chalk.bold('agentvault deploy'), 'to upload to ICP');
}

/**
 * Execute the package command
 */
export async function executePackage(
  sourcePath: string,
  options: PackageCommandOptions
): Promise<PackageResult | null> {
  // Handle dry-run mode
  if (options.dryRun) {
    displayPreview(sourcePath);
    return null;
  }

  const spinner = ora('Packaging agent...').start();

  try {
    // Prepare package options
    const packageOptions: PackageOptions = {
      sourcePath,
      outputPath: options.output ? path.resolve(options.output) : undefined,
      force: options.force,
      skipValidation: options.skipValidation,
    };

    // Execute packaging
    const result = await packageAgent(packageOptions);

    spinner.succeed(`Agent '${result.config.name}' packaged successfully!`);
    displayResult(result);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Packaging failed: ${message}`);
    throw error;
  }
}

/**
 * Create the package command
 */
export function packageCommand(): Command {
  const command = new Command('package');

  command
    .description('Compile agent to WASM for deployment to ICP')
    .argument('[source]', 'path to agent source directory', '.')
    .option('-o, --output <path>', 'output directory for compiled files')
    .option('-f, --force', 'overwrite existing output files')
    .option('--skip-validation', 'skip validation checks')
    .option('--dry-run', 'show what would be packaged without executing')
    .action(async (source: string, options: PackageCommandOptions) => {
      console.log(chalk.bold('\n📦 AgentVault Package\n'));

      try {
        await executePackage(source, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}
