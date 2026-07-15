/**
 * HyperVaultMemoryStore — backbone MemoryStore backed by the cloud mind
 *
 * Maps `AgentMemoryEntry.{key,value,metadata}` ⇄ `HvMemory.{title,content,
 * tags}`. Scoping (`companyId`/`agentId`), the memory key, scalar metadata
 * and TTL expiry all travel as namespaced tags so they round-trip through
 * hypervault. Every write goes through `memorize`/`editMemory`, so it lands
 * as a provenance-stamped mind commit upstream. `vaultRef` records the
 * cloud identity as `hypervault:<memory_id>`.
 */

import type { AgentMemoryEntry } from '../backbone/types.js';
import type { MemoryStore } from '../backbone/services/memory.js';
import type { HyperVaultClient } from './client.js';
import type { HvMemory } from './types.js';

const TAG_PREFIX = 'av';

function companyTag(companyId: string): string {
  return `${TAG_PREFIX}:company:${companyId}`;
}
function agentTag(agentId: string): string {
  return `${TAG_PREFIX}:agent:${agentId}`;
}
function keyTag(key: string): string {
  return `${TAG_PREFIX}:key:${key}`;
}
function expiresTag(expiresAt: string): string {
  return `${TAG_PREFIX}:expires:${expiresAt}`;
}
function metaTag(k: string, v: unknown): string {
  return `${TAG_PREFIX}:meta:${k}=${JSON.stringify(v)}`;
}

export class HyperVaultMemoryStore implements MemoryStore {
  constructor(private readonly client: HyperVaultClient) {}

  async list(companyId: string, agentId: string): Promise<AgentMemoryEntry[]> {
    const memories = await this.client.listMemories({
      tags: [companyTag(companyId), agentTag(agentId)],
    });
    const now = Date.now();
    return memories
      .map((m) => toEntry(m, companyId, agentId))
      .filter((entry): entry is AgentMemoryEntry => entry !== null)
      .filter((entry) => !isExpired(entry, now));
  }

  async get(companyId: string, agentId: string, key: string): Promise<AgentMemoryEntry | null> {
    const memory = await this.findByKey(companyId, agentId, key);
    if (!memory) return null;
    const entry = toEntry(memory, companyId, agentId);
    if (!entry || isExpired(entry, Date.now())) return null;
    return entry;
  }

  async upsert(companyId: string, agentId: string, entry: AgentMemoryEntry): Promise<AgentMemoryEntry> {
    const tags = entryTags(companyId, agentId, entry);
    const existing = await this.findByKey(companyId, agentId, entry.key);
    const saved = existing
      ? await this.client.editMemory(existing.id, { title: entry.key, content: entry.value, tags })
      : await this.client.memorize({ title: entry.key, content: entry.value, tags });
    const id = saved?.id ?? existing?.id ?? entry.id;
    return {
      ...entry,
      vaultRef: `hypervault:${id}`,
      updatedAt: new Date().toISOString(),
    };
  }

  async delete(companyId: string, agentId: string, key: string): Promise<boolean> {
    const memory = await this.findByKey(companyId, agentId, key);
    if (!memory) return false;
    return this.client.forgetMemory(memory.id);
  }

  async purgeExpired(): Promise<number> {
    // Only entries written by this adapter carry expiry tags.
    const memories = await this.client.listMemories({ tags: [] });
    const now = Date.now();
    let purged = 0;
    for (const memory of memories) {
      const expiresAt = readTag(memory.tags, `${TAG_PREFIX}:expires:`);
      if (expiresAt && new Date(expiresAt).getTime() <= now) {
        if (await this.client.forgetMemory(memory.id)) purged += 1;
      }
    }
    return purged;
  }

  private async findByKey(companyId: string, agentId: string, key: string): Promise<HvMemory | null> {
    const memories = await this.client.listMemories({
      tags: [companyTag(companyId), agentTag(agentId), keyTag(key)],
    });
    return memories.find((m) => m.tags.includes(keyTag(key))) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function entryTags(companyId: string, agentId: string, entry: AgentMemoryEntry): string[] {
  const tags = [companyTag(companyId), agentTag(agentId), keyTag(entry.key)];
  if (entry.expiresAt) tags.push(expiresTag(entry.expiresAt));
  for (const [k, v] of Object.entries(entry.metadata ?? {})) {
    // Scalar metadata only — nested objects don't survive the tag encoding.
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      tags.push(metaTag(k, v));
    }
  }
  return tags;
}

function toEntry(memory: HvMemory, companyId: string, agentId: string): AgentMemoryEntry | null {
  const key = readTag(memory.tags, `${TAG_PREFIX}:key:`) ?? memory.title;
  if (!key) return null;
  if (!memory.tags.includes(companyTag(companyId)) || !memory.tags.includes(agentTag(agentId))) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  for (const tag of memory.tags) {
    const prefix = `${TAG_PREFIX}:meta:`;
    if (!tag.startsWith(prefix)) continue;
    const eq = tag.indexOf('=', prefix.length);
    if (eq < 0) continue;
    const k = tag.slice(prefix.length, eq);
    try {
      metadata[k] = JSON.parse(tag.slice(eq + 1));
    } catch {
      metadata[k] = tag.slice(eq + 1);
    }
  }

  const now = new Date().toISOString();
  return {
    id: memory.id,
    companyId,
    agentId,
    key,
    value: memory.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    vaultRef: `hypervault:${memory.id}`,
    expiresAt: readTag(memory.tags, `${TAG_PREFIX}:expires:`),
    createdAt: memory.created_at ?? now,
    updatedAt: memory.updated_at ?? now,
  };
}

function readTag(tags: string[], prefix: string): string | undefined {
  const tag = tags.find((t) => t.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : undefined;
}

function isExpired(entry: AgentMemoryEntry, nowMs: number): boolean {
  return Boolean(entry.expiresAt && new Date(entry.expiresAt).getTime() <= nowMs);
}
