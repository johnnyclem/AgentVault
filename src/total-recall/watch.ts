/**
 * Total Recall — watching a volume for new memory events
 *
 * `watchVolume` follows memories.jsonl and hands every event past a cursor
 * to a callback, so a process other than the writer (a Claude-side ingester,
 * `agentvault total-recall watch`) sees the same stream the writer's
 * webhooks do. The cursor is the last seq handled, kept in a small file
 * beside the archive (`watch.cursor.json`), so a restart resumes rather
 * than replaying. fs.watch wakes it early; a poll interval is the fallback,
 * because fs.watch is unreliable on some filesystems.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryEvent } from './format.js';
import type { TotalRecallVolume } from './volume.js';

export const WATCH_CURSOR_FILE = 'watch.cursor.json';

export interface WatchOptions {
  /** Start after this seq; default: the saved cursor, else 0 */
  sinceSeq?: number;
  /** Poll interval in ms (default 1000) */
  pollMs?: number;
  /** Persist the cursor after each batch (default true) */
  persistCursor?: boolean;
  /** Name of the cursor (several watchers can follow one volume); default "default" */
  cursorName?: string;
}

export interface VolumeWatcher {
  /** Stop watching; resolves once the current batch (if any) is handled. */
  close(): Promise<void>;
  /** Process anything new right now. */
  poke(): Promise<number>;
  readonly cursor: number;
}

function cursorPath(volume: TotalRecallVolume, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(volume.dir, safe === 'default' ? WATCH_CURSOR_FILE : `watch.${safe}.cursor.json`);
}

export function readWatchCursor(volume: TotalRecallVolume, name = 'default'): number {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(volume, name), 'utf8')) as { seq?: number };
    return typeof data.seq === 'number' && data.seq >= 0 ? data.seq : 0;
  } catch {
    return 0;
  }
}

export function writeWatchCursor(volume: TotalRecallVolume, seq: number, name = 'default'): void {
  fs.writeFileSync(cursorPath(volume, name), JSON.stringify({ seq, updatedAt: new Date().toISOString() }) + '\n', {
    mode: 0o600,
  });
}

export function watchVolume(
  volume: TotalRecallVolume,
  onEvent: (event: MemoryEvent) => void | Promise<void>,
  options: WatchOptions = {},
): VolumeWatcher {
  const cursorName = options.cursorName ?? 'default';
  let cursor = options.sinceSeq ?? readWatchCursor(volume, cursorName);
  let closed = false;
  let running: Promise<number> | null = null;

  const drain = async (): Promise<number> => {
    let handled = 0;
    for (;;) {
      if (closed) return handled;
      const batch = volume.readMemoryEvents({ sinceSeq: cursor, limit: 200 });
      if (batch.length === 0) return handled;
      for (const event of batch) {
        await onEvent(event);
        cursor = event.seq;
        handled += 1;
      }
      if (options.persistCursor !== false) writeWatchCursor(volume, cursor, cursorName);
    }
  };

  const poke = (): Promise<number> => {
    if (running) return running;
    running = drain().finally(() => {
      running = null;
    });
    return running;
  };

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    // Watch the directory: the file may not exist yet.
    fsWatcher = fs.watch(volume.dir, (_type, filename) => {
      if (!filename || filename.toString() === path.basename(volume.memoriesPath)) void poke();
    });
    fsWatcher.on('error', () => {
      /* fall back to polling */
    });
  } catch {
    fsWatcher = null;
  }
  const timer = setInterval(() => void poke(), options.pollMs ?? 1000);
  void poke();

  return {
    get cursor() {
      return cursor;
    },
    poke,
    async close() {
      closed = true;
      clearInterval(timer);
      fsWatcher?.close();
      if (running) await running.catch(() => undefined);
    },
  };
}
