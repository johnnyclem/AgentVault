/**
 * Safehouse command – Manage the secret management layer
 *
 * Provides CLI access to the Agent Safehouse-inspired secret management layer:
 * deny-first sandboxing, encrypted memory, leak detection, secret injection,
 * rotation, and tamper-evident audit trails.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { SecretManagementLayer } from '../../src/vault/secret-management-layer.js';
import type { SecretScopeGrant, SecretAccessLevel } from '../../src/vault/safehouse-types.js';

const safehouseCmd = new Command('safehouse');

safehouseCmd
  .description('Agent Safehouse secret management layer (deny-first sandboxing)')
  .action(() => {
    console.log(chalk.bold('\nAgent Safehouse – Secret Management Layer\n'));
    console.log(chalk.gray('Deny-first secret access control for AI agents.\n'));
    console.log('Subcommands:');
    console.log(`  ${chalk.cyan('safehouse scope create')}   Create a new sandbox scope`);
    console.log(`  ${chalk.cyan('safehouse scope list')}     List all scopes`);
    console.log(`  ${chalk.cyan('safehouse scope revoke')}   Revoke a scope`);
    console.log(`  ${chalk.cyan('safehouse scan')}           Run leak detection scan`);
    console.log(`  ${chalk.cyan('safehouse audit')}          View audit trail`);
    console.log(`  ${chalk.cyan('safehouse stats')}          Show operational statistics`);
    console.log(`  ${chalk.cyan('safehouse health')}         Check layer health`);
    console.log(`  ${chalk.cyan('safehouse inject')}         Inject a secret for agent execution`);
  });

// ---------------------------------------------------------------------------
// safehouse scope create
// ---------------------------------------------------------------------------

const scopeCmd = safehouseCmd.command('scope').description('Manage sandbox scopes');

scopeCmd
  .command('create')
  .description('Create a new deny-first sandbox scope for an agent')
  .requiredOption('-a, --agent <agent-id>', 'Agent identifier')
  .option('-l, --label <label>', 'Human-readable scope label')
  .option(
    '-g, --grant <grants...>',
    'Grants in format "pattern:access" (e.g. "api_*:read", "db_*:write")',
  )
  .option('--max-secrets <n>', 'Maximum secrets accessible in this scope', parseInt)
  .option('--expires <duration>', 'Scope expiry (e.g. "1h", "30m", "24h")')
  .option('--backend <backend>', 'Secret backend: hashicorp, bitwarden, or memory (default)')
  .action(async (options) => {
    const spinner = ora('Creating sandbox scope...').start();

    try {
      const grants: SecretScopeGrant[] = [];
      if (options.grant) {
        for (const g of options.grant as string[]) {
          const [pattern, access] = g.split(':');
          if (!pattern || !access) {
            spinner.fail(chalk.red(`Invalid grant format: "${g}". Use "pattern:access".`));
            process.exit(1);
          }
          const validAccess: SecretAccessLevel[] = ['none', 'read', 'write', 'admin'];
          if (!validAccess.includes(access as SecretAccessLevel)) {
            spinner.fail(chalk.red(`Invalid access level: "${access}". Use: ${validAccess.join(', ')}`));
            process.exit(1);
          }
          grants.push({ keyPattern: pattern, access: access as SecretAccessLevel });
        }
      }

      let expiresAt: string | null = null;
      if (options.expires) {
        const match = /^(\d+)(m|h|d)$/.exec(options.expires as string);
        if (!match) {
          spinner.fail(chalk.red('Invalid expires format. Use "30m", "1h", or "7d".'));
          process.exit(1);
        }
        const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
        expiresAt = new Date(Date.now() + parseInt(match[1]!) * multipliers[match[2]!]!).toISOString();
      }

      const sml = SecretManagementLayer.create({
        backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
      });

      const scope = sml.createScope({
        agentId: options.agent as string,
        label: options.label as string | undefined,
        grants,
        expiresAt,
        maxSecrets: options.maxSecrets as number | undefined,
      });

      spinner.succeed(chalk.green('Sandbox scope created'));

      console.log(chalk.cyan('\nScope Details:'));
      console.log(`  ID:          ${chalk.bold(scope.scopeId)}`);
      console.log(`  Agent:       ${scope.agentId}`);
      if (scope.label) console.log(`  Label:       ${scope.label}`);
      console.log(`  Grants:      ${scope.grants.length}`);
      for (const grant of scope.grants) {
        console.log(`    ${chalk.gray(grant.keyPattern)} → ${chalk.yellow(grant.access)}`);
      }
      if (scope.expiresAt) console.log(`  Expires:     ${scope.expiresAt}`);
      if (scope.maxSecrets) console.log(`  Max Secrets: ${scope.maxSecrets}`);
      console.log(`  Cross-Agent: ${scope.allowCrossAgent ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Created:     ${scope.createdAt}`);

      await sml.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

scopeCmd
  .command('list')
  .description('List all sandbox scopes')
  .option('--backend <backend>', 'Secret backend')
  .action(async (options) => {
    const sml = SecretManagementLayer.create({
      backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
    });

    const scopes = sml.sandbox.listScopes();
    if (scopes.length === 0) {
      console.log(chalk.gray('No scopes created in this session.'));
    } else {
      console.log(chalk.bold(`\n${scopes.length} scope(s):\n`));
      for (const scope of scopes) {
        const status = scope.revoked
          ? chalk.red('revoked')
          : scope.expiresAt && new Date(scope.expiresAt) < new Date()
            ? chalk.yellow('expired')
            : chalk.green('active');
        console.log(`  ${chalk.cyan(scope.scopeId)} [${status}]`);
        console.log(`    Agent: ${scope.agentId}  Grants: ${scope.grants.length}`);
      }
    }

    await sml.dispose();
  });

scopeCmd
  .command('revoke')
  .description('Revoke a sandbox scope')
  .argument('<scope-id>', 'Scope ID to revoke')
  .option('--backend <backend>', 'Secret backend')
  .action(async (scopeId, options) => {
    const sml = SecretManagementLayer.create({
      backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
    });

    try {
      sml.revokeScope(scopeId);
      console.log(chalk.green(`Scope "${scopeId}" revoked.`));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }

    await sml.dispose();
  });

// ---------------------------------------------------------------------------
// safehouse scan
// ---------------------------------------------------------------------------

safehouseCmd
  .command('scan')
  .description('Run a leak detection scan against the current environment')
  .option('--backend <backend>', 'Secret backend')
  .action(async (options) => {
    const spinner = ora('Scanning for secret leaks...').start();

    const sml = SecretManagementLayer.create({
      backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
      leakDetection: true,
    });

    const events = sml.scanForLeaks();

    if (events.length === 0) {
      spinner.succeed(chalk.green('No leaked secrets detected'));
    } else {
      spinner.warn(chalk.yellow(`${events.length} potential leak(s) detected`));
      for (const event of events) {
        const icon = event.severity === 'critical' ? chalk.red('CRITICAL') :
          event.severity === 'warning' ? chalk.yellow('WARNING') : chalk.gray('INFO');
        console.log(`\n  [${icon}] ${event.description}`);
        console.log(`    Source: ${event.source}  Key: ${event.secretKey}`);
        if (event.remediated) {
          console.log(`    ${chalk.green('Remediated:')} ${event.remediationAction}`);
        }
      }
    }

    await sml.dispose();
  });

// ---------------------------------------------------------------------------
// safehouse audit
// ---------------------------------------------------------------------------

safehouseCmd
  .command('audit')
  .description('View the secret access audit trail')
  .option('--agent <agent-id>', 'Filter by agent')
  .option('--denied', 'Show only denied operations')
  .option('--json', 'Output as JSON')
  .option('--verify', 'Verify audit chain integrity')
  .action(async (options) => {
    const sml = SecretManagementLayer.create({ auditEnabled: true });

    if (options.verify) {
      const result = sml.verifyAuditChain();
      if (result.valid) {
        console.log(chalk.green('Audit chain integrity: VALID'));
      } else {
        console.log(chalk.red(`Audit chain integrity: BROKEN at entry ${result.brokenAt}`));
        console.log(chalk.red(`  Reason: ${result.reason}`));
      }
      await sml.dispose();
      return;
    }

    let entries = sml.getAuditEntries();

    if (options.agent) {
      entries = entries.filter(e => e.agentId === options.agent);
    }
    if (options.denied) {
      entries = entries.filter(e => !e.allowed);
    }

    if (entries.length === 0) {
      console.log(chalk.gray('No audit entries found.'));
    } else if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(chalk.bold(`\n${entries.length} audit entries:\n`));
      for (const entry of entries.slice(-20)) { // Show last 20
        const status = entry.allowed ? chalk.green('ALLOW') : chalk.red('DENY');
        const key = entry.secretKey ? ` key=${entry.secretKey}` : '';
        console.log(`  ${chalk.gray(entry.timestamp)} [${status}] ${entry.action}${key} (${entry.agentId})`);
        if (entry.denialReason) {
          console.log(`    ${chalk.red('Reason:')} ${entry.denialReason}`);
        }
      }
    }

    await sml.dispose();
  });

// ---------------------------------------------------------------------------
// safehouse stats
// ---------------------------------------------------------------------------

safehouseCmd
  .command('stats')
  .description('Show secret management layer statistics')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const sml = SecretManagementLayer.create();
    const stats = sml.stats();

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(chalk.bold('\nSecret Management Layer Statistics\n'));
      console.log(`  Cached Secrets:   ${stats.cachedSecrets}`);
      console.log(`  Total Reads:      ${stats.totalReads}`);
      console.log(`  Total Writes:     ${stats.totalWrites}`);
      console.log(`  Total Denied:     ${chalk.red(String(stats.totalDenied))}`);
      console.log(`  Leak Events:      ${stats.totalLeaks > 0 ? chalk.red(String(stats.totalLeaks)) : chalk.green('0')}`);
      console.log(`  Rotations:        ${stats.totalRotations}`);
      console.log(`  Active Scopes:    ${stats.activeScopes}`);
      console.log(`  Uptime:           ${Math.round(stats.uptimeMs / 1000)}s`);
    }

    await sml.dispose();
  });

// ---------------------------------------------------------------------------
// safehouse health
// ---------------------------------------------------------------------------

safehouseCmd
  .command('health')
  .description('Check the secret management layer health')
  .option('--backend <backend>', 'Secret backend')
  .action(async (options) => {
    const spinner = ora('Checking secret management layer health...').start();

    const sml = SecretManagementLayer.create({
      backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
    });

    const result = await sml.healthCheck();

    if (result.healthy) {
      spinner.succeed(chalk.green(`Secret management layer healthy: ${result.message}`));
    } else {
      spinner.fail(chalk.red(`Unhealthy: ${result.message}`));
    }

    if (result.version) {
      console.log(chalk.gray(`  Backend version: ${result.version}`));
    }

    await sml.dispose();
  });

// ---------------------------------------------------------------------------
// safehouse inject
// ---------------------------------------------------------------------------

safehouseCmd
  .command('inject')
  .description('Inject a secret for agent execution')
  .requiredOption('-a, --agent <agent-id>', 'Agent identifier')
  .requiredOption('-k, --key <key>', 'Secret key')
  .option('-m, --method <method>', 'Injection method: env-scoped (default), tmpfs-file, callback, memory-fd')
  .option('--backend <backend>', 'Secret backend')
  .action(async (options) => {
    const spinner = ora(`Injecting secret "${options.key}" for agent "${options.agent}"...`).start();

    try {
      const sml = SecretManagementLayer.create({
        backend: (options.backend as 'hashicorp' | 'bitwarden' | 'memory') ?? 'memory',
        injectionMethod: (options.method as 'env-scoped' | 'tmpfs-file' | 'callback' | 'memory-fd') ?? 'env-scoped',
      });

      // Create a permissive scope for the CLI command
      const scope = sml.createScope({
        agentId: options.agent as string,
        grants: [{ keyPattern: '*', access: 'read' }],
      });
      sml.enterScope(scope.scopeId);

      const injection = await sml.injectSecret(options.key as string);

      spinner.succeed(chalk.green(`Secret "${options.key}" injected`));
      console.log(chalk.cyan('\nInjection Details:'));
      console.log(`  Method:    ${injection.method}`);
      console.log(`  Reference: ${injection.reference}`);
      console.log(`  Injected:  ${injection.injectedAt}`);
      if (injection.expiresAt) {
        console.log(`  Expires:   ${injection.expiresAt}`);
      }

      sml.exitScope();
      await sml.dispose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(message));
      process.exit(1);
    }
  });

export { safehouseCmd };
