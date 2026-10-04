import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  MCPToolError,
  PolyticianMCPClient,
  probeMCPServerHealth,
  type MCPServerConfig,
} from '../../src/orchestration/mcp-client.js';
import {
  callPolytician,
  clampCount,
  conceptTitle,
  vaultToolUnavailableMessage,
  LIST_LIMIT_MAX,
  POLYTICIAN_VAULT_TOOLS,
  SEARCH_K_MAX,
} from '../../src/orchestration/polytician-tools.js';
import {
  agentVaultUrlProblem,
  checkPolyticianNamespace,
  defaultPolyticianNamespace,
  polyticianServerConfig,
  PolyticianConfigError,
} from '../../src/orchestration/polytician-config.js';
import {
  buildPolyticianConfig,
  configFileHasLiteralToken,
  defaultPolyticianConfigPath,
  writePolyticianConfigFile,
  POLYTICIAN_API_TOKEN_REFERENCE,
} from '../../src/orchestration/polytician-config-file.js';
import { nearestProjectAgentId } from '../../src/hypervault/pipeline.js';

const polyticianCmd = new Command('polytician');

polyticianCmd
  .description('Manage Polytician semantic memory integration')
  .option('-e, --entry <command>', 'Polytician MCP server entry point (e.g., "node server.js"); every subcommand but config needs it')
  .option(
    '-n, --namespace <name>',
    "Polytician namespace of the agent's concepts (default: the agent name in the nearest agent.json or " +
      '.agentvault/config/agent.config.json, here or in a parent directory, the webapp\'s agentId for it; else "default")'
  )
  .option(
    '--config <path>',
    "Polytician's config file: passed to Polytician as --config, and where config writes " +
      '(default ~/.polytician/config.json, which Polytician reads without --config)'
  )
  .option('-p, --health-port <port>', "HTTP health port of a running Polytician (its POLYTICIAN_HEALTH_PORT; off by default)", parseInt)
  .action((_options, command) => {
    if (command instanceof Command && command.args.length === 0) {
      console.log(chalk.yellow('Please specify a subcommand: status, search, push-all, pull, archive, register, or config'));
      console.log(chalk.gray(`
Examples:
  ${chalk.cyan('agentvault polytician -e "node server.js" status')}
  ${chalk.cyan('agentvault polytician -e "node server.js" search "user authentication"')}
  ${chalk.cyan('agentvault polytician -e "node server.js" push-all')}
  ${chalk.cyan('agentvault polytician -e "node server.js" archive <concept-uuid>')}
  ${chalk.cyan('agentvault polytician config --api-url https://agentvault.example.com')}

Concepts go to the agent's Polytician namespace (--namespace). push-all, pull
and archive use Polytician's vault_* tools, which Polytician registers only when
it is configured for AgentVault: set AGENTVAULT_API_URL and
AGENTVAULT_POLYTICIAN_API_TOKEN, which AgentVault passes to the Polytician it
starts. agentvault polytician config writes AgentVault's URL into Polytician's
config file; the token still comes from the environment.
`));
    }
  });

interface PolyticianOptions {
  entry?: string;
  namespace?: string;
  config?: string;
  healthPort?: number;
}

/**
 * The namespace this command works in: --namespace, else the name of the
 * agent whose project this directory is in (the webapp's agentId for the
 * agent), else "default".
 */
function resolveNamespace(options: PolyticianOptions): string {
  return options.namespace !== undefined
    ? checkPolyticianNamespace(options.namespace, '--namespace')
    : defaultPolyticianNamespace(nearestProjectAgentId(process.cwd()), '--namespace');
}

/**
 * Why Polytician's vault_* calls will be refused although it offers the
 * tools: it has no token to send. It registers them from its config file's
 * agentVault section, whose apiToken `agentvault polytician config` writes as
 * a ${POLYTICIAN_AV_API_TOKEN} reference, and sends the reference itself when
 * the variable is unset. Null when it has a token.
 */
function missingTokenWarning(config: MCPServerConfig): string | null {
  const childEnv = { ...process.env, ...config.env };
  if (childEnv['POLYTICIAN_AV_API_TOKEN'] || configFileHasLiteralToken(config.configPath ?? defaultPolyticianConfigPath())) {
    return null;
  }
  const how = process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] && !process.env['AGENTVAULT_API_URL']
    ? 'AgentVault passes AGENTVAULT_POLYTICIAN_API_TOKEN on only with AGENTVAULT_API_URL: set AGENTVAULT_API_URL too'
    : 'Set AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN, which AgentVault passes on';
  return `Polytician offers its vault_* tools but has no POLYTICIAN_AV_API_TOKEN to send, so AgentVault will refuse ` +
    `its requests (401 UNAUTHORIZED). ${how}, or set POLYTICIAN_AV_API_TOKEN to AgentVault's API token.`;
}

/**
 * How to start Polytician: the entry point, the namespace, the config file,
 * and AgentVault's URL and token for its vault_* tools. Throws
 * PolyticianConfigError, before anything is started, for a missing entry
 * point or a setting Polytician would refuse.
 */
function serverConfig(options: PolyticianOptions): MCPServerConfig {
  if (!options.entry) {
    throw new PolyticianConfigError('Missing -e, --entry <command>: the command that starts Polytician (e.g., "node dist/index.js")');
  }
  return polyticianServerConfig({
    entryPoint: options.entry,
    namespace: resolveNamespace(options),
    configPath: options.config,
    healthPort: options.healthPort,
  });
}

/** Connect, run, and always disconnect, so a failed call does not leave the server running. */
async function withClient<T>(
  config: MCPServerConfig,
  run: (client: PolyticianMCPClient) => Promise<T>
): Promise<T> {
  const client = new PolyticianMCPClient(config);
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.disconnect();
  }
}

/** Fail with an explanation when Polytician was not configured with the AgentVault tool a command needs. */
async function requireVaultTool(client: PolyticianMCPClient, tool: string): Promise<void> {
  const tools = await client.listTools();
  if (!tools.some(t => t.name === tool)) {
    throw new Error(vaultToolUnavailableMessage(tool));
  }
}

function errorMessage(error: unknown): string {
  // MCPToolError messages carry the tool and Polytician's error code
  const message = error instanceof Error ? error.message : 'Unknown error';
  return error instanceof MCPToolError && error.code === 'NAMESPACE_DENIED' ? `${message} (--namespace)` : message;
}

/** An archive or push that got no answer in time: it may have happened on AgentVault. */
function isOutcomeUnknown(error: unknown): error is MCPToolError {
  return error instanceof MCPToolError && error.code === 'OUTCOME_UNKNOWN';
}

polyticianCmd
  .command('status')
  .description('Probe Polytician health and get statistics')
  .action(async () => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora('Checking Polytician status...').start();

    try {
      const config = serverConfig(opts);
      if (opts.healthPort) {
        spinner.text = `Probing health endpoint at port ${opts.healthPort}...`;
        const healthy = await probeMCPServerHealth(opts.healthPort);
        if (!healthy) {
          spinner.warn(chalk.yellow(`Health endpoint not responding at port ${opts.healthPort}`));
        } else {
          spinner.text = 'Health endpoint OK, connecting via MCP...';
        }
      }

      const { serverInfo, stats, health, toolNames } = await withClient(config, async (client) => ({
        serverInfo: client.getServerInfo(),
        stats: await callPolytician(client, 'get_stats', {}),
        health: await callPolytician(client, 'health_check', {}),
        toolNames: (await client.listTools()).map(t => t.name),
      }));

      spinner.succeed(chalk.green('Polytician status retrieved'));

      console.log(chalk.cyan('\nHealth Status:'));
      console.log(`  Server:     ${health.server === 'ok' ? chalk.green('healthy') : chalk.red('unhealthy')}`);
      console.log(`  Version:    ${serverInfo ? `${serverInfo.name} ${serverInfo.version}` : 'unknown'}`);
      console.log(`  Embedding:  ${health.embedding.model}, ${health.embedding.dimension} dimensions (${health.embedding.loaded ? 'loaded' : 'loads on first use'})`);
      console.log(`  LLM:        ${health.llm.provider}`);

      console.log(chalk.cyan('\nStatistics:'));
      console.log(`  Namespace:   ${config.polyticianNamespace}`);
      console.log(`  Concepts:    ${stats.conceptCount}`);
      console.log(`  Vectors:     ${stats.vectorCount}`);
      console.log(`  Markdown:    ${stats.representationCounts.markdown}`);
      console.log(`  ThoughtForm: ${stats.representationCounts.thoughtform}`);

      const vaultTools = POLYTICIAN_VAULT_TOOLS.filter(name => toolNames.includes(name));
      console.log(vaultTools.length > 0
        ? `\nAgentVault tools: ${vaultTools.join(', ')}`
        : `\nAgentVault tools: not configured ${chalk.gray(
          '(push-all, pull and archive need them: set AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN. ' +
          "A config file from agentvault polytician config names AgentVault's URL; the token still comes from the environment)"
        )}`);
      const tokenWarning = vaultTools.length > 0 ? missingTokenWarning(config) : null;
      if (tokenWarning) {
        console.log(chalk.yellow(`Warning: ${tokenWarning}`));
      }

    } catch (error) {
      spinner.fail(chalk.red(`Failed to get status: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('search <query>')
  .description('Search concepts by semantic similarity')
  .option('-l, --limit <n>', `Maximum results to return (1-${SEARCH_K_MAX})`, parseInt, 10)
  .option('--json', 'Output the search results as JSON')
  .action(async (query, options) => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora(`Searching for: "${query}"...`).start();

    try {
      const config = serverConfig(opts);
      const { results, titles } = await withClient(config, async (client) => {
        const { results } = await callPolytician(client, 'search_concepts', {
          query,
          k: clampCount(options.limit, SEARCH_K_MAX, 10),
        });

        // 3.0 concepts have no name; the title is the markdown's first heading
        const titles = new Map<string, string>();
        if (!options.json) {
          for (const hit of results.filter(r => r.representations.markdown)) {
            try {
              const { markdown } = await callPolytician(client, 'read_concept', { id: hit.id, representations: ['markdown'] });
              titles.set(hit.id, conceptTitle(markdown, ''));
            } catch (error) {
              // A concept deleted between the search and the read keeps no title
              if (!(error instanceof MCPToolError && error.code === 'NOT_FOUND')) {
                throw error;
              }
            }
          }
        }
        return { results, titles };
      });

      // Scripts parse stdout: no hits is [], not an empty output
      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        spinner.warn(chalk.yellow(`No matching concepts found in namespace ${config.polyticianNamespace}`));
        return;
      }

      spinner.succeed(chalk.green(`Found ${results.length} matching concept(s) in namespace ${config.polyticianNamespace}`));

      console.log(chalk.cyan('\nResults (score 0-1, higher is closer):'));
      for (const hit of results) {
        const title = titles.get(hit.id) ?? '';
        const tags = hit.tags.length > 0 ? chalk.gray(` [${hit.tags.join(', ')}]`) : '';
        console.log(`  ${chalk.green(hit.id)}  ${hit.score.toFixed(3)}  ${title}${tags}`);
      }

    } catch (error) {
      spinner.fail(chalk.red(`Search failed: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('push-all')
  .description("Push every concept to AgentVault's memory_repo canister (Polytician's vault_memory_push)")
  .action(async () => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora('Pushing concepts to memory_repo...').start();

    try {
      const config = serverConfig(opts);
      const where = `in namespace ${config.polyticianNamespace}`;
      const { pushed, total, errors, unknown } = await withClient(config, async (client) => {
        await requireVaultTool(client, 'vault_memory_push');

        const conceptIds: string[] = [];
        for (let offset = 0; ; offset += LIST_LIMIT_MAX) {
          const page = await callPolytician(client, 'list_concepts', { limit: LIST_LIMIT_MAX, offset });
          conceptIds.push(...page.concepts.map(c => c.id));
          if (page.concepts.length === 0 || conceptIds.length >= page.total) break;
        }

        let pushed = 0;
        let unknown = 0;
        const errors: string[] = [];
        for (const [index, conceptId] of conceptIds.entries()) {
          spinner.text = `Pushing concept ${index + 1} of ${conceptIds.length}...`;
          try {
            await callPolytician(client, 'vault_memory_push', { conceptId });
            pushed++;
          } catch (error) {
            if (isOutcomeUnknown(error)) {
              unknown++;
            }
            errors.push(`${conceptId}: ${errorMessage(error)}`);
          }
        }
        return { pushed, total: conceptIds.length, errors, unknown };
      });

      if (errors.length > 0) {
        const failed = errors.length - unknown;
        const notPushed = [failed > 0 ? `${failed} failed` : '', unknown > 0 ? `${unknown} with unknown outcome` : '']
          .filter(Boolean)
          .join(', ');
        spinner.warn(chalk.yellow(`Pushed ${pushed} of ${total} concepts ${where} to memory_repo; ${notPushed}`));
        for (const err of errors) {
          console.log(chalk.gray(`  - ${err}`));
        }
        process.exit(1);
      } else {
        spinner.succeed(chalk.green(`Pushed ${pushed} of ${total} concepts ${where} to memory_repo`));
      }

    } catch (error) {
      spinner.fail(chalk.red(`Push failed: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('pull')
  .description("Pull the namespace's concepts from AgentVault's memory_repo canister (Polytician's vault_memory_pull)")
  .action(async () => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora('Pulling concepts from memory_repo...').start();

    try {
      // Polytician imports only the entries recorded for this namespace and reports the others as skipped
      const config = serverConfig(opts);
      const data = await withClient(config, async (client) => {
        await requireVaultTool(client, 'vault_memory_pull');
        return callPolytician(client, 'vault_memory_pull', {});
      });

      const skipped = data.skipped ?? [];
      spinner.succeed(chalk.green(
        `Pulled ${data.branch} @ ${data.headSha} into namespace ${config.polyticianNamespace}: ${data.imported} imported, ${skipped.length} skipped`
      ));
      for (const entry of skipped) {
        console.log(chalk.gray(`  - ${entry.key}: ${entry.reason}`));
      }

    } catch (error) {
      spinner.fail(chalk.red(`Pull failed: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('archive <conceptId>')
  .description("Archive a concept to Arweave permanent storage (Polytician's vault_archive_concept; permanent and paid)")
  .action(async (conceptId) => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora(`Archiving concept ${conceptId} to Arweave...`).start();

    try {
      const data = await withClient(serverConfig(opts), async (client) => {
        await requireVaultTool(client, 'vault_archive_concept');
        return callPolytician(client, 'vault_archive_concept', { conceptId });
      });

      spinner.succeed(chalk.green(`Concept archived successfully`));
      console.log(chalk.cyan('\nArweave Receipt:'));
      console.log(`  TX ID: ${data.txId}`);
      console.log(`  URL:   ${chalk.blue(data.url)}`);
      console.log(`  Size:  ${data.size} bytes${data.encrypted ? ' (encrypted)' : ''}`);

    } catch (error) {
      if (isOutcomeUnknown(error)) {
        // Not "failed": the paid upload may have completed
        spinner.warn(chalk.yellow(errorMessage(error)));
      } else {
        spinner.fail(chalk.red(`Archive failed: ${errorMessage(error)}`));
      }
      process.exit(1);
    }
  });

polyticianCmd
  .command('register')
  .description('Register Polytician MCP server in the canister')
  .option('-c, --canister <id>', 'Canister ID to register with')
  .action(async (options) => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const spinner = ora('Registering Polytician MCP server...').start();

    try {
      const config = serverConfig(opts);
      spinner.text = 'Discovering available tools...';
      const tools = await withClient(config, client => client.listTools());

      spinner.text = `Found ${tools.length} tools, registering...`;

      console.log(chalk.cyan('\nPolytician MCP Server Registration:'));
      console.log(`  Server:      ${config.namespace}`);
      console.log(`  Namespace:   ${config.polyticianNamespace} ${chalk.gray('(Polytician namespace of the agent\'s concepts)')}`);
      console.log(`  Entry Point: ${config.entryPoint}`);
      if (opts.healthPort) {
        console.log(`  Health Port: ${opts.healthPort}`);
      }
      console.log(`  Tools:       ${tools.slice(0, 5).map(t => t.name).join(', ')}${tools.length > 5 ? '...' : ''} (${tools.length} total)`);

      if (options.canister) {
        console.log(`  Canister:    ${options.canister}`);
        spinner.warn(chalk.yellow('Canister registration requires Motoko canister implementation'));
      } else {
        spinner.warn(chalk.yellow('No canister ID specified – registration stored locally only'));
      }

      console.log(chalk.gray('\nUse "agentvault mcp register" to complete canister registration.'));

    } catch (error) {
      spinner.fail(chalk.red(`Registration failed: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('config')
  .description(
    "Write Polytician's config file with AgentVault's URL, so Polytician registers its vault_* tools " +
      '(no secret is written: the token is read from POLYTICIAN_AV_API_TOKEN)'
  )
  .option('--api-url <url>', "AgentVault's base URL, https or http on localhost (default: AGENTVAULT_API_URL)")
  .option('--branch <name>', 'memory_repo branch Polytician syncs with', 'polytician-main')
  .option(
    '--archival-tag <tag>',
    'Turn on Arweave archival for concepts carrying this tag (repeat for several; a concept needs every one). Permanent, public and paid',
    (tag: string, tags: string[]) => [...tags, tag],
    [] as string[]
  )
  .option('--arweave-jwk <path>', 'Arweave wallet (JWK) file that pays for archival uploads (needed with --archival-tag)')
  .option('--no-archival', "Turn archival off: remove an existing file's archival settings (needs --force)")
  .option(
    '--force',
    "Update an existing file: set agentVault's URL, token reference and branch (and archival, when given), keep every other setting"
  )
  .action((options: { apiUrl?: string; branch: string; archivalTag: string[]; arweaveJwk?: string; archival: boolean; force?: boolean }) => {
    const opts = polyticianCmd.opts<PolyticianOptions>();
    const target = opts.config ?? defaultPolyticianConfigPath();

    try {
      const apiBaseUrl = options.apiUrl ?? process.env['AGENTVAULT_API_URL'];
      if (!apiBaseUrl) {
        throw new PolyticianConfigError("Give AgentVault's base URL with --api-url, or set AGENTVAULT_API_URL");
      }
      const problem = agentVaultUrlProblem(apiBaseUrl, options.apiUrl !== undefined ? '--api-url' : 'AGENTVAULT_API_URL');
      if (problem) {
        throw new PolyticianConfigError(problem);
      }
      if (options.archivalTag.length > 0 && !options.arweaveJwk) {
        throw new PolyticianConfigError('--archival-tag needs --arweave-jwk <path>: the Arweave wallet that pays for the uploads');
      }
      if (options.arweaveJwk && options.archivalTag.length === 0) {
        throw new PolyticianConfigError('--arweave-jwk needs at least one --archival-tag: Polytician archives only concepts carrying every listed tag');
      }
      if (!options.archival && (options.arweaveJwk || options.archivalTag.length > 0)) {
        throw new PolyticianConfigError('--no-archival turns archival off; it cannot be given with --archival-tag or --arweave-jwk');
      }

      const config = buildPolyticianConfig({
        apiBaseUrl,
        memoryRepoBranch: options.branch,
        archival: options.arweaveJwk ? { tags: options.archivalTag, arweaveJwk: options.arweaveJwk } : undefined,
      });
      const written = writePolyticianConfigFile(target, config, { force: options.force === true, removeArchival: !options.archival });
      const { agentVault } = config;

      console.log(chalk.green(`${written.replaced ? 'Updated' : 'Wrote'} ${written.path} (readable by you only)`));
      console.log(`  agentVault.apiBaseUrl:       ${agentVault.apiBaseUrl}`);
      console.log(`  agentVault.apiToken:         ${POLYTICIAN_API_TOKEN_REFERENCE} ${chalk.gray('(Polytician reads it from its environment)')}`);
      console.log(`  agentVault.memoryRepoBranch: ${agentVault.memoryRepoBranch}`);
      console.log(`  agentVault.archival:         ${agentVault.archival
        ? `on for concepts tagged ${agentVault.archival.tagFilter.join(' and ')}, paid from ${agentVault.archival.arweaveJwk}`
        : written.kept.includes('archival') ? 'as it was (use --no-archival to turn it off)' : 'off'}`);
      if (written.kept.length > 0) {
        console.log(chalk.gray(`Kept the file's other agentVault settings: ${written.kept.join(', ')}`));
      }

      if (agentVault.archival) {
        console.log(chalk.yellow(`
Warning: Arweave uploads are permanent, public and paid. With archival on,
Polytician uploads every concept carrying all of these tags (${agentVault.archival.tagFilter.join(', ')}) each time it is
saved or updated, and vault_archive_concept uploads one on request. An upload
cannot be deleted, anyone can fetch it, and each one is paid from the wallet.
Polytician encrypts the content with its backup key first, and will not start
without one: set POLYTICIAN_BACKUP_KEY, or create its backup.key file.`));
      }

      if (process.env['AGENTVAULT_POLYTICIAN_API_TOKEN'] && !process.env['AGENTVAULT_API_URL']) {
        console.log(chalk.yellow(`
AGENTVAULT_API_URL is not set, so AgentVault will not pass AGENTVAULT_POLYTICIAN_API_TOKEN to the Polytician
it starts, and Polytician would send the ${POLYTICIAN_API_TOKEN_REFERENCE} reference itself. Set
AGENTVAULT_API_URL too (${agentVault.apiBaseUrl}), or set POLYTICIAN_AV_API_TOKEN to AgentVault's API token.`));
      }

      const usage = opts.config
        ? `Pass the file to Polytician with --config ${written.path} (agentvault polytician --config, agentvault orchestrate --polytician-config).`
        : 'Polytician reads this file when it starts without --config.';
      console.log(chalk.gray(`
${usage}
Polytician needs POLYTICIAN_AV_API_TOKEN in its environment: without it, it sends the reference itself
and AgentVault refuses the request. AgentVault sets it (and POLYTICIAN_AV_API_URL) for the Polytician it
starts when AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN are set. For Polytician started by
another MCP client, set POLYTICIAN_AV_API_TOKEN to AgentVault's AGENTVAULT_POLYTICIAN_API_TOKEN.`));
    } catch (error) {
      console.error(chalk.red(`Could not write Polytician's config: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

export { polyticianCmd };
