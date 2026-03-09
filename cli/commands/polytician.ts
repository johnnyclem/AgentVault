import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  PolyticianMCPClient,
  probeMCPServerHealth,
  type MCPServerConfig,
} from '../../src/orchestration/mcp-client.js';

const polyticianCmd = new Command('polytician');

polyticianCmd
  .description('Manage Polytician semantic memory integration')
  .requiredOption('-e, --entry <command>', 'Polytician MCP server entry point (e.g., "node server.js")')
  .option('-n, --namespace <name>', 'Namespace for the server', 'polytician')
  .option('-p, --health-port <port>', 'Health check HTTP port', parseInt)
  .action((_options, command) => {
    if (command instanceof Command && command.args.length === 0) {
      console.log(chalk.yellow('Please specify a subcommand: status, search, push-all, pull, archive, or register'));
      console.log(chalk.gray(`
Examples:
  ${chalk.cyan('agentvault polytician -e "node server.js" status')}
  ${chalk.cyan('agentvault polytician -e "node server.js" search "user authentication"')}
  ${chalk.cyan('agentvault polytician -e "node server.js" push-all')}
  ${chalk.cyan('agentvault polytician -e "node server.js" archive concept-123')}
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

      const client = createClient(opts);
      await client.connect();

      const statsResult = await client.callTool('get_stats', {});
      const healthResult = await client.callTool('health_check', {});

      await client.disconnect();

      spinner.succeed(chalk.green('Polytician status retrieved'));

      console.log(chalk.cyan('\nHealth Status:'));
      const healthData = healthResult.content[0]?.data as Record<string, unknown> | undefined;
      if (healthData) {
        console.log(`  Status:     ${healthData.status === 'ok' ? chalk.green('healthy') : chalk.red('unhealthy')}`);
        console.log(`  Version:    ${healthData.version ?? 'unknown'}`);
      }

      console.log(chalk.cyan('\nStatistics:'));
      const statsData = statsResult.content[0]?.data as Record<string, unknown> | undefined;
      if (statsData) {
        console.log(`  Concepts:   ${statsData.totalConcepts ?? statsData.concepts ?? 0}`);
        console.log(`  Relations:  ${statsData.totalRelations ?? statsData.relations ?? 0}`);
        console.log(`  Embeddings: ${statsData.embeddingsCached ?? statsData.embeddings ?? 0}`);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Failed to get status: ${message}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('search <query>')
  .description('Search concepts by semantic similarity')
  .option('-l, --limit <n>', 'Maximum results to return', parseInt, 10)
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora(`Searching for: "${query}"...`).start();

    try {
      const client = createClient(opts);
      await client.connect();

      const result = await client.callTool('search_concepts', {
        query,
        limit: options.limit,
      });

      await client.disconnect();

      const searchData = result.content[0]?.data as { concepts?: Array<{
        id: string;
        name: string;
        score?: number;
        representation?: string;
      }> } | undefined;

      const concepts = searchData?.concepts ?? [];

      if (concepts.length === 0) {
        spinner.warn(chalk.yellow('No matching concepts found'));
        return;
      }

      spinner.succeed(chalk.green(`Found ${concepts.length} matching concept(s)`));

      if (options.json) {
        console.log(JSON.stringify(concepts, null, 2));
        return;
      }

      console.log(chalk.cyan('\nResults:'));
      for (const concept of concepts) {
        const score = concept.score ? chalk.gray(` (${(concept.score * 100).toFixed(1)}%)`) : '';
        const type = concept.representation ? chalk.magenta(`[${concept.representation}]`) : '';
        console.log(`  ${chalk.green(concept.id)} ${type} ${concept.name}${score}`);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Search failed: ${message}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('push-all')
  .description('Push all concepts to memory_repo canister')
  .action(async () => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora('Pushing concepts to memory_repo...').start();

    try {
      const client = createClient(opts);
      await client.connect();

      const result = await client.callTool('push_to_memory_repo', {});

      await client.disconnect();

      const data = result.content[0]?.data as { pushed?: number; errors?: string[] } | undefined;

      if (data?.errors && data.errors.length > 0) {
        spinner.warn(chalk.yellow(`Pushed ${data.pushed ?? 0} concepts with ${data.errors.length} errors`));
        for (const err of data.errors) {
          console.log(chalk.gray(`  - ${err}`));
        }
      } else {
        spinner.succeed(chalk.green(`Pushed ${data?.pushed ?? 0} concepts to memory_repo`));
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Push failed: ${message}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('pull')
  .description('Pull concepts from memory_repo canister')
  .action(async () => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora('Pulling concepts from memory_repo...').start();

    try {
      const client = createClient(opts);
      await client.connect();

      const result = await client.callTool('pull_from_memory_repo', {});

      await client.disconnect();

      const data = result.content[0]?.data as { pulled?: number; added?: number; updated?: number } | undefined;

      spinner.succeed(chalk.green(`Pulled ${data?.pulled ?? 0} concepts (${data?.added ?? 0} added, ${data?.updated ?? 0} updated)`));

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Pull failed: ${message}`));
      process.exit(1);
    }
  });

polyticianCmd
  .command('archive <conceptId>')
  .description('Archive a concept to Arweave permanent storage')
  .action(async (conceptId) => {
    const opts = polyticianCmd.opts<{ entry: string; namespace: string }>();
    const spinner = ora(`Archiving concept ${conceptId} to Arweave...`).start();

    try {
      const client = createClient(opts);
      await client.connect();

      const result = await client.callTool('archive_concept', { id: conceptId });

      await client.disconnect();

      const data = result.content[0]?.data as { txId?: string; url?: string } | undefined;

      if (data?.txId) {
        spinner.succeed(chalk.green(`Concept archived successfully`));
        console.log(chalk.cyan('\nArweave Receipt:'));
        console.log(`  TX ID: ${data.txId}`);
        if (data.url) {
          console.log(`  URL:   ${chalk.blue(data.url)}`);
        }
      } else {
        spinner.warn(chalk.yellow('Archive completed but no transaction ID returned'));
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Archive failed: ${message}`));
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
      const client = createClient(opts);
      await client.connect();

      const tools = await client.listTools();
      await client.disconnect();

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
      const message = error instanceof Error ? error.message : 'Unknown error';
      spinner.fail(chalk.red(`Registration failed: ${message}`));
      process.exit(1);
    }
  });

export { polyticianCmd };
