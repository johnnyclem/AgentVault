/**
 * HyperVault integration — schema types
 *
 * TypeScript mirrors of the hypervault.store schema (memories, mind DAG,
 * artifacts, connections) plus the export/import wire format. Validators
 * follow the src/backbone/validators.ts idiom (zod object schemas with
 * inferred types).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core rows
// ---------------------------------------------------------------------------

/** A live memory row (`memories` table) */
export const hvMemorySchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  content: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  branch: z.string().optional(),
  /** pgvector embedding (1536-d for text-embedding-3-small); optional in exports */
  embedding: z.array(z.number()).optional(),
  embedding_model: z.string().optional(),
  author_kind: z.string().optional(),
  author_key_prefix: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type HvMemory = z.infer<typeof hvMemorySchema>;

/** A saved artifact (`artifacts` table) */
export const hvArtifactSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().default(''),
  content: z.string().default(''),
  original_content: z.string().optional(),
  source_prompt: z.string().optional(),
  content_hash: z.string().optional(),
  tags: z.array(z.string()).default([]),
  visibility: z.enum(['public', 'unlisted', 'private']).default('private'),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type HvArtifact = z.infer<typeof hvArtifactSchema>;

/** Artifact graph edge (`connections` table) */
export const hvConnectionSchema = z.object({
  id: z.string().min(1),
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  kind: z.string().default('link'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().optional(),
});
export type HvConnection = z.infer<typeof hvConnectionSchema>;

/** Memory knowledge-graph edge (`memory_links` table) */
export const hvMemoryLinkSchema = z.object({
  id: z.string().min(1),
  from_memory_id: z.string().min(1),
  to_memory_id: z.string().min(1),
  kind: z.string().default('related'),
  created_at: z.string().optional(),
});
export type HvMemoryLink = z.infer<typeof hvMemoryLinkSchema>;

// ---------------------------------------------------------------------------
// Mind DAG ("Git for a Mind")
// ---------------------------------------------------------------------------

/** A mind branch (`memory_branches` table) */
export const hvMindBranchSchema = z.object({
  name: z.string().min(1),
  head_commit_id: z.string().optional(),
  created_at: z.string().optional(),
});
export type HvMindBranch = z.infer<typeof hvMindBranchSchema>;

/** A mind commit (`memory_commits` table) — full DAG incl. merge parents */
export const hvMindCommitSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  merge_parent_id: z.string().nullable().optional(),
  branch: z.string().optional(),
  message: z.string().default(''),
  author_kind: z.string().optional(),
  author_key_id: z.string().optional(),
  author_key_prefix: z.string().optional(),
  created_at: z.string().optional(),
});
export type HvMindCommit = z.infer<typeof hvMindCommitSchema>;

/** A memory revision (`memory_revisions` table) — one snapshot per change */
export const hvRevisionSchema = z.object({
  id: z.string().min(1),
  commit_id: z.string().min(1),
  memory_id: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete']).default('update'),
  /** Full memory snapshot at this revision (title/content/tags/summary) */
  snapshot: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().optional(),
});
export type HvRevision = z.infer<typeof hvRevisionSchema>;

// ---------------------------------------------------------------------------
// Export wire format (GET /api/export — streamed NDJSON)
// ---------------------------------------------------------------------------

export const HV_EXPORT_TABLES = [
  'memories',
  'memory_branches',
  'memory_commits',
  'memory_revisions',
  'memory_heads',
  'memory_links',
  'memory_link_changes',
  'memory_artifact_links',
  'artifacts',
  'connections',
  'conversations',
  'messages',
] as const;
export type HvExportTable = (typeof HV_EXPORT_TABLES)[number];

/** One NDJSON line of the export stream: `{"table": "...", "row": {...}}` */
export const hvExportRecordSchema = z.object({
  table: z.enum(HV_EXPORT_TABLES),
  row: z.record(z.string(), z.unknown()),
});
export type HvExportRecord = z.infer<typeof hvExportRecordSchema>;

/** Final NDJSON line of the export stream: the manifest */
export const hvExportManifestSchema = z.object({
  manifest: z.literal(true),
  schema_version: z.number().int().default(1),
  exported_at: z.string().optional(),
  cursor: z.string().optional(),
  row_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  table_hashes: z.record(z.string(), z.string()).default({}),
  branch_heads: z.record(z.string(), z.string()).optional(),
});
export type HvExportManifest = z.infer<typeof hvExportManifestSchema>;

/** Highest export schema major version this client understands (risk #3) */
export const HV_SUPPORTED_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Local state file (.agentvault/hypervault.json) — never contains the key
// ---------------------------------------------------------------------------

export const hypervaultStateSchema = z.object({
  apiUrl: z.string().min(1),
  /** Vault reference, e.g. "vault:hashicorp/<agentId>/hypervault_api_key" */
  keyRef: z.string().optional(),
  branch: z.string().default('main'),
  userIdHint: z.string().optional(),
  lastSync: z.string().optional(),
  lastExportCursor: z.string().optional(),
  lastMindCommitSynced: z.string().optional(),
  canisterId: z.string().optional(),
  lastArweaveTx: z.string().optional(),
});
export type HypervaultState = z.infer<typeof hypervaultStateSchema>;

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export interface HvRecallResult {
  memory: HvMemory;
  /** Fused relevance score (higher is better) */
  score: number;
  /** Which retrieval paths matched */
  matchedBy: Array<'lexical' | 'semantic'>;
}
