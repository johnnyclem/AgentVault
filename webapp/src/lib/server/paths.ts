import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Filesystem confinement for caller-supplied backup locations.
 *
 * The backup routes accept a location in the request body. Passing it straight
 * through to the backup helpers turns them into an arbitrary-file read (import)
 * and an arbitrary-file write (export) for anyone who can reach the API. These
 * helpers reinterpret that input as a location *within* a fixed backup root and
 * reject anything that escapes it.
 */

/** Root that every backup path must resolve inside. */
export function backupRoot(): string {
  return (
    process.env.AGENTVAULT_BACKUP_DIR ??
    path.join(os.homedir(), '.agentvault', 'backups')
  )
}

/**
 * Resolve `requested` inside {@link backupRoot}.
 *
 * Absolute paths and any traversal that lands outside the root are rejected.
 * Relative inputs (including the `./<agent>.json` default the export route has
 * always used) resolve within the root rather than the process working
 * directory.
 *
 * @throws if the input is empty, absolute, or escapes the backup root
 */
export function resolveBackupPath(requested: string): string {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new Error('Backup path must be a non-empty string')
  }

  if (requested.includes('\0')) {
    throw new Error('Backup path must not contain null bytes')
  }

  if (path.isAbsolute(requested)) {
    throw new Error('Backup path must be relative to the backup directory')
  }

  const root = path.resolve(backupRoot())
  const resolved = path.resolve(root, requested)

  // path.relative gives '..' or an absolute path when `resolved` is outside root.
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Backup path escapes the backup directory')
  }

  return resolved
}
