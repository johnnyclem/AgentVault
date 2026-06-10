/**
 * Tests for path validation utility (SEC-12) and atomic file writes (SEC-17).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sanitizePathPart,
  sanitizePathParts,
  atomicWriteFileSync,
} from '../../src/utils/path-validation.js';

describe('sanitizePathPart (SEC-12)', () => {
  it('accepts safe alphanumeric identifiers', () => {
    expect(sanitizePathPart('agent-1')).toBe('agent-1');
    expect(sanitizePathPart('my_wallet.v2')).toBe('my_wallet.v2');
    expect(sanitizePathPart('ABC123')).toBe('ABC123');
  });

  it('rejects empty strings', () => {
    expect(() => sanitizePathPart('')).toThrow(/non-empty/);
  });

  it('rejects parent-directory traversal', () => {
    expect(() => sanitizePathPart('..')).toThrow(/forbidden characters/);
    expect(() => sanitizePathPart('../etc')).toThrow();
  });

  it('rejects path separators', () => {
    expect(() => sanitizePathPart('foo/bar')).toThrow(/forbidden characters/);
    expect(() => sanitizePathPart('foo\\bar')).toThrow(/forbidden characters/);
  });

  it('rejects NUL bytes', () => {
    expect(() => sanitizePathPart('foo\0bar')).toThrow(/forbidden characters/);
  });

  it('rejects current-directory reference', () => {
    expect(() => sanitizePathPart('.')).toThrow(/forbidden characters/);
  });

  it('rejects characters outside the allowed alphabet', () => {
    expect(() => sanitizePathPart('foo bar')).toThrow();
    expect(() => sanitizePathPart('foo$bar')).toThrow();
    expect(() => sanitizePathPart('foo;rm -rf')).toThrow();
  });

  it('rejects over-length input', () => {
    expect(() => sanitizePathPart('a'.repeat(129))).toThrow();
  });

  it('sanitizes multiple parts in one call', () => {
    expect(sanitizePathParts('agent-1', 'wallet-2')).toEqual(['agent-1', 'wallet-2']);
    expect(() => sanitizePathParts('agent-1', '../bad')).toThrow();
  });
});

describe('atomicWriteFileSync (SEC-17)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the file content', () => {
    const target = path.join(tmpDir, 'data.txt');
    atomicWriteFileSync(target, 'hello world');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('does not leave a temp file behind on success', () => {
    const target = path.join(tmpDir, 'final.txt');
    atomicWriteFileSync(target, 'ok');
    const files = fs.readdirSync(tmpDir);
    expect(files).toContain('final.txt');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('honours the requested file mode', () => {
    const target = path.join(tmpDir, 'secret.txt');
    atomicWriteFileSync(target, 'sensitive', { mode: 0o600 });
    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('overwrites an existing file', () => {
    const target = path.join(tmpDir, 'overwrite.txt');
    fs.writeFileSync(target, 'old');
    atomicWriteFileSync(target, 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('accepts Buffer/Uint8Array input', () => {
    const target = path.join(tmpDir, 'bin.dat');
    atomicWriteFileSync(target, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(fs.readFileSync(target)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('creates the parent directory when it does not exist', () => {
    const nested = path.join(tmpDir, 'sub', 'deep');
    const target = path.join(nested, 'data.txt');
    atomicWriteFileSync(target, 'created');
    expect(fs.readFileSync(target, 'utf8')).toBe('created');
  });
});
