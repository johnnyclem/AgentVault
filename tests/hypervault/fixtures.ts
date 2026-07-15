/**
 * Shared fixtures for the hypervault test suite.
 */

import type { HvExportManifest, HvExportRecord } from '../../src/hypervault/types.js';

export function sampleRecords(): HvExportRecord[] {
  return [
    {
      table: 'memories',
      row: {
        id: 'mem-1',
        title: 'First memory',
        content: 'The quick brown fox jumps over the lazy dog.',
        tags: ['soul', 'origin'],
        summary: 'A pangram',
        embedding: [0.1, 0.2, 0.3, 0.4],
        embedding_model: 'text-embedding-3-small',
        branch: 'main',
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      },
    },
    {
      table: 'memories',
      row: {
        id: 'mem-2',
        title: 'Second memory',
        content: 'Sphinx of black quartz, judge my vow.',
        tags: ['origin'],
        embedding: [0.4, 0.3, 0.2, 0.1],
        embedding_model: 'text-embedding-3-small',
        branch: 'main',
      },
    },
    {
      table: 'memory_branches',
      row: { name: 'main', head_commit_id: 'commit-2' },
    },
    {
      table: 'memory_commits',
      row: {
        id: 'commit-1',
        parent_id: null,
        message: 'genesis',
        branch: 'main',
        author_kind: 'agent',
        author_key_prefix: 'hv_abc',
        created_at: '2026-07-01T00:00:00.000Z',
      },
    },
    {
      table: 'memory_commits',
      row: {
        id: 'commit-2',
        parent_id: 'commit-1',
        message: 'add second memory',
        branch: 'main',
        author_kind: 'agent',
        author_key_prefix: 'hv_abc',
        created_at: '2026-07-02T00:00:00.000Z',
      },
    },
    {
      table: 'memory_revisions',
      row: { id: 'rev-1', commit_id: 'commit-1', memory_id: 'mem-1', operation: 'create' },
    },
    {
      table: 'artifacts',
      row: {
        id: 'art-1',
        slug: 'hello-world',
        title: 'Hello World',
        content: '<h1>Hello</h1>',
        content_hash: 'abc123',
        tags: ['demo'],
        visibility: 'public',
      },
    },
    {
      table: 'connections',
      row: { id: 'conn-1', from_id: 'art-1', to_id: 'mem-1', kind: 'derived-from' },
    },
  ];
}

export function sampleManifest(): HvExportManifest {
  return {
    manifest: true,
    schema_version: 1,
    exported_at: '2026-07-15T00:00:00.000Z',
    cursor: '2026-07-15T00:00:00.000Z',
    row_counts: {
      memories: 2,
      memory_branches: 1,
      memory_commits: 2,
      memory_revisions: 1,
      artifacts: 1,
      connections: 1,
    },
    table_hashes: {},
    branch_heads: { main: 'commit-2' },
  };
}

/** Serialize records + manifest as the NDJSON export wire format. */
export function toNdjson(records: HvExportRecord[], manifest: HvExportManifest): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n' + JSON.stringify(manifest) + '\n';
}
