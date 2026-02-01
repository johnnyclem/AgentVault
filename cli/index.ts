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

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentvault')
    .description('Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous')
    .version(VERSION, '-v, --version', 'output the current version');

  // Register commands
  program.addCommand(initCommand());
  program.addCommand(statusCommand());

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
