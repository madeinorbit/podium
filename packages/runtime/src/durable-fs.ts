import { closeSync, fsyncSync, openSync } from 'node:fs'

/**
 * Persist directory entries after a rename or mkdir on POSIX.
 * Windows does not support this directory-fsync pattern through node:fs, so
 * directory-entry durability across power loss is not guaranteed there.
 * Callers must still fsync writable file handles before publishing files;
 * regular-file flush failures must propagate on every platform.
 */
export function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
