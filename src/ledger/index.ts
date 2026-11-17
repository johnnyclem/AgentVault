/**
 * Ledger — public surface (`agentvault/ledger`)
 *
 * An append-only, hash-chained record an agent host writes to over HTTP,
 * anchored on a memory_repo canister. The host seals its own records; the
 * ledger never reads them.
 */

export * from './format.js';
export { LedgerStore, LedgerConflictError, LedgerCorruptError, recordDestination, type AnchorEvidence, type AnchorRecord } from './store.js';
export {
  ANCHOR_FORMAT,
  AnchorPassError,
  anchorPending,
  type AnchorCheckpoint,
  type AnchorFailure,
  type AnchorOptions,
  type AnchorRouter,
  type LedgerAnchor,
} from './anchor.js';
export { createDestinationRouter, destinationOf, type DestinationRouterOptions } from './anchor-router.js';
export {
  MEMORY_REPO_ANCHOR_KIND,
  DEFAULT_LEDGER_BRANCH,
  MemoryRepoAnchor,
  checkMemoryRepoAnchor,
  connectMemoryRepo,
  readMemoryRepo,
  memoryRepoHistory,
  readMemoryRepoHistory,
  type AnchorCheckResult,
  type MemoryRepoEvidence,
  type MemoryRepoPort,
} from './memory-repo-anchor.js';
export { assessCanister, readCanisterFacts, type CanisterFacts, type Finding, type FindingLevel } from './check.js';
export { decodeControllers, readCanisterControl, type CanisterControl } from '../canister/memory-repo-control.js';
export {
  rebuildFromMemoryRepo,
  type MemoryRepoHistoryPort,
  type RebuildOptions,
  type RebuildReport,
  type RebuiltStream,
  type RepoCommit,
} from './rebuild.js';
export {
  MAX_BODY_BYTES,
  MIN_TOKEN_LENGTH,
  createLedgerServer,
  startAnchorSchedule,
  type AnchorSchedule,
  type AnchoringOptions,
  type LedgerServerOptions,
  type ProvisioningOptions,
} from './server.js';
