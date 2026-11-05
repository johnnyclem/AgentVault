/**
 * `agentvault secrets add|list|rm`: the encrypted store of credentials that the
 * credential-proxy sidecar injects into an agent's API calls.
 *
 * Why it exists: PRD-04. The agent must never hold a real API key, so the key
 * has to live somewhere durable that is neither the agent nor plaintext on disk.
 * src/container/secrets-store.ts is that store; this layer is the way in.
 *
 * Security stance:
 *  - A secret VALUE is never a command-line argument (argv shows in `ps` and in
 *    shell history). `add` takes the NAME of an environment variable
 *    (--from-env ANTHROPIC_API_KEY) and reads the value from it, or prompts for
 *    it on a terminal; with neither it fails and names the variable. There is no
 *    --value, --key or --passphrase flag on any command.
 *  - The store passphrase comes from AGENTVAULT_SECRETS_PASSPHRASE or a hidden
 *    prompt (asked twice when the store is created).
 *  - Nothing here ever prints a value, and `list` prints names only. A value the
 *    credential proxy could not inject (not printable ASCII, leading or trailing
 *    space) is refused at `add` time, with the secret's name and no value, rather
 *    than failing later when an agent starts.
 */

import * as fs from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { isValidSecretValue } from '../../src/container/proxy/credential-proxy.js';
import { SecretStore, assertSecretValue } from '../../src/container/secrets-store.js';
import { ContainerError } from '../../src/container/types.js';
import { ENV_NAME_RE, agentvaultHome, assertSecretName } from '../../src/container/validate.js';
import { resolveDeps, runGuarded } from './cli-support.js';
import type { CliContext, ContainerCliDeps } from './cli-support.js';

function openStore(ctx: CliContext): SecretStore {
  return new SecretStore({ home: agentvaultHome(ctx.env) });
}

export interface SecretsAddOptions {
  fromEnv?: string;
}

/** The value for `add`: the named environment variable, else a hidden prompt on a terminal, else a failure. */
async function obtainValue(name: string, variable: string | undefined, ctx: CliContext): Promise<string> {
  if (variable !== undefined) {
    // Do not echo `variable` back unless it is a plausible variable name: a user may have pasted the key itself.
    if (!ENV_NAME_RE.test(variable)) {
      throw new ContainerError('INVALID_INPUT', '--from-env takes the NAME of an environment variable (for example ANTHROPIC_API_KEY), not the value');
    }
    const value = ctx.env[variable];
    if (value !== undefined && value !== '') return value;
    if (!ctx.interactive) {
      throw new ContainerError(
        'INVALID_INPUT',
        `Environment variable ${variable} is not set (or is empty). Export it and run the command again; the value is never taken from a command-line flag.`
      );
    }
  } else if (!ctx.interactive) {
    throw new ContainerError(
      'INVALID_INPUT',
      `No value for secret "${name}": pass --from-env <VAR> to read it from an environment variable, or run in a terminal to be prompted. The value is never taken from a command-line flag.`
    );
  }
  return ctx.promptSecret(`Value for secret "${name}":`);
}

export async function executeSecretsAdd(nameArg: string, options: SecretsAddOptions, ctx: CliContext): Promise<void> {
  const name = assertSecretName(nameArg);
  const value = await obtainValue(name, options.fromEnv, ctx);
  ctx.sensitive.add(value);

  // Check the value before asking for a passphrase: a bad value should not cost the user a prompt.
  assertSecretValue(value, name);
  if (!isValidSecretValue(value)) {
    throw new ContainerError(
      'INVALID_INPUT',
      `The value for secret "${name}" cannot be injected by the credential proxy: it must be printable ASCII with no newline and no leading or trailing space`
    );
  }

  const store = openStore(ctx);
  const isNewStore = !fs.existsSync(store.file);
  const passphrase = await ctx.getPassphrase({
    purpose: 'secrets',
    confirm: isNewStore,
    message: isNewStore ? 'Choose a passphrase for the new secret store:' : 'Passphrase for the secret store:',
  });
  const replaced = isNewStore ? false : (await store.list(passphrase)).includes(name);
  await store.set(name, value, passphrase);
  ctx.log(`${chalk.green('✓')} ${replaced ? 'Updated' : 'Stored'} secret ${chalk.bold(name)} in the encrypted store ${store.file}`);
  ctx.log(chalk.gray(`  Use it with: agentvault run <agent> --service ${name}`));
}

export async function executeSecretsList(options: { json?: boolean }, ctx: CliContext): Promise<void> {
  const store = openStore(ctx);
  // No store, nothing to unlock: do not ask for a passphrase that protects nothing.
  const names = fs.existsSync(store.file)
    ? await store.list(await ctx.getPassphrase({ purpose: 'secrets', confirm: false, message: 'Passphrase for the secret store:' }))
    : [];
  if (options.json === true) {
    ctx.log(JSON.stringify(names, null, 2));
    return;
  }
  if (names.length === 0) {
    ctx.log('No secrets stored. Add one with: agentvault secrets add <name> --from-env <VAR>');
    return;
  }
  for (const name of names) ctx.log(name);
}

export async function executeSecretsRm(nameArg: string, ctx: CliContext): Promise<void> {
  const name = assertSecretName(nameArg);
  const store = openStore(ctx);
  if (!fs.existsSync(store.file)) {
    throw new ContainerError('NOT_FOUND', `No secret named "${name}": the secret store does not exist yet`);
  }
  const passphrase = await ctx.getPassphrase({ purpose: 'secrets', confirm: false, message: 'Passphrase for the secret store:' });
  if (!(await store.delete(name, passphrase))) {
    throw new ContainerError('NOT_FOUND', `No secret named "${name}" in the store`);
  }
  ctx.log(`${chalk.green('✓')} Removed secret ${chalk.bold(name)}`);
}

export function secretsCommand(deps: ContainerCliDeps = {}): Command {
  const group = new Command('secrets').description(
    'Manage the encrypted credentials the credential proxy injects into agents (separate from "vault" and "safehouse")'
  );

  group
    .command('add')
    .description('Store a credential; the value is read from an environment variable or a hidden prompt, never from a flag')
    .argument('<name>', 'service name, for example anthropic, openai or venice')
    .option('--from-env <VAR>', 'NAME of the environment variable that holds the value, for example ANTHROPIC_API_KEY')
    .action(async (name: string, options: SecretsAddOptions) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSecretsAdd(name, options, ctx));
    });

  group
    .command('list')
    .description('List the stored secret names (never the values)')
    .option('-j, --json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSecretsList(options, ctx));
    });

  group
    .command('rm')
    .description('Remove a stored secret')
    .argument('<name>', 'secret name')
    .action(async (name: string) => {
      const ctx = resolveDeps(deps);
      await runGuarded(ctx, () => executeSecretsRm(name, ctx));
    });

  return group;
}
