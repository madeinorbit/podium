import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsync,
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
import type { DeliveryJournal, DeliveryOutcome } from '@podium/harness/driver/host'
import { createLogger } from '@podium/logger'
import { mergeHarnessRefs, type SessionId } from '@podium/model'
import {
  isDurableRuntimeEvent,
  RuntimeEventBody as RuntimeEventBodySchema,
  type RuntimeEventMessage as RuntimeEventFrame,
  RuntimeEventMessage,
} from '@podium/protocol/daemon'
import { fsyncPath, fsyncPathAsync } from '@podium/runtime/fsync'

const FILE_NAME = 'runtime-event-outbox.json'
const JOURNAL_NAME = 'runtime-event-outbox.log'
/** A journal being prepared by compaction; it replaces {@link JOURNAL_NAME} only once durable. */
const NEXT_JOURNAL_NAME = 'runtime-event-outbox.log.next'
const FILE_VERSION = 1
const log = createLogger('daemon:runtime-event-outbox')

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
  /** Constant-time count of retained deliveries, without materializing pending(). */
  readonly pendingCount: number
  pending(): readonly DurableRuntimeEvent[]
  /**
   * Resolves once every written record is durable and no compaction is running.
   * For tests and benchmarks; nothing in the daemon waits on it.
   */
  settled(): Promise<void>
  /** Finish a running compaction, commit pending ACKs and release the journal handle. */
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

/** One background compaction; see the step list in createRuntimeEventOutbox. */
interface Compaction {
  /** Records appended since the snapshot body was captured, in journal order. */
  readonly carry: { record: string; durable: boolean }[]
  /** How many carried records the next journal held when its fsync was issued. */
  copied: number
  readonly epoch: string
  readonly hash: string
  snapshotFd?: number
  journalFd?: number
  /** Invalidates a thread-pool result that a synchronous finish or an abandon overtook. */
  ticket: number
}

interface TypingRecord {
  sessionId: SessionId
  rowId: string
  storedAt?: string
  startedAt?: string
  outcome?: DeliveryOutcome
}
const rowKey = (sessionId: SessionId, rowId: string): string => JSON.stringify([sessionId, rowId])
const snapshotHash = (body: string): string => createHash('sha256').update(body).digest('hex')

function deliveryBody(value: unknown): DeliveryOutcome {
  const parsed = RuntimeEventBodySchema.parse(value)
  if (parsed.t !== 'delivery') throw new Error('invalid runtime delivery outcome')
  return parsed as DeliveryOutcome
}

function parseTyping(value: unknown): TypingRecord {
  const entry = value as Partial<TypingRecord> | null
  if (
    !entry ||
    typeof entry.sessionId !== 'string' ||
    typeof entry.rowId !== 'string' ||
    (entry.storedAt !== undefined &&
      (typeof entry.storedAt !== 'string' || !Number.isFinite(Date.parse(entry.storedAt)))) ||
    (entry.startedAt !== undefined &&
      (typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt)))) ||
    (entry.storedAt === undefined && entry.startedAt === undefined && entry.outcome === undefined)
  ) {
    throw new Error('invalid runtime delivery typing record')
  }
  const outcome = entry.outcome === undefined ? undefined : deliveryBody(entry.outcome)
  if (outcome && outcome.rowId !== entry.rowId)
    throw new Error('runtime delivery outcome row mismatch')
  return {
    sessionId: entry.sessionId,
    rowId: entry.rowId,
    ...(entry.storedAt ? { storedAt: entry.storedAt } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

function parseSnapshot(
  raw: string,
  path: string,
): { events: DurableRuntimeEvent[]; typing: TypingRecord[]; typingEpoch?: string } {
  const parsed = JSON.parse(raw) as {
    version?: unknown
    events?: unknown
    typing?: unknown
    typingEpoch?: unknown
  }
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
  return {
    events,
    typing: ((parsed.typing as unknown[] | undefined) ?? []).map(parseTyping),
    ...(Array.isArray(parsed.typing) &&
    typeof parsed.typingEpoch === 'string' &&
    parsed.typingEpoch.length > 0
      ? { typingEpoch: parsed.typingEpoch }
      : {}),
  }
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
 * {@link COMPACT_AFTER_RECORDS} records, opportunistically when the backlog
 * drains to empty, or when boot must establish/repair typing coverage.
 *
 * DURABILITY OF WHAT WAS PROMISED IS UNCHANGED. Every enqueue, typing fence and
 * delivery outcome still fsyncs before the call returns, so a reopen immediately
 * after an enqueue still sees the event — that is the guarantee the daemon's
 * at-least-once delivery rests on, and it is not traded for throughput.
 *
 * ACKNOWLEDGEMENTS ARE GROUP-COMMITTED (POD-7438). An ACK retirement only ever
 * removes work, so losing it in a crash costs one idempotent replay of an event
 * the server already deduplicates by delivery id; it never loses an event. A
 * reconnect replay acknowledges its whole backlog in one burst, and paying an
 * fsync per ACK on the daemon thread stalled it for seconds. An ACK record is
 * therefore written to the journal in order, on the caller's thread (a page
 * cache copy), and made durable by one background fsync covering every ACK
 * written since the previous one. A process kill loses nothing (the page cache
 * survives it); a power cut loses at most the ACKs of the fsync in flight.
 *
 * COMPACTION RUNS OFF THE CALLER'S THREAD TOO. The snapshot body is captured
 * synchronously, then each fsync runs in the thread pool and each rename runs on
 * this thread once its precondition is durable. Records appended meanwhile go to
 * the old journal, which stays authoritative until the new one replaces it, and
 * are carried into the new journal behind its coverage header. Boot and
 * {@link RuntimeEventOutbox.close} finish a compaction synchronously.
 *
 * A TORN TRAILING RECORD IS EXPECTED, not corruption: a crash mid-append leaves
 * a partial final line. Recovery stops at the last complete record, because the
 * alternative — refusing to open — would strand every earlier event that IS
 * intact. A torn tail invalidates stored-only no-write witnesses: a later
 * typing fence might have been lost. Positive write/outcome evidence survives.
 */
export function createRuntimeEventOutbox(dir: string): RuntimeEventOutbox {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, FILE_NAME)
  const temporary = `${path}.tmp`
  const journalPath = join(dir, JOURNAL_NAME)
  const nextJournalPath = join(dir, NEXT_JOURNAL_NAME)
  // A next journal that never replaced the journal holds only copies of its records.
  rmSync(nextJournalPath, { force: true })
  let events = new Map<string, DurableRuntimeEvent>()
  const typing = new Map<string, TypingRecord>()
  let typingEpoch: string | undefined
  let snapshotBody: string | undefined
  // Queue receipts and outbound events share this journal. Record the receipt
  // synchronously even when a family's event stream is consumed asynchronously.
  const retainOutcome = (sessionId: SessionId, outcome: DeliveryOutcome): boolean => {
    const key = rowKey(sessionId, outcome.rowId)
    const prior = typing.get(key)
    const previous = prior?.outcome
    // A contradiction is reported, not a new final status. Accepted reports
    // may also arrive after a final outcome through an asynchronous consumer.
    if (
      previous &&
      (previous.outcome === 'dropped' ||
        (previous.outcome === 'failed' && previous.cause !== 'unconfirmed') ||
        (previous.outcome !== 'accepted' && outcome.outcome === 'accepted') ||
        (previous.outcome === 'delivered' && outcome.outcome !== 'delivered'))
    )
      return false
    if (previous?.outcome === 'delivered' && outcome.outcome === 'delivered') {
      const transcriptItem = outcome.transcriptItem ?? previous.transcriptItem
      const harnessRef = mergeHarnessRefs(previous.harnessRef, outcome.harnessRef)
      outcome = {
        ...outcome,
        ...(transcriptItem ? { transcriptItem } : {}),
        ...(harnessRef ? { harnessRef } : {}),
      }
    }
    if (JSON.stringify(previous) === JSON.stringify(outcome)) return false
    typing.set(key, { ...prior, sessionId, rowId: outcome.rowId, outcome })
    return true
  }
  const track = (event: DurableRuntimeEvent): void => {
    if (event.event.t !== 'delivery') return
    retainOutcome(event.sessionId, deliveryBody(event.event))
  }
  const retire = (deliveryId: string): void => {
    const event = events.get(deliveryId)
    events.delete(deliveryId)
    if (event?.event.t !== 'delivery') return
    const key = rowKey(event.sessionId, event.event.rowId)
    // An accepted hold is not settled. A final server ack retires its fence
    // even if an earlier accepted report is still awaiting acknowledgement.
    const saved = typing.get(key)?.outcome
    if (
      event.event.outcome !== 'accepted' &&
      (!saved || JSON.stringify(saved) === JSON.stringify(deliveryBody(event.event)))
    )
      typing.delete(key)
  }
  const loadSnapshot = (snapshot: ReturnType<typeof parseSnapshot>): void => {
    typingEpoch = snapshot.typingEpoch
    events = new Map(snapshot.events.map((event) => [event.deliveryId, event]))
    for (const entry of snapshot.typing) typing.set(rowKey(entry.sessionId, entry.rowId), entry)
    for (const event of snapshot.events) track(event)
  }

  if (existsSync(temporary)) {
    let recovered: ReturnType<typeof parseSnapshot> | undefined
    try {
      snapshotBody = readFileSync(temporary, 'utf8')
      recovered = parseSnapshot(snapshotBody, temporary)
    } catch (error) {
      if (!existsSync(path)) throw error
    }
    if (recovered) {
      loadSnapshot(recovered)
      renameSync(temporary, path)
      fsyncPath(dir)
    } else {
      snapshotBody = readFileSync(path, 'utf8')
      loadSnapshot(parseSnapshot(snapshotBody, path))
    }
  } else if (existsSync(path)) {
    snapshotBody = readFileSync(path, 'utf8')
    loadSnapshot(parseSnapshot(snapshotBody, path))
  }

  /**
   * Replay the journal over the snapshot. Records are applied in order, so an
   * add followed by an ack for the same delivery retires it exactly as it did
   * when both were whole-file writes.
   */
  let journalRecords = 0
  let validBytes = 0
  let tornTail = false
  let coverageTrusted = false
  if (existsSync(journalPath)) {
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    try {
      const header = JSON.parse(lines[0]!) as {
        op?: unknown
        epoch?: unknown
        snapshotHash?: unknown
      }
      // The epoch catches a lost component/interrupted compaction; the hash
      // also catches a reset snapshot that still carries its old epoch.
      coverageTrusted =
        snapshotBody !== undefined &&
        typingEpoch !== undefined &&
        header.op === 'coverage' &&
        header.epoch === typingEpoch &&
        header.snapshotHash === snapshotHash(snapshotBody)
    } catch {
      /* Legacy, empty or damaged journal: absence is not no-write proof. */
    }
    for (const [index, line] of lines.entries()) {
      if (index === lines.length - 1) {
        tornTail = line.length > 0
        break
      }
      if (!line) {
        validBytes += 1
        continue
      }
      let record: {
        op?: unknown
        deliveryId?: unknown
        event?: unknown
        sessionId?: unknown
        rowId?: unknown
      }
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
      if (record.op === 'coverage') {
        if (index !== 0) coverageTrusted = false
        journalRecords -= 1
        continue
      }
      if (record.op === 'ack' && typeof record.deliveryId === 'string') {
        retire(record.deliveryId)
        continue
      }
      if (record.op === 'typing') {
        const entry = parseTyping(record)
        const key = rowKey(entry.sessionId, entry.rowId)
        typing.set(key, { ...typing.get(key), ...entry })
        continue
      }
      if (record.op === 'stored') {
        if (coverageTrusted) {
          const entry = parseTyping(record)
          const key = rowKey(entry.sessionId, entry.rowId)
          typing.set(key, { ...typing.get(key), ...entry })
        }
        continue
      }
      if (record.op === 'outcome' && typeof record.sessionId === 'string') {
        retainOutcome(record.sessionId as SessionId, deliveryBody(record.event))
        continue
      }
      if (
        record.op === 'untyped' &&
        typeof record.sessionId === 'string' &&
        typeof record.rowId === 'string'
      ) {
        if (!coverageTrusted) continue
        const key = rowKey(record.sessionId as SessionId, record.rowId)
        const saved = typing.get(key)
        if (saved?.outcome || saved?.storedAt) {
          const { startedAt: _started, ...untyped } = saved
          typing.set(key, untyped)
        } else typing.delete(key)
        continue
      }
      if (record.op === 'add' && record.event) {
        const parsed = RuntimeEventMessage.parse(record.event)
        if (!parsed.deliveryId) continue
        events.set(parsed.deliveryId, { ...parsed, deliveryId: parsed.deliveryId })
        track({ ...parsed, deliveryId: parsed.deliveryId })
        continue
      }
      coverageTrusted = false
    }
  }
  // Never append a new typing fence behind a torn record: a subsequent reopen
  // would stop at that record and mistake the new attempt for never typed.
  if (tornTail) truncateSync(journalPath, validBytes)

  // Both files must prove a continuous covered lifetime. Missing/reset files,
  // interrupted compaction and torn records may have lost a later typing fence.
  // Keep positive write/outcome evidence; discard every negative write witness.
  if (!coverageTrusted || tornTail) {
    for (const [key, saved] of typing) {
      const { storedAt: _stored, ...uncertain } = saved
      if (uncertain.startedAt || uncertain.outcome) typing.set(key, uncertain)
      else typing.delete(key)
    }
  }

  /** The journal descriptor, held open so steady state never pays an open/close. */
  let journalFd: number | undefined = openSync(journalPath, 'a', 0o600)
  fsyncSync(journalFd)
  fsyncPath(dir)
  /** Bumped whenever {@link journalFd} stops naming the journal, so a late fsync result is ignored. */
  let journalGeneration = 0
  /** Records written to the journal descriptor, and how many of them a finished fsync covers. */
  let writtenRecords = 0
  let syncedRecords = 0
  let syncInFlight = false
  /** A journal rename whose directory entry is not durable yet; a durable append must not outrun it. */
  let directoryPending = false
  let compaction: Compaction | undefined
  /** After a failed background compaction, wait for this many journal records before the next try. */
  let compactRetryAt = 0
  /** Thread-pool operations not yet reported back; {@link settled} waits for them. */
  let inFlight = 0
  const idleWaiters: Array<() => void> = []
  const settle = (): void => {
    if (inFlight > 0 || compaction || syncedRecords < writtenRecords) return
    for (const resolve of idleWaiters.splice(0)) resolve()
  }
  const background = (
    start: (done: (error?: unknown) => void) => void,
    then: (error?: unknown) => void,
  ): void => {
    inFlight += 1
    start((error) => {
      inFlight -= 1
      then(error)
      settle()
    })
  }

  const renderSnapshot = (): string =>
    `${JSON.stringify({ version: FILE_VERSION, events: [...events.values()], typing: [...typing.values()], typingEpoch }, null, 2)}\n`

  /** Group commit: one fsync covers every record written before it was issued. */
  const scheduleSync = (): void => {
    if (syncInFlight || journalFd === undefined || syncedRecords >= writtenRecords) return
    const fd = journalFd
    const generation = journalGeneration
    const covers = writtenRecords
    syncInFlight = true
    background(
      (done) => fsync(fd, (error) => done(error ?? undefined)),
      (error) => {
        syncInFlight = false
        if (generation === journalGeneration) {
          // A failed fsync is not retried in a loop; the next record or close() retries it.
          if (error) {
            log.warn('runtime event outbox acknowledgement fsync failed', { err: error })
            return
          }
          syncedRecords = Math.max(syncedRecords, covers)
        }
        scheduleSync()
      },
    )
  }

  /**
   * Fold the journal into the snapshot and start a fresh one, as a chain of
   * steps that each wait for the previous step's data to be durable. Order:
   *   1. capture the snapshot body and write it to the temporary file;
   *   2. after its fsync, rename it over the snapshot;
   *   3. after the directory fsync, write the coverage header and the records
   *      appended since step 1 to the next journal;
   *   4. after its fsync, append the records that arrived during that fsync,
   *      rename the next journal over the journal and switch the descriptor.
   * Until step 4 the old journal holds every record, so a crash at any point
   * reopens a complete history; between steps 2 and 4 its coverage header no
   * longer matches the snapshot, which recovery treats as an uncovered lifetime.
   */
  const beginCompaction = (): Compaction & { snapshotFd: number } => {
    typingEpoch = randomUUID()
    const body = renderSnapshot()
    const fd = openSync(temporary, 'w', 0o600)
    const job = {
      carry: [],
      copied: 0,
      epoch: typingEpoch,
      hash: snapshotHash(body),
      snapshotFd: fd,
      ticket: 0,
    } satisfies Compaction
    compaction = job
    writeFileSync(fd, body)
    return job
  }

  /** Continue once `target` is durable: inline for a synchronous caller, from the thread pool otherwise. */
  const whenDurable = (
    job: Compaction,
    target: number | 'directory',
    sync: boolean,
    then: () => void,
  ): void => {
    job.ticket += 1
    if (sync) {
      if (target === 'directory') fsyncPath(dir)
      else fsyncSync(target)
      then()
      return
    }
    const ticket = job.ticket
    const start =
      target === 'directory'
        ? (done: (error?: unknown) => void) => {
            fsyncPathAsync(dir).then(() => done(), done)
          }
        : (done: (error?: unknown) => void) => fsync(target, (error) => done(error ?? undefined))
    background(start, (error) => {
      // Finished synchronously by close(), or abandoned, while this fsync ran.
      if (compaction !== job || job.ticket !== ticket) return
      if (error) return abandon(job, error)
      try {
        then()
      } catch (failure) {
        abandon(job, failure)
      }
    })
  }

  const renameSnapshot = (job: Compaction, fd: number, sync: boolean): void =>
    whenDurable(job, fd, sync, () => {
      closeSync(fd)
      job.snapshotFd = undefined
      renameSync(temporary, path)
      whenDurable(job, 'directory', sync, () => startNextJournal(job, sync))
    })

  const startNextJournal = (job: Compaction, sync: boolean): void => {
    const fd = openSync(nextJournalPath, 'w', 0o600)
    job.journalFd = fd
    const header = `${JSON.stringify({ op: 'coverage', epoch: job.epoch, snapshotHash: job.hash })}\n`
    writeFileSync(fd, header + job.carry.map((entry) => entry.record).join(''))
    job.copied = job.carry.length
    whenDurable(job, fd, sync, () => replaceJournal(job, fd, sync))
  }

  const replaceJournal = (job: Compaction, fd: number, sync: boolean): void => {
    const tail = job.carry.slice(job.copied)
    if (tail.length > 0) {
      appendFileSync(fd, tail.map((entry) => entry.record).join(''))
      // A promised record must stay durable across the switch; ACKs may ride the next group commit.
      if (tail.some((entry) => entry.durable)) fsyncSync(fd)
    }
    const unsyncedTail = tail.length > 0 && !tail.some((entry) => entry.durable)
    if (journalFd !== undefined) {
      closeSync(journalFd)
      // If the rename fails, the next append reopens the old journal by name.
      journalFd = undefined
      journalGeneration += 1
    }
    renameSync(nextJournalPath, journalPath)
    journalFd = fd
    journalGeneration += 1
    compactRetryAt = 0
    writtenRecords = job.carry.length
    syncedRecords = unsyncedTail ? job.copied : writtenRecords
    journalRecords = job.carry.length
    job.journalFd = undefined
    compaction = undefined
    directoryPending = true
    const generation = journalGeneration
    if (sync) {
      fsyncPath(dir)
      directoryPending = false
    } else {
      background(
        (done) => {
          fsyncPathAsync(dir).then(() => done(), done)
        },
        (error) => {
          if (error) log.warn('runtime event outbox directory fsync failed', { err: error })
          else if (generation === journalGeneration) directoryPending = false
        },
      )
    }
    scheduleSync()
  }

  /** Give up on a background compaction. The old journal is still authoritative. */
  const abandon = (job: Compaction, error: unknown): void => {
    log.warn('runtime event outbox compaction failed', { err: error })
    job.ticket += 1
    for (const fd of [job.snapshotFd, job.journalFd]) {
      if (fd === undefined) continue
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    if (job.journalFd !== undefined) rmSync(nextJournalPath, { force: true })
    job.snapshotFd = undefined
    job.journalFd = undefined
    if (compaction === job) compaction = undefined
    compactRetryAt = journalRecords + COMPACT_AFTER_RECORDS
  }

  /** Run a compaction to completion on this thread: boot, close(), or an explicit drain. */
  const finishCompaction = (job: Compaction): void => {
    const { snapshotFd, journalFd: nextFd } = job
    if (snapshotFd !== undefined) renameSnapshot(job, snapshotFd, true)
    else if (nextFd !== undefined)
      whenDurable(job, nextFd, true, () => replaceJournal(job, nextFd, true))
    else whenDurable(job, 'directory', true, () => startNextJournal(job, true))
  }

  const compact = (): void => finishCompaction(beginCompaction())

  /**
   * Append one record. A promised record is durable before this returns; an
   * ACK (`durable: false`) is durable after the next group commit.
   */
  const append = (record: string, durable = true): void => {
    if (journalFd === undefined) {
      journalFd = openSync(journalPath, 'a', 0o600)
      journalGeneration += 1
      writtenRecords = 0
      syncedRecords = 0
    }
    appendFileSync(journalFd, record)
    writtenRecords += 1
    journalRecords += 1
    compaction?.carry.push({ record, durable })
    if (!durable) {
      scheduleSync()
      return
    }
    fsyncSync(journalFd)
    syncedRecords = writtenRecords
    if (directoryPending) {
      fsyncPath(dir)
      directoryPending = false
    }
  }

  /**
   * Compact when the journal has outgrown the snapshot it sits on, and take the
   * free one whenever the backlog drains: an empty pending set makes the
   * snapshot write trivial, so a healthy daemon compacts constantly and cheaply
   * and a backlogged one is never asked to. Either way it runs in the background.
   */
  const maybeCompact = (): void => {
    if (compaction || journalRecords < compactRetryAt) return
    if (
      journalRecords >= COMPACT_AFTER_RECORDS ||
      (events.size === 0 && typing.size === 0 && journalRecords > 0)
    ) {
      try {
        const job = beginCompaction()
        renameSnapshot(job, job.snapshotFd, false)
      } catch (error) {
        // beginCompaction() registers the job before its first write can fail.
        if (compaction) abandon(compaction, error)
        else {
          log.warn('runtime event outbox compaction failed', { err: error })
          compactRetryAt = journalRecords + COMPACT_AFTER_RECORDS
        }
      }
    }
  }

  if (!coverageTrusted || tornTail) compact()

  return {
    deliveryJournal(sessionId) {
      return {
        read(rowId) {
          const key = rowKey(sessionId, rowId)
          const saved = typing.get(key)
          const event = saved?.outcome
          if (event?.t === 'delivery') {
            const { t, outcome, held, reason, cause, transcriptItem, harnessRef } = event
            return {
              typingStarted: true,
              outcome: {
                t,
                rowId,
                outcome,
                ...(held ? { held } : {}),
                ...(reason ? { reason } : {}),
                ...(cause ? { cause } : {}),
                ...(transcriptItem ? { transcriptItem } : {}),
                ...(harnessRef ? { harnessRef } : {}),
              },
            }
          }
          return saved ? { typingStarted: saved.startedAt !== undefined } : undefined
        },
        store(rowId) {
          const key = rowKey(sessionId, rowId)
          if (typing.has(key)) return
          const entry = { sessionId, rowId, storedAt: new Date().toISOString() }
          append(`${JSON.stringify({ op: 'stored', ...entry })}\n`)
          typing.set(key, entry)
          maybeCompact()
        },
        start(rowId) {
          const key = rowKey(sessionId, rowId)
          if (typing.get(key)?.startedAt) return
          const entry = { sessionId, rowId, startedAt: new Date().toISOString() }
          append(`${JSON.stringify({ op: 'typing', ...entry })}\n`)
          typing.set(key, { ...typing.get(key), ...entry })
          maybeCompact()
        },
        clear(rowId) {
          const key = rowKey(sessionId, rowId)
          if (!typing.get(key)?.startedAt) return
          append(`${JSON.stringify({ op: 'untyped', sessionId, rowId })}\n`)
          const saved = typing.get(key)!
          if (saved.outcome || saved.storedAt) {
            const { startedAt: _started, ...untyped } = saved
            typing.set(key, untyped)
          } else typing.delete(key)
          maybeCompact()
        },
        record(outcome) {
          const key = rowKey(sessionId, outcome.rowId)
          const previous = typing.get(key)
          if (!retainOutcome(sessionId, outcome)) return
          const next = typing.get(key)!
          // Do not let a failed fsync publish an in-memory receipt that was
          // never made durable. The queue must observe the persistence error.
          if (previous) typing.set(key, previous)
          else typing.delete(key)
          append(`${JSON.stringify({ op: 'outcome', sessionId, event: outcome })}\n`)
          typing.set(key, next)
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
      events.set(event.deliveryId, event)
      track(event)
      maybeCompact()
    },
    acknowledge(deliveryId) {
      if (!events.has(deliveryId)) return false
      append(`${JSON.stringify({ op: 'ack', deliveryId })}\n`, false)
      retire(deliveryId)
      maybeCompact()
      return true
    },
    get pendingCount() {
      return events.size
    },
    pending: () => [...events.values()],
    settled() {
      if (inFlight === 0 && !compaction && syncedRecords >= writtenRecords) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },
    close() {
      if (compaction) {
        const job = compaction
        try {
          finishCompaction(job)
        } catch (error) {
          abandon(job, error)
        }
      }
      if (journalFd === undefined) return
      if (syncedRecords < writtenRecords) fsyncSync(journalFd)
      closeSync(journalFd)
      journalFd = undefined
      journalGeneration += 1
      writtenRecords = 0
      syncedRecords = 0
      settle()
    },
  }
}
