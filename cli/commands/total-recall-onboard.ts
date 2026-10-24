/**
 * `agentvault total-recall onboard` — guided setup
 *
 *   agentvault total-recall onboard                 # the guided wizard
 *   agentvault total-recall onboard --yes \
 *     --transcript append --chatgpt-export ~/Downloads/chatgpt-export \
 *     --connect claude-code,claude-desktop          # the same, scripted
 *
 * One conversation: where the archive lives, what it keeps, what to bring in
 * from ChatGPT, which assistants to connect. Then it does all of it, starts
 * the real server the way an assistant would to prove it works, and hands
 * back the words to say to each assistant next. Safe to run again at any
 * time: it never rewrites what is already archived.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import inquirer from 'inquirer';
import {
  CHATGPT_MEMORY_EXPORT_PROMPT,
  CLAUDE_INGEST_PROMPT,
  DEFAULT_SERVER_NAME,
  DEFAULT_VOLUME_DIR,
  HOME_VOLUME_DIR,
  TotalRecallVolume,
  applyPlan,
  clientTargets,
  expandHome,
  locateChatGptExport,
  prettyPath,
  renderCard,
  resolveVolumeDir,
  wrapText,
  type ClientId,
  type OnboardPlan,
  type OnboardReporter,
  type OnboardResult,
} from '../../src/total-recall/index.js';

const accent = chalk.cyan;
const dim = chalk.dim;
const good = chalk.green('✔');
const warnMark = chalk.yellow('!');

const CLIENT_IDS: readonly ClientId[] = ['claude-code', 'claude-desktop'];

interface OnboardOptions {
  yes?: boolean;
  json?: boolean;
  transcript?: string;
  recordRecalls?: string;
  chatgptExport?: string;
  memories?: string;
  connect?: string;
  project?: string;
  test: boolean;
}

// ---------------------------------------------------------------------------
// Words and layout
// ---------------------------------------------------------------------------

const width = (): number => Math.max(48, Math.min(process.stdout.columns ?? 80, 84) - 4);
/** Text width inside a card, so the framed prompts fit a narrow terminal too. */
const cardText = (): number => Math.max(34, Math.min(58, width() - 8));

function say(text = ''): void {
  console.log(text);
}

function indent(lines: string[], by = 2): string {
  return lines.map((l) => ' '.repeat(by) + l).join('\n');
}

function paragraph(text: string, by = 2): void {
  say(indent(wrapText(text, width() - by), by));
}

function banner(): void {
  say();
  say(`  ${accent('◆')}  ${chalk.bold('Total Recall')}`);
  say(`  ${dim('Every memory your assistants form, kept in a file you own.')}`);
  say();
  paragraph(
    "In a few minutes we'll create your archive, bring in what ChatGPT has on you, connect your assistants, and prove it all works. Nothing is sent anywhere. Run this again whenever you like; it never rewrites what's already archived.",
  );
}

function section(n: number, title: string, blurb?: string): void {
  say();
  say(`  ${accent(['①', '②', '③', '④', '⑤'][n - 1] ?? '•')}  ${chalk.bold(title)}`);
  if (blurb) paragraph(dim(blurb), 5);
}

function card(title: string, rows: string[]): void {
  say(indent(renderCard(title, rows, { style: dim, minWidth: 52 })));
}

// ---------------------------------------------------------------------------
// Collecting a plan
// ---------------------------------------------------------------------------

function parseConnect(value: string | undefined): ClientId[] {
  if (!value || value === 'none') return [];
  const wanted = value.split(',').map((v) => v.trim()).filter(Boolean);
  const bad = wanted.filter((v) => !(CLIENT_IDS as readonly string[]).includes(v));
  if (bad.length > 0) throw new Error(`--connect takes ${CLIENT_IDS.join(', ')} or none (got ${bad.join(', ')})`);
  return wanted as ClientId[];
}

function onOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${flag} takes on or off`);
}

/** The plan a scripted run describes: flags only, no questions, no surprises (nothing is connected unless asked). */
function planFromFlags(options: OnboardOptions, volumeFlag: string | undefined): OnboardPlan {
  if (options.transcript !== undefined && options.transcript !== 'off' && options.transcript !== 'append') {
    throw new Error('--transcript takes off or append');
  }
  let memoriesText: string | undefined;
  if (options.memories) {
    const file = path.resolve(expandHome(options.memories));
    if (!fs.existsSync(file)) throw new Error(`--memories: not found: ${file}`);
    memoriesText = fs.readFileSync(file, 'utf8');
  }
  return {
    volumeDir: resolveVolumeDir({ flag: volumeFlag, env: process.env.AGENTVAULT_TOTAL_RECALL_DIR }),
    transcript: options.transcript as 'off' | 'append' | undefined,
    recordRecalls: onOff(options.recordRecalls, '--record-recalls'),
    chatgptExport: options.chatgptExport,
    memoriesText,
    connect: parseConnect(options.connect),
    projectDir: path.resolve(options.project ?? process.cwd()),
    runSelfTest: options.test,
  };
}

async function askVolumeDir(volumeFlag: string | undefined): Promise<string> {
  const explicit = volumeFlag ?? process.env.AGENTVAULT_TOTAL_RECALL_DIR;
  if (explicit) return resolveVolumeDir({ flag: explicit });
  const found = resolveVolumeDir();
  if (TotalRecallVolume.exists(found)) {
    const status = TotalRecallVolume.open(found).status();
    say(`  ${good} Found your archive at ${accent(prettyPath(found))} ${dim(`(${status.memories.events} memory events, ${status.transcript.messages} transcript messages)`)}`);
    say(`  ${dim('Everything already in it stays exactly as it is.')}`);
    return found;
  }
  const homeDir = path.join(os.homedir(), HOME_VOLUME_DIR);
  const projectDir = path.resolve(DEFAULT_VOLUME_DIR);
  const { where } = await inquirer.prompt<{ where: 'home' | 'project' | 'other' }>([
    {
      type: 'list',
      name: 'where',
      message: 'Where should your archive live?',
      choices: [
        { name: `In your home folder ${dim(`${prettyPath(homeDir)} — one archive for every assistant and project`)}`, value: 'home' },
        { name: `In this project ${dim(`${prettyPath(projectDir)} — travels with this folder`)}`, value: 'project' },
        { name: 'Somewhere else…', value: 'other' },
      ],
    },
  ]);
  if (where === 'home') return homeDir;
  if (where === 'project') return projectDir;
  const { dir } = await inquirer.prompt<{ dir: string }>([
    { type: 'input', name: 'dir', message: 'Folder for the archive:', validate: (v: string) => (v.trim() ? true : 'Enter a folder') },
  ]);
  return path.resolve(expandHome(dir.trim()));
}

async function askExportPath(): Promise<string> {
  say();
  paragraph(dim('In ChatGPT: Settings → Data controls → Export data. It emails you a zip; unzip it and point me at the folder (or at conversations.json).'), 5);
  const { exportPath } = await inquirer.prompt<{ exportPath: string }>([
    {
      type: 'input',
      name: 'exportPath',
      message: 'Where is your ChatGPT export?',
      validate: (v: string) => {
        try {
          locateChatGptExport(v);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
  ]);
  const files = locateChatGptExport(exportPath);
  say(`  ${good} ${dim(`Found ${files.length} conversation file${files.length === 1 ? '' : 's'}`)}`);
  return exportPath;
}

async function askMemories(): Promise<string | undefined> {
  say();
  paragraph(dim('ChatGPT keeps a separate list of what it has learned about you, and the export leaves it out. Paste this into ChatGPT to get it back verbatim:'), 5);
  say();
  card('Say this to ChatGPT', wrapText(CHATGPT_MEMORY_EXPORT_PROMPT, cardText()));
  say();
  const { how } = await inquirer.prompt<{ how: 'paste' | 'file' | 'later' }>([
    {
      type: 'list',
      name: 'how',
      message: 'When you have its answer:',
      choices: [
        { name: 'Paste it here (opens your editor)', value: 'paste' },
        { name: 'It is in a file', value: 'file' },
        { name: 'Skip for now', value: 'later' },
      ],
    },
  ]);
  if (how === 'later') return undefined;
  if (how === 'paste') {
    const { text } = await inquirer.prompt<{ text: string }>([
      { type: 'editor', name: 'text', message: "Paste ChatGPT's list, save and close the editor" },
    ]);
    return text;
  }
  const { file } = await inquirer.prompt<{ file: string }>([
    {
      type: 'input',
      name: 'file',
      message: 'Path to the file:',
      validate: (v: string) => (fs.existsSync(path.resolve(expandHome(v.trim()))) ? true : 'No file at that path'),
    },
  ]);
  return fs.readFileSync(path.resolve(expandHome(file.trim())), 'utf8');
}

async function collectInteractive(options: OnboardOptions, volumeFlag: string | undefined): Promise<OnboardPlan> {
  const projectDir = path.resolve(options.project ?? process.cwd());

  section(1, 'Your archive');
  const volumeDir = await askVolumeDir(volumeFlag);
  const existing = TotalRecallVolume.exists(volumeDir) ? TotalRecallVolume.open(volumeDir).policy : undefined;

  section(2, 'What to keep', 'The archive is append-only: a memory that changes is recorded as a new version, and nothing is ever overwritten or deleted.');
  const { transcript, recordRecalls } = await inquirer.prompt<{ transcript: 'off' | 'append'; recordRecalls: boolean }>([
    {
      type: 'list',
      name: 'transcript',
      message: 'How much should it keep?',
      default: existing?.transcript ?? 'off',
      choices: [
        { name: `Memories ${dim('— what each assistant remembers about you')}`, value: 'off' },
        { name: `Memories + full transcript ${dim('— also every conversation turn, searchable later')}`, value: 'append' },
      ],
    },
    {
      type: 'confirm',
      name: 'recordRecalls',
      message: `Note when an assistant recalls a memory? ${dim('(shows which ones actually get used)')}`,
      default: existing ? existing.recordOps.includes('recalled') : true,
    },
  ]);

  section(3, 'Bring your history in', 'ChatGPT knows you from three years of conversations. Choose what to carry across; both are safe to repeat later.');
  const { sources } = await inquirer.prompt<{ sources: Array<'export' | 'memories'> }>([
    {
      type: 'checkbox',
      name: 'sources',
      message: 'Import from ChatGPT:',
      choices: [
        { name: `Your conversations ${dim('(the data export)')}`, value: 'export' },
        { name: `Its saved memories ${dim('(Settings → Personalization → Memory)')}`, value: 'memories' },
      ],
    },
  ]);
  const chatgptExport = sources.includes('export') ? await askExportPath() : undefined;
  if (chatgptExport && transcript === 'off') {
    say(`  ${dim('Imported conversations are kept in the transcript archive either way. Choose "full transcript" above to keep new turns there too.')}`);
  }
  const memoriesText = sources.includes('memories') ? await askMemories() : undefined;

  section(4, 'Connect your assistants', 'Each one is told to record every memory it creates, recalls or updates. Existing settings are backed up before anything changes.');
  const targets = clientTargets({ projectDir });
  const desktop = targets.find((t) => t.id === 'claude-desktop')!;
  const code = targets.find((t) => t.id === 'claude-code')!;
  const { connect } = await inquirer.prompt<{ connect: ClientId[] }>([
    {
      type: 'checkbox',
      name: 'connect',
      message: 'Connect:',
      choices: [
        { name: `Claude Code ${dim(prettyPath(code.configPath))}`, value: 'claude-code', checked: true },
        { name: `Claude Desktop ${dim(prettyPath(desktop.configPath))}`, value: 'claude-desktop', checked: fs.existsSync(path.dirname(desktop.configPath)) },
        { name: 'ChatGPT', value: 'chatgpt', disabled: 'needs a remote MCP URL; AgentVault serves stdio only today' },
      ],
    },
  ]);

  return {
    volumeDir,
    transcript,
    recordRecalls,
    chatgptExport,
    memoriesText,
    connect: connect.filter((c): c is ClientId => (CLIENT_IDS as readonly string[]).includes(c)),
    projectDir,
    runSelfTest: options.test,
  };
}

// ---------------------------------------------------------------------------
// Showing the plan and the result
// ---------------------------------------------------------------------------

function planRows(plan: OnboardPlan): string[] {
  const rows: string[] = [];
  const exists = TotalRecallVolume.exists(plan.volumeDir);
  rows.push(`${chalk.bold('Archive')}      ${prettyPath(plan.volumeDir, { max: 40 })} ${dim(exists ? '(existing)' : '(new)')}`);
  const keeps = [plan.transcript === 'append' ? 'memories + transcript' : plan.transcript === 'off' ? 'memories' : undefined, plan.recordRecalls === false ? 'no recalls' : undefined].filter(Boolean);
  if (keeps.length > 0) rows.push(`${chalk.bold('Keeps')}        ${keeps.join(', ')}`);
  const imports = [plan.chatgptExport ? 'ChatGPT conversations' : undefined, plan.memoriesText?.trim() ? 'saved memories' : undefined].filter(Boolean);
  rows.push(`${chalk.bold('Imports')}      ${imports.length > 0 ? imports.join(', ') : dim('nothing')}`);
  const connects = (plan.connect ?? []).map((c) => (c === 'claude-code' ? 'Claude Code' : 'Claude Desktop'));
  rows.push(`${chalk.bold('Connects')}     ${connects.length > 0 ? connects.join(', ') : dim('nothing (config printed at the end)')}`);
  return rows;
}

function spinnerReporter(): OnboardReporter {
  let spinner: Ora | null = null;
  let label = '';
  const finish = (symbol: string, text: string, method: 'succeed' | 'warn'): void => {
    if (spinner) {
      spinner[method](text);
      spinner = null;
    } else {
      say(`  ${symbol} ${text}`);
    }
  };
  return {
    start(_step, text) {
      label = text;
      // A terminal reporting zero columns (some CI ptys) makes ora's frame clearing loop forever; print plain lines there.
      spinner = ora({ text: label, indent: 2, color: 'cyan', ...((process.stderr.columns ?? 0) > 0 ? {} : { isEnabled: false }) }).start();
    },
    progress(_step, detail) {
      if (spinner) spinner.text = detail;
    },
    done: (_step, detail) => finish(good, detail, 'succeed'),
    warn: (_step, detail) => finish(warnMark, chalk.yellow(detail), 'warn'),
  };
}

function printResult(result: OnboardResult, plan: OnboardPlan): void {
  say();
  const rows: string[] = [];
  rows.push(`${chalk.bold('Archive')}   ${prettyPath(result.volume.dir, { max: 44 })}`);
  rows.push(`${chalk.bold('Keeps')}     ${result.volume.policy.transcript === 'append' ? 'memories + full transcript' : 'memories'}${result.volume.policy.recordOps.includes('recalled') ? '' : ', no recalls'}`);
  if (result.history.chatgpt) rows.push(`${chalk.bold('Imported')}  ${result.history.chatgpt.messages.toLocaleString('en-US')} messages · ${result.history.chatgpt.conversations.toLocaleString('en-US')} conversations`);
  if (result.history.memories) rows.push(`${chalk.bold('Imported')}  ${result.history.memories.imported} saved memories`);
  for (const c of result.connected) rows.push(`${chalk.bold('Connected')} ${c.label} ${dim(c.action === 'unchanged' ? '(already)' : `(${c.action})`)}`);
  if (result.selfTest) rows.push(`${chalk.bold('Verified')}  ${result.selfTest.ok ? chalk.green('the server works end to end') : chalk.yellow('see the notes above')}`);
  card(result.problems.length === 0 ? "You're set" : 'Set up, with notes', rows);

  const reloads = result.connected.filter((c) => c.action !== 'unchanged');
  if (reloads.length > 0) {
    say();
    say(`  ${chalk.bold('First')}  ${dim('Load the new server:')}`);
    for (const c of reloads) say(`         ${c.label}: ${c.reload}`);
  }
  if (result.connected.length === 0) {
    say();
    say(`  ${chalk.bold('Connect an assistant by hand')} ${dim('— add this under "mcpServers" in its MCP config:')}`);
    say(indent(JSON.stringify({ [DEFAULT_SERVER_NAME]: result.entry }, null, 2).split('\n'), 4));
  }
  const backups = result.connected.filter((c) => c.backup);
  for (const c of backups) say(`  ${dim(`Backup of the old ${c.label} config: ${prettyPath(c.backup!, { max: 56 })}`)}`);

  say();
  say(`  ${chalk.bold('Then')}  ${dim('Tell Claude, once, to learn what ChatGPT knew:')}`);
  say();
  card('Say this to Claude', wrapText(CLAUDE_INGEST_PROMPT, cardText()));
  say();
  say(`  ${chalk.bold('Later')}`);
  const later: Array<[string, string]> = [
    ['agentvault total-recall status', 'what the archive holds'],
    ['agentvault total-recall search "…"', 'find a memory'],
    ['agentvault total-recall onboard', 'run again any time, e.g. with a newer ChatGPT export'],
  ];
  const pad = Math.max(...later.map(([cmd]) => cmd.length));
  for (const [cmd, what] of later) {
    if (9 + pad + 2 + what.length <= width() + 2) say(`         ${accent(cmd.padEnd(pad))}  ${dim(what)}`);
    else {
      say(`         ${accent(cmd)}`);
      say(`           ${dim(what)}`);
    }
  }
  if (plan.volumeDir !== path.resolve(DEFAULT_VOLUME_DIR) && !process.env.AGENTVAULT_TOTAL_RECALL_DIR) {
    const found = resolveVolumeDir();
    if (found !== result.volume.dir) {
      say();
      say(`  ${dim('This archive is not the default here; point other commands at it with')} ${accent(`--volume ${prettyPath(result.volume.dir, { max: 50 })}`)}`);
    }
  }
  say();
  say(indent(wrapText(dim('ChatGPT itself cannot connect live yet: that needs a remote MCP URL, and AgentVault serves stdio only today. What ChatGPT knew is in the archive now, for Claude to read.'), width() - 2), 2));
  if (result.problems.length > 0) say(`  ${warnMark} ${chalk.yellow(`${result.problems.length} thing${result.problems.length === 1 ? '' : 's'} need attention (listed above).`)}`);
  say();
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export function addOnboardCommand(parent: Command): void {
  parent
    .command('onboard')
    .description('Guided setup: create the archive, bring in ChatGPT history, connect assistants, and verify')
    .option('-y, --yes', 'No questions: use the flags below (nothing is connected unless --connect says so)')
    .option('--json', 'Print the result as JSON (implies --yes)')
    .option('--transcript <mode>', 'off | append')
    .option('--record-recalls <onoff>', 'on | off')
    .option('--chatgpt-export <path>', 'A ChatGPT export: conversations.json, or the unzipped folder')
    .option('--memories <file>', "A file holding ChatGPT's saved memories, one per line")
    .option('--connect <clients>', `Comma list of ${CLIENT_IDS.join(', ')}, or none`)
    .option('--project <dir>', "Where Claude Code's .mcp.json goes (default: here)")
    .option('--no-test', 'Skip the end-to-end server check')
    .action(async (options: OnboardOptions, cmd: Command) => {
      const volumeFlag = (cmd.parent?.opts<{ volume?: string }>().volume) ?? undefined;
      const scripted = Boolean(options.yes || options.json);
      // Ctrl-C needs two nets. In a raw-mode prompt inquirer 9 doesn't raise SIGINT at all: the prompt just never
      // settles, the event loop drains and Node exits quietly. Elsewhere (while applying) it is an ordinary SIGINT.
      let phase: 'asking' | 'applying' | 'done' = 'asking';
      let reported = false;
      const interrupted = (): void => {
        if (reported || phase === 'done') return;
        reported = true;
        say(
          phase === 'applying'
            ? `\n\n  ${dim('Stopped. Everything written so far is safe; run onboard again to carry on.')}\n`
            : `\n\n  ${dim('Cancelled. Nothing was changed.')}\n`,
        );
      };
      if (!scripted) {
        process.on('SIGINT', () => {
          interrupted();
          process.exit(130);
        });
        process.on('exit', () => {
          if (phase !== 'done' && !reported) {
            interrupted();
            process.exitCode = 130;
          }
        });
      }
      try {
        if (!scripted && !(process.stdin.isTTY && process.stdout.isTTY)) {
          throw new Error('onboard asks questions, so it needs a terminal. For scripts, pass --yes with flags (see --help).');
        }
        let plan: OnboardPlan;
        if (scripted) {
          plan = planFromFlags(options, volumeFlag);
        } else {
          banner();
          plan = await collectInteractive(options, volumeFlag);
          say();
          card('Ready', planRows(plan));
          say();
          const { go } = await inquirer.prompt<{ go: boolean }>([{ type: 'confirm', name: 'go', message: 'Set it up?', default: true }]);
          if (!go) {
            say(`\n  ${dim('Nothing was changed.')}\n`);
            return;
          }
          say();
        }
        phase = 'applying';
        const result = await applyPlan(plan, scripted ? undefined : spinnerReporter());
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (!scripted) {
          printResult(result, plan);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        if (result.problems.length > 0) process.exitCode = 1;
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (name === 'ExitPromptError') {
          interrupted();
          process.exitCode = 130;
          return;
        }
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      } finally {
        if (!reported) phase = 'done';
      }
    });
}
