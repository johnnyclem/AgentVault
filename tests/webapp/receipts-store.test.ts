/**
 * The webapp's store for signed memory_repo write receipts
 * (webapp/src/lib/server/memory-write-receipts.ts): append-only JSONL, one
 * receipt per line, one file per UTC day, read back newest first in pages.
 *
 * Several requests, and several server processes, append at once. Each line
 * must reach the file in one write() on an O_APPEND descriptor, or lines
 * interleave: fs.appendFile splits anything over 512 KiB and tore nearly
 * every large line when processes raced. The concurrency tests below append
 * lines of over 1 MB from several independent copies of the module at once,
 * which issue concurrent writes to the same file as separate processes would.
 *
 * Loaded by path with its one `@/` import mapped, so the root typecheck does
 * not compile the webapp.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IcpWriteReceipt } from '../../src/canister/memory-repo-receipts-types.js';

vi.mock('@/canister/memory-repo-receipts', async () => await import('../../src/canister/memory-repo-receipts.js'));

interface ReceiptPage {
  receipts: IcpWriteReceipt[];
  nextCursor: string | null;
  skippedLines: number;
  oldestKept: string | null;
}

interface Store {
  receiptsDir(): string;
  appendIcpWriteReceipt(receipt: IcpWriteReceipt, options?: { dir?: string; partMaxBytes?: number }): Promise<void>;
  readIcpWriteReceiptPage(options: { cursor?: string | null; limit: number; maxBytes?: number; dir?: string }): Promise<ReceiptPage>;
  InvalidCursorError: new () => Error;
  MAX_LINE_BYTES: number;
  APPEND_STALLED_MS: number;
}

const STORE = path.join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'server', 'memory-write-receipts.ts');
let store: Store;

beforeAll(async () => {
  store = (await import(STORE)) as Store;
});

let dir: string;

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'av-receipts-')), 'receipts');
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function receipt(n: number, overrides: Partial<IcpWriteReceipt> = {}): IcpWriteReceipt {
  return {
    version: 1,
    id: createHash('sha256').update(String(n)).digest('hex'),
    recordedAt: '2026-10-24T12:00:00.000Z',
    network: 'local',
    request: {
      canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
      methodName: 'commitToBranch',
      arg: '4449444c',
      sender: '2vxsx-fae',
      ingressExpiry: '1800000000000000000',
      nonce: 'ab',
    },
    senderPubkey: 'aa',
    senderSig: 'bb',
    certificate: 'cc',
    result: { ok: `commit-${n}` },
    summary: { kind: 'commit', branch: 'polytician-main', message: `message ${n}` },
    ...overrides,
  };
}

/** A receipt whose stored line is about `bytes` long. */
function largeReceipt(n: number, bytes: number): IcpWriteReceipt {
  const base = receipt(n);
  return { ...base, summary: { ...base.summary, message: String(n % 10).repeat(bytes) } };
}

function files(): string[] {
  return fs.readdirSync(dir).sort();
}

function linesOf(name: string): string[] {
  return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.length > 0);
}

async function readAll(limit = 50): Promise<IcpWriteReceipt[]> {
  const all: IcpWriteReceipt[] = [];
  let cursor: string | null = null;
  do {
    const page: ReceiptPage = await store.readIcpWriteReceiptPage({ dir, limit, cursor });
    all.push(...page.receipts);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

describe('appendIcpWriteReceipt', () => {
  it.skipIf(process.platform === 'win32')('creates the directory 0700 and a file per UTC day 0600, one JSON line per receipt', async () => {
    await store.appendIcpWriteReceipt(receipt(1, { recordedAt: '2026-10-24T23:59:59.000+00:00' }), { dir });
    // 01:30 at UTC+3 is still the 23rd in UTC
    await store.appendIcpWriteReceipt(receipt(2, { recordedAt: '2026-10-24T01:30:00.000+03:00' }), { dir });
    await store.appendIcpWriteReceipt(receipt(3), { dir });

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(files()).toEqual(['memory-repo-writes-2026-10-23.jsonl', 'memory-repo-writes-2026-10-24.jsonl']);
    for (const name of files()) {
      expect(fs.statSync(path.join(dir, name)).mode & 0o777, name).toBe(0o600);
    }
    expect(linesOf('memory-repo-writes-2026-10-24.jsonl').map((line) => JSON.parse(line))).toEqual([
      receipt(1, { recordedAt: '2026-10-24T23:59:59.000+00:00' }),
      receipt(3),
    ]);
    expect(fs.readFileSync(path.join(dir, 'memory-repo-writes-2026-10-23.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(receipt(2, { recordedAt: '2026-10-24T01:30:00.000+03:00' }))}\n`,
    );
  });

  it('starts a new part of the day once a part is full, and reads parts newest first', async () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(receipt(1))}\n`);
    for (const n of [1, 2, 3, 4, 5]) {
      await store.appendIcpWriteReceipt(receipt(n), { dir, partMaxBytes: lineBytes * 2 });
    }

    expect(files()).toEqual([
      'memory-repo-writes-2026-10-24.1.jsonl',
      'memory-repo-writes-2026-10-24.2.jsonl',
      'memory-repo-writes-2026-10-24.jsonl',
    ]);
    expect(linesOf('memory-repo-writes-2026-10-24.2.jsonl')).toHaveLength(1);
    expect((await readAll(2)).map((r) => r.result.ok)).toEqual(['commit-5', 'commit-4', 'commit-3', 'commit-2', 'commit-1']);
  });

  it('never goes back to an older part with room once a newer part exists', async () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(receipt(1))}\n`);
    const partMaxBytes = lineBytes * 3;
    for (const n of [1, 2]) await store.appendIcpWriteReceipt(receipt(n), { dir, partMaxBytes });
    // About two lines' worth: too large for what is left of part 0
    await store.appendIcpWriteReceipt(largeReceipt(3, lineBytes), { dir, partMaxBytes });
    expect(files()).toEqual(['memory-repo-writes-2026-10-24.1.jsonl', 'memory-repo-writes-2026-10-24.jsonl']);
    const first = await store.readIcpWriteReceiptPage({ dir, limit: 1 });
    expect(first.receipts.map((r) => r.result.ok)).toEqual(['commit-3']);

    // Part 0 still has room for a small line, but it goes after the large one
    await store.appendIcpWriteReceipt(receipt(4), { dir, partMaxBytes });

    expect(linesOf('memory-repo-writes-2026-10-24.jsonl')).toHaveLength(2);
    expect((await readAll()).map((r) => r.result.ok)).toEqual(['commit-4', 'commit-3', 'commit-2', 'commit-1']);
    // The cursor the first page gave, for the whole of part 0, still yields exactly the older receipts
    const older = await store.readIcpWriteReceiptPage({ dir, limit: 10, cursor: first.nextCursor });
    expect(older.receipts.map((r) => r.result.ok)).toEqual(['commit-2', 'commit-1']);
  });

  it('refuses a line over the 5 MiB cap and writes nothing', async () => {
    await expect(store.appendIcpWriteReceipt(largeReceipt(1, store.MAX_LINE_BYTES), { dir })).rejects.toThrow(/line limit/);
    expect(fs.existsSync(dir) ? files() : []).toEqual([]);

    // The failed append does not stop the next one
    await store.appendIcpWriteReceipt(receipt(2), { dir });
    expect((await readAll()).map((r) => r.result.ok)).toEqual(['commit-2']);
  });

  it('fails when the receipt directory cannot be created, without leaving anything behind', async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory');

    await expect(store.appendIcpWriteReceipt(receipt(1), { dir })).rejects.toThrow();
    expect(fs.readFileSync(dir, 'utf8')).toBe('not a directory');
  });

  it('keeps every large line whole when independent writers append at once', async () => {
    // Separate copies of the module have separate in-process queues, so
    // their writes reach the file concurrently, as separate processes' do
    const writers: Store[] = [store];
    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      writers.push((await import(STORE)) as Store);
    }
    const appends = writers.flatMap((writer, w) =>
      Array.from({ length: 6 }, (_, i) => writer.appendIcpWriteReceipt(largeReceipt(w * 100 + i, 1_200_000), { dir })),
    );
    await Promise.all(appends);

    const lines = files().flatMap(linesOf);
    expect(lines).toHaveLength(24);
    const ids = lines.map((line) => (JSON.parse(line) as IcpWriteReceipt).result.ok);
    expect(new Set(ids).size).toBe(24);
    const page = await store.readIcpWriteReceiptPage({ dir, limit: 50, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(page.receipts).toHaveLength(24);
    expect(page.skippedLines).toBe(0);
  });

  it('fails an append at once while an earlier one has been stuck for APPEND_STALLED_MS, rather than queue it', async () => {
    let opened!: () => void;
    const reachedOpen = new Promise<void>((resolve) => (opened = resolve));
    let release!: (error: Error) => void;
    const stuck = new Promise<never>((_, reject) => (release = reject));
    const open = vi.spyOn(fs.promises, 'open').mockImplementationOnce(() => {
      opened();
      return stuck;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = store.appendIcpWriteReceipt(receipt(1), { dir });
      await reachedOpen;
      // Stuck, but not for long yet: this one queues behind it
      const second = store.appendIcpWriteReceipt(receipt(2), { dir });

      vi.setSystemTime(Date.now() + store.APPEND_STALLED_MS);
      const third = await Promise.race([
        store.appendIcpWriteReceipt(receipt(3), { dir }).then(() => 'stored', (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still queued'), 200)),
      ]);
      expect(third).toBeInstanceOf(Error);
      expect((third as Error).message).toBe('an earlier receipt append has not finished after 10 s, so this one was not queued behind it');

      release(new Error('the disk came back with an error'));
      await expect(first).rejects.toThrow('the disk came back with an error');
      await second;
      // Appends queue again once the stuck one has finished
      await store.appendIcpWriteReceipt(receipt(4), { dir });
      expect(open).toHaveBeenCalledTimes(3);
      expect((await readAll()).map((r) => r.result.ok)).toEqual(['commit-4', 'commit-2']);
    } finally {
      release(new Error('released'));
      vi.useRealTimers();
      open.mockRestore();
    }
  });

  it('starts on a fresh line after a write that came up short, so the fragment cannot swallow the next receipt', async () => {
    await store.appendIcpWriteReceipt(receipt(1), { dir });
    const [name] = files();
    fs.appendFileSync(path.join(dir, name!), JSON.stringify(receipt(2)).slice(0, 40));

    // A fragment with no newline yet may be a line still being written: not read, not counted
    const before = await store.readIcpWriteReceiptPage({ dir, limit: 10 });
    expect(before.receipts.map((r) => r.result.ok)).toEqual(['commit-1']);
    expect(before.skippedLines).toBe(0);

    await store.appendIcpWriteReceipt(receipt(3), { dir });

    const after = await store.readIcpWriteReceiptPage({ dir, limit: 10 });
    expect(after.receipts.map((r) => r.result.ok)).toEqual(['commit-3', 'commit-1']);
    expect(after.skippedLines).toBe(1);
  });
});

describe('readIcpWriteReceiptPage', () => {
  it('gives an empty page for a directory that does not exist', async () => {
    expect(await store.readIcpWriteReceiptPage({ dir, limit: 10 })).toEqual({
      receipts: [],
      nextCursor: null,
      skippedLines: 0,
      oldestKept: null,
    });
  });

  it('pages newest first across days, and names the oldest day kept', async () => {
    const days = ['2026-10-20', '2026-10-22', '2026-10-24'];
    let n = 0;
    for (const day of days) {
      for (let i = 0; i < 4; i++) {
        n++;
        await store.appendIcpWriteReceipt(receipt(n, { recordedAt: `${day}T0${i}:00:00.000Z` }), { dir });
      }
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a receipt file');

    const first = await store.readIcpWriteReceiptPage({ dir, limit: 5 });
    expect(first.receipts.map((r) => r.result.ok)).toEqual(['commit-12', 'commit-11', 'commit-10', 'commit-9', 'commit-8']);
    expect(first.oldestKept).toBe('2026-10-20');
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await store.readIcpWriteReceiptPage({ dir, limit: 5, cursor: first.nextCursor });
    expect(second.receipts.map((r) => r.result.ok)).toEqual(['commit-7', 'commit-6', 'commit-5', 'commit-4', 'commit-3']);
    const third = await store.readIcpWriteReceiptPage({ dir, limit: 5, cursor: second.nextCursor });
    expect(third.receipts.map((r) => r.result.ok)).toEqual(['commit-2', 'commit-1']);
    expect(third.nextCursor).toBeNull();
  });

  it('returns the stored receipts as they were appended', async () => {
    const stored = receipt(1, { summary: { kind: 'commit', branch: 'b', tags: ['t'], entryKeys: ['k'], entryCount: 1, diffBytes: 9 } });
    await store.appendIcpWriteReceipt(stored, { dir });

    expect((await store.readIcpWriteReceiptPage({ dir, limit: 1 })).receipts).toEqual([stored]);
  });

  it('a cursor still yields exactly the next older receipts after newer ones are appended', async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await store.appendIcpWriteReceipt(receipt(n), { dir });
    const first = await store.readIcpWriteReceiptPage({ dir, limit: 3 });

    for (const n of [7, 8]) await store.appendIcpWriteReceipt(receipt(n), { dir });
    const second = await store.readIcpWriteReceiptPage({ dir, limit: 3, cursor: first.nextCursor });

    expect(first.receipts.map((r) => r.result.ok)).toEqual(['commit-6', 'commit-5', 'commit-4']);
    expect(second.receipts.map((r) => r.result.ok)).toEqual(['commit-3', 'commit-2', 'commit-1']);
    expect(second.nextCursor).toBeNull();
  });

  it('skips and counts lines that are not receipts, and ignores blank ones', async () => {
    await store.appendIcpWriteReceipt(receipt(1), { dir });
    const [name] = files();
    const file = path.join(dir, name!);
    fs.appendFileSync(file, `{"version":1,"id":"torn\n\n${JSON.stringify({ ...receipt(2), version: 2 })}\n`);
    await store.appendIcpWriteReceipt(receipt(3), { dir });

    const page = await store.readIcpWriteReceiptPage({ dir, limit: 10 });
    expect(page.receipts.map((r) => r.result.ok)).toEqual(['commit-3', 'commit-1']);
    expect(page.skippedLines).toBe(2);
  });

  it('stops a page at the byte budget, but always returns at least one receipt', async () => {
    for (const n of [1, 2, 3]) await store.appendIcpWriteReceipt(largeReceipt(n, 3000), { dir });

    const page = await store.readIcpWriteReceiptPage({ dir, limit: 10, maxBytes: 5000 });
    expect(page.receipts.map((r) => r.result.ok)).toEqual(['commit-3', 'commit-2']);
    const tiny = await store.readIcpWriteReceiptPage({ dir, limit: 10, maxBytes: 1, cursor: page.nextCursor });
    expect(tiny.receipts.map((r) => r.result.ok)).toEqual(['commit-1']);
    expect(tiny.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not issue, or one naming a file it does not keep', async () => {
    await store.appendIcpWriteReceipt(receipt(1), { dir });
    fs.writeFileSync(path.join(path.dirname(dir), 'memory-repo-writes-2026-10-01.jsonl'), `${JSON.stringify(receipt(9))}\n`);
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const kept = 'memory-repo-writes-2026-10-24.jsonl';

    const invalid = [
      cursor({ s: '../memory-repo-writes-2026-10-01.jsonl', l: null }),
      cursor({ s: path.join(path.dirname(dir), 'memory-repo-writes-2026-10-01.jsonl'), l: null }),
      cursor({ s: 'index.yaml', l: null }),
      cursor({ s: 'memory-repo-writes-2026-10-23.jsonl', l: null }),
      cursor({ s: kept, l: -1 }),
      cursor({ s: kept, l: 1.5 }),
      cursor({ s: kept, l: '1' }),
      cursor({ s: kept }),
      cursor([kept, 0]),
      cursor('text'),
      'not base64 json!',
    ];
    for (const value of invalid) {
      await expect(store.readIcpWriteReceiptPage({ dir, limit: 10, cursor: value }), value).rejects.toBeInstanceOf(store.InvalidCursorError);
    }
    expect((await store.readIcpWriteReceiptPage({ dir, limit: 10, cursor: cursor({ s: kept, l: 1 }) })).receipts).toHaveLength(1);
  });
});

describe('receiptsDir', () => {
  it('is AGENTVAULT_RECEIPTS_DIR when set, read on every call, else beside the archive index in ~/.agentvault', () => {
    vi.stubEnv('AGENTVAULT_RECEIPTS_DIR', '');
    expect(store.receiptsDir()).toBe(path.join(os.homedir(), '.agentvault', 'receipts'));
    vi.stubEnv('AGENTVAULT_RECEIPTS_DIR', 'relative/receipts');
    expect(store.receiptsDir()).toBe(path.resolve('relative/receipts'));
  });
});
