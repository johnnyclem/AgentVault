/**
 * `agentvault total-recall` — a write-once/read-many archive of agent memories
 *
 *   init [dir]                         Create a volume (default .agentvault/total-recall)
 *   status                             Counts, chain heads, policy, last anchor
 *   policy [--transcript off|append] [--record-recalls on|off] [--webhook <url>] [--hook <argv>] [--provider <name>]
 *   record --op <op> --provider <p> --key <k> --content <text>
 *   log [--since <seq>] [--op <op>] [--provider <p>] [--limit <n>]
 *   list [--provider <p>] [--deleted]
 *   search <query>
 *   history --provider <p> --key <k>
 *   verify
 *   anchor [--canister-id <id>] [--host <url>] [--identity <pem>]
 *   import chatgpt <conversations.json> | memories <file> --provider <p>
 *   watch [--hook <argv>] [--webhook <url>] [--since <seq>] [--once]
 *   stenographer [--mode live|catchup] [--db <path>] [--run]
 *
 * The MCP tools (`agentvault mcp serve`) are the way assistants write; this
 * command group is how a person inspects, imports into, and watches the
 * same volume.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  DEFAULT_VOLUME_DIR,
  MEMORY_OPS,
  TotalRecallVolume,
  importChatGptConversations,
  importMemoryList,
  notifyEvent,
  policyInstructions,
  watchVolume,
  type MemoryEvent,
  type MemoryOp,
  type TotalRecallPolicy,
} from '../../src/total-recall/index.js';

const totalRecallCmd = new Command('total-recall');

/** Volume dir from `--volume`, env, or the project default. */
function volumeDir(options: { volume?: string }): string {
  return path.resolve(options.volume ?? process.env.AGENTVAULT_TOTAL_RECALL_DIR ?? DEFAULT_VOLUME_DIR);
}

function openVolume(options: { volume?: string }): TotalRecallVolume {
  return TotalRecallVolume.open(volumeDir(options));
}

function die(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function parseOp(value: string): MemoryOp {
  if (!(MEMORY_OPS as readonly string[]).includes(value)) die(`--op must be one of ${MEMORY_OPS.join(', ')}`);
  return value as MemoryOp;
}

function printEvent(event: MemoryEvent): void {
  const who = [event.source.provider, event.source.agent].filter(Boolean).join('/');
  const preview = event.memory.content.replace(/\s+/g, ' ').slice(0, 90);
  console.log(
    `${chalk.gray(String(event.seq).padStart(6))} ${chalk.gray(event.ts)} ${chalk.cyan(event.op.padEnd(8))} ${chalk.yellow(who)} ${chalk.bold(event.memory.key)}${event.memory.title ? ` — ${event.memory.title}` : ''}`,
  );
  if (preview) console.log(`       ${preview}${event.memory.content.length > 90 ? '…' : ''}`);
}

totalRecallCmd
  .alias('tr')
  .description('Write-once/read-many archive of agent memories, with an optional append-only transcript')
  .option('--volume <dir>', 'Volume directory (default .agentvault/total-recall, or $AGENTVAULT_TOTAL_RECALL_DIR)')
  .action(() => {
    console.log(chalk.yellow('Specify a subcommand:'));
    console.log(
      chalk.gray(`
  ${chalk.cyan('agentvault total-recall init')}                         Create a volume
  ${chalk.cyan('agentvault total-recall status')}                       Counts, heads, policy
  ${chalk.cyan('agentvault total-recall policy --transcript append')}   Turn full-transcript mode on
  ${chalk.cyan('agentvault total-recall log --since 0')}                Memory events in order
  ${chalk.cyan('agentvault total-recall search "coffee"')}              Search current memories
  ${chalk.cyan('agentvault total-recall verify')}                       Re-check both hash chains
  ${chalk.cyan('agentvault total-recall import chatgpt conversations.json')}
  ${chalk.cyan('agentvault total-recall watch --hook ./ingest.sh')}      Run a hook per new event
  ${chalk.cyan('agentvault total-recall stenographer --run')}            Index the transcript with stenographer
  ${chalk.cyan('agentvault mcp serve')}                                 Serve the total_recall_* MCP tools
`),
    );
  });

totalRecallCmd
  .command('init')
  .description('Create a total-recall volume')
  .argument('[dir]', 'Volume directory')
  .option('--transcript <mode>', 'off | append', 'off')
  .option('--id <volumeId>', 'Volume id (default: random)')
  .action((dir: string | undefined, options: { transcript: string; id?: string }, cmd: Command) => {
    const parent = cmd.parent!.opts<{ volume?: string }>();
    const target = dir ? path.resolve(dir) : volumeDir(parent);
    if (options.transcript !== 'off' && options.transcript !== 'append') die('--transcript must be off or append');
    try {
      const volume = TotalRecallVolume.init(target, {
        volumeId: options.id,
        policy: { transcript: options.transcript },
      });
      console.log(chalk.green(`✔ Created total-recall volume ${volume.volumeId} at ${target}`));
      console.log(chalk.gray('\nServe it to your assistants with:'));
      console.log(chalk.cyan(`  agentvault mcp serve --total-recall ${target}`));
      console.log(chalk.gray('\nGuardrail every connected assistant receives:\n'));
      console.log(policyInstructions(volume.policy, { volumeId: volume.volumeId }));
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('status')
  .description('Counts, chain heads, policy, last anchor')
  .option('--json', 'Output as JSON')
  .action((options: { json?: boolean }, cmd: Command) => {
    try {
      const status = openVolume(cmd.parent!.opts()).status();
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(chalk.bold(`Total-recall volume ${status.volumeId}`) + chalk.gray(`  (${status.dir})`));
      console.log(`  created        ${status.createdAt}`);
      console.log(
        `  memories       ${status.memories.events} events, ${status.memories.current} current, ${status.memories.deleted} deleted`,
      );
      for (const [provider, n] of Object.entries(status.memories.providers)) console.log(`                 ${provider}: ${n}`);
      console.log(`  memories head  ${status.memories.head ?? chalk.gray('(empty)')}`);
      console.log(
        `  transcript     ${status.policy.transcript === 'append' ? chalk.green('append') : chalk.gray('off')}, ${status.transcript.messages} messages in ${status.transcript.sessions} sessions`,
      );
      console.log(`  transcript head ${status.transcript.head ?? chalk.gray('(empty)')}`);
      console.log(`  record ops     ${status.policy.recordOps.join(', ')}`);
      console.log(`  providers      ${status.policy.providers.length ? status.policy.providers.join(', ') : 'any'}`);
      console.log(
        `  sinks          ${status.policy.webhooks.length} webhook(s)${status.policy.hookCommand ? `, hook: ${status.policy.hookCommand.join(' ')}` : ''}`,
      );
      console.log(
        `  last anchor    ${status.lastAnchor ? `${status.lastAnchor.ts} → ${status.lastAnchor.target}${status.lastAnchor.ref ? ` (${status.lastAnchor.ref})` : ''}` : chalk.gray('none')}`,
      );
      if (status.tornTail.memories || status.tornTail.transcript) {
        console.log(chalk.yellow('  ⚠ a torn tail (interrupted write) will be truncated on the next append'));
      }
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('policy')
  .description('Show or change the guardrail policy (the archive files are never touched)')
  .option('--transcript <mode>', 'off | append')
  .option('--record-recalls <onoff>', 'on | off: whether "recalled" events are kept')
  .option('--provider <name...>', 'Only these providers may write (repeatable); "any" clears')
  .option('--webhook <url...>', 'POST each memory event here (loopback unless --allow-remote)')
  .option('--allow-remote', 'Allow non-loopback webhooks')
  .option('--clear-webhooks', 'Remove every webhook')
  .option('--hook <argv>', 'Command (JSON array or space-separated) run per event with the event on stdin')
  .option('--clear-hook', 'Remove the hook command')
  .option('--json', 'Output as JSON')
  .action(
    (
      options: {
        transcript?: string;
        recordRecalls?: string;
        provider?: string[];
        webhook?: string[];
        allowRemote?: boolean;
        clearWebhooks?: boolean;
        hook?: string;
        clearHook?: boolean;
        json?: boolean;
      },
      cmd: Command,
    ) => {
      try {
        const volume = openVolume(cmd.parent!.opts());
        const patch: Partial<TotalRecallPolicy> = {};
        if (options.transcript !== undefined) {
          if (options.transcript !== 'off' && options.transcript !== 'append') die('--transcript must be off or append');
          patch.transcript = options.transcript;
        }
        if (options.recordRecalls !== undefined) {
          const ops = volume.policy.recordOps.filter((o) => o !== 'recalled');
          patch.recordOps = options.recordRecalls === 'on' ? [...ops, 'recalled'] : ops;
        }
        if (options.provider) patch.providers = options.provider.includes('any') ? [] : options.provider.map((p) => p.toLowerCase());
        if (options.clearWebhooks) patch.webhooks = [];
        if (options.webhook) {
          patch.webhooks = [
            ...(patch.webhooks ?? volume.policy.webhooks),
            ...options.webhook.map((url) => ({ url, allowRemote: Boolean(options.allowRemote) })),
          ];
        }
        if (options.clearHook) patch.hookCommand = undefined;
        if (options.hook) {
          let argv: string[];
          try {
            const parsed = JSON.parse(options.hook) as unknown;
            argv = Array.isArray(parsed) ? parsed.map(String) : options.hook.split(/\s+/);
          } catch {
            argv = options.hook.split(/\s+/).filter(Boolean);
          }
          patch.hookCommand = argv;
        }
        const policy = Object.keys(patch).length > 0 ? volume.setPolicy(patch) : volume.policy;
        if (options.json) {
          console.log(JSON.stringify({ policy, instructions: policyInstructions(policy, { volumeId: volume.volumeId }) }, null, 2));
          return;
        }
        if (Object.keys(patch).length > 0) console.log(chalk.green('✔ Policy updated'));
        console.log(JSON.stringify(policy, null, 2));
        console.log(chalk.gray('\nGuardrail every connected assistant receives:\n'));
        console.log(policyInstructions(policy, { volumeId: volume.volumeId }));
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
    },
  );

totalRecallCmd
  .command('record')
  .description('Append a memory event by hand')
  .requiredOption('--op <op>', `One of ${MEMORY_OPS.join(', ')}`)
  .requiredOption('--provider <name>', 'Provider the memory belongs to (chatgpt, claude, ...)')
  .requiredOption('--key <key>', 'Stable memory key')
  .option('--content <text>', 'Memory content (or pipe it on stdin)')
  .option('--title <title>')
  .option('--tag <tag...>')
  .option('--agent <agent>')
  .option('--session <session>')
  .action(
    async (
      options: { op: string; provider: string; key: string; content?: string; title?: string; tag?: string[]; agent?: string; session?: string },
      cmd: Command,
    ) => {
      try {
        const volume = TotalRecallVolume.openOrInit(volumeDir(cmd.parent!.opts()));
        const content = options.content ?? (process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8'));
        const event = volume.appendMemoryEvent({
          op: parseOp(options.op),
          source: { provider: options.provider.toLowerCase(), agent: options.agent, session: options.session },
          memory: { key: options.key, content, title: options.title, tags: options.tag },
        });
        const results = await notifyEvent(volume.policy, event, { volumeId: volume.volumeId });
        for (const r of results) if (!r.ok) console.error(chalk.yellow(`delivery to ${r.sink} failed: ${r.error}`));
        console.log(chalk.green(`✔ Recorded seq ${event.seq}`) + chalk.gray(`  ${event.hash}`));
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
    },
  );

totalRecallCmd
  .command('log')
  .description('Memory events in order')
  .option('--since <seq>', 'Events after this seq', '0')
  .option('--op <op>', 'Only this op')
  .option('--provider <name>')
  .option('--limit <n>', 'Max events', '50')
  .option('--json', 'One JSON line per event')
  .action((options: { since: string; op?: string; provider?: string; limit: string; json?: boolean }, cmd: Command) => {
    try {
      const events = openVolume(cmd.parent!.opts()).readMemoryEvents({
        sinceSeq: Number(options.since) || 0,
        ops: options.op ? [parseOp(options.op)] : undefined,
        provider: options.provider?.toLowerCase(),
        limit: Number(options.limit) || 50,
      });
      if (options.json) {
        for (const e of events) console.log(JSON.stringify(e));
        return;
      }
      if (events.length === 0) console.log(chalk.gray('(no events)'));
      for (const e of events) printEvent(e);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('list')
  .description('Current memories, folded from their events')
  .option('--provider <name>')
  .option('--deleted', 'Include deleted memories')
  .option('--json')
  .action((options: { provider?: string; deleted?: boolean; json?: boolean }, cmd: Command) => {
    try {
      const memories = openVolume(cmd.parent!.opts()).foldMemories({
        provider: options.provider?.toLowerCase(),
        includeDeleted: options.deleted,
      });
      if (options.json) {
        console.log(JSON.stringify(memories, null, 2));
        return;
      }
      if (memories.length === 0) console.log(chalk.gray('(no memories)'));
      for (const m of memories) {
        console.log(
          `${m.deleted ? chalk.red('✗') : chalk.green('•')} ${chalk.yellow(m.provider)} ${chalk.bold(m.key)}${m.title ? ` — ${m.title}` : ''} ${chalk.gray(`v${m.versions}, ${m.recalls} recalls`)}`,
        );
        console.log(`    ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('search')
  .description('Lexical search over current memories')
  .argument('<query>')
  .option('--limit <n>', 'Max results', '10')
  .option('--provider <name>')
  .option('--json')
  .action((query: string, options: { limit: string; provider?: string; json?: boolean }, cmd: Command) => {
    try {
      const results = openVolume(cmd.parent!.opts()).searchMemories(query, {
        limit: Number(options.limit) || 10,
        provider: options.provider?.toLowerCase(),
      });
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (results.length === 0) console.log(chalk.gray('(no matches)'));
      for (const r of results) {
        console.log(`${chalk.gray(r.score.toFixed(3))} ${chalk.yellow(r.memory.provider)} ${chalk.bold(r.memory.key)}${r.memory.title ? ` — ${r.memory.title}` : ''}`);
        console.log(`      ${r.memory.content.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('history')
  .description('Every version and recall of one memory')
  .requiredOption('--provider <name>')
  .requiredOption('--key <key>')
  .option('--json')
  .action((options: { provider: string; key: string; json?: boolean }, cmd: Command) => {
    try {
      const events = openVolume(cmd.parent!.opts()).memoryHistory(options.provider.toLowerCase(), options.key);
      if (options.json) {
        for (const e of events) console.log(JSON.stringify(e));
        return;
      }
      if (events.length === 0) console.log(chalk.gray('(no events for that memory)'));
      for (const e of events) printEvent(e);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('verify')
  .description('Re-walk both hash chains and check them against the last anchor')
  .option('--json')
  .action((options: { json?: boolean }, cmd: Command) => {
    try {
      const result = openVolume(cmd.parent!.opts()).verify();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const mark = (ok: boolean): string => (ok ? chalk.green('✔') : chalk.red('✗'));
        console.log(`${mark(result.memories.valid)} memories.jsonl    ${result.memories.count} events, head ${result.memories.head ?? '(empty)'}`);
        console.log(`${mark(result.transcript.valid)} transcript.jsonl  ${result.transcript.count} messages, head ${result.transcript.head ?? '(empty)'}`);
        console.log(
          `${mark(result.anchor.consistent)} anchor            ${result.anchor.record ? `${result.anchor.record.ts} → ${result.anchor.record.target}` : 'none recorded'}`,
        );
        for (const e of [...result.memories.errors, ...result.transcript.errors, ...result.anchor.errors]) console.log(chalk.red(`  ${e}`));
      }
      if (!result.valid) process.exit(1);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('anchor')
  .description('Record the current chain heads locally and, with --canister-id, as a signed MemoryRepo commit')
  .option('--canister-id <id>', 'MemoryRepo canister to commit the heads to')
  .option('--host <url>', 'ICP host (default: local replica or ic)')
  .option('--identity <pem>', 'Identity PEM file used to sign the commit')
  .action(async (options: { canisterId?: string; host?: string; identity?: string }, cmd: Command) => {
    const spinner = ora('Anchoring chain heads...').start();
    try {
      const volume = openVolume(cmd.parent!.opts());
      if (!options.canisterId) {
        const record = volume.anchor('local');
        spinner.succeed(chalk.green(`Anchored locally: memories@${record.memoriesSeq} ${record.memoriesHead ?? '-'}, transcript@${record.transcriptSeq}`));
        return;
      }
      const [{ createMemoryRepoActor, createMemoryRepoAgent, explainMemoryRepoWriteError, memoryRepoErrorText, validateCanisterId }, { requireCliSigningIdentity }] =
        await Promise.all([import('../../src/canister/memory-repo-actor.js'), import('../../src/canister/identity.js')]);
      validateCanisterId(options.canisterId);
      const signing = requireCliSigningIdentity({ identityPath: options.identity });
      const agent = await createMemoryRepoAgent(options.host, signing.identity);
      const actor = createMemoryRepoActor(options.canisterId, agent);
      // Record the heads first so the on-chain commit names exactly what the volume held.
      const pending = volume.verify();
      if (!pending.valid) {
        spinner.fail(chalk.red('Refusing to anchor a volume whose chains do not verify; run `agentvault total-recall verify`'));
        process.exit(1);
      }
      const heads = {
        volumeId: volume.volumeId,
        memoriesSeq: pending.memories.count,
        memoriesHead: pending.memories.head,
        transcriptSeq: pending.transcript.count,
        transcriptHead: pending.transcript.head,
        anchoredAt: new Date().toISOString(),
      };
      let result: Awaited<ReturnType<typeof actor.commit>>;
      try {
        result = await actor.commit(`total-recall anchor ${volume.volumeId}@${heads.memoriesSeq}`, JSON.stringify(heads), [
          'total-recall',
          'anchor',
        ]);
      } catch (error) {
        const refusal = explainMemoryRepoWriteError(error, signing.principal);
        spinner.fail(chalk.red(refusal ? refusal.message : memoryRepoErrorText(error)));
        process.exit(1);
      }
      if ('err' in result) {
        spinner.fail(chalk.red(`Canister refused the anchor commit: ${result.err}`));
        process.exit(1);
      }
      const record = volume.anchor(`canister:${options.canisterId}`, result.ok);
      spinner.succeed(chalk.green(`Anchored on-chain: commit ${result.ok} (memories@${record.memoriesSeq}, transcript@${record.transcriptSeq})`));
    } catch (error) {
      spinner.fail(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

const importCmd = totalRecallCmd.command('import').description('Import what a provider export does give you');

importCmd
  .command('chatgpt')
  .description('Append every conversation of a ChatGPT data export (conversations.json) to the transcript')
  .argument('<conversations.json>')
  .action((file: string, _options: unknown, cmd: Command) => {
    const spinner = ora('Importing ChatGPT conversations...').start();
    try {
      const volume = TotalRecallVolume.openOrInit(volumeDir(cmd.parent!.parent!.opts()));
      if (volume.policy.transcript !== 'append') {
        spinner.info(chalk.yellow('Transcript mode is off; the import still lands in transcript.jsonl (turn it on with `policy --transcript append` for live turns).'));
        spinner.start();
      }
      const summary = importChatGptConversations(volume, path.resolve(file));
      spinner.succeed(chalk.green(`Imported ${summary.messages} messages from ${summary.conversations} conversations (${summary.skipped} already present)`));
    } catch (error) {
      spinner.fail(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

importCmd
  .command('memories')
  .description('Import a pasted memory list (one memory per line or paragraph) as created events')
  .argument('<file>', 'Text/markdown file, or - for stdin')
  .requiredOption('--provider <name>', 'Provider the memories came from (chatgpt, claude, ...)')
  .option('--agent <agent>')
  .option('--tag <tag...>')
  .action((file: string, options: { provider: string; agent?: string; tag?: string[] }, cmd: Command) => {
    try {
      const volume = TotalRecallVolume.openOrInit(volumeDir(cmd.parent!.parent!.opts()));
      const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
      const result = importMemoryList(volume, text, { provider: options.provider.toLowerCase(), agent: options.agent, tags: options.tag });
      console.log(chalk.green(`✔ Imported ${result.imported} memories (${result.skipped} already present)`));
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

totalRecallCmd
  .command('watch')
  .description('Follow the volume and run the sinks (policy webhooks/hook, or the ones given here) for each new memory event')
  .option('--hook <argv>', 'Command run per event with the event JSON on stdin (JSON array or space-separated)')
  .option('--webhook <url...>', 'POST each event here')
  .option('--allow-remote', 'Allow non-loopback webhooks')
  .option('--since <seq>', 'Start after this seq instead of the saved cursor')
  .option('--cursor <name>', 'Cursor name, so several watchers can follow one volume', 'default')
  .option('--once', 'Process what is new, then exit')
  .option('--quiet', 'Do not print events')
  .action(
    async (
      options: { hook?: string; webhook?: string[]; allowRemote?: boolean; since?: string; cursor: string; once?: boolean; quiet?: boolean },
      cmd: Command,
    ) => {
      try {
        const volume = openVolume(cmd.parent!.opts());
        const sinks: Pick<TotalRecallPolicy, 'webhooks' | 'hookCommand'> =
          options.hook || options.webhook
            ? {
                webhooks: (options.webhook ?? []).map((url) => ({ url, allowRemote: Boolean(options.allowRemote) })),
                hookCommand: options.hook ? options.hook.split(/\s+/).filter(Boolean) : undefined,
              }
            : volume.policy;
        const watcher = watchVolume(
          volume,
          async (event) => {
            if (!options.quiet) printEvent(event);
            const results = await notifyEvent(sinks, event, { volumeId: volume.volumeId });
            for (const r of results) if (!r.ok) console.error(chalk.yellow(`  delivery to ${r.sink} failed: ${r.error}`));
          },
          { sinceSeq: options.since !== undefined ? Number(options.since) || 0 : undefined, cursorName: options.cursor },
        );
        if (options.once) {
          const n = await watcher.poke();
          await watcher.close();
          console.log(chalk.gray(`${n} new event(s); cursor at ${watcher.cursor}`));
          return;
        }
        console.error(chalk.gray(`Watching ${volume.dir} from seq ${watcher.cursor} (Ctrl-C to stop)`));
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            void watcher.close().then(resolve);
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
    },
  );

totalRecallCmd
  .command('stenographer')
  .description('Index the transcript with stenographer (prints the command and MCP config; --run launches it)')
  .option('--mode <mode>', 'live | catchup | daemon', 'live')
  .option('--db <path>', 'Stenographer state database (default <volume>/stenographer.db)')
  .option('--embeddings <name>', 'Stenographer --embeddings (e.g. hashed for offline)')
  .option('--run', 'Launch stenographer now (npx -y @stenographer/core)')
  .action(async (options: { mode: string; db?: string; embeddings?: string; run?: boolean }, cmd: Command) => {
    try {
      const volume = openVolume(cmd.parent!.opts());
      const db = path.resolve(options.db ?? path.join(volume.dir, 'stenographer.db'));
      const args = ['-y', '@stenographer/core', 'start', volume.transcriptPath, db, '--mode', options.mode];
      if (options.embeddings) args.push('--embeddings', options.embeddings);
      console.log(chalk.gray('# transcript.jsonl is stenographer-native JSONL; no adapter needed'));
      console.log(chalk.cyan(`npx ${args.join(' ')}`));
      console.log(chalk.gray('\n# MCP client config (e.g. .mcp.json):'));
      console.log(
        JSON.stringify(
          {
            mcpServers: {
              'total-recall': { command: 'agentvault', args: ['mcp', 'serve', '--total-recall', volume.dir] },
              stenographer: { command: 'npx', args },
            },
          },
          null,
          2,
        ),
      );
      if (!options.run) return;
      await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`stenographer exited with ${code}`))));
      });
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

export { totalRecallCmd };
