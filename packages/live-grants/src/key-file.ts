/**
 * A key ring read from a file and read again when the file changes, so a
 * rotated key is picked up without a restart (POD-6954 design 4.5; acceptance
 * 3 of POD-7311).
 *
 * On hosted, every Core process, room node and daemon verifier reads its ring
 * this way: Core from a file with the private halves (a mounted secret), the
 * others from one with the public halves only. A file that changes into
 * something unreadable keeps the last good ring and reports the error, so a
 * half-written secret never empties the ring.
 */

import { readFileSync, statSync } from 'node:fs'
import { type LiveGrantKeyRing, parseLiveGrantKeyRing } from './keys'

/** How often the file is looked at, at most. */
export const KEY_FILE_CHECK_MS = 5_000

export interface KeyFileOptions {
  readonly checkEveryMs?: number
  readonly now?: () => number
  /** A changed file could not be read; the previous ring stays. */
  readonly onError?: (error: unknown) => void
}

interface FileStamp {
  readonly mtimeMs: number
  readonly size: number
  readonly ino: number
}

const stampOf = (path: string): FileStamp => {
  const stat = statSync(path)
  return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino }
}

const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino

export class LiveGrantKeyFile {
  private current: LiveGrantKeyRing
  private stamp: FileStamp
  private checkedAt: number
  private readonly checkEveryMs: number
  private readonly now: () => number

  /** Reads the file now; a missing or unreadable file throws. */
  constructor(
    readonly path: string,
    private readonly opts: KeyFileOptions = {},
  ) {
    this.checkEveryMs = opts.checkEveryMs ?? KEY_FILE_CHECK_MS
    this.now = opts.now ?? Date.now
    this.stamp = stampOf(path)
    this.current = parseLiveGrantKeyRing(readFileSync(path, 'utf8'))
    this.checkedAt = this.now()
  }

  /** The current ring; the file is looked at again once `checkEveryMs` has passed. */
  ring(): LiveGrantKeyRing {
    const now = this.now()
    if (now - this.checkedAt < this.checkEveryMs) return this.current
    this.checkedAt = now
    try {
      const stamp = stampOf(this.path)
      if (sameStamp(stamp, this.stamp)) return this.current
      const ring = parseLiveGrantKeyRing(readFileSync(this.path, 'utf8'))
      this.current = ring
      this.stamp = stamp
    } catch (error) {
      this.opts.onError?.(error)
    }
    return this.current
  }
}
