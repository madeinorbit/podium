/**
 * THE PRE-MIGRATION BACKUP'S SEED (POD-7576).
 *
 * The boot backup (`backupDatabase`) is the recovery point of a migrating update, and
 * it has to be taken by the new server with no other writer, so it sits inside the
 * update's handover gap: on a multi-gigabyte database the copy and its fsync held the
 * server unreachable for about 20 seconds. Most of that is writing bytes that the old
 * server could have written while it was still serving.
 *
 * So the old server writes a SEED: a plain copy of the database file, made while it
 * serves, flushed to disk and published under {@link backupSeedPath}. The new server's
 * boot backup starts from that file instead of from nothing ({@link refreshFromSeed}):
 * it reads the live database and the seed side by side and rewrites only the pages that
 * differ, then sets the length. The result is byte for byte the live database at the
 * moment the backup is taken, exactly what a full copy would have produced.
 *
 * THE SEED IS NEVER TRUSTED. It may be torn (the old server keeps writing while it is
 * copied), stale (an update that was canceled after it was written) or from before a
 * restore. None of that matters: every byte of the backup is either compared equal to
 * the live file or overwritten from it. A seed only decides how much has to be written
 * inside the gap. It is not a backup: its name does not match the `.backup-v` pattern,
 * so nothing lists, verifies, retains or restores it.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createLogger } from '@podium/logger'
import { fsyncPathAsync } from '@podium/runtime/fsync'

const log = createLogger('server:migrations')

/** Where the seed of `dbPath`'s next pre-migration backup is published. */
export function backupSeedPath(dbPath: string): string {
  return `${dbPath}.backup-seed`
}

const SEED_PARTIAL_INFIX = '.partial-'

/** Bytes a published seed holds, which the boot backup reuses rather than adds. */
export function backupSeedBytes(dbPath: string): number {
  try {
    // Only a seed the boot would take over ({@link usableBackupSeed}) is reusable.
    const entry = lstatSync(backupSeedPath(dbPath))
    return entry.isFile() && entry.nlink === 1 ? entry.size : 0
  } catch {
    return 0
  }
}

/** Remove the published seed and any unfinished one. Never throws. */
export function discardBackupSeed(dbPath: string): void {
  const seed = backupSeedPath(dbPath)
  const prefix = `${basename(seed)}${SEED_PARTIAL_INFIX}`
  try {
    rmSync(seed, { force: true })
    for (const name of readdirSync(dirname(dbPath))) {
      if (name.startsWith(prefix)) rmSync(join(dirname(dbPath), name), { force: true })
    }
  } catch (err) {
    log.warn('could not remove the pre-migration backup seed', { path: seed, err })
  }
}

/** How a seed write ended. */
export type BackupSeedOutcome =
  | { seeded: true; bytes: number; partial?: true; ms: number }
  | { seeded: false; reason: string; ms: number }

/** Read and write size of the seed copy: large enough to stream, small enough to stay out of the way. */
const SEED_CHUNK_BYTES = 8 << 20

/**
 * Flush the seed every this many bytes. A serving SQLite commit fsyncs its WAL, and on a
 * journaling file system that fsync can wait for every dirty data page queued before it:
 * with the whole seed left dirty until the end, the old server's commits stalled for up
 * to 0.7 s on a 3 GB copy (POD-7576 bench). Flushing as it goes keeps that queue short.
 */
const SEED_FLUSH_BYTES = 64 << 20

/** How a seed write is bounded. */
export interface BackupSeedLimits {
  /**
   * Free bytes the database's file system must keep, counting the seed's own bytes as
   * still free: the boot reuses them. The caller passes the boot's upgrade requirement,
   * so a disk the boot would refuse gets no seed, and the serving server is never left
   * with less than the upgrade's headroom beside it.
   */
  requiredBytes: number
  /** Free bytes on the file system holding `dir` (`freeDiskBytes` in production). */
  freeBytes: (dir: string) => number
  /** The copy's time budget; at the budget the copied prefix is published as it is. */
  budgetMs?: number
  now?: () => number
}

/**
 * Copy the database file to a new seed while the old server serves, then flush it and
 * publish it. Asynchronous throughout (the event loop never waits on the copy). Never
 * throws: a seed that could not be written leaves no file behind, and the boot backup
 * then copies in full.
 *
 * DISK FIRST (POD-7576 review F1). The seed is written beside a server that is still
 * serving, so it starts only when the file system holds `requiredBytes`, and the check
 * is repeated after every chunk: if other writes eat the room meanwhile, the seed is
 * abandoned and removed rather than leave the live database without space for its WAL.
 *
 * AT THE BUDGET, a prefix (review F4). A database that cannot be copied within the
 * budget still publishes what was copied: the boot rewrites the rest, which is less
 * than all of it.
 *
 * The flush is the point. Without it the copied pages sit dirty in the page cache, and
 * the boot backup's own fsync would write them out inside the gap after all.
 */
export async function writeBackupSeed(
  dbPath: string,
  limits: BackupSeedLimits,
): Promise<BackupSeedOutcome> {
  const now = limits.now ?? (() => performance.now())
  const freeBytes = limits.freeBytes
  const started = now()
  const budgetMs = limits.budgetMs ?? 120_000
  const seed = backupSeedPath(dbPath)
  const dir = dirname(dbPath)
  // The previous seed goes first, so the disk never holds two.
  discardBackupSeed(dbPath)
  const roomFor = (copied: number) => freeBytes(dir) + copied >= limits.requiredBytes
  if (!roomFor(0)) {
    return {
      seeded: false,
      reason: `less than ${limits.requiredBytes} bytes free in ${dir}`,
      ms: now() - started,
    }
  }
  const partial = `${seed}${SEED_PARTIAL_INFIX}${randomUUID()}`
  try {
    const copy = await copyWithin(dbPath, partial, {
      expired: () => now() - started > budgetMs,
      roomFor,
    })
    if (copy.stopped === 'budget' && copy.bytes === 0) {
      await rm(partial, { force: true })
      return { seeded: false, reason: `the copy outstayed ${budgetMs} ms`, ms: now() - started }
    }
    if (copy.stopped === 'disk') {
      await rm(partial, { force: true })
      return {
        seeded: false,
        reason: `free space in ${dir} fell below ${limits.requiredBytes} bytes during the copy`,
        ms: now() - started,
      }
    }
    await rename(partial, seed)
    await fsyncPathAsync(dir)
    return {
      seeded: true,
      bytes: copy.bytes,
      ...(copy.stopped === 'budget' ? { partial: true } : {}),
      ms: now() - started,
    }
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {})
    return {
      seeded: false,
      reason: err instanceof Error ? err.message : String(err),
      ms: now() - started,
    }
  }
}

/**
 * Stream `from` into a new file at `to`, fsynced. Stops early when the budget expires
 * (the prefix is kept and flushed) or the disk runs short (the caller removes it).
 */
async function copyWithin(
  from: string,
  to: string,
  checks: { expired: () => boolean; roomFor: (copied: number) => boolean },
): Promise<{ bytes: number; stopped?: 'budget' | 'disk' }> {
  const source = await open(from, 'r')
  try {
    const target = await open(to, 'wx')
    try {
      const buffer = Buffer.allocUnsafe(SEED_CHUNK_BYTES)
      let position = 0
      let stopped: 'budget' | 'disk' | undefined
      for (;;) {
        if (checks.expired()) {
          stopped = 'budget'
          break
        }
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await target.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          )
          written += bytesWritten
        }
        position += bytesRead
        if (!checks.roomFor(position)) return { bytes: position, stopped: 'disk' }
        if (position % SEED_FLUSH_BYTES < bytesRead) await target.datasync()
      }
      await target.sync()
      return stopped ? { bytes: position, stopped } : { bytes: position }
    } finally {
      await target.close()
    }
  } finally {
    await source.close()
  }
}

/** What {@link refreshFromSeed} had to do. */
export interface SeedRefresh {
  /** The live file's length, which the backup now has. */
  bytes: number
  /** Bytes rewritten because the seed differed (or was shorter). */
  rewrittenBytes: number
}

/** Compare unit for a clean run, and the block a difference is rewritten in. */
const COMPARE_CHUNK_BYTES = 1 << 20
const REWRITE_BLOCK_BYTES = 4096

/**
 * Make the file at `target` (a seed, renamed to the backup's partial name) a byte-exact
 * copy of `source`. Synchronous: it runs in the boot backup, which owns the database
 * with no other writer and blocks the boot by design, as the copy it replaces did.
 *
 * Every position below the source's length is read from both files. Where a block
 * differs, or the target has no bytes there, the source's block is written over it;
 * the target is then cut or extended to the source's length. Nothing about the seed
 * is assumed, so the result is the source whatever the seed held. The caller flushes
 * and publishes it exactly as it would a fresh copy.
 */
export function refreshFromSeed(source: string, target: string): SeedRefresh {
  const from = openSync(source, 'r')
  try {
    const to = openSync(target, 'r+')
    try {
      // Checked again on the open descriptors, before anything is written: what was
      // checked by name may not be what was opened.
      const seedStat = fstatSync(to)
      if (!seedStat.isFile() || seedStat.nlink !== 1 || sameFile(seedStat, fstatSync(from)))
        throw new SeedIdentityError(`the seed at ${target} is not a file of its own`)
      const live = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      const seedBytes = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      let position = 0
      let rewrittenBytes = 0
      for (;;) {
        const length = readFully(from, live, position)
        if (length === 0) break
        const heldLength = readFully(to, seedBytes, position)
        if (
          heldLength !== length ||
          !live.subarray(0, length).equals(seedBytes.subarray(0, length))
        ) {
          rewrittenBytes += rewriteDiffering(to, live, seedBytes, length, heldLength, position)
        }
        position += length
        if (length < COMPARE_CHUNK_BYTES) break
      }
      ftruncateSync(to, position)
      // The backup's age is the moment it was taken, not when its seed was copied:
      // retention orders snapshots by modification time.
      const at = new Date()
      futimesSync(to, at, at)
      return { bytes: position, rewrittenBytes }
    } finally {
      closeSync(to)
    }
  } finally {
    closeSync(from)
  }
}

/** Write each differing block of one chunk over the target; the bytes written. */
function rewriteDiffering(
  to: number,
  live: Buffer,
  held: Buffer,
  length: number,
  heldLength: number,
  position: number,
): number {
  let written = 0
  let runStart = -1
  const flush = (end: number) => {
    if (runStart < 0) return
    writeFully(to, live.subarray(runStart, end), position + runStart)
    written += end - runStart
    runStart = -1
  }
  for (let offset = 0; offset < length; offset += REWRITE_BLOCK_BYTES) {
    const end = Math.min(offset + REWRITE_BLOCK_BYTES, length)
    const same = end <= heldLength && live.subarray(offset, end).equals(held.subarray(offset, end))
    if (same) flush(offset)
    else if (runStart < 0) runStart = offset
  }
  flush(length)
  return written
}

/** Read up to `buffer.length` bytes at `position`; short only at the end of the file. */
function readFully(fd: number, buffer: Buffer, position: number): number {
  let total = 0
  while (total < buffer.length) {
    const read = readSync(fd, buffer, total, buffer.length - total, position + total)
    if (read === 0) break
    total += read
  }
  return total
}

function writeFully(fd: number, bytes: Buffer, position: number): void {
  let total = 0
  while (total < bytes.length) {
    total += writeSync(fd, bytes, total, bytes.length - total, position + total)
  }
}

/**
 * The published seed, when it can be taken over: a regular file (not a link) with one
 * name, that is not the database itself. Anything else is discarded and the boot copies
 * in full (POD-7576 review F2): a symlink or hard link to the live database would make
 * the "backup" the live inode, which the migration then writes into.
 */
export function usableBackupSeed(dbPath: string): string | undefined {
  const seed = backupSeedPath(dbPath)
  let entry: Stats
  try {
    entry = lstatSync(seed)
  } catch {
    return undefined
  }
  if (entry.isFile() && entry.nlink === 1 && !sameFile(entry, statSync(dbPath))) return seed
  log.warn('ignoring a pre-migration backup seed that is not a file of its own', {
    path: seed,
    symlink: entry.isSymbolicLink(),
    links: entry.nlink,
  })
  discardBackupSeed(dbPath)
  return undefined
}

/** Thrown by {@link refreshFromSeed} before any write, when the opened seed is not its own file. */
export class SeedIdentityError extends Error {}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
