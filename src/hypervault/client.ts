/**
 * HyperVault typed REST client
 *
 * Thin, typed wrapper over the hypervault.store HTTP API (the same surface
 * the upstream Python MCP server proxies). Authenticates with the
 * `X-HyperVault-Key` header, retries transient failures with exponential
 * backoff, and honours hypervault's 60 req/min per-key rate limit by
 * backing off on 429 responses.
 */

import { request } from 'undici';
import {
  hvExportManifestSchema,
  hvExportRecordSchema,
  HV_SUPPORTED_SCHEMA_VERSION,
  type HvArtifact,
  type HvExportManifest,
  type HvExportRecord,
  type HvMemory,
  type HvMindBranch,
  type HvMindCommit,
} from './types.js';

export const DEFAULT_HYPERVAULT_API_URL = 'https://hypervault.store';

/** Retry policy for transient failures */
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

export interface HyperVaultClientOptions {
  apiKey: string;
  apiUrl?: string;
  /** Override for tests: milliseconds to wait between retries multiplier */
  backoffMs?: number;
}

export interface ExportOptions {
  include?: string[];
  since?: string;
  branch?: string;
}

export interface ExportResult {
  records: HvExportRecord[];
  manifest: HvExportManifest;
}

export interface MemorizeInput {
  title?: string;
  content: string;
  tags?: string[];
  summary?: string;
}

export interface RecallOptions {
  limit?: number;
  tags?: string[];
}

export class HyperVaultError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'HyperVaultError';
  }
}

export class HyperVaultClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly backoffMs: number;

  constructor(options: HyperVaultClientOptions) {
    if (!options.apiKey) {
      throw new HyperVaultError('HyperVault API key is required');
    }
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl ?? process.env.HYPERVAULT_API_URL ?? DEFAULT_HYPERVAULT_API_URL).replace(/\/+$/, '');
    this.backoffMs = options.backoffMs ?? BASE_BACKOFF_MS;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  // -------------------------------------------------------------------------
  // Low-level request with retry/backoff
  // -------------------------------------------------------------------------

  private async requestRaw(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<{ statusCode: number; body: NodeJS.ReadableStream & { text(): Promise<string> } }> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }
      try {
        const res = await request(url, {
          method,
          headers: {
            'X-HyperVault-Key': this.apiKey,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        // Retry on rate limit and server errors; return everything else.
        if (res.statusCode === 429 || res.statusCode >= 500) {
          lastError = new HyperVaultError(
            `HyperVault responded ${res.statusCode} for ${method} ${path}`,
            res.statusCode,
          );
          await res.body.text().catch(() => undefined); // drain
          continue;
        }
        return { statusCode: res.statusCode, body: res.body };
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new HyperVaultError(`HyperVault request failed after ${MAX_RETRIES + 1} attempts: ${message}`);
  }

  private async requestJSON<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const res = await this.requestRaw(method, path, body, query);
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new HyperVaultError('HyperVault API key was rejected (check `agentvault hypervault connect`)', res.statusCode);
    }
    if (res.statusCode >= 400) {
      throw new HyperVaultError(`HyperVault ${method} ${path} failed (${res.statusCode}): ${truncate(text)}`, res.statusCode);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HyperVaultError(`HyperVault ${method} ${path} returned invalid JSON: ${truncate(text)}`, res.statusCode);
    }
  }

  // -------------------------------------------------------------------------
  // Key / identity
  // -------------------------------------------------------------------------

  /** Validate the API key. Returns a user hint when the API provides one. */
  async validateKey(): Promise<{ valid: boolean; userIdHint?: string }> {
    try {
      const data = await this.requestJSON<{ user_id?: string; key_prefix?: string }>('GET', '/api/keys');
      return { valid: true, userIdHint: data?.user_id ?? data?.key_prefix };
    } catch (error) {
      if (error instanceof HyperVaultError && (error.statusCode === 401 || error.statusCode === 403)) {
        return { valid: false };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Memories
  // -------------------------------------------------------------------------

  async memorize(input: MemorizeInput): Promise<HvMemory> {
    return this.requestJSON<HvMemory>('POST', '/api/memories', input);
  }

  async listMemories(options: { limit?: number; tags?: string[] } = {}): Promise<HvMemory[]> {
    const data = await this.requestJSON<HvMemory[] | { memories: HvMemory[] }>('GET', '/api/memories', undefined, {
      limit: options.limit?.toString(),
      tags: options.tags?.join(','),
    });
    return Array.isArray(data) ? data : (data?.memories ?? []);
  }

  async getMemory(id: string): Promise<HvMemory | null> {
    try {
      return await this.requestJSON<HvMemory>('GET', `/api/memories/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof HyperVaultError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async recall(query: string, options: RecallOptions = {}): Promise<HvMemory[]> {
    const data = await this.requestJSON<HvMemory[] | { memories: HvMemory[] }>('GET', '/api/recall', undefined, {
      q: query,
      limit: options.limit?.toString(),
      tags: options.tags?.join(','),
    });
    return Array.isArray(data) ? data : (data?.memories ?? []);
  }

  async editMemory(id: string, patch: Partial<MemorizeInput>): Promise<HvMemory> {
    return this.requestJSON<HvMemory>('PATCH', `/api/memories/${encodeURIComponent(id)}`, patch);
  }

  async forgetMemory(id: string): Promise<boolean> {
    try {
      await this.requestJSON('DELETE', `/api/memories/${encodeURIComponent(id)}`);
      return true;
    } catch (error) {
      if (error instanceof HyperVaultError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async memoryHistory(id: string): Promise<Array<Record<string, unknown>>> {
    return this.requestJSON('GET', `/api/memories/${encodeURIComponent(id)}/history`);
  }

  // -------------------------------------------------------------------------
  // Mind DAG
  // -------------------------------------------------------------------------

  async mindLog(options: { branch?: string; since?: string; limit?: number } = {}): Promise<HvMindCommit[]> {
    const data = await this.requestJSON<HvMindCommit[] | { commits: HvMindCommit[] }>('GET', '/api/mind/log', undefined, {
      branch: options.branch,
      since: options.since,
      limit: options.limit?.toString(),
    });
    return Array.isArray(data) ? data : (data?.commits ?? []);
  }

  async mindBranches(): Promise<HvMindBranch[]> {
    const data = await this.requestJSON<HvMindBranch[] | { branches: HvMindBranch[] }>('GET', '/api/mind/branches');
    return Array.isArray(data) ? data : (data?.branches ?? []);
  }

  async mindBranch(name: string): Promise<HvMindBranch> {
    return this.requestJSON<HvMindBranch>('POST', '/api/mind/branches', { name });
  }

  async mindDiff(from: string, to: string): Promise<Record<string, unknown>> {
    return this.requestJSON('GET', '/api/mind/diff', undefined, { from, to });
  }

  async mindMerge(fromBranch: string, toBranch: string): Promise<Record<string, unknown>> {
    return this.requestJSON('POST', '/api/mind/merge', { from: fromBranch, to: toBranch });
  }

  async mindRevert(commitId: string): Promise<Record<string, unknown>> {
    return this.requestJSON('POST', '/api/mind/revert', { commit_id: commitId });
  }

  async mindState(branch?: string): Promise<Record<string, unknown>> {
    return this.requestJSON('GET', '/api/mind/state', undefined, { branch });
  }

  // -------------------------------------------------------------------------
  // Artifacts & connections
  // -------------------------------------------------------------------------

  async saveArtifact(artifact: Partial<HvArtifact> & { content: string }): Promise<HvArtifact> {
    return this.requestJSON<HvArtifact>('POST', '/api/artifacts', artifact);
  }

  async listArtifacts(): Promise<HvArtifact[]> {
    const data = await this.requestJSON<HvArtifact[] | { artifacts: HvArtifact[] }>('GET', '/api/artifacts');
    return Array.isArray(data) ? data : (data?.artifacts ?? []);
  }

  async deleteArtifact(slug: string): Promise<boolean> {
    try {
      await this.requestJSON('DELETE', `/api/artifacts/${encodeURIComponent(slug)}`);
      return true;
    } catch (error) {
      if (error instanceof HyperVaultError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async connect(fromId: string, toId: string, kind = 'link'): Promise<Record<string, unknown>> {
    return this.requestJSON('POST', '/api/connections', { from_id: fromId, to_id: toId, kind });
  }

  // -------------------------------------------------------------------------
  // Bulk export / import (companion hypervault PRs §4.1 / §4.3)
  // -------------------------------------------------------------------------

  /**
   * Stream the full-account NDJSON export.
   *
   * Yields one validated record per row; the final manifest line is returned
   * via the `onManifest` callback (and validated against the supported
   * schema version).
   */
  async *exportVaultStream(
    options: ExportOptions = {},
    onManifest?: (manifest: HvExportManifest) => void,
  ): AsyncGenerator<HvExportRecord> {
    const res = await this.requestRaw('GET', '/api/export', undefined, {
      include: options.include?.join(','),
      since: options.since,
      branch: options.branch,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new HyperVaultError(`HyperVault export failed (${res.statusCode}): ${truncate(text)}`, res.statusCode);
    }

    let buffer = '';
    for await (const chunk of res.body) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const record = parseExportLine(line, onManifest);
        if (record) yield record;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const record = parseExportLine(tail, onManifest);
      if (record) yield record;
    }
  }

  /** Collect a full export into memory (fine for typical accounts). */
  async exportVault(options: ExportOptions = {}): Promise<ExportResult> {
    let manifest: HvExportManifest | undefined;
    const records: HvExportRecord[] = [];
    for await (const record of this.exportVaultStream(options, (m) => (manifest = m))) {
      records.push(record);
    }
    if (!manifest) {
      // Tolerate servers that omit the manifest line by synthesizing one.
      manifest = hvExportManifestSchema.parse({ manifest: true, row_counts: countRows(records) });
    }
    return { records, manifest };
  }

  /** Restore a full account from export records (POST /api/import/vault). */
  async importVault(records: HvExportRecord[], manifest?: HvExportManifest): Promise<{ imported: number }> {
    const ndjson =
      records.map((r) => JSON.stringify(r)).join('\n') + (manifest ? '\n' + JSON.stringify(manifest) : '') + '\n';
    const url = new URL(this.apiUrl + '/api/import/vault');
    const res = await request(url, {
      method: 'POST',
      headers: {
        'X-HyperVault-Key': this.apiKey,
        'content-type': 'application/x-ndjson',
      },
      body: ndjson,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new HyperVaultError(`HyperVault import failed (${res.statusCode}): ${truncate(text)}`, res.statusCode);
    }
    try {
      const data = JSON.parse(text) as { imported?: number };
      return { imported: data.imported ?? records.length };
    } catch {
      return { imported: records.length };
    }
  }

  /** Post an archive receipt so the hypervault dashboard can show it (§4.4). */
  async postArchiveReceipt(receipt: {
    kind: 'arweave' | 'icp';
    ref: string;
    manifest_hash: string;
  }): Promise<void> {
    try {
      await this.requestJSON('POST', '/api/archive-receipts', receipt);
    } catch (error) {
      // Receipts are best-effort: older hypervault deployments don't have
      // the endpoint yet, and archive success must not depend on it.
      if (error instanceof HyperVaultError && (error.statusCode === 404 || error.statusCode === 405)) return;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseExportLine(
  line: string,
  onManifest?: (manifest: HvExportManifest) => void,
): HvExportRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new HyperVaultError(`Export stream contained an invalid NDJSON line: ${truncate(line)}`);
  }
  if (parsed && typeof parsed === 'object' && 'manifest' in (parsed as Record<string, unknown>)) {
    const manifest = hvExportManifestSchema.parse(parsed);
    if (Math.floor(manifest.schema_version) > HV_SUPPORTED_SCHEMA_VERSION) {
      throw new HyperVaultError(
        `Export schema version ${manifest.schema_version} is newer than supported (${HV_SUPPORTED_SCHEMA_VERSION}); upgrade agentvault`,
      );
    }
    onManifest?.(manifest);
    return null;
  }
  const result = hvExportRecordSchema.safeParse(parsed);
  if (!result.success) {
    // Skip unknown tables rather than failing the whole export (schema drift).
    return null;
  }
  return result.data;
}

export function countRows(records: HvExportRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.table] = (counts[record.table] ?? 0) + 1;
  }
  return counts;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
