/**
 * Agent Memory Service
 *
 * Per-agent key-value working memory with optional TTL expiration.
 * Default implementation uses an in-memory store; consumers can inject
 * a database-backed adapter by implementing MemoryStore.
 */

import { randomUUID } from 'node:crypto';
import type { AgentMemoryEntry, SetMemoryInput } from '../types.js';

/** Storage adapter interface for memory entries */
export interface MemoryStore {
  list(companyId: string, agentId: string): Promise<AgentMemoryEntry[]>;
  get(companyId: string, agentId: string, key: string): Promise<AgentMemoryEntry | null>;
  upsert(companyId: string, agentId: string, entry: AgentMemoryEntry): Promise<AgentMemoryEntry>;
  delete(companyId: string, agentId: string, key: string): Promise<boolean>;
  purgeExpired(): Promise<number>;
}

/** In-memory implementation of MemoryStore */
export class InMemoryMemoryStore implements MemoryStore {
  private entries = new Map<string, AgentMemoryEntry>();

  private makeKey(companyId: string, agentId: string, key: string): string {
    return `${companyId}:${agentId}:${key}`;
  }

  async list(companyId: string, agentId: string): Promise<AgentMemoryEntry[]> {
    const prefix = `${companyId}:${agentId}:`;
    const now = new Date().toISOString();
    const results: AgentMemoryEntry[] = [];
    for (const [k, v] of this.entries) {
      if (k.startsWith(prefix)) {
        if (!v.expiresAt || v.expiresAt > now) {
          results.push(v);
        }
      }
    }
    return results;
  }

  async get(companyId: string, agentId: string, key: string): Promise<AgentMemoryEntry | null> {
    const entry = this.entries.get(this.makeKey(companyId, agentId, key));
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= new Date().toISOString()) {
      this.entries.delete(this.makeKey(companyId, agentId, key));
      return null;
    }
    return entry;
  }

  async upsert(companyId: string, agentId: string, entry: AgentMemoryEntry): Promise<AgentMemoryEntry> {
    this.entries.set(this.makeKey(companyId, agentId, entry.key), entry);
    return entry;
  }

  async delete(companyId: string, agentId: string, key: string): Promise<boolean> {
    return this.entries.delete(this.makeKey(companyId, agentId, key));
  }

  async purgeExpired(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const [k, v] of this.entries) {
      if (v.expiresAt && v.expiresAt <= now) {
        this.entries.delete(k);
        count++;
      }
    }
    return count;
  }
}

export class MemoryService {
  constructor(private store: MemoryStore = new InMemoryMemoryStore()) {}

  async listMemory(companyId: string, agentId: string): Promise<AgentMemoryEntry[]> {
    return this.store.list(companyId, agentId);
  }

  async getMemory(companyId: string, agentId: string, key: string): Promise<AgentMemoryEntry | null> {
    return this.store.get(companyId, agentId, key);
  }

  async setMemory(
    companyId: string,
    agentId: string,
    input: SetMemoryInput,
  ): Promise<AgentMemoryEntry> {
    const now = new Date().toISOString();
    const existing = await this.store.get(companyId, agentId, input.key);

    const entry: AgentMemoryEntry = {
      id: existing?.id ?? randomUUID(),
      companyId,
      agentId,
      key: input.key,
      value: input.value,
      metadata: input.metadata,
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.ttlSeconds
        ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
        : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    return this.store.upsert(companyId, agentId, entry);
  }

  async deleteMemory(companyId: string, agentId: string, key: string): Promise<boolean> {
    return this.store.delete(companyId, agentId, key);
  }

  async purgeExpired(): Promise<number> {
    return this.store.purgeExpired();
  }
}
