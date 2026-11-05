/**
 * sweepStaleSnapshotData: what a process that was killed without cleaning up
 * (SIGKILL, OOM, power loss) leaves behind is removed by the next snapshot
 * command, and nothing else is. The second half matters more than the first:
 * the sweep runs in directories the user chose, next to concurrent snapshots, so
 * a wrong guess deletes someone's data or somebody else's work in progress.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepStaleSnapshotData } from '../../src/container/snapshot.js';

const CANARY = 'CANARY-PLAINTEXT-VOLUME-DATA-2f1e6a1d';

let work: string;
let counter = 0;
let deadPid: number;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-sweep-test-'));
  // A process that has certainly exited: its PID is the only thing we need from it.
  const child = spawnSync(process.execPath, ['-e', '0']);
  deadPid = child.pid;
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function fresh(label: string): string {
  counter += 1;
  const dir = path.join(work, `${counter}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function spool(parent: string, pid: number, suffix = 'AbC123'): string {
  const dir = path.join(parent, `avt-snapshot-${pid}-${suffix}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'data.tar'), CANARY);
  return dir;
}

/** A snapshot directory, optionally completed with a manifest. */
function snapshotDir(parent: string, name: string, options: { manifest?: boolean } = {}): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'data.tar.enc'), 'ciphertext');
  if (options.manifest === true) fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  return dir;
}

describe('sweepStaleSnapshotData: scratch directories (restore and verify spools)', () => {
  it('removes the spool of a dead process, contents included, and reports it', () => {
    const scratch = fresh('scratch');
    const stale = spool(scratch, deadPid);
    const result = sweepStaleSnapshotData({ scratchDirs: [scratch] });
    expect(fs.existsSync(stale)).toBe(false);
    expect(result.removed).toEqual([stale]);
  });

  it('never touches the spool of a live process: concurrent snapshots are legitimate', () => {
    const scratch = fresh('scratch');
    const live = spool(scratch, process.pid);
    expect(sweepStaleSnapshotData({ scratchDirs: [scratch] }).removed).toEqual([]);
    expect(fs.readFileSync(path.join(live, 'data.tar'), 'utf8')).toBe(CANARY);
  });

  it.skipIf(process.platform === 'win32')('treats a process that exists but belongs to someone else as alive (EPERM is not proof of death)', () => {
    const scratch = fresh('scratch');
    const init = spool(scratch, 1);
    expect(sweepStaleSnapshotData({ scratchDirs: [scratch] }).removed).toEqual([]);
    expect(fs.existsSync(init)).toBe(true);
  });

  it('removes only what is unmistakably a spool', () => {
    const scratch = fresh('scratch');
    const kept = [
      path.join(scratch, 'keep-me'),
      path.join(scratch, 'avt-snapshot-abcdef'), // an older build's name: no PID, owner unknown
      path.join(scratch, `avt-snapshot-${deadPid}-short`),
      path.join(scratch, `avt-snapshot-${deadPid}-AbC123-more`),
      path.join(scratch, `not-avt-snapshot-${deadPid}-AbC123`),
    ];
    for (const dir of kept) fs.mkdirSync(dir);
    const asFile = path.join(scratch, `avt-snapshot-${deadPid}-FiLe00`);
    fs.writeFileSync(asFile, 'a file, not a directory');

    expect(sweepStaleSnapshotData({ scratchDirs: [scratch] }).removed).toEqual([]);
    for (const dir of [...kept, asFile]) expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not follow a symlink that is named like a dead spool', () => {
    const scratch = fresh('scratch');
    const victim = fresh('victim');
    fs.writeFileSync(path.join(victim, 'precious'), 'do not delete');
    const link = path.join(scratch, `avt-snapshot-${deadPid}-LiNk00`);
    fs.symlinkSync(victim, link);
    expect(sweepStaleSnapshotData({ scratchDirs: [scratch] }).removed).toEqual([]);
    expect(fs.readFileSync(path.join(victim, 'precious'), 'utf8')).toBe('do not delete');
  });

  it('a missing directory is fine', () => {
    expect(sweepStaleSnapshotData({ scratchDirs: [path.join(work, 'no-such-dir')], snapshotDirs: [path.join(work, 'nor-this')] })).toEqual({ removed: [] });
  });

  it('with nothing to sweep it does nothing', () => {
    expect(sweepStaleSnapshotData({})).toEqual({ removed: [] });
  });
});

describe('sweepStaleSnapshotData: snapshot directories', () => {
  it('removes an interrupted create (no manifest, a dead owner) as a whole', () => {
    const parent = fresh('snapshots');
    const dir = snapshotDir(parent, 'alpha-20261105T051500Z');
    spool(dir, deadPid);
    const result = sweepStaleSnapshotData({ snapshotDirs: [parent] });
    expect(fs.existsSync(dir)).toBe(false);
    expect(result.removed).toEqual([dir]);
  });

  it('leaves a create that is still running alone, spool and half-written snapshot', () => {
    const parent = fresh('snapshots');
    const dir = snapshotDir(parent, 'alpha-20261105T051500Z');
    const live = spool(dir, process.pid);
    expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'data.tar.enc'))).toBe(true);
  });

  it('one live owner among dead ones is enough to leave everything alone', () => {
    const parent = fresh('snapshots');
    const dir = snapshotDir(parent, 'alpha-20261105T051500Z-2');
    const dead = spool(dir, deadPid, 'DeAd00');
    spool(dir, process.pid, 'LiVe00');
    expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('in a completed snapshot only a dead spool goes: the snapshot itself is kept', () => {
    const parent = fresh('snapshots');
    const dir = snapshotDir(parent, 'alpha-20261105T051500Z', { manifest: true });
    const stale = spool(dir, deadPid);
    const result = sweepStaleSnapshotData({ snapshotDirs: [parent] });
    expect(result.removed).toEqual([stale]);
    expect(fs.readdirSync(dir).sort()).toEqual(['data.tar.enc', 'manifest.json']);
  });

  it('in a completed snapshot a live spool stays too', () => {
    const parent = fresh('snapshots');
    const dir = snapshotDir(parent, 'alpha-20261105T051500Z', { manifest: true });
    const live = spool(dir, process.pid);
    expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('removes the .<key>.tar.plain an earlier build left behind: from a manifest-less directory the whole directory, from a completed one just the file', () => {
    const parent = fresh('snapshots');
    const interrupted = snapshotDir(parent, 'alpha-20261105T051500Z');
    fs.writeFileSync(path.join(interrupted, '.data.tar.plain'), CANARY);
    const completed = snapshotDir(parent, 'beta-20261105T051500Z', { manifest: true });
    fs.writeFileSync(path.join(completed, '.data.tar.plain'), CANARY);

    const result = sweepStaleSnapshotData({ snapshotDirs: [parent] });
    expect(result.removed.sort()).toEqual([interrupted, path.join(completed, '.data.tar.plain')].sort());
    expect(fs.existsSync(interrupted)).toBe(false);
    expect(fs.readdirSync(completed).sort()).toEqual(['data.tar.enc', 'manifest.json']);
  });

  describe('never deletes a directory it cannot prove is its own', () => {
    it('a manifest-less snapshot-named directory with no marker of ours (also what a create looks like for a moment before its spool exists)', () => {
      const parent = fresh('snapshots');
      const dir = snapshotDir(parent, 'alpha-20261105T051500Z');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'the user put this here');
      expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    });

    it.each([['Documents'], ['project'], ['alpha-2026-11-05'], ['alpha-20261105T051500'], ['Alpha-20261105T051500Z'], ['alpha-20261105T051500Z-123']])(
      'a directory called %s, even if it holds a dead spool and a .tar.plain',
      (name) => {
        const parent = fresh('snapshots');
        const dir = path.join(parent, name);
        fs.mkdirSync(dir);
        spool(dir, deadPid);
        fs.writeFileSync(path.join(dir, '.data.tar.plain'), CANARY);
        expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
        expect(fs.readdirSync(dir)).toContain('.data.tar.plain');
      }
    );

    it('a .plain file that does not have our name pattern', () => {
      const parent = fresh('snapshots');
      const dir = snapshotDir(parent, 'beta-20261105T051500Z', { manifest: true });
      for (const name of ['.Data.tar.plain', 'data.tar.plain', '.data.tar.plain.bak']) fs.writeFileSync(path.join(dir, name), 'x');
      expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
    });

    it('a symlinked snapshot directory (it would lead outside the directory being swept)', () => {
      const parent = fresh('snapshots');
      const outside = fresh('outside');
      spool(outside, deadPid);
      fs.writeFileSync(path.join(outside, '.data.tar.plain'), CANARY);
      fs.symlinkSync(outside, path.join(parent, 'alpha-20261105T051500Z'));
      expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
      expect(fs.readdirSync(outside).length).toBe(2);
    });

    it('a spool that is a symlink', () => {
      const parent = fresh('snapshots');
      const outside = fresh('outside');
      fs.writeFileSync(path.join(outside, 'precious'), 'x');
      const dir = snapshotDir(parent, 'alpha-20261105T051500Z', { manifest: true });
      fs.symlinkSync(outside, path.join(dir, `avt-snapshot-${deadPid}-LiNk00`));
      expect(sweepStaleSnapshotData({ snapshotDirs: [parent] }).removed).toEqual([]);
      expect(fs.existsSync(path.join(outside, 'precious'))).toBe(true);
    });
  });

  it('sweeps several directories in one call, snapshots and scratch together', () => {
    const snapshots = fresh('snapshots');
    const more = fresh('more-snapshots');
    const scratch = fresh('scratch');
    const a = snapshotDir(snapshots, 'alpha-20261105T051500Z');
    spool(a, deadPid);
    const b = snapshotDir(more, 'beta-20261105T051500Z');
    spool(b, deadPid);
    const c = spool(scratch, deadPid);
    const result = sweepStaleSnapshotData({ snapshotDirs: [snapshots, more], scratchDirs: [scratch] });
    expect(result.removed.sort()).toEqual([a, b, c].sort());
  });
});
