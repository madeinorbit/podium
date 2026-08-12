/**
 * DURABLE CRASH EVENTS — the server-side store behind `logs.crash`
 * [spec:2026-08-11-logging-strategy-design, "Crash capture"].
 *
 * A crash event is an error plus the client's whole flight recorder, so it is
 * rich, occasional, and worth keeping on the user's own machine — which is the
 * property the support flow turns on: the full data already sits on the user's
 * server, and only the scrubbed signature ever leaves it (through the telemetry
 * crash tier, gated by consent).
 *
 * FILES, NOT A TABLE, and the choice is the spec's ("crash_events table or
 * bounded file store — implementer's choice"). Three reasons decided it here:
 * a crash event is an append-only blob nothing joins against; the snapshot is
 * kilobytes of NDJSON that would sit in a SQLite row as an opaque string
 * anyway; and `podium logs export-crash` runs in the CLI, which must be able to
 * read these with no server running and no migration applied. One file per
 * event also makes retention a `rmSync`, not a delete-with-subquery.
 *
 * RETENTION IS THE SMALLER OF THE TWO BOUNDS (spec: "last 50 crash events or 30
 * days, whichever is smaller"), applied on every write. Both are enforced, so a
 * machine that crashes 50 times in an hour keeps an hour of history and a
 * machine that crashed twice last year keeps none.
 *
 * The store NEVER THROWS at its callers on a storage failure. It sits on an
 * ingestion endpoint: a full disk must not turn a client's crash report into a
 * server error, which would be the logging layer breaking the app it exists to
 * observe. Writes report failure by returning `undefined`; reads skip what they
 * cannot parse.
 */

import type { MachineId } from '@podium/model'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logDir } from './run-registry'

/** Spec bound: never keep more than this many events, however recent. */
export const CRASH_MAX_EVENTS = 50
/** Spec bound: never keep an event older than this, however few there are. */
export const CRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Who crashed. Free-form strings: this is a client's self-description, and it
 *  is used for grouping and for the export bundle, never for authorization. */
export interface CrashOrigin {
  role: string
  v?: string
  machineId?: MachineId
}

export interface CrashError {
  name: string
  message: string
  stack?: string
}

export interface CrashEventInput {
  origin: CrashOrigin
  err: CrashError
  /** The client's ring buffer at the moment it died — log records as sent. */
  snapshot: readonly unknown[]
  /** Anything the producer wants to carry, e.g. a React component stack. */
  context?: Record<string, unknown>
}

export interface CrashEvent extends CrashEventInput {
  id: string
  /** When the SERVER accepted it (ISO-8601 ms). The client's own clock appears
   *  only inside the snapshot records, where its skew is the reader's problem
   *  rather than the retention policy's. */
  receivedAt: string
}

export interface CrashStoreOptions {
  /** Defaults to `<stateDir>/logs/crashes`. */
  dir?: string
  maxEvents?: number
  maxAgeMs?: number
  /** Injected by tests; production uses the wall clock. */
  now?: () => number
  /** Injected by tests; production uses a random id. */
  id?: () => string
}

export interface CrashStore {
  readonly dir: string
  /** Store one event and apply retention. `undefined` when the write failed. */
  record(input: CrashEventInput): CrashEvent | undefined
  /** Newest first. `limit` caps how many are read and parsed. */
  list(limit?: number): CrashEvent[]
  /** Apply retention now; returns how many files were removed. */
  prune(): number
}

/** `<stateDir>/logs/crashes` — beside the NDJSON logs, under the same dir the
 *  CLI already knows how to find. */
export function crashDir(): string {
  return join(logDir(), 'crashes')
}

/**
 * `2026-08-11T14:03:22.847Z` → `20260811T140322847`.
 *
 * The filename carries the timestamp so retention can sort and age files
 * without opening them — a directory of 50 events is pruned with one `readdir`.
 * Colons and dots are stripped rather than escaped: they are legal on POSIX and
 * a minefield on Windows, and nothing reads them back out (the authoritative
 * `receivedAt` is inside the file).
 */
function stamp(iso: string): string {
  return iso.replace(/[-:.]/g, '').replace(/Z$/, '')
}

const FILE_PATTERN = /^(\d{8}T\d{9})-([0-9a-z]+)\.json$/

interface Entry {
  readonly file: string
  readonly at: number
}

/** ms since epoch for a `20260811T140322847` stamp; NaN when it is not one. */
function stampMs(value: string): number {
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(
    9,
    11,
  )}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(15, 18)}Z`
  return Date.parse(iso)
}

export function createCrashStore(options: CrashStoreOptions = {}): CrashStore {
  const dir = options.dir ?? crashDir()
  const maxEvents = options.maxEvents ?? CRASH_MAX_EVENTS
  const maxAgeMs = options.maxAgeMs ?? CRASH_MAX_AGE_MS
  const now = options.now ?? (() => Date.now())
  const nextId = options.id ?? (() => Math.floor(Math.random() * 0xffffffff).toString(36))

  /**
   * Files this store owns, oldest first.
   *
   * ONLY NAMES THIS STORE COULD HAVE WRITTEN are returned, and that is what
   * keeps retention from deleting a stranger's file: the crash dir is a
   * directory on a user's disk, and an export bundle or an editor's swap file
   * dropped in it must survive a prune untouched.
   */
  function entries(): Entry[] {
    if (!existsSync(dir)) return []
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const found: Entry[] = []
    for (const file of names) {
      const match = FILE_PATTERN.exec(file)
      if (!match?.[1]) continue
      const at = stampMs(match[1])
      if (Number.isNaN(at)) continue
      found.push({ file, at })
    }
    return found.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file))
  }

  function prune(): number {
    const all = entries()
    const cutoff = now() - maxAgeMs
    // BOTH bounds, and the count bound is applied to what survives the age
    // bound — "whichever is smaller" is an intersection, not a choice between
    // two policies.
    const doomed = all.filter((e, index) => e.at < cutoff || index < all.length - maxEvents)
    let removed = 0
    for (const entry of doomed) {
      try {
        rmSync(join(dir, entry.file), { force: true })
        removed += 1
      } catch {
        // A file we cannot remove is left for the next prune. Retention is a
        // budget, not an invariant to throw over.
      }
    }
    return removed
  }

  return {
    dir,
    record(input) {
      const receivedAt = new Date(now()).toISOString()
      const event: CrashEvent = { ...input, id: nextId(), receivedAt }
      const path = join(dir, `${stamp(receivedAt)}-${event.id}.json`)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
      } catch {
        return undefined
      }
      prune()
      return event
    },
    list(limit) {
      const wanted = limit ?? maxEvents
      const newestFirst = entries().reverse()
      const out: CrashEvent[] = []
      for (const entry of newestFirst) {
        if (out.length >= wanted) break
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(dir, entry.file), 'utf8'))
          if (typeof parsed === 'object' && parsed !== null) out.push(parsed as CrashEvent)
        } catch {
          // A truncated file (a crash during a crash write) is skipped, not
          // fatal: the other events are still worth reading.
        }
      }
      return out
    },
    prune,
  }
}
