/**
 * The state of a memory_repo branch as AgentVault's HTTP API serves it
 * (GET /api/memory-repo/branches/:branch), for clients such as Polytician's
 * vault_memory_pull.
 *
 * The canister stores commits, not a key/value state. The commits route
 * stores each commit's entries as a JSON array in its diff, and the tombstone
 * route stores { deleted: key }. A branch's state is every entry committed on
 * it, a later commit replacing an earlier entry with the same key and a
 * tombstone removing it. Polytician pushes one commit per concept, so the
 * newest commit alone holds only the last concept pushed.
 */

import type { Commit } from './memory-repo-actor.js';

export interface MemoryEntry {
  key: string;
  contentType: string;
  data: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface MemoryBranchState {
  branch: string;
  headSha: string | null;
  entries: MemoryEntry[];
}

type DiffChange = { entries: MemoryEntry[] } | { deleted: string } | null;

/** What one commit's diff does: add entries, delete a key, or nothing AgentVault's routes wrote (e.g. a Soul.md). */
function parseDiff(diff: string): DiffChange {
  let parsed: unknown;
  try {
    parsed = JSON.parse(diff);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const entries: MemoryEntry[] = [];
    for (const item of parsed as unknown[]) {
      if (item && typeof item === 'object') {
        const raw = item as Record<string, unknown>;
        entries.push({
          key: typeof raw.key === 'string' ? raw.key : '',
          contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/json',
          data: typeof raw.data === 'string' ? raw.data : '',
          tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
            ? raw.metadata as Record<string, unknown>
            : {},
        });
      }
    }
    return { entries };
  }

  if (parsed && typeof parsed === 'object' && typeof (parsed as { deleted?: unknown }).deleted === 'string') {
    return { deleted: (parsed as { deleted: string }).deleted };
  }
  return null;
}

/**
 * Build a branch's state from the canister's log for it (newest commit
 * first, as `log` returns it): replay the commits oldest to newest.
 */
export function branchStateFromLog(branch: string, log: readonly Commit[]): MemoryBranchState {
  const entries = new Map<string, MemoryEntry>();

  for (const commit of [...log].reverse()) {
    const change = parseDiff(commit.diff);
    if (change === null) {
      continue;
    }
    if ('deleted' in change) {
      entries.delete(change.deleted);
    } else {
      for (const entry of change.entries) {
        entries.set(entry.key, entry);
      }
    }
  }

  return {
    branch,
    headSha: log[0]?.id ?? null,
    entries: [...entries.values()],
  };
}
