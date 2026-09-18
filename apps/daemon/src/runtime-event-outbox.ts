import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  RuntimeEventMessage,
  type RuntimeEventMessage as RuntimeEventFrame,
} from '@podium/protocol/daemon'

const FILE_NAME = 'runtime-event-outbox.json'
const JOURNAL_NAME = 'runtime-event-outbox.log'
const FILE_VERSION = 1

/**
 * How many journal records may accumulate before the snapshot is rewritten.
 *
 * Compaction is the ONLY O(pending) write left, so this is the knob that trades
 * steady-state cost against recovery time. At 512 the whole-file rewrite happens
 * once per 512 events instead of twice per event, which is the difference the
 * spiral described above turns on.
 */
const COMPACT_AFTER_RECORDS = 512

export type DurableRuntimeEvent = RuntimeEventFrame & { deliveryId: string }

export interface RuntimeEventOutbox {
  enqueue(event: DurableRuntimeEvent): void
  acknowledge(deliveryId: string): boolean
  pending(): readonly DurableRuntimeEvent[]
  /** Release the journal handle. For shutdown and for tests; the data is already durable. */
  close(): void
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function parseEvents(raw: string, path: string): DurableRuntimeEvent[] {
  const parsed = JSON.parse(raw) as { version?: unknown; events?: unknown }
  if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.events)) {
    throw new Error(`invalid runtime event outbox: ${path}`)
  }
  return parsed.events.map((value) => {
    const event = RuntimeEventMessage.parse(value)
    if (!event.deliveryId) throw new Error(`runtime event has no delivery id: ${path}`)
    return { ...event, deliveryId: event.deliveryId }
  })
}

/**
 * APPEND-ONLY DURABLE OUTBOX FOR RUNTIME EVENTS (POD-4261).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A WHOLE-FILE REWRITE ANY MORE
 * ---------------------------------------------------------------------------
 *
 * This file used to describe itself as a "synchronous fsync+rename outbox for
 * low-cadence coarse runtime events", and it persisted by serialising the ENTIRE
 * pending set — pretty-printed — then writeFileSync + fsync + rename + a second
 * fsync on the directory, on EVERY enqueue AND every acknowledge.
 *
 * That assumption held exactly as long as the events stayed low-cadence. Turning
 * PODIUM_RUNTIME_CONTRACT on machine-wide breaks it: an unflagged session emits
 * no runtime frames at all, while a flagged one mirrors every observation,
 * transcript delta, exit, cwd, draft and context into a durable event. On a box
 * with ~134 live sessions that converts the daemon's whole frame volume into
 * whole-file fsyncs on the main thread.
 *
 * And it did not merely get slow, it spiralled, because entries are retired only
 * on acknowledge: the main thread blocks in fsync, the WS link cannot be
 * serviced and drops, no acknowledgements arrive, the pending set GROWS, every
 * subsequent write serialises a bigger set, and the reconnect replays the whole
 * backlog at once. O(n^2) with positive feedback, observed as 26 link losses in
 * 17 minutes with the daemon pinned.
 *
 * ---------------------------------------------------------------------------
 * WHAT REPLACED IT, AND WHAT DID NOT CHANGE
 * ---------------------------------------------------------------------------
 *
 * Steady state is now an append of ONE record to a journal held open for the
 * process lifetime, plus one fsync on that descriptor: O(1) per event, no
 * reopen, no rename, no directory fsync. The snapshot is rewritten only once per
 * {@link COMPACT_AFTER_RECORDS} records, or opportunistically when the backlog
 * drains to empty, which is the cheapest moment to do it.
 *
 * DURABILITY IS DELIBERATELY UNCHANGED. Every mutation still fsyncs before the
 * call returns, so a reopen immediately after an enqueue still sees the event —
 * that is the guarantee the daemon's at-least-once delivery rests on, and it is
 * the one thing that must NOT be traded for throughput. Batching these fsyncs
 * behind a timer would be faster still and would silently widen the crash window
 * that this contract exists to close.
 *
 * A TORN TRAILING RECORD IS EXPECTED, not corruption: a crash mid-append leaves
 * a partial final line. Recovery stops at the last parseable record, because the
 * alternative — refusing to open — would strand every earlier event that IS
 * intact.
 */
export function createRuntimeEventOutbox(dir: string): RuntimeEventOutbox {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE_NAME)
  const temporary = `${path}.tmp`
  const journalPath = join(dir, JOURNAL_NAME)
  let events = new Map<string, DurableRuntimeEvent>()

  if (existsSync(temporary)) {
    let recovered: DurableRuntimeEvent[] | undefined
    try {
      recovered = parseEvents(readFileSync(temporary, 'utf8'), temporary)
    } catch (error) {
      if (!existsSync(path)) throw error
    }
    if (recovered) {
      events = new Map(recovered.map((event) => [event.deliveryId, event]))
      renameSync(temporary, path)
      fsyncDirectory(dir)
    } else {
      events = new Map(
        parseEvents(readFileSync(path, 'utf8'), path).map((event) => [event.deliveryId, event]),
      )
    }
  } else if (existsSync(path)) {
    events = new Map(
      parseEvents(readFileSync(path, 'utf8'), path).map((event) => [event.deliveryId, event]),
    )
  }

  /**
   * Replay the journal over the snapshot. Records are applied in order, so an
   * add followed by an ack for the same delivery retires it exactly as it did
   * when both were whole-file writes.
   */
  let journalRecords = 0
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line) continue
      let record: { op?: unknown; deliveryId?: unknown; event?: unknown }
      try {
        record = JSON.parse(line) as typeof record
      } catch {
        // A torn trailing record from a crash mid-append. Nothing after it can
        // be trusted either, so stop rather than skip.
        break
      }
      journalRecords += 1
      if (record.op === 'ack' && typeof record.deliveryId === 'string') {
        events.delete(record.deliveryId)
        continue
      }
      if (record.op === 'add' && record.event) {
        const parsed = RuntimeEventMessage.parse(record.event)
        if (!parsed.deliveryId) continue
        events.set(parsed.deliveryId, { ...parsed, deliveryId: parsed.deliveryId })
      }
    }
  }

  /** The journal descriptor, held open so steady state never pays an open/close. */
  let journalFd: number | undefined = openSync(journalPath, 'a', 0o600)

  const writeSnapshot = (next: Map<string, DurableRuntimeEvent>): void => {
    const body = `${JSON.stringify({ version: FILE_VERSION, events: [...next.values()] }, null, 2)}\n`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    fsyncDirectory(dir)
  }

  /** Fold the journal into the snapshot and start a fresh one. */
  const compact = (): void => {
    writeSnapshot(events)
    if (journalFd !== undefined) {
      closeSync(journalFd)
      journalFd = undefined
    }
    rmSync(journalPath, { force: true })
    fsyncDirectory(dir)
    journalFd = openSync(journalPath, 'a', 0o600)
    journalRecords = 0
  }

  const append = (record: string): void => {
    if (journalFd === undefined) journalFd = openSync(journalPath, 'a', 0o600)
    appendFileSync(journalFd, record)
    fsyncSync(journalFd)
    journalRecords += 1
  }

  /**
   * Compact when the journal has outgrown the snapshot it sits on, and take the
   * free one whenever the backlog drains: an empty pending set makes the
   * snapshot write trivial, so a healthy daemon compacts constantly and cheaply
   * and a backlogged one is never asked to.
   */
  const maybeCompact = (): void => {
    if (journalRecords >= COMPACT_AFTER_RECORDS || (events.size === 0 && journalRecords > 0)) {
      compact()
    }
  }

  return {
    enqueue(event) {
      const existing = events.get(event.deliveryId)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error(`runtime event delivery id collision: ${event.deliveryId}`)
        }
        return
      }
      append(`${JSON.stringify({ op: 'add', event })}\n`)
      const next = new Map(events)
      next.set(event.deliveryId, event)
      events = next
      maybeCompact()
    },
    acknowledge(deliveryId) {
      if (!events.has(deliveryId)) return false
      append(`${JSON.stringify({ op: 'ack', deliveryId })}\n`)
      const next = new Map(events)
      next.delete(deliveryId)
      events = next
      maybeCompact()
      return true
    },
    pending: () => [...events.values()],
    close() {
      if (journalFd === undefined) return
      closeSync(journalFd)
      journalFd = undefined
    },
  }
}
