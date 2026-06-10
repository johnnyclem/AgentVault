/**
 * Path validation utilities
 *
 * SEC-12: rejects user-supplied path segments that could traverse outside
 * their intended directory. Use on every untrusted string before joining
 * it into a filesystem path.
 *
 * SEC-17: provides atomicWriteFileSync that writes to a temp file and
 * renames into place, preventing partial writes on crash.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const VALID_PATH_PART = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * Validate and normalize a path component that came from untrusted input.
 *
 * Rejects empty strings, `..`, anything containing path separators or NUL,
 * and anything outside the allowed character set. Returns the validated
 * value so the call site can use the return rather than the original.
 *
 * @throws Error with a stable, non-leaky message on invalid input
 */
export function sanitizePathPart(part: string): string {
  if (typeof part !== 'string' || part.length === 0) {
    throw new Error('Invalid path component: must be a non-empty string');
  }
  if (
    part === '.' ||
    part === '..' ||
    part.includes('/') ||
    part.includes('\\') ||
    part.includes('\0')
  ) {
    throw new Error('Invalid path component: contains forbidden characters');
  }
  if (!VALID_PATH_PART.test(part)) {
    throw new Error(
      'Invalid path component: only [a-zA-Z0-9._-] up to 128 chars allowed'
    );
  }
  return part;
}

/**
 * Sanitize multiple path components in one call.
 */
export function sanitizePathParts(...parts: string[]): string[] {
  return parts.map(sanitizePathPart);
}

/**
 * SEC-17: atomically write a file by writing to a temp sibling and
 * renaming over the target. Survives process kill mid-write without
 * corrupting the destination.
 */
export function atomicWriteFileSync(
  targetPath: string,
  data: string | Buffer | Uint8Array,
  options: { mode?: number; encoding?: BufferEncoding } = {}
): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Unique temp name so concurrent writers don't clobber each other
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w', options.mode ?? 0o600);
    const buf =
      typeof data === 'string'
        ? Buffer.from(data, options.encoding ?? 'utf8')
        : Buffer.from(data);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
