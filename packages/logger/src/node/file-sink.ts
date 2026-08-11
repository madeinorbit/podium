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
import { dirname } from 'node:path'
import type { LogLevel } from '../levels'
import type { LogRecord } from '../record'
import { toNdjson } from '../record'
import type { Sink } from '../sinks'

/** 10 MiB per file (spec: Storage and rotation). */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
/** Five files TOTAL — the live one plus `.1` … `.4` (spec), so 50 MiB per role. */
export const DEFAULT_MAX_FILES = 5

/** The console methods the degrade path uses. Narrow so a test can fake it. */
export interface ConsoleLike {
  error(...args: unknown[]): void
}

export interface FileSinkOptions {
  /** Absolute path of the LIVE file, e.g. `~/.podium/logs/server.ndjson`. */
  path: string
  /** ABSENT follows the namespace's configured level, as the console sink does. */
  minLevel?: LogLevel
  /** Rotate before a record would push the live file past this. */
  maxBytes?: number
  /** Live file + archives. 1 means "no archives, truncate in place". */
  maxFiles?: number
  console?: ConsoleLike
}

export interface FileSink extends Sink {
  /**
   * Every accepted record is already on the fd — this exists for the interface,
   * not because anything is buffered here. See the durability note below.
   */
  flush(): Promise<void>
  /** Releases the fd. Implies a final flush, which for this sink is a no-op. */
  close(): Promise<void>
  /** True once a write failed and records started going to the console instead. */
  readonly degraded: boolean
  /** The live file's current size in bytes, as this sink accounts for it. */
  readonly bytes: number
}

/**
 * Durable NDJSON with in-process size-based rotation.
 *
 * WHY SYNCHRONOUS WRITES. `Sink.write` is sync-void and a sink must own its own
 * failures — an async write that rejects escapes the dispatcher's try/catch,
 * lands as an unhandledRejection, and leaves the broken sink registered, which
 * is exactly the "logging must never break the app" property inverted. A
 * `writeSync` to a local file costs single-digit microseconds, keeps records in
 * emission order without a queue, and — the reason that actually decides it —
 * means the crash net's own last record is on disk BEFORE the process dies.
 * A buffered async sink loses precisely the records worth having.
 *
 * WHAT A FAILURE DOES. Nothing throws out of here. On the first write or
 * rotation error (ENOSPC is the case the spec names, but a read-only mount or a
 * revoked fd behaves the same) the sink emits ONE local warning and degrades:
 * the same NDJSON goes to the console for the rest of the process. It does not
 * retry the file — a disk that filled once fills again, and a sink that probes
 * the filesystem on every record turns a full disk into a performance incident
 * on top of a logging one.
 */
export function createFileSink(options: FileSinkOptions): FileSink {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new RangeError(`file sink maxFiles must be a positive integer, got ${maxFiles}`)
  }
  if (!Number.isFinite(maxBytes) || maxBytes < 1) {
    throw new RangeError(`file sink maxBytes must be a positive number, got ${maxBytes}`)
  }
  const target = options.console ?? console

  let fd: number | undefined
  let bytes = 0
  let degraded = false
  let closed = false

  /** Open the live file for append and adopt whatever is already in it. */
  function open(): void {
    mkdirSync(dirname(options.path), { recursive: true })
    // Size BEFORE the open: a restart appends to the previous run's file, and a
    // sink that started its accounting at zero would let it grow to
    // maxBytes past whatever was already there, once per restart.
    bytes = existsSync(options.path) ? statSync(options.path).size : 0
    fd = openSync(options.path, 'a')
  }

  /**
   * `x.ndjson.3` → `.4`, … , `x.ndjson` → `.1`, oldest dropped. Renaming from
   * the OLDEST end is what makes this safe to interrupt: a crash mid-rotation
   * loses at most one archive, never overwrites a younger one with an older one.
   *
   * EVERY DESTINATION IS UNLINKED BEFORE ITS RENAME, and that is not belt-and-
   * braces. `renameSync` silently replaces an existing destination on POSIX but
   * THROWS on Windows, so a rotation that leaned on the overwrite would work
   * here and, from the second rotation onward, throw on Windows — where the
   * throw is caught by the degrade path, so the symptom would be a Windows
   * install quietly logging to the console forever with a full `.1` on disk.
   */
  function rotate(): void {
    if (fd !== undefined) {
      closeSync(fd)
      fd = undefined
    }
    const archive = (index: number): string => `${options.path}.${index}`
    if (maxFiles > 1) {
      // The oldest archive is dropped rather than shifted: it is the one that
      // falls off the end of the budget.
      rmSync(archive(maxFiles - 1), { force: true })
      for (let i = maxFiles - 2; i >= 1; i--) {
        if (!existsSync(archive(i))) continue
        rmSync(archive(i + 1), { force: true })
        renameSync(archive(i), archive(i + 1))
      }
      if (existsSync(options.path)) {
        rmSync(archive(1), { force: true })
        renameSync(options.path, archive(1))
      }
    } else {
      // No archives: the live file IS the whole budget, so it starts over.
      rmSync(options.path, { force: true })
    }
    open()
  }

  function degrade(err: unknown): void {
    degraded = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The fd is already unusable; that is why we are here.
      }
      fd = undefined
    }
    // console directly, not the logger: reporting a sink failure THROUGH the
    // logger is a log-about-logging loop.
    try {
      target.error(
        `[podium:logger] file sink '${options.path}' failed and has degraded to the console: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    } catch {
      // Even the warning is best-effort. There is nowhere left to report to.
    }
  }

  return {
    name: 'file',
    ...(options.minLevel ? { minLevel: options.minLevel } : {}),
    get degraded() {
      return degraded
    },
    get bytes() {
      return bytes
    },
    write(record: LogRecord): void {
      const line = toNdjson(record)
      if (degraded || closed) {
        try {
          target.error(line.trimEnd())
        } catch {
          // Nowhere left to write.
        }
        return
      }
      try {
        if (fd === undefined) open()
        const size = Buffer.byteLength(line)
        // `>` not `>=`, and only when the file is non-empty: a single record
        // larger than maxBytes must still be written somewhere rather than
        // rotating an empty file forever.
        if (bytes > 0 && bytes + size > maxBytes) rotate()
        // `rotate()` and `open()` both reassign `fd`, so it is re-read here
        // rather than captured before the branch.
        const handle = fd
        if (handle === undefined) throw new Error('file sink has no open descriptor')
        writeSync(handle, line)
        bytes += size
      } catch (err) {
        degrade(err)
        try {
          target.error(line.trimEnd())
        } catch {
          // Nowhere left to write.
        }
      }
    },
    flush(): Promise<void> {
      // Nothing is buffered in this process — `writeSync` already returned. The
      // seam exists so a shutdown drain can await every sink uniformly.
      return Promise.resolve()
    },
    close(): Promise<void> {
      // `close()` implies a final flush per the sink contract. Here that is
      // definitionally satisfied: `writeSync` already returned for every record
      // this sink accepted, so there is nothing to settle before releasing.
      closed = true
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Closing a broken fd is not worth reporting at shutdown.
        }
        fd = undefined
      }
      return Promise.resolve()
    },
  }
}
