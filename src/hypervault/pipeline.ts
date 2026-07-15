/**
 * HyperVault pipeline — the flows behind the CLI commands and MCP tools
 *
 * Every flagship flow (§6) lives here as a plain async function so the
 * `agentvault hypervault …` CLI, the native MCP server, and the SDK all
 * share one implementation:
 *
 *   connect   → validate key, vault it, write hypervault.json (keyRef only)
 *   pull      → incremental export → snapshot + working tree + indices
 *   snapshot  → full export → snapshot bundle on disk
 *   archive   → snapshot → encrypt → canister replay → Arweave → receipts
 *   verify    → every link of the integrity chain
 *   restore   → Arweave tx / snapshot file → local project or hypervault
 *   status    → the whole three-tier picture
 *   recall    → offline hybrid recall over local indices
 *   bootstrap → scaffold + connect + pull + MCP wiring
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { HyperVaultClient, countRows, type ExportResult } from './client.js';
import {
  defaultHypervaultState,
  loadHypervaultState,
  resolveHyperVaultKey,
  saveHypervaultState,
  storeHyperVaultKey,
} from './auth.js';
import {
  buildSnapshot,
  readSnapshot,
  snapshotToRecords,
  verifySnapshot,
  writeSnapshot,
  readEmbeddings,
  snapshotEmbeddingModel,
  SNAPSHOT_FILE_EXTENSION,
  type HypervaultSnapshot,
  type SnapshotVerifyResult,
} from './snapshot.js';
import {
  buildIndices,
  loadIndices,
  saveIndices,
  snapshotMemories,
} from './index/builder.js';
import { hybridRecall, type QueryEmbedder } from './index/recall.js';
import { syncMindToCanister, writeArchiveReceipt, type MindSyncResult } from './mind-sync.js';
import {
  hvMemorySchema,
  hvMindBranchSchema,
  hvMindCommitSchema,
  hvRevisionSchema,
  type HvExportRecord,
  type HvMemory,
  type HvRecallResult,
  type HypervaultState,
} from './types.js';
import type { _SERVICE } from '../canister/memory-repo-actor.js';

export const SNAPSHOT_DIR = path.join('.agentvault', 'canister');
export const SNAPSHOT_BASENAME = `latest${SNAPSHOT_FILE_EXTENSION}`;
export const MEMORIES_DIR = path.join('.agentvault', 'memories');

export function snapshotPath(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, SNAPSHOT_DIR, SNAPSHOT_BASENAME);
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  key?: string;
  apiUrl?: string;
  agentId?: string;
  projectRoot?: string;
}

export interface ConnectResult {
  valid: boolean;
  keyRef?: string;
  vaulted: boolean;
  userIdHint?: string;
  warning?: string;
}

export async function connectHyperVault(options: ConnectOptions = {}): Promise<ConnectResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const agentId = options.agentId ?? projectAgentId(projectRoot);
  const resolved = await resolveHyperVaultKey({ flagKey: options.key, agentId });
  if (!resolved) {
    throw new Error(
      'No HyperVault API key found. Pass one via HYPERVAULT_API_KEY, the secrets vault, or --key (discouraged).',
    );
  }

  const client = new HyperVaultClient({ apiKey: resolved.key, apiUrl: options.apiUrl });
  const validation = await client.validateKey();
  if (!validation.valid) {
    return { valid: false, vaulted: false };
  }

  // Vault the key so it never needs to be passed again; scrub any flag copy.
  let keyRef = resolved.keyRef;
  let vaulted = resolved.source === 'vault';
  let warning: string | undefined;
  if (resolved.source !== 'vault' && agentId) {
    try {
      keyRef = await storeHyperVaultKey(agentId, resolved.key);
      vaulted = true;
    } catch {
      warning = 'Secrets vault unavailable — key NOT persisted. Set HYPERVAULT_API_KEY or configure `agentvault vault`.';
    }
  }
  if (resolved.insecureSource) {
    warning = [
      'The --key flag leaks secrets into shell history and process lists; prefer HYPERVAULT_API_KEY or the secrets vault.',
      warning,
    ]
      .filter(Boolean)
      .join(' ');
  }

  const state: HypervaultState = {
    ...(loadHypervaultState(projectRoot) ?? defaultHypervaultState()),
    apiUrl: client.getApiUrl(),
    keyRef,
    userIdHint: validation.userIdHint,
  };
  ensureDir(path.join(projectRoot, '.agentvault'));
  saveHypervaultState(state, projectRoot);

  return { valid: true, keyRef, vaulted, userIdHint: validation.userIdHint, warning };
}

/** Build an authenticated client from resolved key + saved state. */
export async function clientFromProject(options: {
  key?: string;
  apiUrl?: string;
  projectRoot?: string;
} = {}): Promise<HyperVaultClient> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const state = loadHypervaultState(projectRoot);
  const resolved = await resolveHyperVaultKey({
    flagKey: options.key,
    agentId: projectAgentId(projectRoot),
  });
  if (!resolved) {
    throw new Error('No HyperVault API key available. Run `agentvault hypervault connect` first.');
  }
  return new HyperVaultClient({
    apiKey: resolved.key,
    apiUrl: options.apiUrl ?? state?.apiUrl,
  });
}

// ---------------------------------------------------------------------------
// pull (incremental export → snapshot + working tree + indices)
// ---------------------------------------------------------------------------

export interface PullOptions {
  client: HyperVaultClient;
  projectRoot?: string;
  branch?: string;
  since?: string;
  /** Skip artifact entries (--no-artifacts) */
  includeArtifacts?: boolean;
  /** Skip index build (--no-index) */
  buildIndex?: boolean;
}

export interface PullResult {
  recordsPulled: number;
  totalRecords: number;
  memoriesWritten: number;
  indicesBuilt: boolean;
  snapshotFile: string;
  cursor?: string;
}

export async function pullHyperVault(options: PullOptions): Promise<PullResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const state = loadHypervaultState(projectRoot) ?? defaultHypervaultState();
  const since = options.since ?? state.lastExportCursor;

  const include = options.includeArtifacts === false
    ? ['memories', 'mind', 'connections', 'embeddings']
    : undefined;
  const fresh = await options.client.exportVault({ since, branch: options.branch ?? state.branch, include });

  // Merge into the existing snapshot for incremental pulls.
  let merged: HvExportRecord[] = fresh.records;
  const file = snapshotPath(projectRoot);
  if (since && fs.existsSync(file)) {
    const existing = await snapshotToRecords(await readSnapshot(file));
    merged = mergeRecords(existing, fresh.records);
  }

  const manifest = { ...fresh.manifest, row_counts: countRows(merged) };
  const snapshot = await buildSnapshot(merged, manifest);
  ensureDir(path.dirname(file));
  await writeSnapshot(snapshot, file);

  const memories = await snapshotMemories(snapshot);
  const memoriesWritten = writeMemoriesWorkingTree(memories, projectRoot);

  let indicesBuilt = false;
  if (options.buildIndex !== false) {
    const embeddings = await readEmbeddings(snapshot);
    const model = await snapshotEmbeddingModel(snapshot);
    saveIndices(buildIndices(memories, embeddings, model), projectRoot);
    indicesBuilt = true;
  }

  saveHypervaultState(
    {
      ...state,
      branch: options.branch ?? state.branch,
      lastExportCursor: fresh.manifest.cursor ?? state.lastExportCursor,
      lastSync: new Date().toISOString(),
    },
    projectRoot,
  );

  return {
    recordsPulled: fresh.records.length,
    totalRecords: merged.length,
    memoriesWritten,
    indicesBuilt,
    snapshotFile: file,
    cursor: fresh.manifest.cursor,
  };
}

/** Merge export records, newer rows replacing older ones by (table, id). */
export function mergeRecords(existing: HvExportRecord[], fresh: HvExportRecord[]): HvExportRecord[] {
  const keyOf = (r: HvExportRecord): string => {
    const id = typeof r.row.id === 'string' ? r.row.id : typeof r.row.name === 'string' ? r.row.name : JSON.stringify(r.row);
    return `${r.table} ${id}`;
  };
  const merged = new Map<string, HvExportRecord>();
  for (const record of existing) merged.set(keyOf(record), record);
  for (const record of fresh) merged.set(keyOf(record), record);
  return [...merged.values()];
}

/** Write the human-readable markdown working tree (`.agentvault/memories/`). */
export function writeMemoriesWorkingTree(memories: HvMemory[], projectRoot: string = process.cwd()): number {
  const dir = path.join(projectRoot, MEMORIES_DIR);
  ensureDir(dir);
  let written = 0;
  for (const memory of memories) {
    const safeName = memory.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'memory';
    const frontmatter = [
      '---',
      `id: ${JSON.stringify(memory.id)}`,
      `title: ${JSON.stringify(memory.title)}`,
      `tags: ${JSON.stringify(memory.tags)}`,
      ...(memory.branch ? [`branch: ${JSON.stringify(memory.branch)}`] : []),
      ...(memory.summary ? [`summary: ${JSON.stringify(memory.summary)}`] : []),
      ...(memory.updated_at ? [`updated_at: ${JSON.stringify(memory.updated_at)}`] : []),
      '---',
      '',
    ].join('\n');
    atomicWriteFileSync(path.join(dir, `${safeName}.md`), frontmatter + memory.content + '\n', {
      encoding: 'utf8',
    });
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// push (local working tree → cloud, via provenance-stamped writes)
// ---------------------------------------------------------------------------

export interface PushOptions {
  client: HyperVaultClient;
  projectRoot?: string;
  dryRun?: boolean;
}

export interface PushChange {
  id: string;
  title: string;
  kind: 'create' | 'update';
}

export interface PushResult {
  changes: PushChange[];
  pushed: number;
  dryRun: boolean;
}

/**
 * Push local working-tree edits up through `memorize`/`editMemory` so each
 * lands as a mind commit. New files (no cloud id) become creates.
 */
export async function pushHyperVault(options: PushOptions): Promise<PushResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dir = path.join(projectRoot, MEMORIES_DIR);
  if (!fs.existsSync(dir)) {
    return { changes: [], pushed: 0, dryRun: Boolean(options.dryRun) };
  }

  const file = snapshotPath(projectRoot);
  const baseline = new Map<string, HvMemory>();
  if (fs.existsSync(file)) {
    for (const memory of await snapshotMemories(await readSnapshot(file))) {
      baseline.set(memory.id, memory);
    }
  }

  const changes: PushChange[] = [];
  const toPush: Array<{ change: PushChange; memory: Partial<HvMemory> & { content: string } }> = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const parsed = parseMemoryMarkdown(fs.readFileSync(path.join(dir, entry), 'utf-8'));
    if (!parsed) continue;
    const existing = parsed.id ? baseline.get(parsed.id) : undefined;
    if (existing) {
      if (existing.content.trimEnd() !== parsed.content.trimEnd() || existing.title !== (parsed.title ?? existing.title)) {
        const change: PushChange = { id: existing.id, title: parsed.title ?? existing.title, kind: 'update' };
        changes.push(change);
        toPush.push({ change, memory: { id: existing.id, title: parsed.title, content: parsed.content, tags: parsed.tags } });
      }
    } else {
      const change: PushChange = { id: parsed.id ?? entry, title: parsed.title ?? entry, kind: 'create' };
      changes.push(change);
      toPush.push({ change, memory: { title: parsed.title, content: parsed.content, tags: parsed.tags } });
    }
  }

  if (options.dryRun) {
    return { changes, pushed: 0, dryRun: true };
  }

  let pushed = 0;
  for (const { change, memory } of toPush) {
    if (change.kind === 'update' && memory.id) {
      await options.client.editMemory(memory.id, {
        title: memory.title,
        content: memory.content,
        tags: memory.tags,
      });
    } else {
      await options.client.memorize({ title: memory.title, content: memory.content, tags: memory.tags });
    }
    pushed += 1;
  }
  return { changes, pushed, dryRun: false };
}

function parseMemoryMarkdown(
  text: string,
): { id?: string; title?: string; tags?: string[]; content: string } | null {
  if (!text.startsWith('---\n')) {
    return { content: text };
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { content: text };
  const header = text.slice(4, end);
  const content = text.slice(end + 5).replace(/^\n/, '');
  const fields: Record<string, unknown> = {};
  for (const line of header.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    try {
      fields[key] = JSON.parse(line.slice(colon + 1).trim());
    } catch {
      fields[key] = line.slice(colon + 1).trim();
    }
  }
  return {
    id: typeof fields.id === 'string' ? fields.id : undefined,
    title: typeof fields.title === 'string' ? fields.title : undefined,
    tags: Array.isArray(fields.tags) ? fields.tags.filter((t): t is string => typeof t === 'string') : undefined,
    content,
  };
}

// ---------------------------------------------------------------------------
// snapshot (full export → bundle on disk)
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  client: HyperVaultClient;
  outputPath?: string;
  passphrase?: string;
  includeConversations?: boolean;
  branch?: string;
  projectRoot?: string;
  signingKeyPath?: string;
}

export interface SnapshotResult {
  snapshot: HypervaultSnapshot;
  path: string;
  sizeBytes: number;
  rowCounts: Record<string, number>;
}

export async function snapshotHyperVault(options: SnapshotOptions): Promise<SnapshotResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const include = options.includeConversations ? undefined : undefined; // server default: all
  const exported: ExportResult = await options.client.exportVault({ branch: options.branch, include });
  const snapshot = await buildSnapshot(exported.records, exported.manifest, {
    passphrase: options.passphrase,
    includeConversations: options.includeConversations,
    signingKeyPath: options.signingKeyPath,
  });
  const outputPath =
    options.outputPath ?? path.join(projectRoot, `hypervault-${timestampSlug()}${SNAPSHOT_FILE_EXTENSION}`);
  ensureDir(path.dirname(outputPath));
  const sizeBytes = await writeSnapshot(snapshot, outputPath);
  return { snapshot, path: outputPath, sizeBytes, rowCounts: snapshot.manifest.rowCounts };
}

// ---------------------------------------------------------------------------
// archive (§6.2) — snapshot → encrypt → canister → Arweave → receipts → verify
// ---------------------------------------------------------------------------

export interface ArchiveOptions {
  client: HyperVaultClient;
  projectRoot?: string;
  passphrase?: string;
  /** memory_repo canister actor (omit to skip the warm tier) */
  actor?: _SERVICE;
  canisterId?: string;
  /** Arweave JWK (omit to skip the cold tier) */
  arweaveJwk?: Record<string, unknown>;
  /** Injected for tests */
  archiver?: ArchiverLike;
  agentName?: string;
  includeConversations?: boolean;
  since?: string;
  signingKeyPath?: string;
  onStep?: (step: string, detail?: string) => void;
}

export interface ArchiverLike {
  archive(
    state: Record<string, unknown>,
    jwk: Record<string, unknown>,
  ): Promise<{ success: boolean; transactionId?: string; error?: string }>;
  fetchBundle(bundleId: string): Promise<{ state: string } | null>;
  verifyBundle(bundle: never, expectedPublicKey?: string): Promise<{ valid: boolean; error?: string }>;
}

export interface ArchiveResultSummary {
  snapshotFile: string;
  rowCounts: Record<string, number>;
  mindSync?: MindSyncResult;
  arweaveTx?: string;
  receiptOnChain: boolean;
  receiptPosted: boolean;
  verified: boolean;
  errors: string[];
}

export async function archiveHyperVault(options: ArchiveOptions): Promise<ArchiveResultSummary> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const step = options.onStep ?? ((): void => undefined);
  const errors: string[] = [];

  // 1. Export
  step('export', options.since ? `incremental since ${options.since}` : 'full account');
  const exported = await options.client.exportVault({ since: options.since });

  // 2. Bundle (+ 3. encrypt)
  step('bundle', `${exported.records.length} records`);
  const snapshot = await buildSnapshot(exported.records, exported.manifest, {
    passphrase: options.passphrase,
    includeConversations: options.includeConversations,
    signingKeyPath: options.signingKeyPath,
  });
  const file = path.join(projectRoot, SNAPSHOT_DIR, `archive-${timestampSlug()}${SNAPSHOT_FILE_EXTENSION}`);
  ensureDir(path.dirname(file));
  await writeSnapshot(snapshot, file);
  step('encrypt', options.passphrase ? 'aes-256-gcm (passphrase-wrapped)' : 'plaintext (--encrypt recommended)');

  // 4. Canister commit — replay the mind DAG
  let mindSync: MindSyncResult | undefined;
  if (options.actor) {
    step('canister', options.canisterId);
    const records = exported.records;
    mindSync = await syncMindToCanister(options.actor, {
      commits: parseRows(records, 'memory_commits', hvMindCommitSchema),
      revisions: parseRows(records, 'memory_revisions', hvRevisionSchema),
      branches: parseRows(records, 'memory_branches', hvMindBranchSchema),
      memories: parseRows(records, 'memories', hvMemorySchema),
    });
    errors.push(...mindSync.errors);
  }

  // 5. Arweave upload
  let arweaveTx: string | undefined;
  let verified = false;
  if (options.arweaveJwk) {
    step('arweave', 'uploading snapshot bundle');
    const archiver = options.archiver ?? (await defaultArchiver(options.agentName ?? projectAgentId(projectRoot) ?? 'agent', options.signingKeyPath));
    const upload = await archiver.archive(
      { format: snapshot.format, snapshot: JSON.stringify(snapshot) },
      options.arweaveJwk,
    );
    if (upload.success && upload.transactionId) {
      arweaveTx = upload.transactionId;
    } else {
      errors.push(`Arweave upload failed: ${upload.error ?? 'unknown error'}`);
    }

    // 7. Verify — re-fetch and check the whole chain
    if (arweaveTx) {
      step('verify', arweaveTx);
      try {
        const fetched = await archiver.fetchBundle(arweaveTx);
        if (fetched) {
          const state = JSON.parse(fetched.state) as { snapshot?: string };
          if (state.snapshot) {
            const roundTripped = JSON.parse(state.snapshot) as HypervaultSnapshot;
            const result = await verifySnapshot(roundTripped, { passphrase: options.passphrase });
            verified = result.signatureValid && result.checksumsValid;
            if (!verified) errors.push(...result.errors);
          }
        } else {
          errors.push('Could not re-fetch bundle from Arweave for verification');
        }
      } catch (error) {
        errors.push(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 6. Receipts
  let receiptOnChain = false;
  let receiptPosted = false;
  if (arweaveTx) {
    step('receipts', arweaveTx);
    if (options.actor) {
      receiptOnChain = await writeArchiveReceipt(options.actor, arweaveTx, snapshot.manifest.merkleRoot);
    }
    try {
      await options.client.postArchiveReceipt({
        kind: 'arweave',
        ref: arweaveTx,
        manifest_hash: snapshot.manifest.merkleRoot,
      });
      receiptPosted = true;
    } catch {
      receiptPosted = false;
    }
  }

  // Update cursors
  const state = loadHypervaultState(projectRoot) ?? defaultHypervaultState();
  saveHypervaultState(
    {
      ...state,
      canisterId: options.canisterId ?? state.canisterId,
      lastArweaveTx: arweaveTx ?? state.lastArweaveTx,
      lastMindCommitSynced: mindSync?.lastSyncedCommitId ?? state.lastMindCommitSynced,
      lastExportCursor: exported.manifest.cursor ?? state.lastExportCursor,
      lastSync: new Date().toISOString(),
    },
    projectRoot,
  );

  return {
    snapshotFile: file,
    rowCounts: snapshot.manifest.rowCounts,
    mindSync,
    arweaveTx,
    receiptOnChain,
    receiptPosted,
    verified,
    errors,
  };
}

async function defaultArchiver(agentName: string, signingKeyPath?: string): Promise<ArchiverLike> {
  const { ArweaveArchiver } = await import('../archival/arweave-archiver.js');
  return new ArweaveArchiver({ agentName, signingKeyPath }) as unknown as ArchiverLike;
}

function parseRows<T>(
  records: HvExportRecord[],
  table: HvExportRecord['table'],
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): T[] {
  const rows: T[] = [];
  for (const record of records) {
    if (record.table !== table) continue;
    const parsed = schema.safeParse(record.row);
    if (parsed.success && parsed.data !== undefined) rows.push(parsed.data);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// verify / restore
// ---------------------------------------------------------------------------

export async function verifySnapshotFile(
  filePath: string,
  options: { passphrase?: string; expectedPublicKey?: string } = {},
): Promise<SnapshotVerifyResult> {
  const snapshot = await readSnapshot(filePath);
  return verifySnapshot(snapshot, options);
}

export interface RestoreOptions {
  /** `ar://<tx>` or a snapshot file path */
  ref: string;
  to: 'local' | 'hypervault';
  passphrase?: string;
  projectRoot?: string;
  /** Required for --to hypervault (a distinct explicit key — §7.4) */
  client?: HyperVaultClient;
  /** Injected for tests / Arweave fetch */
  archiver?: ArchiverLike;
  agentName?: string;
}

export interface RestoreResult {
  records: number;
  memoriesWritten?: number;
  importedToHypervault?: number;
  verify: SnapshotVerifyResult;
}

export async function restoreHyperVault(options: RestoreOptions): Promise<RestoreResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  let snapshot: HypervaultSnapshot;

  if (options.ref.startsWith('ar://')) {
    const txId = options.ref.slice('ar://'.length);
    const archiver = options.archiver ?? (await defaultArchiver(options.agentName ?? 'agent'));
    const bundle = await archiver.fetchBundle(txId);
    if (!bundle) {
      throw new Error(`Could not fetch Arweave bundle ${txId}`);
    }
    const state = JSON.parse(bundle.state) as { snapshot?: string };
    if (!state.snapshot) {
      throw new Error('Arweave bundle does not contain a hypervault snapshot');
    }
    snapshot = JSON.parse(state.snapshot) as HypervaultSnapshot;
  } else {
    snapshot = await readSnapshot(options.ref);
  }

  const verify = await verifySnapshot(snapshot, { passphrase: options.passphrase });
  if (!verify.signatureValid || !verify.checksumsValid) {
    throw new Error(`Snapshot failed verification: ${verify.errors.join('; ') || 'unknown error'}`);
  }

  const records = await snapshotToRecords(snapshot, options.passphrase);

  if (options.to === 'hypervault') {
    if (!options.client) {
      throw new Error('Restoring to hypervault requires an explicit API key for the destination account');
    }
    const result = await options.client.importVault(records);
    return { records: records.length, importedToHypervault: result.imported, verify };
  }

  // --to local: rebuild snapshot copy, working tree, and indices
  const file = snapshotPath(projectRoot);
  ensureDir(path.dirname(file));
  await writeSnapshot(snapshot, file);
  const memories = await snapshotMemories(snapshot, options.passphrase);
  const memoriesWritten = writeMemoriesWorkingTree(memories, projectRoot);
  const embeddings = await readEmbeddings(snapshot, options.passphrase);
  const model = await snapshotEmbeddingModel(snapshot, options.passphrase);
  saveIndices(buildIndices(memories, embeddings, model), projectRoot);

  const state = loadHypervaultState(projectRoot) ?? defaultHypervaultState();
  saveHypervaultState({ ...state, lastSync: new Date().toISOString() }, projectRoot);

  return { records: records.length, memoriesWritten, verify };
}

// ---------------------------------------------------------------------------
// status — the whole three-tier picture
// ---------------------------------------------------------------------------

export interface StatusOptions {
  projectRoot?: string;
  client?: HyperVaultClient;
  actor?: _SERVICE;
}

export interface StatusResult {
  configured: boolean;
  apiUrl?: string;
  keyRef?: string;
  keyValid?: boolean;
  cloud?: { memories: number; artifacts: number; branches: number };
  local: {
    snapshotPresent: boolean;
    memoriesInWorkingTree: number;
    ftsIndexed: number;
    vectorsIndexed: number;
    lastSync?: string;
    lastExportCursor?: string;
  };
  canister?: { id: string; currentBranch?: string; totalCommits?: string; lastMindCommitSynced?: string };
  arweave?: { lastTx?: string };
}

export async function statusHyperVault(options: StatusOptions = {}): Promise<StatusResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const state = loadHypervaultState(projectRoot);

  const local = {
    snapshotPresent: fs.existsSync(snapshotPath(projectRoot)),
    memoriesInWorkingTree: countMarkdown(path.join(projectRoot, MEMORIES_DIR)),
    ftsIndexed: 0,
    vectorsIndexed: 0,
    lastSync: state?.lastSync,
    lastExportCursor: state?.lastExportCursor,
  };
  const indices = loadIndices(projectRoot);
  local.ftsIndexed = indices.fts?.size ?? 0;
  local.vectorsIndexed = indices.vectors?.size ?? 0;

  const result: StatusResult = {
    configured: state !== null,
    apiUrl: state?.apiUrl,
    keyRef: state?.keyRef,
    local,
    arweave: state?.lastArweaveTx ? { lastTx: state.lastArweaveTx } : undefined,
  };

  if (options.client) {
    try {
      const validation = await options.client.validateKey();
      result.keyValid = validation.valid;
      if (validation.valid) {
        const [memories, artifacts, branches] = await Promise.all([
          options.client.listMemories(),
          options.client.listArtifacts(),
          options.client.mindBranches(),
        ]);
        result.cloud = { memories: memories.length, artifacts: artifacts.length, branches: branches.length };
      }
    } catch {
      result.keyValid = false;
    }
  }

  if (state?.canisterId) {
    result.canister = { id: state.canisterId, lastMindCommitSynced: state.lastMindCommitSynced };
    if (options.actor) {
      try {
        const repo = await options.actor.getRepoStatus();
        result.canister.currentBranch = repo.currentBranch;
        result.canister.totalCommits = repo.totalCommits.toString();
      } catch {
        // canister unreachable — leave the cached values
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// recall — offline hybrid recall over local indices
// ---------------------------------------------------------------------------

export interface RecallLocalOptions {
  projectRoot?: string;
  limit?: number;
  embedQuery?: QueryEmbedder;
  passphrase?: string;
}

export async function recallLocal(query: string, options: RecallLocalOptions = {}): Promise<HvRecallResult[]> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const indices = loadIndices(projectRoot);
  if (!indices.fts && !indices.vectors) {
    throw new Error('No local indices found. Run `agentvault hypervault pull` or `reindex` first.');
  }
  const file = snapshotPath(projectRoot);
  if (!fs.existsSync(file)) {
    throw new Error('No local snapshot found. Run `agentvault hypervault pull` first.');
  }
  const memories = await snapshotMemories(await readSnapshot(file), options.passphrase);
  const memoriesById = new Map(memories.map((m) => [m.id, m]));
  return hybridRecall(query, indices, memoriesById, {
    limit: options.limit,
    embedQuery: options.embedQuery,
  });
}

/** Rebuild local indices from the pulled snapshot. */
export async function reindexHyperVault(options: { projectRoot?: string; passphrase?: string } = {}): Promise<{
  memoriesIndexed: number;
  vectorsIndexed: number;
}> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const file = snapshotPath(projectRoot);
  if (!fs.existsSync(file)) {
    throw new Error('No local snapshot found. Run `agentvault hypervault pull` first.');
  }
  const snapshot = await readSnapshot(file);
  const memories = await snapshotMemories(snapshot, options.passphrase);
  const embeddings = await readEmbeddings(snapshot, options.passphrase);
  const model = await snapshotEmbeddingModel(snapshot, options.passphrase);
  const built = buildIndices(memories, embeddings, model);
  saveIndices(built, projectRoot);
  return { memoriesIndexed: built.memoriesIndexed, vectorsIndexed: built.vectorsIndexed };
}

// ---------------------------------------------------------------------------
// bootstrap (§6.1) — scaffold + connect + pull + indices + MCP wiring
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  project: string;
  key?: string;
  apiUrl?: string;
  branch?: string;
  includeArtifacts?: boolean;
  buildIndex?: boolean;
  soulSlug?: string;
  cwd?: string;
  onStep?: (step: string, detail?: string) => void;
}

export interface BootstrapResult {
  projectPath: string;
  connected: boolean;
  pull?: PullResult;
  mcpConfigPath: string;
  soulDetected: boolean;
  warning?: string;
}

export async function bootstrapHyperVault(options: BootstrapOptions): Promise<BootstrapResult> {
  const step = options.onStep ?? ((): void => undefined);
  const cwd = options.cwd ?? process.cwd();
  const projectPath = path.resolve(cwd, options.project);
  const name = path.basename(projectPath);

  // 1. Scaffold
  step('scaffold', projectPath);
  ensureDir(projectPath);
  const agentJsonPath = path.join(projectPath, 'agent.json');
  if (!fs.existsSync(agentJsonPath)) {
    atomicWriteFileSync(
      agentJsonPath,
      JSON.stringify(
        {
          name,
          version: '1.0.0',
          description: `HyperVault-backed agent ${name}`,
          type: 'generic',
          entryPoint: 'index.js',
          hypervault: { apiUrl: options.apiUrl ?? defaultHypervaultState().apiUrl, branch: options.branch ?? 'main' },
        },
        null,
        2,
      ) + '\n',
      { encoding: 'utf8' },
    );
  }
  const indexJsPath = path.join(projectPath, 'index.js');
  if (!fs.existsSync(indexJsPath)) {
    atomicWriteFileSync(
      indexJsPath,
      `// ${name} — HyperVault-backed AgentVault agent\nexport async function handleTask(task) {\n  return { status: 'ok', task };\n}\n`,
      { encoding: 'utf8' },
    );
  }
  ensureDir(path.join(projectPath, '.agentvault'));

  // 2. Connect
  step('connect');
  const connect = await connectHyperVault({
    key: options.key,
    apiUrl: options.apiUrl,
    agentId: name,
    projectRoot: projectPath,
  });
  if (!connect.valid) {
    return {
      projectPath,
      connected: false,
      mcpConfigPath: '',
      soulDetected: false,
      warning: 'HyperVault key was rejected — create one at your hypervault.store dashboard and re-run connect.',
    };
  }

  // 3+4. Pull memories & mind, build indices
  step('pull');
  const client = await clientFromProject({ key: options.key, apiUrl: options.apiUrl, projectRoot: projectPath });
  const pull = await pullHyperVault({
    client,
    projectRoot: projectPath,
    branch: options.branch,
    includeArtifacts: options.includeArtifacts,
    buildIndex: options.buildIndex,
  });

  // 5. Wire MCP — register both the native server and the upstream Python one
  step('mcp');
  const mcpConfigPath = path.join(projectPath, '.mcp.json');
  const existing = fs.existsSync(mcpConfigPath)
    ? (JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8')) as { mcpServers?: Record<string, unknown> })
    : {};
  const mcpConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      agentvault: {
        command: 'npx',
        args: ['-y', 'agentvault@latest', 'mcp', 'serve'],
      },
      'hypervault-mcp': {
        command: 'hypervault-mcp',
        args: [],
      },
    },
  };
  atomicWriteFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n', { encoding: 'utf8' });

  // 6. Soul detection
  step('soul');
  let soulDetected = false;
  try {
    const soulMemories = options.soulSlug
      ? [await client.getMemory(options.soulSlug)].filter((m): m is HvMemory => m !== null)
      : (await client.listMemories({ tags: ['soul'] })).filter((m) => m.tags.includes('soul'));
    const soul = soulMemories[0];
    if (soul) {
      atomicWriteFileSync(path.join(projectPath, 'soul.md'), soul.content + '\n', { encoding: 'utf8' });
      atomicWriteFileSync(
        path.join(projectPath, '.agentvault', 'memory-repo.config.json'),
        JSON.stringify({ soulDetected: true, soulFile: 'soul.md', detectedAt: Date.now() }, null, 2) + '\n',
        { encoding: 'utf8' },
      );
      soulDetected = true;
    }
  } catch {
    soulDetected = false;
  }

  return { projectPath, connected: true, pull, mcpConfigPath, soulDetected, warning: connect.warning };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function projectAgentId(projectRoot: string): string | undefined {
  const agentJson = path.join(projectRoot, 'agent.json');
  if (fs.existsSync(agentJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(agentJson, 'utf-8')) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // fall through
    }
  }
  const configPath = path.join(projectRoot, '.agentvault', 'config', 'agent.config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // fall through
    }
  }
  return undefined;
}

function countMarkdown(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
