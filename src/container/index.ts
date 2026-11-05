/**
 * Public surface of the container runtime (PRD-01..04, 08).
 *
 * Why a barrel with explicit names: callers (the CLI, MCP glue, tests of other
 * layers) should import "the container module", not nine files, and a bare
 * `export *` would silently re-export whatever a file adds later.
 *
 * Names are chosen to stay clear of the other src/ barrels. src/pilot already
 * exports ProxyConfig, so the credential-proxy types keep their
 * Credential/Proxy-specific names; src/hypervault already exports
 * verifySnapshot (and has a snapshot format of its own), and src/packaging and
 * src/wallet export listAgents, so the volume-snapshot functions and listAgents
 * are exported ONLY under a "Container" alias.
 * tests/cli/commands/container.test.ts fails if a name here appears in another
 * src barrel.
 *
 * Module boundary (PRD-07 section 4): nothing in src/container may import from
 * src/hypervault, src/wiki or src/total-recall.
 *
 * Deliberately not exported: the credential-proxy engine in ./proxy (it runs
 * inside the sidecar, not in the host process), the AVENC byte-level crypto
 * (internal to snapshots and the secret store) and the tar validator.
 */

// Contracts
export { ContainerError, DEFAULT_AGENT_USER, DEFAULT_LIMITS } from './types.js';
export {
  LABEL_AGENT,
  LABEL_MANAGED,
  LABEL_MANIFEST,
  LABEL_ROLE,
  LABEL_SOURCE_HASH,
  LABEL_VOLUME_KEY,
  PROXY_ALIAS,
  PROXY_CONFIG_ENV,
  PROXY_PLACEHOLDER_KEY,
  PROXY_PORT,
  PROXY_SECRET_ENV_PREFIX,
} from './types.js';
export type {
  BuildRequest,
  BuildResult,
  CommandOptions,
  CommandResult,
  CommandRunner,
  ContainerErrorCode,
  ContainerInfo,
  ContainerMount,
  ContainerRole,
  ContainerRuntime,
  ContainerSpec,
  CredentialProxyConfig,
  ImageInfo,
  NetworkMode,
  ProxyInjection,
  ProxyPlan,
  ProxyRoute,
  ResourceLimits,
  SecretResolver,
  StartAgentRequest,
  StartedAgent,
} from './types.js';

// Validation and naming
export {
  AGENT_NAME_RE,
  CONTAINER_PATH_RE,
  ENV_NAME_RE,
  IMAGE_REF_RE,
  SECRET_NAME_RE,
  VOLUME_KEY_RE,
  agentvaultHome,
  assertAgentName,
  assertBindSource,
  assertContainerPath,
  assertEnvName,
  assertImageRef,
  assertSecretName,
  assertVolumeKey,
  resourceNames,
  secretEnvName,
  volumeKeyForPath,
  volumeKeysForPaths,
} from './validate.js';
export type { ResourceNames } from './validate.js';

// Manifest
export {
  DEFAULT_ISOLATION,
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  containerManifestSchema,
  manifestFromLabels,
  manifestToLabel,
  parseManifest,
} from './manifest.js';
export type { ContainerManifest } from './manifest.js';

// Policy and the Docker adapter
export { AGENT_ENV_DENYLIST, buildAgentSpec, buildProxySpec, isDeniedAgentEnvName } from './policy.js';
export { DockerRuntime, assertDockerName, buildRunArgs, classifyDockerFailure } from './docker.js';
export { execaRunner } from './runner.js';

// Packaging
export { OUTPUT_MARKER, packageContainer, stageBuildContext } from './package-image.js';
export type { ContainerPackageOptions, ContainerPackageResult, PackagingRuntime } from './package-image.js';

// Lifecycle
export {
  PROXY_READY_POLL_MS,
  PROXY_READY_TIMEOUT_MS,
  listAgents as listContainerAgents,
  redactSecrets,
  removeAgent,
  startAgent,
  stopAgent,
} from './lifecycle.js';
export type { AgentSummary, StartAgentOptions } from './lifecycle.js';

// Credentials
export {
  SecretStore,
  assertSecretValue,
  createChainResolver,
  createEnvResolver,
  createStoreResolver,
} from './secrets-store.js';
export type { PartialSecretResolver, SecretStoreOptions } from './secrets-store.js';
export { planProxy } from './proxy/plan.js';
export type { PlanProxyOptions } from './proxy/plan.js';
export { getPreset, listPresetServices, presetSecretEnvMapping } from './proxy/presets.js';
export type { ServicePreset } from './proxy/presets.js';

// Volume snapshots (aliased: src/hypervault owns the unprefixed names)
export {
  SNAPSHOT_FORMAT,
  createSnapshot as createContainerSnapshot,
  listSnapshots as listContainerSnapshots,
  readSnapshotManifest as readContainerSnapshotManifest,
  restoreSnapshot as restoreContainerSnapshot,
  verifySnapshot as verifyContainerSnapshot,
} from './snapshot.js';
export type {
  CreateSnapshotRequest as CreateContainerSnapshotRequest,
  CreateSnapshotResult as CreateContainerSnapshotResult,
  RestoreSnapshotRequest as RestoreContainerSnapshotRequest,
  RestoreSnapshotResult as RestoreContainerSnapshotResult,
  SnapshotManifest as ContainerSnapshotManifest,
  SnapshotSummary as ContainerSnapshotSummary,
  VerifySnapshotRequest as VerifyContainerSnapshotRequest,
  VerifySnapshotResult as VerifyContainerSnapshotResult,
} from './snapshot.js';
