/**
 * `agentvault ledger` — an append-only record that agent hosts write to
 *
 *   serve    Run the HTTP gateway, anchoring to memory_repo canisters when a replica is named
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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  describeIdentitySource,
  requireCliSigningIdentity,
  resolveServerSigningIdentity,
  type SigningIdentity,
} from '../../src/canister/identity.js';
import { createMemoryRepoAgent, isLocalReplicaHost, validateCanisterId } from '../../src/canister/memory-repo-actor.js';
import { DEFAULT_QUOTE_MINUTES, OrderService, OrderStore, orderView, parsePriceXdr } from '../../src/canister/payments.js';
import { icPaymentPorts } from '../../src/canister/payments-ic.js';
import { CanisterProvisioner, ProvisionStore, parseProvisionCycles } from '../../src/canister/provision.js';
import { CYCLES_LEDGER_ID, icProvisioningPorts } from '../../src/canister/provision-ic.js';
import {
  DEFAULT_LEDGER_BRANCH,
  LedgerStore,
  MEMORY_REPO_ANCHOR_KIND,
  MIN_TOKEN_LENGTH,
  anchorPending,
  assessCanister,
  checkMemoryRepoAnchor,
  connectMemoryRepo,
  createDestinationRouter,
  createLedgerServer,
  readCanisterFacts,
  readMemoryRepo,
  readMemoryRepoHistory,
  rebuildFromMemoryRepo,
  startAnchorSchedule,
  AnchorPassError,
  type AnchorRecord,
  type AnchoringOptions,
  type Finding,
  type OrdersOptions,
  type ProvisioningOptions,
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

/**
 * How this gateway anchors, or null when it was not told where: a replica to anchor on (`--ic-host`)
 * and an identity to sign with. A canister named with `--canister-id` is where streams that name
 * no place of their own go; without one, only streams that name theirs are anchored.
 */
async function anchoringFor(options: CanisterOptions, store: LedgerStore) {
  const defaultDestination = options.canisterId ?? process.env.MEMORY_REPO_CANISTER_ID;
  if (!options.icHost && !defaultDestination) return null;
  if (!options.icHost) die('Name the replica or boundary node with --ic-host (https://icp-api.io for mainnet)');
  const host = options.icHost;
  const signer = signingIdentity(options);
  if (signer.warning) console.error(chalk.yellow(signer.warning));
  console.log(chalk.gray(`Signing as ${signer.principal} (${describeIdentitySource(signer.source)})`));
  if (defaultDestination) {
    validateCanisterId(defaultDestination);
    await reportCanister({ canisterId: defaultDestination, host }, signer.principal);
  }
  const router = createDestinationRouter({
    store,
    defaultDestination,
    branch: options.branch,
    connect: (canisterId) => connectMemoryRepo({ canisterId, host, identity: signer.identity, principal: signer.principal }),
  });
  return { router, writer: signer.principal, defaultDestination, identity: signer.identity, host };
}

interface ProvisionFlags {
  provisionWasm?: string;
  provisionCycles: string;
  maxCanisters?: string;
  cyclesLedger: string;
}

interface OrderFlags {
  orderPriceXdr?: string;
  orderQuoteMinutes: string;
}

/** What the cycles ledger takes from the gateway on top of a canister's cycles, in cycles. */
const CYCLES_LEDGER_FEE = 100_000_000n;
/** How often unpaid and paid orders are looked at. */
const ORDER_POLL_MS = 30_000;

/** What one install_code message can carry, with room for its envelope. */
const MAX_WASM_BYTES = 1_900_000;

/**
 * Lets the gateway create a canister for an owner and hand it over, at the operator's expense, when
 * it was told to. Nothing here is on by default: a gateway that can spend must be asked to, with a
 * cap on how many canisters it may ever create.
 */
async function provisioningFor(
  flags: ProvisionFlags,
  anchoring: Awaited<ReturnType<typeof anchoringFor>>,
  store: LedgerStore,
): Promise<{ options: ProvisioningOptions; provisioner: CanisterProvisioner; cycles: bigint } | undefined> {
  if (!flags.provisionWasm) {
    if (flags.maxCanisters !== undefined) die('--max-canisters only applies with --provision-wasm');
    return undefined;
  }
  if (!anchoring) die('Creating canisters needs a replica and an identity: name --ic-host');
  let cycles: bigint;
  try {
    cycles = parseProvisionCycles(flags.provisionCycles);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const limit = Number(flags.maxCanisters);
  if (flags.maxCanisters === undefined || !Number.isInteger(limit) || limit < 1) {
    die('Set --max-canisters to the most canisters this gateway may ever create; it spends your cycles');
  }
  let wasm: Uint8Array;
  try {
    wasm = fs.readFileSync(flags.provisionWasm);
  } catch {
    die(`Cannot read ${flags.provisionWasm}`);
  }
  if (wasm[0] === 0x1f && wasm[1] === 0x8b) wasm = gunzipSync(wasm);
  if (wasm.length > MAX_WASM_BYTES) die(`${flags.provisionWasm} is larger than one install message can carry`);

  const source = isLocalReplicaHost(anchoring.host) ? ('local' as const) : { cyclesLedger: flags.cyclesLedger };
  const provisioner = new CanisterProvisioner({
    ports: await icProvisioningPorts({ host: anchoring.host, identity: anchoring.identity, source }),
    store: new ProvisionStore(store.dir),
    treasury: anchoring.writer,
    wasm,
    cycles,
    limit,
    writers: [anchoring.writer],
    log: (message) => console.log(chalk.gray(message)),
  });
  console.log(chalk.gray(`Creating canisters: ${Number(cycles) / 1e12}T cycles each, at most ${limit}, memory_repo code ${provisioner.moduleHash}`));
  return { options: { begin: (key, owner) => provisioner.begin(key, owner), get: (key) => provisioner.get(key) }, provisioner, cycles };
}

/**
 * Lets the gateway sell canisters for ICP, when it was told a price. A sale pays for a canister the
 * provisioner then makes, so it needs provisioning, and the ICP ledger and the minting canister only
 * exist on the Internet Computer.
 */
async function ordersFor(
  flags: OrderFlags,
  anchoring: Awaited<ReturnType<typeof anchoringFor>>,
  provisioned: Awaited<ReturnType<typeof provisioningFor>>,
  store: LedgerStore,
): Promise<{ options: OrdersOptions; service: OrderService } | undefined> {
  if (flags.orderPriceXdr === undefined) return undefined;
  if (!anchoring || !provisioned) die('Selling canisters needs --provision-wasm and --max-canisters, and a replica: name --ic-host');
  let priceCycles: bigint;
  try {
    // A price below what a canister costs would lose money on every sale.
    priceCycles = parsePriceXdr(flags.orderPriceXdr, provisioned.cycles + CYCLES_LEDGER_FEE);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const quoteMinutes = Number(flags.orderQuoteMinutes);
  if (!Number.isFinite(quoteMinutes) || quoteMinutes < 1 || quoteMinutes > 1440) die('--order-quote-minutes is how long a quoted amount holds: 1 to 1440');

  const agent = await createMemoryRepoAgent(anchoring.host, anchoring.identity);
  const service = new OrderService({
    ports: icPaymentPorts({ agent, treasury: anchoring.writer }),
    store: new OrderStore(store.dir),
    provisioner: provisioned.provisioner,
    treasury: anchoring.writer,
    priceCycles,
    quoteMs: quoteMinutes * 60_000,
    log: (message) => console.log(chalk.gray(message)),
  });
  console.log(chalk.gray(`Selling canisters: ${Number(priceCycles) / 1e12} XDR each, paid in ICP to ${anchoring.writer}`));
  return {
    service,
    options: {
      create: async (key, owner) => orderView(await service.create(key, owner), anchoring.writer),
      get: (key) => {
        const record = service.get(key);
        return record ? orderView(record, anchoring.writer) : null;
      },
    },
  };
}

function anchoringOptions(
  anchoring: NonNullable<Awaited<ReturnType<typeof anchoringFor>>>,
  error: (stream: string) => string | null,
): AnchoringOptions {
  return { writer: anchoring.writer, defaultDestination: anchoring.defaultDestination, validateDestination: validateCanisterId, error };
}

function describeAnchors(records: readonly AnchorRecord[]): string {
  return records.map((record) => `${record.stream} ${record.from}-${record.to}`).join(', ');
}

function addCanisterOptions(command: Command): Command {
  return command
    .option('--canister-id <id>', 'memory_repo canister: where streams that name no place of their own are anchored, and the only one `verify` checks (or MEMORY_REPO_CANISTER_ID)')
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
    .option('--digest-only', 'Anchor only the hashes of each range, not a copy of its entries')
    .option('--provision-wasm <file>', 'Let hosts have canisters created for their owners, installed with this memory_repo wasm (needs --max-canisters)')
    .option('--provision-cycles <trillions>', 'Cycles each created canister is funded with, in trillions', '1')
    .option('--max-canisters <n>', 'The most canisters this gateway may ever create')
    .option('--cycles-ledger <id>', 'The cycles ledger that pays for them, off a local replica', CYCLES_LEDGER_ID)
    .option('--order-price-xdr <xdr>', 'Sell canisters for ICP at this price in XDR (a trillion cycles each); needs --provision-wasm')
    .option('--order-quote-minutes <minutes>', 'How long a quoted amount of ICP holds', String(DEFAULT_QUOTE_MINUTES)),
).action(async (options: StoreOptions & CanisterOptions & ProvisionFlags & OrderFlags & { host: string; port: string; anchorInterval: string; digestOnly?: boolean }) => {
  const token = process.env[LEDGER_TOKEN_ENV] ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    die(`Set ${LEDGER_TOKEN_ENV} to a secret of at least ${MIN_TOKEN_LENGTH} characters, for example: openssl rand -hex 32`);
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port must be a port number');
  const minutes = Number(options.anchorInterval);
  if (!Number.isFinite(minutes) || minutes <= 0) die('--anchor-interval must be a number of minutes above zero');

  // Refused before anything connects: the ICP ledger and the minting canister are on the Internet Computer only.
  if (options.orderPriceXdr !== undefined && options.icHost && isLocalReplicaHost(options.icHost)) {
    die('Selling canisters for ICP needs the Internet Computer: the ICP ledger and the cycles minting canister are not on a local replica');
  }
  const store = openStore(options);
  const anchoring = await anchoringFor(options, store);
  const provisioned = await provisioningFor(options, anchoring, store);
  const selling = await ordersFor(options, anchoring, provisioned, store);
  const schedule = anchoring
    ? startAnchorSchedule(store, anchoring.router, {
        intervalMs: minutes * 60_000,
        inlineEntries: !options.digestOnly,
        onAnchored: (records) => console.log(`Anchored ${describeAnchors(records)}`),
        onError: (error) => console.error(chalk.red(`Anchoring failed, will retry: ${error instanceof Error ? error.message : String(error)}`)),
      })
    : undefined;

  const server = createLedgerServer({
    store,
    token,
    anchoring: anchoring && schedule ? anchoringOptions(anchoring, (stream) => schedule.error(stream)) : undefined,
    provisioning: provisioned?.options,
    orders: selling?.options,
    onError: (error) => console.error(chalk.red(`Request failed: ${error instanceof Error ? error.message : String(error)}`)),
  });
  server.listen(port, options.host, () => {
    const address = server.address();
    const bound = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${options.host}:${port}`;
    console.log(`Ledger gateway listening on http://${bound} (${store.dir})`);
    if (!schedule) console.log(chalk.yellow('No replica named: entries are stored here but not anchored.'));
    else if (!anchoring?.defaultDestination) console.log(chalk.gray('No default canister: only streams that name their own are anchored.'));
  });

  const watcher = selling?.service.start(ORDER_POLL_MS);
  const shutdown = (): void => {
    watcher?.stop();
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
    const anchoring = await anchoringFor(options, store);
    if (!anchoring) die('Name the replica with --ic-host, and a canister with --canister-id unless streams name their own');
    const records = await anchorPending(store, anchoring.router, { inlineEntries: !options.digestOnly });
    console.log(records.length > 0 ? `Anchored ${describeAnchors(records)}` : 'Nothing to anchor');
  } catch (error) {
    if (error instanceof AnchorPassError && error.records.length > 0) console.log(`Anchored ${describeAnchors([...error.records])}`);
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
        const destination = store.anchorTarget(stream);
        return { stream, entries: head?.seq ?? 0, head: head?.hash ?? null, destination, anchored: store.anchoredSeq(stream, destination ?? undefined) };
      });
      if (options.json) {
        console.log(JSON.stringify({ dir: store.dir, streams }, null, 2));
        return;
      }
      console.log(chalk.gray(store.dir));
      if (streams.length === 0) console.log('No streams yet');
      for (const { stream, entries, head, destination, anchored } of streams) {
        const pending = entries - anchored;
        console.log(
          `${chalk.bold(stream)}  ${entries} entries  head ${head?.slice(0, 16) ?? '-'}  ` +
            (pending === 0 ? chalk.green('anchored') : chalk.yellow(`${pending} not anchored`)) +
            (destination ? chalk.gray(`  -> ${destination}`) : ''),
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

    if (options.canisterId || process.env.MEMORY_REPO_CANISTER_ID || options.icHost) {
      // Each anchor is read back from the canister it was written to; --canister-id narrows to one.
      const { host } = canisterTarget({ ...options, canisterId: options.canisterId ?? 'unused' });
      const only = options.canisterId ?? process.env.MEMORY_REPO_CANISTER_ID;
      const repos = new Map<string, Awaited<ReturnType<typeof readMemoryRepo>>>();
      for (const record of store.anchors()) {
        if (record.evidence.kind !== MEMORY_REPO_ANCHOR_KIND) continue;
        const named = record.evidence['canisterId'];
        if (typeof named !== 'string' || (only && named !== only)) continue;
        if (!repos.has(named)) repos.set(named, await readMemoryRepo({ canisterId: named, host }));
        const repo = repos.get(named)!;
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
