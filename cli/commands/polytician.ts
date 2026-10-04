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

const polyticianCmd = new Command('polytician');

polyticianCmd
  .description('Manage Polytician semantic memory integration')
  .requiredOption('-e, --entry <command>', 'Polytician MCP server entry point (e.g., "node server.js")')
  .option('-n, --namespace <name>', 'Namespace for the server', 'polytician')
  .option('-p, --health-port <port>', "HTTP health port of a running Polytician (its POLYTICIAN_HEALTH_PORT; off by default)", parseInt)
  .action((_options, command) => {
    if (command instanceof Command && command.args.length === 0) {
      console.log(chalk.yellow('Please specify a subcommand: status, search, push-all, pull, archive, or register'));
      console.log(chalk.gray(`
Examples:
  ${chalk.cyan('agentvault polytician -e "node server.js" status')}
  ${chalk.cyan('agentvault polytician -e "node server.js" search "user authentication"')}
  ${chalk.cyan('agentvault polytician -e "node server.js" push-all')}
  ${chalk.cyan('agentvault polytician -e "node server.js" archive <concept-uuid>')}

push-all, pull and archive use Polytician's vault_* tools, which Polytician
registers only when POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN are set.
`));
    }
  });

function createClient(options: { entry: string; namespace: string; healthPort?: number }): PolyticianMCPClient {
  const config: MCPServerConfig = {
    namespace: options.namespace,
    entryPoint: options.entry,
    healthPort: options.healthPort,
  };
  return new PolyticianMCPClient(config);
}

/** Connect, run, and always disconnect, so a failed call does not leave the server running. */
async function withClient<T>(
  options: { entry: string; namespace: string; healthPort?: number },
  run: (client: PolyticianMCPClient) => Promise<T>
): Promise<T> {
  const client = createClient(options);
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
  return error instanceof Error ? error.message : 'Unknown error';
}

/** An archive or push that got no answer in time: it may have happened on AgentVault. */
function isOutcomeUnknown(error: unknown): error is MCPToolError {
  return error instanceof MCPToolError && error.code === 'OUTCOME_UNKNOWN';
}

polyticianCmd
  .command('status')
  .description('Probe Polytician health and get statistics')
  .action(async () => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string; healthPort?: number }>();
    const spinner = ora('Checking Polytician status...').start();

    try {
      if (opts.healthPort) {
        spinner.text = `Probing health endpoint at port ${opts.healthPort}...`;
        const healthy = await probeMCPServerHealth(opts.healthPort);
        if (!healthy) {
          spinner.warn(chalk.yellow(`Health endpoint not responding at port ${opts.healthPort}`));
        } else {
          spinner.text = 'Health endpoint OK, connecting via MCP...';
        }
      }

      const { serverInfo, stats, health, toolNames } = await withClient(opts, async (client) => ({
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
      console.log(`  Concepts:    ${stats.conceptCount}`);
      console.log(`  Vectors:     ${stats.vectorCount}`);
      console.log(`  Markdown:    ${stats.representationCounts.markdown}`);
      console.log(`  ThoughtForm: ${stats.representationCounts.thoughtform}`);

      const vaultTools = POLYTICIAN_VAULT_TOOLS.filter(name => toolNames.includes(name));
      console.log(vaultTools.length > 0
        ? `\nAgentVault tools: ${vaultTools.join(', ')}`
        : `\nAgentVault tools: not configured ${chalk.gray('(push-all, pull and archive need POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN set for Polytician)')}`);

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
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora(`Searching for: "${query}"...`).start();

    try {
      const { results, titles } = await withClient(opts, async (client) => {
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
        spinner.warn(chalk.yellow('No matching concepts found'));
        return;
      }

      spinner.succeed(chalk.green(`Found ${results.length} matching concept(s)`));

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
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora('Pushing concepts to memory_repo...').start();

    try {
      const { pushed, total, errors, unknown } = await withClient(opts, async (client) => {
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
        spinner.warn(chalk.yellow(`Pushed ${pushed} of ${total} concepts to memory_repo; ${notPushed}`));
        for (const err of errors) {
          console.log(chalk.gray(`  - ${err}`));
        }
        process.exit(1);
      } else {
        spinner.succeed(chalk.green(`Pushed ${pushed} of ${total} concepts to memory_repo`));
      }

    } catch (error) {
      spinner.fail(chalk.red(`Push failed: ${errorMessage(error)}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('pull')
  .description("Pull concepts from AgentVault's memory_repo canister (Polytician's vault_memory_pull)")
  .action(async () => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora('Pulling concepts from memory_repo...').start();

    try {
      const data = await withClient(opts, async (client) => {
        await requireVaultTool(client, 'vault_memory_pull');
        return callPolytician(client, 'vault_memory_pull', {});
      });

      const skipped = data.skipped ?? [];
      spinner.succeed(chalk.green(`Pulled ${data.branch} @ ${data.headSha}: ${data.imported} imported, ${skipped.length} skipped`));
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
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora(`Archiving concept ${conceptId} to Arweave...`).start();

    try {
      const data = await withClient(opts, async (client) => {
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
    const opts = polyticianCmd.opts<{ entry: string; namespace: string; healthPort?: number }>();
    const spinner = ora('Registering Polytician MCP server...').start();

    try {
      spinner.text = 'Discovering available tools...';
      const tools = await withClient(opts, client => client.listTools());

      spinner.text = `Found ${tools.length} tools, registering...`;

      console.log(chalk.cyan('\nPolytician MCP Server Registration:'));
      console.log(`  Namespace:   ${opts.namespace}`);
      console.log(`  Entry Point: ${opts.entry}`);
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

export { polyticianCmd };
