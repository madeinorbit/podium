import { closeSync, fsyncSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'

/**
 * fsync a file or a directory by path. Windows flushes only through a handle with write
 * access: fsync on a read-only handle fails with EPERM for files and directories alike,
 * while a read-write handle flushes both (measured with Bun 1.4.2 on Windows 11). POSIX
 * keeps the read-only open, which is the only way to open a directory there.
 */
export function fsyncPath(path: string): void {
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** {@link fsyncPath} for async callers. */
export async function fsyncPathAsync(path: string): Promise<void> {
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
