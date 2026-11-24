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
  existsSync,
  ftruncateSync,
  futimesSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
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
    return statSync(backupSeedPath(dbPath)).size
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
  | { seeded: true; bytes: number; ms: number }
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

/**
 * Copy the database file to a new seed while the old server serves, then flush it and
 * publish it. Asynchronous throughout (the event loop never waits on the copy) and
 * bounded by `budgetMs`: a copy that outstays it is abandoned. Never throws: a seed that
 * could not be written leaves no file behind, and the boot backup then copies in full.
 *
 * The flush is the point. Without it the copied pages sit dirty in the page cache, and
 * the boot backup's own fsync would write them out inside the gap after all.
 */
export async function writeBackupSeed(
  dbPath: string,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<BackupSeedOutcome> {
  const now = opts.now ?? (() => performance.now())
  const started = now()
  const budgetMs = opts.budgetMs ?? 120_000
  const seed = backupSeedPath(dbPath)
  // The previous seed goes first, so the disk never holds two.
  discardBackupSeed(dbPath)
  const partial = `${seed}${SEED_PARTIAL_INFIX}${randomUUID()}`
  try {
    const bytes = await copyWithin(dbPath, partial, () => now() - started > budgetMs)
    if (bytes === undefined) {
      await rm(partial, { force: true })
      return { seeded: false, reason: `the copy outstayed ${budgetMs} ms`, ms: now() - started }
    }
    await rename(partial, seed)
    await fsyncPathAsync(dirname(dbPath))
    return { seeded: true, bytes, ms: now() - started }
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {})
    return {
      seeded: false,
      reason: err instanceof Error ? err.message : String(err),
      ms: now() - started,
    }
  }
}

/** Stream `from` into a new file at `to` and fsync it; `undefined` when `expired` stopped it. */
async function copyWithin(
  from: string,
  to: string,
  expired: () => boolean,
): Promise<number | undefined> {
  const source = await open(from, 'r')
  try {
    const target = await open(to, 'wx')
    try {
      const buffer = Buffer.allocUnsafe(SEED_CHUNK_BYTES)
      let position = 0
      for (;;) {
        if (expired()) return undefined
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
        if (position % SEED_FLUSH_BYTES < bytesRead) await target.datasync()
      }
      await target.sync()
      return position
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
      const live = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      const held = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      let position = 0
      let rewrittenBytes = 0
      for (;;) {
        const length = readFully(from, live, position)
        if (length === 0) break
        const heldLength = readFully(to, held, position)
        if (heldLength !== length || !live.subarray(0, length).equals(held.subarray(0, length))) {
          rewrittenBytes += rewriteDiffering(to, live, held, length, heldLength, position)
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

/** True when a published seed exists for `dbPath`. */
export function hasBackupSeed(dbPath: string): boolean {
  return existsSync(backupSeedPath(dbPath))
}
