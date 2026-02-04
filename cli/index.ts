#!/usr/bin/env node
/**
 * AgentVault CLI
 *
 * Command-line interface for the AgentVault platform.
 */

import { Command } from 'commander';
import { VERSION } from '../src/index.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { packageCommand } from './commands/package.js';
import { deployCommand } from './commands/deploy.js';
import { fetchCommand } from './commands/fetch.js';
import { decryptCommand } from './commands/decrypt.js';
import { rebuildCommand } from './commands/rebuild.js';
import { execCommand } from './commands/exec.js';
import { listCommand } from './commands/list.js';
import { showCommand } from './commands/show.js';
import { walletCommand } from './commands/wallet.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentvault')
    .description('Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous')
    .version(VERSION, '-v, --version', 'output the current version');

  // Register commands
  program.addCommand(initCommand());
  program.addCommand(statusCommand());
  program.addCommand(packageCommand());
  program.addCommand(deployCommand());
  program.addCommand(fetchCommand());
  program.addCommand(decryptCommand());
  program.addCommand(rebuildCommand());
  program.addCommand(execCommand());
  program.addCommand(listCommand());
  program.addCommand(showCommand());
  program.addCommand(walletCommand());

  return program;
}

export async function run(args: string[] = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(args);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: Error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
