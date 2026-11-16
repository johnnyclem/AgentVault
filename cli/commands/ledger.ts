/**
 * `agentvault ledger` — an append-only record that agent hosts write to
 *
 *   serve    Run the HTTP gateway, anchoring to a memory_repo canister when one is named
 *   anchor   Anchor what is pending once, then exit
 *   status   Each stream's length, head and anchored mark
 *   verify   Re-derive every chain from disk; with a canister, read its anchors back too
 *   rebuild  Rebuild a ledger from a canister's anchors alone, into a new directory
 *   check    Check a canister from outside: who controls it, and the role the gateway would hold
 *
 * A host (a hosted bot server, for example) seals its own records and sends
 * only opaque bytes, so the gateway never sees what they say. The token that
 * lets a host write comes from AGENTVAULT_LEDGER_TOKEN, never a flag.
 *
 * Examples:
 *   AGENTVAULT_LEDGER_TOKEN=$(openssl rand -hex 32) agentvault ledger serve
 *   agentvault ledger serve --canister-id <id> --ic-host https://icp-api.io --anchor-interval 60
 *   agentvault ledger verify --canister-id <id> --ic-host https://icp-api.io
 *   agentvault ledger rebuild --canister-id <id> --ic-host https://icp-api.io --dir ./recovered
 *   agentvault ledger check --canister-id <id> --ic-host https://icp-api.io --identity gateway.pem
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  describeIdentitySource,
  requireCliSigningIdentity,
  resolveServerSigningIdentity,
  type SigningIdentity,
} from '../../src/canister/identity.js';
import {
  DEFAULT_LEDGER_BRANCH,
  LedgerStore,
  MEMORY_REPO_ANCHOR_KIND,
  MIN_TOKEN_LENGTH,
  MemoryRepoAnchor,
  anchorPending,
  assessCanister,
  checkMemoryRepoAnchor,
  connectMemoryRepo,
  createLedgerServer,
  readCanisterFacts,
  readMemoryRepo,
  readMemoryRepoHistory,
  rebuildFromMemoryRepo,
  startAnchorSchedule,
  type AnchorRecord,
  type Finding,
  type MemoryRepoPort,
} from '../../src/ledger/index.js';

export const LEDGER_TOKEN_ENV = 'AGENTVAULT_LEDGER_TOKEN';
export const LEDGER_DIR_ENV = 'AGENTVAULT_LEDGER_DIR';
const DEFAULT_PORT = 8787;
const DEFAULT_ANCHOR_INTERVAL_MINUTES = 60;

interface StoreOptions {
  dir?: string;
}

interface CanisterOptions {
  canisterId?: string;
  icHost?: string;
  identity?: string;
  branch: string;
}

function die(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function ledgerDir(options: StoreOptions): string {
  return path.resolve(options.dir ?? process.env[LEDGER_DIR_ENV] ?? path.join(os.homedir(), '.agentvault', 'ledger'));
}

function openStore(options: StoreOptions): LedgerStore {
  return LedgerStore.open(ledgerDir(options));
}

/** The identity anchors are signed with: --identity, else the server's environment, else dfx's selected identity. */
function signingIdentity(options: CanisterOptions): SigningIdentity {
  if (options.identity) return requireCliSigningIdentity({ identityPath: options.identity });
  return resolveServerSigningIdentity(process.env) ?? requireCliSigningIdentity();
}

/** The canister and replica the options name, or exit with what is missing. */
function canisterTarget(options: CanisterOptions): { canisterId: string; host: string } {
  const canisterId = options.canisterId ?? process.env.MEMORY_REPO_CANISTER_ID;
  if (!canisterId) die('Name the memory_repo canister with --canister-id or MEMORY_REPO_CANISTER_ID');
  if (!options.icHost) die('Name the replica or boundary node with --ic-host (https://icp-api.io for mainnet)');
  return { canisterId, host: options.icHost };
}

function printFinding({ level, text }: Finding): void {
  const label = { ok: chalk.green('ok     '), note: chalk.gray('note   '), warn: chalk.yellow('warn   '), problem: chalk.red('PROBLEM') }[level];
  console.log(`${label} ${text}`);
}

/**
 * Says what the canister's settings mean for this gateway, before the first anchor does it at the
 * end of an interval. A canister that cannot be read, or a warning, never stops the gateway: it
 * keeps accepting entries either way.
 */
async function reportCanister(target: { canisterId: string; host: string }, gateway: string): Promise<void> {
  try {
    for (const finding of assessCanister(await readCanisterFacts(target), gateway)) {
      if (finding.level === 'warn' || finding.level === 'problem') printFinding(finding);
    }
  } catch (error) {
    console.error(chalk.yellow(`Could not read the canister's settings: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function connect(options: CanisterOptions): Promise<MemoryRepoPort> {
  const { canisterId, host } = canisterTarget(options);
  const signer = signingIdentity(options);
  if (signer.warning) console.error(chalk.yellow(signer.warning));
  console.log(chalk.gray(`Signing as ${signer.principal} (${describeIdentitySource(signer.source)})`));
  await reportCanister({ canisterId, host }, signer.principal);
  return connectMemoryRepo({ canisterId, host, identity: signer.identity, principal: signer.principal });
}

function describeAnchors(records: readonly AnchorRecord[]): string {
  return records.map((record) => `${record.stream} ${record.from}-${record.to}`).join(', ');
}

function addCanisterOptions(command: Command): Command {
  return command
    .option('--canister-id <id>', 'memory_repo canister to anchor to (or MEMORY_REPO_CANISTER_ID)')
    .option('--ic-host <url>', 'Replica or boundary node URL, such as https://icp-api.io')
    .option('--identity <pem>', 'PEM file of the key anchors are signed with')
    .option('--branch <name>', 'memory_repo branch the checkpoints are committed to', DEFAULT_LEDGER_BRANCH);
}

const ledgerCmd = new Command('ledger').description('An append-only, hash-chained record agent hosts write to, anchored on a canister');

addCanisterOptions(
  ledgerCmd
    .command('serve')
    .description('Run the ledger gateway')
    .option('--dir <dir>', `Ledger directory (default ~/.agentvault/ledger, or $${LEDGER_DIR_ENV})`)
    .option('--host <address>', 'Address to listen on', '127.0.0.1')
    .option('--port <port>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--anchor-interval <minutes>', 'Minutes between anchor runs', String(DEFAULT_ANCHOR_INTERVAL_MINUTES))
    .option('--digest-only', 'Anchor only the hashes of each range, not a copy of its entries'),
).action(async (options: StoreOptions & CanisterOptions & { host: string; port: string; anchorInterval: string; digestOnly?: boolean }) => {
  const token = process.env[LEDGER_TOKEN_ENV] ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    die(`Set ${LEDGER_TOKEN_ENV} to a secret of at least ${MIN_TOKEN_LENGTH} characters, for example: openssl rand -hex 32`);
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port must be a port number');
  const minutes = Number(options.anchorInterval);
  if (!Number.isFinite(minutes) || minutes <= 0) die('--anchor-interval must be a number of minutes above zero');

  const store = openStore(options);
  const anchoring = options.canisterId || process.env.MEMORY_REPO_CANISTER_ID;
  const schedule = anchoring
    ? startAnchorSchedule(store, new MemoryRepoAnchor(await connect(options), options.branch), {
        intervalMs: minutes * 60_000,
        inlineEntries: !options.digestOnly,
        onAnchored: (records) => console.log(`Anchored ${describeAnchors(records)}`),
        onError: (error) => console.error(chalk.red(`Anchoring failed, will retry: ${error instanceof Error ? error.message : String(error)}`)),
      })
    : undefined;

  const server = createLedgerServer({
    store,
    token,
    onError: (error) => console.error(chalk.red(`Request failed: ${error instanceof Error ? error.message : String(error)}`)),
  });
  server.listen(port, options.host, () => {
    const address = server.address();
    const bound = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${options.host}:${port}`;
    console.log(`Ledger gateway listening on http://${bound} (${store.dir})`);
    if (!schedule) console.log(chalk.yellow('No canister named: entries are stored here but not anchored.'));
  });

  const shutdown = (): void => {
    server.close(() => {
      // Anchor what arrived since the last run, so a planned stop leaves nothing pending.
      void (schedule ? schedule.run().then(() => schedule.stop()) : Promise.resolve()).finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
});

addCanisterOptions(
  ledgerCmd
    .command('anchor')
    .description('Anchor every entry not yet anchored, then exit')
    .option('--dir <dir>', 'Ledger directory')
    .option('--digest-only', 'Anchor only the hashes of each range, not a copy of its entries'),
).action(async (options: StoreOptions & CanisterOptions & { digestOnly?: boolean }) => {
  try {
    const store = openStore(options);
    const anchor = new MemoryRepoAnchor(await connect(options), options.branch);
    const records = await anchorPending(store, anchor, { inlineEntries: !options.digestOnly });
    console.log(records.length > 0 ? `Anchored ${describeAnchors(records)}` : 'Nothing to anchor');
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
});

ledgerCmd
  .command('status')
  .description("Each stream's length, head and anchored mark")
  .option('--dir <dir>', 'Ledger directory')
  .option('--json', 'Print JSON')
  .action((options: StoreOptions & { json?: boolean }) => {
    try {
      const store = openStore(options);
      const streams = store.streams().map((stream) => {
        const head = store.head(stream);
        return { stream, entries: head?.seq ?? 0, head: head?.hash ?? null, anchored: store.anchoredSeq(stream) };
      });
      if (options.json) {
        console.log(JSON.stringify({ dir: store.dir, streams }, null, 2));
        return;
      }
      console.log(chalk.gray(store.dir));
      if (streams.length === 0) console.log('No streams yet');
      for (const { stream, entries, head, anchored } of streams) {
        const pending = entries - anchored;
        console.log(
          `${chalk.bold(stream)}  ${entries} entries  head ${head?.slice(0, 16) ?? '-'}  ` +
            (pending === 0 ? chalk.green('anchored') : chalk.yellow(`${pending} not anchored`)),
        );
      }
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

addCanisterOptions(
  ledgerCmd
    .command('verify')
    .description('Re-derive every chain from disk; with a canister, check its anchors against it')
    .option('--dir <dir>', 'Ledger directory'),
).action(async (options: StoreOptions & CanisterOptions) => {
  try {
    const store = openStore(options);
    let failed = false;
    for (const stream of store.streams()) {
      const check = store.verify(stream);
      if (check.ok) {
        console.log(`${chalk.green('ok')}  ${stream}  ${check.entries} entries`);
      } else {
        failed = true;
        console.log(`${chalk.red('BAD')} ${stream}  ${check.reason}`);
      }
    }

    if (options.canisterId || process.env.MEMORY_REPO_CANISTER_ID) {
      const repo = await readMemoryRepo(canisterTarget(options));
      for (const record of store.anchors()) {
        if (record.evidence.kind !== MEMORY_REPO_ANCHOR_KIND) continue;
        const stored = store.read(record.stream, { after: record.from - 1, limit: record.to - record.from + 1 });
        const result = await checkMemoryRepoAnchor(repo, record, stored);
        const range = `${record.stream} ${record.from}-${record.to}`;
        if (result.ok) {
          console.log(`${chalk.green('ok')}  anchor ${range}`);
        } else {
          failed = true;
          console.log(`${chalk.red('BAD')} anchor ${range}  ${result.reason}`);
        }
      }
    }
    if (failed) process.exit(1);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
});

ledgerCmd
  .command('rebuild')
  .description("Rebuild a ledger from a canister's anchors alone, into a new directory")
  .requiredOption('--dir <dir>', 'Directory for the rebuilt ledger; there is no default, so a live ledger is never written to by mistake')
  .option('--canister-id <id>', 'memory_repo canister the ledger was anchored to (or MEMORY_REPO_CANISTER_ID)')
  .option('--ic-host <url>', 'Replica or boundary node URL, such as https://icp-api.io')
  .option('--branch <name>', 'memory_repo branch the checkpoints were committed to', DEFAULT_LEDGER_BRANCH)
  .option('--stream <id>', 'Rebuild only this stream')
  .option('--json', 'Print JSON')
  .action(async (options: StoreOptions & CanisterOptions & { stream?: string; json?: boolean }) => {
    try {
      // Queries are anonymous: rebuilding needs no key, and works when every other copy is gone.
      const repo = await readMemoryRepoHistory(canisterTarget(options));
      const store = LedgerStore.open(path.resolve(options.dir!));
      const report = await rebuildFromMemoryRepo(repo, store, { branch: options.branch, stream: options.stream });
      if (options.json) {
        console.log(JSON.stringify({ dir: store.dir, ...report }, null, 2));
      } else {
        console.log(
          chalk.gray(`Read ${report.commits} commits on '${report.branch}' of ${report.canisterId}; rebuilt into ${store.dir}`),
        );
        if (report.streams.length === 0) console.log('No streams were anchored');
        for (const { stream, entries, head, complete } of report.streams) {
          const state = complete ? chalk.green('ok     ') : chalk.yellow('PARTIAL');
          console.log(`${state} ${chalk.bold(stream)}  ${entries} entries  head ${head?.hash.slice(0, 16) ?? '-'}`);
        }
        for (const problem of report.problems) console.log(chalk.red(`Problem: ${problem}`));
        if (report.streams.length > 0) {
          console.log(chalk.gray(`Serve it with: ${LEDGER_TOKEN_ENV}=$(openssl rand -hex 32) agentvault ledger serve --dir ${store.dir}`));
        }
      }
      if (report.problems.length > 0) process.exit(1);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

ledgerCmd
  .command('check')
  .description('Check a canister from outside: who controls it, who owns its repository, and the role the gateway would hold')
  .option('--canister-id <id>', 'memory_repo canister to check (or MEMORY_REPO_CANISTER_ID)')
  .option('--ic-host <url>', 'Replica or boundary node URL, such as https://icp-api.io')
  .option('--identity <pem>', "PEM file of the key the gateway signs with, to say what role it would hold there")
  .option('--strict', 'Exit 1 on a warning as well as on a problem')
  .option('--json', 'Print JSON')
  .action(async (options: { canisterId?: string; icHost?: string; identity?: string; strict?: boolean; json?: boolean }) => {
    try {
      const { canisterId, host } = canisterTarget({ ...options, branch: DEFAULT_LEDGER_BRANCH });
      // No key is needed to read a canister; one only names the gateway's role.
      const gateway = options.identity
        ? requireCliSigningIdentity({ identityPath: options.identity }).principal
        : resolveServerSigningIdentity(process.env)?.principal;
      const facts = await readCanisterFacts({ canisterId, host });
      const findings = assessCanister(facts, gateway);
      if (options.json) {
        console.log(JSON.stringify({ ...facts, gateway: gateway ?? null, findings }, null, 2));
      } else {
        console.log(chalk.gray(`${canisterId}${gateway ? `  (gateway ${gateway})` : ''}`));
        for (const finding of findings) printFinding(finding);
      }
      const failing = findings.some((finding) => finding.level === 'problem' || (options.strict && finding.level === 'warn'));
      if (failing) process.exit(1);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  });

export { ledgerCmd };
