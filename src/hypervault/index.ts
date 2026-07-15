/**
 * HyperVault integration — public surface (`agentvault/hypervault`)
 *
 * The living cloud mind (hypervault.store) made a first-class citizen of
 * AgentVault: typed REST client, snapshot/bundle format, local indices,
 * backbone/wiki adapters, on-chain mind-DAG mirror, and the flagship
 * bootstrap/archive/restore pipeline.
 */

export * from './types.js';
export {
  HyperVaultClient,
  HyperVaultError,
  DEFAULT_HYPERVAULT_API_URL,
  countRows,
  type HyperVaultClientOptions,
  type ExportOptions,
  type ExportResult,
  type MemorizeInput,
  type RecallOptions,
} from './client.js';
export {
  resolveHyperVaultKey,
  storeHyperVaultKey,
  makeKeyRef,
  loadHypervaultState,
  saveHypervaultState,
  hypervaultStatePath,
  defaultHypervaultState,
  HYPERVAULT_KEY_SECRET_NAME,
  HYPERVAULT_STATE_FILENAME,
  type ResolvedHyperVaultKey,
  type HyperVaultKeySource,
} from './auth.js';
export {
  buildSnapshot,
  writeSnapshot,
  readSnapshot,
  validateSnapshot,
  verifySnapshot,
  readSnapshotEntry,
  snapshotToRecords,
  readEmbeddings,
  snapshotEmbeddingModel,
  canonicalManifestBytes,
  HYPERVAULT_SNAPSHOT_FORMAT,
  SNAPSHOT_FILE_EXTENSION,
  type HypervaultSnapshot,
  type HypervaultSnapshotManifest,
  type SnapshotVerifyResult,
  type BuildSnapshotOptions,
} from './snapshot.js';
export { FtsIndex, tokenize, type FtsHit, type FtsDocInput } from './index/fts-index.js';
export { VectorIndex, type VectorHit } from './index/vector-index.js';
export {
  buildIndices,
  buildIndicesFromSnapshot,
  saveIndices,
  loadIndices,
  snapshotMemories,
  indexDir,
  type BuiltIndices,
} from './index/builder.js';
export { hybridRecall, type QueryEmbedder, type HybridRecallOptions } from './index/recall.js';
export { HyperVaultMemoryStore } from './memory-store.js';
export { HyperVaultKnowledgeStore } from './knowledge-store.js';
export { HyperVaultWikiStore } from './wiki-store.js';
export {
  syncMindToCanister,
  topologicalOrder,
  collectSyncedCommitIds,
  writeArchiveReceipt,
  type MindSyncInput,
  type MindSyncResult,
} from './mind-sync.js';
export * from './pipeline.js';
export {
  getHyperVaultToolDefinitions,
  handleHyperVaultToolCall,
  serveMcp,
  type McpServeOptions,
} from './mcp-server.js';
