import { randomUUID } from 'node:crypto'
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
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  RuntimeEventMessage,
  isDurableRuntimeEvent,
  type RuntimeEventMessage as RuntimeEventFrame,
} from '@podium/protocol/daemon'
import type { SessionId } from '@podium/model'
import type { DeliveryJournal } from '@podium/harness/driver/host'

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
  deliveryJournal(sessionId: SessionId): DeliveryJournal
  enqueue(event: DurableRuntimeEvent): void
  acknowledge(deliveryId: string): boolean
  pending(): readonly DurableRuntimeEvent[]
  /** Release the journal handle. For shutdown and for tests; the data is already durable. */
  close(): void
}

/** Prepare at the host boundary, including the window before transport exists.
 * Explicit ids retain their original delivery contract across upgrades. */
export function prepareRuntimeEventDelivery(
  outbox: RuntimeEventOutbox,
  message: RuntimeEventFrame,
): RuntimeEventFrame {
  if (message.deliveryId === undefined && !isDurableRuntimeEvent(message.event)) return message
  const retained = { ...message, deliveryId: message.deliveryId ?? randomUUID() }
  outbox.enqueue(retained)
  return retained
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

interface TypingRecord { sessionId: SessionId; rowId: string; startedAt: string }
const rowKey = (sessionId: SessionId, rowId: string): string => JSON.stringify([sessionId, rowId])

function parseTyping(value: unknown): TypingRecord {
  const entry = value as Partial<TypingRecord> | null
  if (!entry || typeof entry.sessionId !== 'string' || typeof entry.rowId !== 'string' ||
      typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt))) {
    throw new Error('invalid runtime delivery typing record')
  }
  return { sessionId: entry.sessionId, rowId: entry.rowId, startedAt: entry.startedAt }
}

function parseSnapshot(raw: string, path: string): { events: DurableRuntimeEvent[]; typing: TypingRecord[] } {
  const parsed = JSON.parse(raw) as { version?: unknown; events?: unknown; typing?: unknown }
  if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.events)) {
    throw new Error(`invalid runtime event outbox: ${path}`)
  }
  const events = parsed.events.map((value) => {
    const event = RuntimeEventMessage.parse(value)
    if (!event.deliveryId) throw new Error(`runtime event has no delivery id: ${path}`)
    return { ...event, deliveryId: event.deliveryId }
  })
  if (parsed.typing !== undefined && !Array.isArray(parsed.typing)) {
    throw new Error(`invalid runtime delivery journal: ${path}`)
  }
  return { events, typing: ((parsed.typing as unknown[] | undefined) ?? []).map(parseTyping) }
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
 * That assumption held exactly as long as the events stayed low-cadence. Every
 * driven session mirrors every observation, transcript delta, exit, cwd, draft
 * and context into a durable event. On a box with ~134 live sessions that
 * converts the daemon's whole frame volume into whole-file fsyncs on the main
 * thread.
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
  const typing = new Map<string, TypingRecord>()
  // Index the outcomes already persisted by this outbox, rather than copying
  // them into a second store. Both accepted holds and final outcomes replay.
  const byRow = new Map<string, Map<string, DurableRuntimeEvent>>()
  const track = (event: DurableRuntimeEvent): void => {
    if (event.event.t !== 'delivery') return
    const key = rowKey(event.sessionId, event.event.rowId)
    let pending = byRow.get(key)
    if (!pending) byRow.set(key, pending = new Map())
    pending.set(event.deliveryId, event)
  }
  const retire = (deliveryId: string): void => {
    const event = events.get(deliveryId)
    events.delete(deliveryId)
    if (event?.event.t !== 'delivery') return
    const key = rowKey(event.sessionId, event.event.rowId)
    const pending = byRow.get(key)
    pending?.delete(deliveryId)
    if (pending?.size === 0) {
      byRow.delete(key)
    }
    // An accepted hold is not settled. A final server ack retires its fence
    // even if an earlier accepted report is still awaiting acknowledgement.
    if (event.event.outcome !== 'accepted') typing.delete(key)
  }
  const loadSnapshot = (snapshot: ReturnType<typeof parseSnapshot>): void => {
    events = new Map(snapshot.events.map((event) => [event.deliveryId, event]))
    for (const entry of snapshot.typing) typing.set(rowKey(entry.sessionId, entry.rowId), entry)
    for (const event of snapshot.events) track(event)
  }

  if (existsSync(temporary)) {
    let recovered: ReturnType<typeof parseSnapshot> | undefined
    try {
      recovered = parseSnapshot(readFileSync(temporary, 'utf8'), temporary)
    } catch (error) {
      if (!existsSync(path)) throw error
    }
    if (recovered) {
      loadSnapshot(recovered)
      renameSync(temporary, path)
      fsyncDirectory(dir)
    } else {
      loadSnapshot(parseSnapshot(readFileSync(path, 'utf8'), path))
    }
  } else if (existsSync(path)) {
    loadSnapshot(parseSnapshot(readFileSync(path, 'utf8'), path))
  }

  /**
   * Replay the journal over the snapshot. Records are applied in order, so an
   * add followed by an ack for the same delivery retires it exactly as it did
   * when both were whole-file writes.
   */
  let journalRecords = 0
  let validBytes = 0
  let tornTail = false
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (index === lines.length - 1) {
        tornTail = line.length > 0
        break
      }
      if (!line) { validBytes += 1; continue }
      let record: { op?: unknown; deliveryId?: unknown; event?: unknown; sessionId?: unknown; rowId?: unknown }
      try {
        record = JSON.parse(line) as typeof record
      } catch {
        // A torn trailing record from a crash mid-append. Nothing after it can
        // be trusted either, so stop rather than skip.
        tornTail = true
        break
      }
      journalRecords += 1
      validBytes += Buffer.byteLength(line, 'utf8') + 1
      if (record.op === 'ack' && typeof record.deliveryId === 'string') {
        retire(record.deliveryId)
        continue
      }
      if (record.op === 'typing') {
        const entry = parseTyping(record)
        const key = rowKey(entry.sessionId, entry.rowId)
        typing.set(key, entry)
        continue
      }
      if (record.op === 'untyped' && typeof record.sessionId === 'string' && typeof record.rowId === 'string') {
        typing.delete(rowKey(record.sessionId as SessionId, record.rowId))
        continue
      }
      if (record.op === 'add' && record.event) {
        const parsed = RuntimeEventMessage.parse(record.event)
        if (!parsed.deliveryId) continue
        events.set(parsed.deliveryId, { ...parsed, deliveryId: parsed.deliveryId })
        track({ ...parsed, deliveryId: parsed.deliveryId })
      }
    }
  }
  // Never append a new typing fence behind a torn record: a subsequent reopen
  // would stop at that record and mistake the new attempt for never typed.
  if (tornTail) truncateSync(journalPath, validBytes)

  /** The journal descriptor, held open so steady state never pays an open/close. */
  let journalFd: number | undefined = openSync(journalPath, 'a', 0o600)
  fsyncSync(journalFd)
  fsyncDirectory(dir)

  const writeSnapshot = (next: Map<string, DurableRuntimeEvent>): void => {
    const body = `${JSON.stringify({ version: FILE_VERSION, events: [...next.values()], typing: [...typing.values()] }, null, 2)}\n`
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
    fsyncSync(journalFd)
    fsyncDirectory(dir)
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
    if (journalRecords >= COMPACT_AFTER_RECORDS || (events.size === 0 && typing.size === 0 && journalRecords > 0)) {
      compact()
    }
  }

  return {
    deliveryJournal(sessionId) {
      return {
        read(rowId) {
          const key = rowKey(sessionId, rowId)
          const event = [...(byRow.get(key)?.values() ?? [])].at(-1)?.event
          if (event?.t === 'delivery') {
            const { t, outcome, held, reason, cause, transcriptItem, harnessRef } = event
            return { typingStarted: true, outcome: { t, rowId, outcome,
              ...(held ? { held } : {}), ...(reason ? { reason } : {}), ...(cause ? { cause } : {}),
              ...(transcriptItem ? { transcriptItem } : {}), ...(harnessRef ? { harnessRef } : {}),
            } }
          }
          return typing.has(key) ? { typingStarted: true } : undefined
        },
        start(rowId) {
          const key = rowKey(sessionId, rowId)
          if (typing.has(key)) return
          const entry = { sessionId, rowId, startedAt: new Date().toISOString() }
          append(`${JSON.stringify({ op: 'typing', ...entry })}\n`)
          typing.set(key, entry)
          maybeCompact()
        },
        clear(rowId) {
          const key = rowKey(sessionId, rowId)
          if (!typing.has(key)) return
          append(`${JSON.stringify({ op: 'untyped', sessionId, rowId })}\n`)
          typing.delete(key)
          maybeCompact()
        },
      }
    },
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
      track(event)
      maybeCompact()
    },
    acknowledge(deliveryId) {
      if (!events.has(deliveryId)) return false
      append(`${JSON.stringify({ op: 'ack', deliveryId })}\n`)
      retire(deliveryId)
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
