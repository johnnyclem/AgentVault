/**
 * validateTarArchive against hostile archives. Fixtures are built by GNU tar
 * 1.35 wherever tar can produce the case, and by hand-assembled header bytes
 * where it cannot (devices, parser-differential tricks, lone zero blocks).
 *
 * Every rejection test has a matching "this is fine" control, so a validator
 * that rejected everything would fail here too.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateTarArchive } from '../../src/container/tar-validate.js';
import { ContainerError } from '../../src/container/types.js';

let work: string;
let counter = 0;

const tarAvailable = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout.includes('GNU tar');

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-tarval-'));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hand-built archives
// ---------------------------------------------------------------------------

interface HeaderSpec {
  name?: string;
  mode?: number;
  size?: number;
  type?: string;
  link?: string;
  /** 'posix' ustar\0 00, 'gnu' "ustar  \0", 'v7' none, or raw 8 bytes */
  magic?: 'posix' | 'gnu' | 'v7' | Buffer;
  prefix?: string;
  sizeField?: Buffer;
  corruptChecksum?: boolean;
  /** Bytes written into the name field starting at offset 0 (may include NULs). */
  rawName?: Buffer;
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`, 'latin1');
}

function header(spec: HeaderSpec): Buffer {
  const b = Buffer.alloc(512);
  const put = (offset: number, data: Buffer | string, max: number): void => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    buf.copy(b, offset, 0, Math.min(max, buf.length));
  };
  if (spec.rawName !== undefined) put(0, spec.rawName, 100);
  else put(0, spec.name ?? 'file', 100);
  put(100, octal(spec.mode ?? 0o644, 8), 8);
  put(108, octal(0, 8), 8);
  put(116, octal(0, 8), 8);
  put(124, spec.sizeField ?? octal(spec.size ?? 0, 12), 12);
  put(136, octal(0, 12), 12);
  b.fill(0x20, 148, 156);
  b[156] = (spec.type ?? '0').charCodeAt(0);
  put(157, spec.link ?? '', 100);
  const magic = spec.magic ?? 'posix';
  if (magic === 'posix') put(257, Buffer.from('ustar\0' + '00', 'latin1'), 8);
  else if (magic === 'gnu') put(257, Buffer.from('ustar  \0', 'latin1'), 8);
  else if (magic !== 'v7') put(257, magic, 8);
  put(345, spec.prefix ?? '', 155);
  let sum = 0;
  for (const byte of b) sum += byte;
  const text = `${sum.toString(8).padStart(6, '0')}\0 `;
  put(148, spec.corruptChecksum === true ? '9999999\0' : text, 8);
  return b;
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function entry(spec: HeaderSpec, data: Buffer | string = ''): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([header({ ...spec, size: spec.size ?? body.length }), pad(body)]);
}

function file(name: string, data = 'data', extra: HeaderSpec = {}): Buffer {
  return entry({ name, ...extra }, data);
}

function dir(name: string, extra: HeaderSpec = {}): Buffer {
  return entry({ name, type: '5', mode: 0o755, ...extra });
}

function symlink(name: string, target: string, extra: HeaderSpec = {}): Buffer {
  return entry({ name, type: '2', link: target, mode: 0o777, ...extra });
}

function hardlink(name: string, target: string, extra: HeaderSpec = {}): Buffer {
  return entry({ name, type: '1', link: target, ...extra });
}

function paxRecord(key: string, value: string | Buffer): Buffer {
  const val = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
  const rest = Buffer.concat([Buffer.from(` ${key}=`, 'latin1'), val, Buffer.from('\n')]);
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) length += 1;
  return Buffer.concat([Buffer.from(String(length), 'latin1'), rest]);
}

function pax(...records: Buffer[]): Buffer {
  return entry({ name: 'PaxHeader/x', type: 'x' }, Buffer.concat(records));
}

function globalPax(...records: Buffer[]): Buffer {
  return entry({ name: 'PaxHeader/g', type: 'g' }, Buffer.concat(records));
}

function longName(name: string | Buffer): Buffer {
  return entry({ name: '././@LongLink', type: 'L', magic: 'gnu' }, Buffer.concat([Buffer.from(name), Buffer.from('\0')]));
}

const END = Buffer.alloc(1024);

function archive(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, END]);
}

function writeTar(data: Buffer): string {
  counter += 1;
  const file = path.join(work, `fixture-${counter}.tar`);
  fs.writeFileSync(file, data);
  return file;
}

async function reject(data: Buffer, pattern: RegExp): Promise<ContainerError> {
  const err = await validateTarArchive(writeTar(data)).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'expected the archive to be rejected').toBeInstanceOf(ContainerError);
  const ce = err as ContainerError;
  expect(ce.code).toBe('INTEGRITY');
  expect(ce.message).toMatch(pattern);
  return ce;
}

async function accept(data: Buffer): Promise<Awaited<ReturnType<typeof validateTarArchive>>> {
  return validateTarArchive(writeTar(data));
}

// ---------------------------------------------------------------------------
// GNU tar fixtures
// ---------------------------------------------------------------------------

function gnuTar(args: string[], cwd: string): void {
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${r.stderr}`);
}

function stage(): string {
  counter += 1;
  const dirPath = path.join(work, `stage-${counter}`);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function tarPath(): string {
  counter += 1;
  return path.join(work, `gnu-${counter}.tar`);
}

function listCount(tarFile: string): number {
  return spawnSync('tar', ['-tf', tarFile], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length;
}

describe.skipIf(!tarAvailable)('valid archives built by GNU tar', () => {
  it('accepts a realistic tree and counts every kind', async () => {
    const root = stage();
    fs.mkdirSync(path.join(root, 'sub/deeper'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'sub/b.txt'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(root, 'sub/deeper/c.bin'), Buffer.alloc(513, 7));
    fs.symlinkSync('a.txt', path.join(root, 'rel-link'));
    fs.symlinkSync('../a.txt', path.join(root, 'sub/up-link'));
    fs.symlinkSync('sub/deeper', path.join(root, 'dir-link'));
    fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'hard'));
    fs.writeFileSync(path.join(root, 'füße-日本語-🙂.txt'), 'unicode');
    fs.chmodSync(path.join(root, 'a.txt'), 0o640);
    fs.chmodSync(path.join(root, 'sub'), 0o700);

    const out = tarPath();
    gnuTar(['-cf', out, '.'], root);
    const summary = await validateTarArchive(out);
    expect(summary.entries).toBe(listCount(out));
    expect(summary.symlinks).toBe(3);
    expect(summary.hardlinks).toBe(1);
    expect(summary.directories).toBe(4); // ./ sub sub/deeper empty
    expect(summary.files).toBe(4);
    expect(summary.totalBytes).toBe(5 + 1000 + 513 + 7);
    expect(summary.entries).toBe(summary.files + summary.directories + summary.symlinks + summary.hardlinks);
  });

  it.each([['gnu'], ['pax'], ['posix'], ['oldgnu']])('accepts format %s with names over 100 and over 255 characters', async (format) => {
    const root = stage();
    const long100 = 'd'.repeat(60);
    const longDir = path.join(root, long100, long100, long100, long100);
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(path.join(longDir, `${'f'.repeat(120)}.txt`), 'long');
    fs.writeFileSync(path.join(root, `${'x'.repeat(200)}`), 'single long component');
    const out = tarPath();
    gnuTar([`--format=${format}`, '-cf', out, '.'], root);
    const summary = await validateTarArchive(out);
    expect(summary.entries).toBe(listCount(out));
    expect(summary.files).toBe(2);
    expect(summary.entries).toBeGreaterThan(5);
  });

  it('accepts ustar and v7 formats', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'short.txt'), 'x');
    fs.mkdirSync(path.join(root, 'd'));
    for (const format of ['ustar', 'v7']) {
      const out = tarPath();
      gnuTar([`--format=${format}`, '-cf', out, '.'], root);
      expect((await validateTarArchive(out)).entries).toBe(listCount(out));
    }
  });

  it('accepts a multi-megabyte file and reports its size', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 5, 1));
    const out = tarPath();
    gnuTar(['-cf', out, '.'], root);
    expect((await validateTarArchive(out)).totalBytes).toBe(3 * 1024 * 1024 + 5);
  });

  it('accepts the default 10240-byte record padding after the end marker', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'one'), '1');
    const out = tarPath();
    gnuTar(['-cf', out, '.'], root);
    expect(fs.statSync(out).size % 10240).toBe(0);
    expect((await validateTarArchive(out)).files).toBe(1);
  });

  it('accepts legitimate mode bits that are not setuid, setgid or sticky', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'exec'), '#!/bin/sh');
    fs.chmodSync(path.join(root, 'exec'), 0o755);
    fs.writeFileSync(path.join(root, 'private'), 'p');
    fs.chmodSync(path.join(root, 'private'), 0o600);
    const out = tarPath();
    gnuTar(['-cf', out, '.'], root);
    expect((await validateTarArchive(out)).files).toBe(2);
  });
});

describe.skipIf(!tarAvailable)('hostile archives built by GNU tar', () => {
  it('rejects an absolute member name (--absolute-names)', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'victim'), 'x');
    const out = tarPath();
    gnuTar(['--absolute-names', '-cf', out, path.join(root, 'victim')], '/');
    const err = await validateTarArchive(out).catch((e: unknown) => e as ContainerError);
    expect(err).toBeInstanceOf(ContainerError);
    expect((err as ContainerError).code).toBe('INTEGRITY');
    expect((err as ContainerError).message).toMatch(/absolute name/);
    expect((err as ContainerError).message).toContain(root);
  });

  it('rejects "../" members produced with --transform', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'x'), 'x');
    const out = tarPath();
    gnuTar(['--transform', 's,^,../,', '-cf', out, 'x'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/"\.\." component/);
  });

  it('rejects a symlink to /etc followed by a file written through it', async () => {
    const root = stage();
    fs.symlinkSync('/etc', path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'payload'), 'pwned');
    const out = tarPath();
    gnuTar(['-cf', out, 'link'], root);
    gnuTar(['-rf', out, '--transform', 's,^payload$,link/passwd,', 'payload'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/absolute target/);
  });

  it('rejects a file written through an EARLIER in-root symlink (the write-through attack on its own)', async () => {
    const root = stage();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.symlinkSync('sub', path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'payload'), 'pwned');
    const out = tarPath();
    gnuTar(['-cf', out, 'sub', 'link'], root);
    // The link target is fine, so only the through-symlink rule can catch this.
    expect((await validateTarArchive(out)).symlinks).toBe(1);
    gnuTar(['-rf', out, '--transform', 's,^payload$,link/evil,', 'payload'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/passes through the earlier symlink "link"/);
  });

  it('rejects a symlink that escapes with ".."', async () => {
    const root = stage();
    fs.symlinkSync('../../outside', path.join(root, 'escape'));
    const out = tarPath();
    gnuTar(['-cf', out, 'escape'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/escapes the extraction root/);
  });

  it('rejects a hardlink whose target is absolute (member names relative, link target left absolute)', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'a'), 'x');
    fs.linkSync(path.join(root, 'a'), path.join(root, 'b'));
    const out = tarPath();
    gnuTar(['-P', '--transform', 'flags=r;s,^.*/,,', '-cf', out, path.join(root, 'a'), path.join(root, 'b')], '/');
    await expect(validateTarArchive(out)).rejects.toThrow(/absolute hardlink target/);
  });

  it('rejects a hardlink that points outside via "../" (link-target-only transform)', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'a'), 'x');
    fs.linkSync(path.join(root, 'a'), path.join(root, 'b'));
    const out = tarPath();
    gnuTar(['-P', '--transform', 'flags=h;s,^a$,../a,', '-cf', out, 'a', 'b'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/"\.\." component in the hardlink target/);
  });

  it('accepts the same hardlink pair when the target stays inside', async () => {
    const root = stage();
    fs.writeFileSync(path.join(root, 'a'), 'x');
    fs.linkSync(path.join(root, 'a'), path.join(root, 'b'));
    const out = tarPath();
    gnuTar(['-cf', out, 'a', 'b'], root);
    expect((await validateTarArchive(out)).hardlinks).toBe(1);
  });

  it('rejects a FIFO', async () => {
    const root = stage();
    spawnSync('mkfifo', [path.join(root, 'pipe')]);
    const out = tarPath();
    gnuTar(['-cf', out, 'pipe'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/unsupported entry type: FIFO/);
  });

  it.each([
    ['setuid file', 0o4755, false],
    ['setgid file', 0o2755, false],
    ['sticky directory', 0o1777, true],
    ['setgid directory', 0o2775, true],
  ])('rejects a %s', async (_label, mode, isDir) => {
    const root = stage();
    const target = path.join(root, 'thing');
    if (isDir) fs.mkdirSync(target);
    else fs.writeFileSync(target, 'x');
    fs.chmodSync(target, mode);
    const out = tarPath();
    gnuTar(['-cf', out, 'thing'], root);
    await expect(validateTarArchive(out)).rejects.toThrow(/setuid, setgid or sticky/);
  });

  describe('truncation and corruption', () => {
    function smallArchive(): Buffer {
      const root = stage();
      fs.writeFileSync(path.join(root, 'file-one'), 'x'.repeat(1500));
      fs.writeFileSync(path.join(root, 'file-two'), 'y'.repeat(700));
      const out = tarPath();
      // blocking factor 1: no 10240-byte padding, so the end marker is exactly two blocks
      gnuTar(['-b', '1', '-cf', out, 'file-one', 'file-two'], root);
      return fs.readFileSync(out);
    }

    it('control: the untouched archive validates', async () => {
      const data = smallArchive();
      expect(data.length % 512).toBe(0);
      expect((await accept(data)).files).toBe(2);
    });

    it('rejects an archive missing its last byte', async () => {
      const data = smallArchive();
      await reject(data.subarray(0, data.length - 1), /truncated archive/);
    });

    it('rejects an archive missing one end-of-archive block', async () => {
      const data = smallArchive();
      await reject(data.subarray(0, data.length - 512), /lone zero block/);
    });

    it('rejects an archive with no end-of-archive marker at all', async () => {
      const data = smallArchive();
      await reject(data.subarray(0, data.length - 1024), /missing end-of-archive marker/);
    });

    it('rejects a cut in the middle of a header', async () => {
      const data = smallArchive();
      await reject(data.subarray(0, 300), /truncated archive/);
    });

    it('rejects a cut at a block boundary in the middle of file data', async () => {
      const data = smallArchive();
      await reject(data.subarray(0, 1024), /entry data extends past the end/);
    });

    it('rejects an empty file', async () => {
      await reject(Buffer.alloc(0), /empty file/);
    });

    it('rejects a corrupted header checksum', async () => {
      const data = Buffer.from(smallArchive());
      data[3] = (data[3] ?? 0) ^ 0x01; // flip a bit in the first name
      await reject(data, /bad header checksum/);
    });

    it('rejects a corrupted checksum field', async () => {
      const data = Buffer.from(smallArchive());
      data[148] = 0x39;
      await reject(data, /bad header checksum|malformed number/);
    });
  });
});

describe('hand-built archives', () => {
  it('control: a minimal valid archive is accepted', async () => {
    const s = await accept(archive(dir('./'), file('./a.txt', 'hi'), symlink('./l', 'a.txt'), hardlink('./h', 'a.txt')));
    expect(s).toEqual({ entries: 4, files: 1, directories: 1, symlinks: 1, hardlinks: 1, totalBytes: 2 });
  });

  it('accepts an archive with no entries (just the end marker)', async () => {
    expect((await accept(END)).entries).toBe(0);
  });

  it('accepts a base-256 encoded size field', async () => {
    const sizeField = Buffer.alloc(12);
    sizeField[0] = 0x80;
    sizeField.writeUInt32BE(5, 8);
    const s = await accept(archive(entry({ name: 'big-encoded', sizeField }, 'hello')));
    expect(s.totalBytes).toBe(5);
  });

  describe('names', () => {
    it('rejects an absolute name', async () => {
      await reject(archive(file('/etc/passwd')), /absolute name/);
    });

    it.each([['../x'], ['a/../../b'], ['a/..'], ['./../x'], ['a/b/../../../c']])('rejects ".." in %s', async (name) => {
      await reject(archive(file(name)), /"\.\." component/);
    });

    it('accepts "..." and names that merely contain two dots', async () => {
      const s = await accept(archive(file('...'), file('a..b'), file('..hidden'), file('x/..y/z')));
      expect(s.files).toBe(4);
    });

    it('rejects a GNU long name containing NUL', async () => {
      await reject(archive(longName(Buffer.from('safe\0../../evil')), file('ignored')), /NUL inside a GNU long name/);
    });

    it('rejects a pax path containing NUL', async () => {
      await reject(archive(pax(paxRecord('path', Buffer.from('a\0b'))), file('x')), /NUL in the pax path/);
    });

    it('rejects an empty pax path', async () => {
      await reject(archive(pax(paxRecord('path', '')), file('x')), /empty pax path/);
    });

    it('rejects non-zero bytes after the NUL terminator of a name', async () => {
      await reject(archive(entry({ rawName: Buffer.from('good\0../../bad') }, 'x')), /non-zero bytes after the terminator/);
    });

    it('accepts a name of exactly 4096 bytes and rejects 4097 (pax path)', async () => {
      const ok = `${'a'.repeat(100)}/`.repeat(41).slice(0, 4096);
      expect(ok).toHaveLength(4096);
      expect((await accept(archive(pax(paxRecord('path', ok)), file('x')))).files).toBe(1);
      await reject(archive(pax(paxRecord('path', `${ok}b`)), file('x')), /longer than 4096 bytes/);
    });

    it('rejects a GNU long name over the cap', async () => {
      await reject(archive(longName('b'.repeat(5000)), file('x')), /extended header is too large/);
    });

    it('rejects an empty name', async () => {
      await reject(archive(entry({ rawName: Buffer.alloc(0) }, 'x')), /empty name/);
    });

    it('rejects a regular file whose name ends with a slash', async () => {
      await reject(archive(file('looks-like-a-dir/', 'data')), /ends with "\/"/);
    });

    it('rejects a file that would replace the extraction root', async () => {
      await reject(archive(file('.')), /replace the extraction root/);
      await reject(archive(file('./')), /ends with "\/"|replace the extraction root/);
      await reject(archive(symlink('.', 'x')), /replace the extraction root/);
    });

    it('applies the ustar prefix (so a hostile prefix is judged too)', async () => {
      await reject(archive(file('safe', 'x', { prefix: '/etc' })), /absolute name/);
      await reject(archive(file('x', 'x', { prefix: 'a/../..' })), /"\.\." component/);
      expect((await accept(archive(file('leaf.txt', 'x', { prefix: 'a/b' })))).files).toBe(1);
    });

    it('rejects data in the prefix region of a non-POSIX header (BusyBox would prepend it)', async () => {
      await reject(archive(file('b', 'x', { magic: 'gnu', prefix: 'pre' })), /prefix region/);
      await reject(archive(file('b', 'x', { magic: 'v7', prefix: 'pre' })), /prefix region/);
    });

    it('rejects an unrecognised magic', async () => {
      await reject(archive(file('b', 'x', { magic: Buffer.from('notustar') })), /bad magic/);
    });
  });

  describe('entry types', () => {
    it.each([
      ['character device', '3'],
      ['block device', '4'],
      ['FIFO', '6'],
      ['contiguous file', '7'],
      ['sparse file', 'S'],
      ['GNU directory dump', 'D'],
      ['volume label', 'V'],
      ['multi-volume continuation', 'M'],
      ['Solaris extended header', 'X'],
      ['old GNU long name', 'N'],
    ])('rejects a %s', async (label, type) => {
      await reject(archive(entry({ name: 'thing', type })), new RegExp(`unsupported entry type: ${label}`));
    });

    it('rejects an unknown type with its hex value', async () => {
      await reject(archive(entry({ name: 'thing', type: 'Z' })), /type 0x5a/);
    });

    it.each([
      ['dir', (): Buffer => dir('d/', { size: 512 })],
      ['symlink', (): Buffer => symlink('l', 'x', { size: 512 })],
      ['hardlink', (): Buffer => hardlink('h', 'f', { size: 512 })],
    ])('rejects a %s header that declares data (parsers disagree on skipping it)', async (_label, make) => {
      // The "data" is a smuggled header that BusyBox would extract.
      const smuggled = file('smuggled', 'x');
      await reject(archive(file('f'), Buffer.concat([make().subarray(0, 512), smuggled])), /declares data/);
    });

    it.each([
      ['setuid', 0o4000],
      ['setgid', 0o2000],
      ['sticky', 0o1000],
      ['setuid+exec', 0o4755],
    ])('rejects mode bits: %s', async (_label, mode) => {
      await reject(archive(file('f', 'x', { mode })), /setuid, setgid or sticky/);
      await reject(archive(dir('d/', { mode })), /setuid, setgid or sticky/);
      await reject(archive(symlink('l', 'f', { mode })), /setuid, setgid or sticky/);
    });

    it('accepts world-writable, but not sticky, modes', async () => {
      expect((await accept(archive(file('f', 'x', { mode: 0o777 }), dir('d/', { mode: 0o777 })))).entries).toBe(2);
    });
  });

  describe('symlinks', () => {
    it('rejects an absolute target', async () => {
      await reject(archive(symlink('l', '/etc/passwd')), /absolute target/);
    });

    it('rejects an empty target', async () => {
      await reject(archive(symlink('l', '')), /empty target/);
    });

    it.each([
      ['l', '..'],
      ['l', '../x'],
      ['d/l', '../../x'],
      ['d/e/l', '../../../x'],
      ['l', 'a/../..'],
    ])('rejects %s -> %s (escapes the root)', async (name, target) => {
      const parents = name.includes('/') ? [dir(`${name.split('/').slice(0, -1).join('/')}/`)] : [];
      await reject(archive(...parents, symlink(name, target)), /escapes the extraction root/);
    });

    it.each([
      ['d/l', '../f'],
      ['d/e/l', '../../f'],
      ['d/l', '.'],
      ['l', 'd/../f'],
      ['l', 'sub/deeper'],
      ['d/l', 'sibling/../../f'],
    ])('accepts %s -> %s (stays inside)', async (name, target) => {
      const s = await accept(archive(dir('d/'), dir('d/e/'), file('f'), symlink(name, target)));
      expect(s.symlinks).toBe(1);
    });

    it('rejects ".." applied after another symlink (lexical resolution would be wrong)', async () => {
      await reject(archive(dir('deep/'), symlink('a', 'deep'), symlink('s', 'a/..')), /applies "\.\." after another symlink/);
    });

    it('rejects a symlink that refers back through itself', async () => {
      await reject(archive(symlink('s', 's/..')), /applies "\.\." after another symlink|escapes/);
    });

    it('rejects any later entry that passes through an earlier symlink', async () => {
      await reject(archive(dir('real/'), symlink('link', 'real'), file('link/evil')), /passes through the earlier symlink "link"/);
      await reject(archive(dir('real/'), symlink('link', 'real'), dir('link/sub/')), /passes through the earlier symlink "link"/);
      await reject(
        archive(dir('a/'), symlink('a/link', '.'), file('a/link/b/c')),
        /passes through the earlier symlink "a\/link"/
      );
      await reject(archive(dir('real/'), symlink('link', 'real'), symlink('link/inner', 'x')), /passes through/);
    });

    it('accepts the same entries when the order makes them harmless', async () => {
      // the file is written BEFORE the symlink exists, under the real directory
      const s = await accept(archive(dir('real/'), file('real/ok'), symlink('link', 'real')));
      expect(s).toMatchObject({ files: 1, symlinks: 1 });
    });

    it('rejects a symlink that replaces a directory used as a parent', async () => {
      await reject(archive(file('a/b'), symlink('a', 'x')), /duplicate path with different types \(dir then symlink\)/);
    });

    it('accepts re-declaring a symlink at the same path', async () => {
      expect((await accept(archive(symlink('l', 'a'), symlink('l', 'b')))).symlinks).toBe(2);
    });
  });

  describe('hardlinks', () => {
    it('rejects an absolute target', async () => {
      await reject(archive(file('f'), hardlink('h', '/etc/passwd')), /absolute hardlink target/);
    });

    it('rejects ".." in the target', async () => {
      await reject(archive(file('f'), hardlink('h', '../f')), /"\.\." component in the hardlink target/);
      await reject(archive(file('d/f'), hardlink('h', 'd/../d/f')), /"\.\." component in the hardlink target/);
    });

    it('rejects a target that has not appeared earlier', async () => {
      await reject(archive(hardlink('h', 'later'), file('later')), /has not appeared earlier/);
      await reject(archive(hardlink('h', 'never-existed')), /has not appeared earlier/);
    });

    it('rejects a hardlink to itself', async () => {
      await reject(archive(hardlink('h', 'h')), /has not appeared earlier/);
    });

    it('rejects a target that is a directory or a symlink', async () => {
      await reject(archive(dir('d/'), hardlink('h', 'd')), /is a dir, not a regular file/);
      await reject(archive(file('f'), symlink('s', 'f'), hardlink('h', 's')), /is a symlink, not a regular file/);
    });

    it('rejects a target reached through an earlier symlink', async () => {
      await reject(
        archive(dir('real/'), file('real/f'), symlink('link', 'real'), hardlink('h', 'link/f')),
        /hardlink target passes through the earlier symlink "link"/
      );
    });

    it('accepts normalised targets and hardlink chains', async () => {
      const s = await accept(archive(file('./d/f'), hardlink('./h1', './d/f'), hardlink('h2', 'h1'), hardlink('d/h3', 'd//f')));
      expect(s.hardlinks).toBe(3);
    });

    it('rejects an empty target', async () => {
      await reject(archive(file('f'), hardlink('h', '')), /empty target/);
    });
  });

  describe('duplicates', () => {
    it.each([
      ['file then directory', (): Buffer[] => [file('x'), dir('x/')], /\(file then dir\)/],
      ['directory then file', (): Buffer[] => [dir('x/'), file('x')], /\(dir then file\)/],
      ['file then symlink', (): Buffer[] => [file('x'), symlink('x', 'y')], /\(file then symlink\)/],
      ['symlink then file', (): Buffer[] => [symlink('x', 'y'), file('x')], /\(symlink then file\)/],
      ['file then hardlink', (): Buffer[] => [file('x'), file('y'), hardlink('x', 'y')], /\(file then hardlink\)/],
      ['file used as a parent', (): Buffer[] => [file('x'), file('x/child')], /parent "x" is not a directory/],
      ['hardlink used as a parent', (): Buffer[] => [file('f'), hardlink('h', 'f'), file('h/child')], /parent "h" is not a directory/],
    ])('rejects %s', async (_label, build, pattern) => {
      await reject(archive(...build()), pattern);
    });

    it('accepts the same type twice (file, file) and implicit parents followed by their directory entry', async () => {
      expect((await accept(archive(file('x', 'one'), file('x', 'two')))).files).toBe(2);
      expect((await accept(archive(file('a/b/c'), dir('a/b/'), dir('a/')))).entries).toBe(3);
      expect((await accept(archive(file('./a/b'), file('a//b')))).files).toBe(2);
    });
  });

  describe('parser differentials', () => {
    it('rejects a pax size that differs from the header size (BusyBox ignores the pax size)', async () => {
      await reject(archive(pax(paxRecord('size', '0')), file('a', 'DATA')), /pax size differs from the header size/);
      await reject(archive(pax(paxRecord('size', '1024')), file('a', '')), /pax size differs/);
    });

    it('accepts a pax size that agrees with the header', async () => {
      expect((await accept(archive(pax(paxRecord('size', '4')), file('a', 'DATA')))).totalBytes).toBe(4);
    });

    it('rejects a malformed pax size', async () => {
      await reject(archive(pax(paxRecord('size', '-4')), file('a', 'DATA')), /malformed pax size/);
      await reject(archive(pax(paxRecord('size', '0x10')), file('a', 'DATA')), /malformed pax size/);
    });

    it('rejects sparse files in any pax form', async () => {
      await reject(archive(pax(paxRecord('GNU.sparse.major', '1')), file('a')), /sparse files are not supported/);
      await reject(archive(globalPax(paxRecord('GNU.sparse.name', 'x')), file('a')), /sparse files are not supported/);
    });

    it('rejects a global pax header that sets path, linkpath or size', async () => {
      await reject(archive(globalPax(paxRecord('path', 'forced-name')), file('a')), /global pax header sets "path"/);
      await reject(archive(globalPax(paxRecord('linkpath', 'x')), file('a')), /global pax header sets "linkpath"/);
      await reject(archive(globalPax(paxRecord('size', '1')), file('a')), /global pax header sets "size"/);
    });

    it('accepts a global pax header with harmless keys', async () => {
      expect((await accept(archive(globalPax(paxRecord('comment', 'hello'), paxRecord('mtime', '1.5')), file('a')))).files).toBe(1);
    });

    it('applies a pax path and judges IT, not the header name', async () => {
      await reject(archive(pax(paxRecord('path', '../../etc/cron.d/evil')), file('innocent')), /"\.\." component/);
      await reject(archive(pax(paxRecord('path', '/etc/passwd')), file('innocent')), /absolute name/);
      expect((await accept(archive(pax(paxRecord('path', 'fine/name')), file('also-fine')))).files).toBe(1);
    });

    it('applies a pax linkpath', async () => {
      await reject(archive(pax(paxRecord('linkpath', '/etc/shadow')), symlink('l', 'fine')), /absolute target/);
      await reject(archive(pax(paxRecord('linkpath', '../../x')), symlink('l', 'fine')), /escapes the extraction root/);
    });

    it('rejects both a GNU long name and a pax path before one entry (the later one wins in BusyBox)', async () => {
      await reject(
        archive(longName('from-long-name'), pax(paxRecord('path', 'from-pax')), file('orig')),
        /both a GNU long name and a pax path/
      );
      await reject(
        archive(pax(paxRecord('path', 'from-pax')), longName('from-long-name'), file('orig')),
        /both a GNU long name and a pax path/
      );
    });

    it('rejects two GNU long-name headers or two pax headers for one entry', async () => {
      await reject(archive(longName('first'), longName('second'), file('orig')), /two GNU long-name headers/);
      await reject(archive(pax(paxRecord('path', 'a')), pax(paxRecord('path', 'b')), file('orig')), /two pax headers/);
    });

    it('rejects duplicate path records inside one pax header', async () => {
      await reject(archive(pax(paxRecord('path', 'a'), paxRecord('path', 'b')), file('orig')), /duplicate pax "path"/);
    });

    it('accepts a GNU long name together with a long link', async () => {
      const long = 'n'.repeat(150);
      const longLink = entry({ name: '././@LongLink', type: 'K', magic: 'gnu' }, Buffer.concat([Buffer.from(long), Buffer.from('\0')]));
      const s = await accept(archive(file(long), longName('l'.repeat(120)), longLink, symlink('x', 'y')));
      expect(s.symlinks).toBe(1);
    });

    it('rejects a GNU long link that escapes', async () => {
      const longLink = entry({ name: '././@LongLink', type: 'K', magic: 'gnu' }, Buffer.from(`${'../'.repeat(40)}x\0`));
      await reject(archive(longLink, symlink('l', 'short')), /escapes the extraction root/);
    });

    it('rejects extended headers in a header without ustar magic', async () => {
      await reject(archive(entry({ name: 'PaxHeader', type: 'x', magic: 'v7' }, paxRecord('path', 'a')), file('b')), /without ustar magic/);
    });

    it('rejects a lone zero block followed by more entries (BusyBox keeps extracting after it)', async () => {
      await reject(Buffer.concat([file('a'), Buffer.alloc(512), file('after'), END]), /lone zero block is followed by more data/);
    });

    it('rejects non-zero data after the end-of-archive marker', async () => {
      const trailing = Buffer.concat([archive(file('a')), Buffer.alloc(512 * 3), file('second-archive-entry')]);
      await reject(trailing, /data after the end-of-archive marker/);
    });

    it('accepts any amount of zero padding after the end marker', async () => {
      expect((await accept(Buffer.concat([archive(file('a')), Buffer.alloc(512 * 40)]))).files).toBe(1);
    });

    it('rejects an extended header that is not followed by an entry', async () => {
      await reject(archive(longName('dangling')), /not followed by an entry/);
      await reject(archive(file('a'), pax(paxRecord('path', 'dangling'))), /not followed by an entry/);
    });

    it('rejects a truncated extended header', async () => {
      const bytes = Buffer.concat([longName('x'.repeat(2000))]);
      await reject(bytes.subarray(0, 1024), /extended header data/);
    });

    it('rejects malformed pax records', async () => {
      await reject(archive(entry({ name: 'p', type: 'x' }, 'not a record\n'), file('a')), /malformed pax record/);
      await reject(archive(entry({ name: 'p', type: 'x' }, '99 path=short\n'), file('a')), /malformed pax record/);
      await reject(archive(entry({ name: 'p', type: 'x' }, '12 path=abcd'), file('a')), /malformed pax record/);
      await reject(archive(entry({ name: 'p', type: 'x' }, '7 =abc\n'), file('a')), /malformed pax record/);
    });
  });

  describe('limits', () => {
    it('enforces maxEntries', async () => {
      const data = archive(file('a'), file('b'), file('c'));
      await expect(validateTarArchive(writeTar(data), { maxEntries: 2 })).rejects.toThrow(/more than 2 entries/);
      expect((await validateTarArchive(writeTar(data), { maxEntries: 3 })).entries).toBe(3);
    });

    it('does not count extended headers as entries', async () => {
      const data = archive(pax(paxRecord('path', 'a')), file('x'), pax(paxRecord('path', 'b')), file('y'));
      expect((await validateTarArchive(writeTar(data), { maxEntries: 2 })).entries).toBe(2);
    });

    it('enforces maxBytes on the sum of file sizes', async () => {
      const data = archive(file('a', 'x'.repeat(600)), file('b', 'y'.repeat(600)));
      await expect(validateTarArchive(writeTar(data), { maxBytes: 1000 })).rejects.toThrow(/more than 1000 bytes/);
      expect((await validateTarArchive(writeTar(data), { maxBytes: 1200 })).totalBytes).toBe(1200);
    });

    it('rejects a declared size beyond the physical archive (a size bomb costs nothing to detect)', async () => {
      const sizeField = Buffer.alloc(12);
      sizeField[0] = 0x80;
      sizeField.writeBigUInt64BE(40n * 1024n ** 3n, 4);
      await reject(archive(entry({ name: 'bomb', sizeField }, '')), /entry data extends past the end/);
    });

    it('rejects an invalid policy', async () => {
      await expect(validateTarArchive(writeTar(END), { maxEntries: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('bounds the memory spent on names', async () => {
      // header name fields hold 100 bytes; each remembered path costs its length plus bookkeeping
      const data = archive(file('a'.repeat(100)), file('b'.repeat(100)), file('c'.repeat(100)));
      await expect(validateTarArchive(writeTar(data), { maxTrackedNameBytes: 300 })).rejects.toThrow(/too many or too long names/);
      expect((await validateTarArchive(writeTar(data), { maxTrackedNameBytes: 600 })).files).toBe(3);
    });

    it('validates 20000 entries (header window refills correctly)', async () => {
      const parts: Buffer[] = [];
      for (let i = 0; i < 20_000; i += 1) parts.push(file(`d${i % 50}/f${i}`, i % 3 === 0 ? 'x'.repeat(i % 700) : ''));
      const s = await accept(archive(...parts));
      expect(s.files).toBe(20_000);
    });
  });

  describe('inputs', () => {
    it('reports a missing file as NOT_FOUND', async () => {
      await expect(validateTarArchive(path.join(work, 'does-not-exist.tar'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a directory', async () => {
      await expect(validateTarArchive(work)).rejects.toMatchObject({ code: 'INTEGRITY' });
    });

    it('rejects a file that is not a tar at all', async () => {
      await reject(Buffer.alloc(1024, 0x41), /bad header checksum|malformed number|bad magic/);
      await reject(Buffer.from('this is not a tar archive'), /truncated archive/);
    });
  });

  describe('error messages', () => {
    it('names the offending entry as JSON, truncated, with control characters escaped', async () => {
      const nasty = `evil\n[SECRET]\u001b[2J/${'z'.repeat(300)}/../x`;
      const err = await reject(archive(pax(paxRecord('path', Buffer.from(nasty))), file('x')), /"\.\." component/);
      expect(err.message).not.toContain('\n');
      expect(err.message).not.toContain('\u001b');
      expect(err.message).toContain('evil\\n[SECRET]');
      expect(err.message.length).toBeLessThan(400);
      expect(err.message).toContain('...');
    });

    it('decodes UTF-8 names for display', async () => {
      const err = await reject(archive(entry({ rawName: Buffer.from('日本語/../x') }, 'x')), /"\.\." component/);
      expect(err.message).toContain('日本語');
    });
  });
});
