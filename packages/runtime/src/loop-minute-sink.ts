/**
 * THE MINUTE FILE (loop profile levels design §5.1).
 *
 * One NDJSON line per minute per component, in
 * `<stateDir>/perf/loop-<component>.ndjson`. The same record also goes through
 * the logger at `info`, so it reaches the journal and `podium logs` — but the
 * dedicated file is the contract for an agent reading this back later: it holds
 * ONLY these records, in order, with no other log traffic to filter out. Every
 * previous investigation of a loop stall began by reconstructing exactly this
 * from journal prose, by hand.
 *
 * WHY NOT `createFileSink`. The logger's file sink writes `LogRecord`s: each
 * line would carry a level, a namespace, a message and the minute nested under
 * a field, which is precisely the "only these records" property given away. The
 * rotation logic here is the same shape as that sink's and deliberately so —
 * open lazily, adopt the size already on disk, rename the live file aside, drop
 * anything older, never let a write failure escape.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { createLogger, type Logger } from '@podium/logger'
import type { LoopComponent, LoopMinute, LoopMinuteSink } from './loop-accounting'

/**
 * 8 MiB, one archive: a minute record is ~250 bytes, so the live file holds
 * roughly three weeks and the pair about six. Bounded is the invariant (§2.5);
 * the exact span is a consequence of it.
 */
export const DEFAULT_LOOP_MINUTE_MAX_BYTES = 8 * 1024 * 1024

export interface LoopMinuteFileSink extends LoopMinuteSink {
  /** The live file. It does not exist until the first record is written. */
  readonly path: string
  /** True once a write failed; records then go to the logger only. */
  readonly degraded: boolean
  close(): void
}

export interface LoopMinuteSinkOptions {
  /** Directory for the file, created on the first write and not before. */
  dir: string
  component: LoopComponent
  maxBytes?: number
  /** Where the duplicate `loop minute` record goes. */
  log?: Logger
}

/** `<dir>/loop-<component>.ndjson` — the path an agent is told to read. */
export function loopMinutePath(dir: string, component: LoopComponent): string {
  return join(dir, `loop-${component}.ndjson`)
}

export function createLoopMinuteSink(options: LoopMinuteSinkOptions): LoopMinuteFileSink {
  const path = loopMinutePath(options.dir, options.component)
  const maxBytes = options.maxBytes ?? DEFAULT_LOOP_MINUTE_MAX_BYTES
  const log = options.log ?? createLogger(`${options.component}:loop`)

  let fd: number | undefined
  let bytes = 0
  let degraded = false
  let closed = false

  /**
   * Open for append and adopt what is already there. Sizing BEFORE the open
   * matters: a restart appends to the previous run's file, and a sink that
   * started its accounting at zero would let the file grow by another maxBytes
   * per restart.
   */
  function open(): void {
    mkdirSync(options.dir, { recursive: true })
    bytes = existsSync(path) ? statSync(path).size : 0
    fd = openSync(path, 'a')
  }

  /** Live → `.1`, previous `.1` dropped. One generation, per §5.1. */
  function rotate(): void {
    if (fd !== undefined) {
      closeSync(fd)
      fd = undefined
    }
    const archive = `${path}.1`
    // Unlinked before the rename rather than relying on the overwrite:
    // `renameSync` replaces silently on POSIX and THROWS on Windows.
    rmSync(archive, { force: true })
    if (existsSync(path)) renameSync(path, archive)
    open()
  }

  return {
    get path() {
      return path
    },
    get degraded() {
      return degraded
    },
    write(minute: LoopMinute): void {
      // The journal copy first, so a file that cannot be written still leaves
      // the record somewhere — this is the fallback the degrade path relies on.
      log.info('loop minute', { ...minute })
      if (degraded || closed) return
      try {
        const line = `${JSON.stringify(minute)}\n`
        if (fd === undefined) open()
        const size = Buffer.byteLength(line)
        if (bytes > 0 && bytes + size > maxBytes) rotate()
        const handle = fd
        if (handle === undefined) throw new Error('loop minute sink has no open descriptor')
        writeSync(handle, line)
        bytes += size
      } catch (err) {
        // Once, then never again: a disk that filled once fills again, and a
        // sink that probes the filesystem every minute turns a full disk into a
        // second incident. The logger copy above continues regardless.
        degraded = true
        if (fd !== undefined) {
          try {
            closeSync(fd)
          } catch {
            // The fd is already unusable; that is why we are here.
          }
          fd = undefined
        }
        log.warn('loop minute file degraded — records continue in the log only', {
          path,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    },
    close(): void {
      closed = true
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Closing a broken fd is not worth reporting at shutdown.
        }
        fd = undefined
      }
    },
  }
}
