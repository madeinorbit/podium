/**
 * FLEET DAEMON LOG INGESTION — where a remote daemon's raised records land
 * (POD-3156, chunk of [spec:2026-08-11-logging-strategy-design]).
 *
 * ---------------------------------------------------------------------------
 * A SEPARATE STORE FROM `logs/clients`, AND HERE IS WHY
 * ---------------------------------------------------------------------------
 * The obvious move is to reuse {@link LogIngestService}: same file sink, same
 * rotation, same per-origin split, one fewer directory. It was rejected for
 * three reasons, in ascending order of how much they matter.
 *
 *  1. THE BUDGET IS SHARED AND WOULD BE SPENT BY THE WRONG SPENDER. That
 *     service opens at most `MAX_ORIGIN_FILES` (64) files and folds everything
 *     after that into `other.ndjson`. A fleet of machines and a household of
 *     browsers would compete for one allowance, and the loser — silently — is
 *     whichever arrived second. Two stores means a machine can never evict a
 *     browser origin, and the daemon budget can be tuned for a fleet without
 *     changing what a phone gets.
 *
 *  2. THE VOLUME PROFILE IS NOT THE SAME. A browser tab logs while somebody is
 *     looking at it. A daemon logs for weeks. Sharing a rotation policy means
 *     one of the two is wrong, and the disk budget below is the knob that says
 *     which — separately, and out loud.
 *
 *  3. THE ATTRIBUTION IS NOT THE SAME, and this is the reason that decides it.
 *     A client's `origin` is a SELF-DESCRIPTION off the wire; the server files
 *     `web-<whatever the client said>` because a `/client` socket offers nothing
 *     better. A daemon's machine comes from the AUTHENTICATED TRANSPORT and
 *     cannot be spoofed by a payload. Those are two different evidentiary
 *     grades, and a reader who found both under one directory would have no way
 *     to tell which one they were holding. Keeping them apart makes the
 *     directory name carry the claim: `logs/clients/…` is what something said
 *     about itself, `logs/fleet/…` is which machine the server authenticated.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SHARED ANYWAY
 * ---------------------------------------------------------------------------
 * The MECHANISM — `createFileSink`, its 10 MB × 5 rotation, its fail-open
 * degrade path. That is the part worth having once, and it already is once, in
 * `@podium/logger/node`. What is duplicated here is a map of sinks and a
 * filename rule, which is a dozen lines and is the part that had to differ.
 *
 * NOTHING HERE THROWS. Same rule as the client ingestion service: this is the
 * logging layer, and a full disk must not turn a daemon's diagnostic batch into
 * a dropped socket. Failures degrade to one server-side line and a truthful
 * count in the result.
 *
 * ---------------------------------------------------------------------------
 * THE WRITES ARE DEFERRED AND SLICED, WHICH THE CLIENT STORE'S ARE NOT
 * ---------------------------------------------------------------------------
 * `LogIngestService.forward` writes its batch inline, and gets away with it: it
 * is reached over `/trpc`, so its cost lands on the request that carried it and
 * on nobody else's.
 *
 * This one is reached from the DAEMON SOCKET'S MESSAGE CALLBACK, which is the
 * same event loop that serves every request in the process. A batch written
 * there puts its whole cost — up to 50 synchronous appends plus, occasionally, a
 * rotation — in front of whatever arrives next. So `append` only TAGS and
 * QUEUES, and the writes happen in bounded slices between event-loop turns.
 *
 * The writes are still SYNCHRONOUS when they happen, because `Sink.write` may
 * not reject and a buffered async sink loses the records worth having (see
 * `@podium/logger/node`). Deferring changes WHEN the cost is paid and slicing
 * bounds HOW MUCH of it is paid at once; neither trades away durability. The
 * quantity a waiting request actually cares about is the longest uninterrupted
 * block, and that is now a constant instead of a function of fleet size.
 *
 * The queue that makes this possible is bounded, so it can drop — and a drop
 * HERE is a different fact from a drop at the daemon, so it is counted
 * separately and reported separately.
 */

import { join } from 'node:path'
import { createLogger, type LogRecord } from '@podium/logger'
import { createFileSink, type FileSink } from '@podium/logger/node'
import type { MachineId } from '@podium/model'
import type { DaemonLogBatchMessage } from '@podium/protocol/daemon'
import { logDir } from '@podium/runtime/run-registry'

const log = createLogger('server:logs')

/**
 * How many machines get their own file before the rest share one.
 *
 * SAY THE WORST CASE OUT LOUD, as the client store does: at the inherited
 * 10 MB × 5 rotation, 32 machines is 32 × 50 MB ≈ 1.6 GB before anything is
 * discarded. That is the ceiling of a 32-machine fleet all raised at once and
 * all chatty, not a steady state — forwarding is OFF until an operator raises a
 * machine, and a raise expires. A normal install spends nothing here at all.
 */
export const MAX_FLEET_FILES = 32

/** Where records from a machine we have stopped opening files for go. */
const OVERFLOW_MACHINE = 'other'

export interface FleetLogStoreDeps {
  /** Defaults to `<stateDir>/logs/fleet`. */
  dir?: string
  /** Injected by tests. Production uses the rotating file sink. */
  createSink?: (path: string) => FileSink
  maxMachineFiles?: number
}

/** One record as the wire delivered it — the schema's own inferred shape, so a
 *  change to `DaemonLogRecord` reaches this file as a type error. */
export type DaemonLogRecordWire = DaemonLogBatchMessage['records'][number]

export interface FleetIngestResult {
  /** Records ACCEPTED for writing. Not "written": the writes are deferred off
   *  the socket callback, so this is a queue admission and the only way to be
   *  short of the batch is a store that is already closed. */
  accepted: number
  /** The file they were filed under, so an operator can be told where to look. */
  file: string
  /** Drops the daemon reported in this batch — see {@link FleetLogStore.append}. */
  dropped: number
}

/**
 * `mach_abc123` → `mach_abc123`; anything exotic → underscores.
 *
 * A MachineId is minted, not typed, so this is belt and braces rather than the
 * load-bearing check the client store's `originKey` is — but it is the same
 * shape of problem (a filename built from an id) and gets the same allowlist,
 * because "it cannot contain a slash today" is a property of a generator that
 * could change and not of this code.
 */
export function machineFileKey(machineId: string): string {
  const safe = machineId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
  return safe.length > 0 ? safe : 'unknown'
}

/**
 * One forwarded record, re-tagged with what the SERVER knows.
 *
 * `machineId` IS OVERWRITTEN, always. It is the field these records are FILED
 * by, and the server's answer is the authenticated one — so a record that
 * arrived claiming another machine is corrected on the way to disk rather than
 * filed under a lie.
 *
 * `role` IS NOT, and the difference is deliberate. It is descriptive rather than
 * load-bearing (nothing routes, files or authorizes on it), and the record
 * already carries the truthful one from its own process context — which on an
 * all-in-one install is `all-in-one`, not `daemon`, because there the daemon
 * shares a process with the server and the forwarded stream legitimately
 * includes both. Stamping `daemon` over that would make the one field that says
 * WHICH PROGRAM wrote a line report the same answer for two of them. `daemon` is
 * the fallback for a record that carries no role at all.
 *
 * `v` is taken from the BATCH when it carried one — a daemon can self-update
 * under a live socket, and the batch is the finest grain at which that is
 * knowable.
 */
export function taggedDaemonRecord(
  record: DaemonLogRecordWire,
  machineId: MachineId,
  version?: string,
): LogRecord {
  return {
    ...record,
    role: typeof record.role === 'string' && record.role.length > 0 ? record.role : 'daemon',
    machineId,
    ...(version !== undefined ? { v: version } : {}),
  } as LogRecord
}

/**
 * How many records the drain writes before yielding the event loop.
 *
 * THIS IS THE LATENCY KNOB, and it is the only one that matters. The file sink
 * writes synchronously and deliberately (see `@podium/logger/node`: a buffered
 * async sink loses precisely the records worth having, and `Sink.write` may not
 * reject), so ingesting a batch costs the event loop a fixed amount of CPU
 * whenever it happens. What a request waiting behind it cares about is not that
 * total — it is the LONGEST UNINTERRUPTED BLOCK. Slicing the drain bounds that
 * to a constant regardless of how much a saturated fleet has queued.
 *
 * Sixteen ~1 KB `writeSync` calls is tens of microseconds on a local disk. A
 * rotation (five renames plus an open) can land inside a slice and is the real
 * worst case; it is bounded, happens once per 10 MB, and is why the slice is
 * small rather than "one batch".
 */
const WRITE_SLICE = 16

/**
 * Records held across all machines before drop-oldest begins.
 *
 * Ten batches at the wire's cap. A server can be slow at disk or busy at
 * everything, and the answer to either has to be a bound rather than a heap that
 * grows until something else fails — the same reasoning as the daemon's own
 * queue, at the other end of the same pipe.
 */
const MAX_PENDING_RECORDS = 5000

/** One record waiting to be written, with the file it was assigned to. */
interface PendingWrite {
  name: string
  record: LogRecord
}

export class FleetLogStore {
  private readonly dir: string
  private readonly makeSink: (path: string) => FileSink
  private readonly maxMachineFiles: number
  private readonly sinks = new Map<string, FileSink>()
  /**
   * Which FILE each machine key was assigned, decided at append time.
   *
   * Separate from {@link sinks} because the two happen at different moments now:
   * a batch has to be told which file it landed in while the socket callback is
   * still running, and the file itself is not opened until the drain reaches it.
   * Deriving the assignment from the open-sink count would give a machine a
   * different answer depending on how far the drain had got.
   */
  private readonly assigned = new Map<string, string>()
  /** Drops the DAEMON reported, per machine, since boot. */
  private readonly daemonDropped = new Map<string, number>()
  /** Drops THIS SERVER made under its own backpressure, per machine, since boot.
   *  Kept apart from the daemon's: a lossy link and a saturated server are
   *  different problems with different fixes, and one counter would say neither. */
  private readonly serverDropped = new Map<string, number>()
  private readonly pending: PendingWrite[] = []
  private scheduled: ReturnType<typeof setImmediate> | undefined
  private closed = false

  constructor(deps: FleetLogStoreDeps = {}) {
    this.dir = deps.dir ?? join(logDir(), 'fleet')
    this.maxMachineFiles = deps.maxMachineFiles ?? MAX_FLEET_FILES
    this.makeSink =
      deps.createSink ??
      ((path) =>
        createFileSink({
          path,
          // ALL LEVELS, for the client store's reason: the daemon already
          // applied the operator's threshold before forwarding, so a gate here
          // would discard exactly the `debug` records the raise was for.
          minLevel: 'trace',
        }))
  }

  /** Which file this machine's records go in. Decided once, at first sight. */
  private nameFor(key: string): string {
    const existing = this.assigned.get(key)
    if (existing !== undefined) return existing
    const name = this.assigned.size >= this.maxMachineFiles ? OVERFLOW_MACHINE : key
    this.assigned.set(key, name)
    return name
  }

  /** The rotating file for a name, opened on first WRITE — not on first batch. */
  private sinkFor(name: string): FileSink | undefined {
    const existing = this.sinks.get(name)
    if (existing) return existing
    try {
      const sink = this.makeSink(join(this.dir, `${name}.ndjson`))
      this.sinks.set(name, sink)
      return sink
    } catch (err) {
      // A sink that cannot even be constructed (unwritable log dir) is reported
      // once; there is nothing to retry here, and the records assigned to it are
      // discarded by the drain rather than held forever.
      log.warn('fleet log sink unavailable', { machine: name, err })
      return undefined
    }
  }

  /**
   * Enqueue one record, dropping the OLDEST when the bound is met.
   *
   * Oldest, for the daemon queue's reason at the other end of the pipe: when a
   * server has fallen behind, the records describing what is happening now
   * matter more than the ones describing what already passed.
   */
  private enqueue(name: string, record: LogRecord, key: string): void {
    this.pending.push({ name, record })
    if (this.pending.length <= MAX_PENDING_RECORDS) return
    const over = this.pending.length - MAX_PENDING_RECORDS
    this.pending.splice(0, over)
    this.serverDropped.set(key, (this.serverDropped.get(key) ?? 0) + over)
  }

  private schedule(): void {
    if (this.scheduled !== undefined || this.closed || this.pending.length === 0) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      this.drainSlice()
      this.schedule()
    })
    // A pending drain must not hold a shutting-down server open; `close()` does
    // the final flush, and it does it synchronously.
    this.scheduled.unref?.()
  }

  /** Write at most {@link WRITE_SLICE} records, then return to the event loop. */
  private drainSlice(): void {
    const slice = this.pending.splice(0, WRITE_SLICE)
    for (const { name, record } of slice) {
      // The sink owns its own failures and never throws (fail-open), so a
      // degraded sink still consumes its record: it went somewhere, and the sink
      // emitted its own one-time warning about where.
      this.sinkFor(name)?.write(record)
    }
  }

  /**
   * Accept one authenticated daemon's batch.
   *
   * NOTHING IS WRITTEN HERE, and that is the point. This runs in the daemon
   * socket's message callback, on the same event loop that is serving every
   * request in the process; a batch that wrote its 50 records inline would put
   * the whole of that work — rotation included — in front of whatever request
   * arrived next. The records are tagged and queued, and the writes happen in
   * bounded slices between event-loop turns.
   *
   * THE DAEMON'S DROP COUNT IS WRITTEN INTO THE FILE, not just counted in
   * memory. A gap in a log is ambiguous — a quiet daemon and an overflowing
   * queue look identical — and the whole point of the daemon reporting its own
   * drops is to end that ambiguity for the person reading the file, who is not
   * holding this process's counters.
   */
  append(
    machineId: MachineId,
    batch: { records: readonly DaemonLogRecordWire[]; dropped?: number; v?: string },
  ): FleetIngestResult {
    const key = machineFileKey(machineId)
    const name = this.nameFor(key)
    const file = `logs/fleet/${name}.ndjson`
    const dropped = batch.dropped ?? 0
    if (dropped > 0) this.daemonDropped.set(key, (this.daemonDropped.get(key) ?? 0) + dropped)
    if (this.closed) return { accepted: 0, file, dropped }
    if (dropped > 0) {
      this.enqueue(
        name,
        taggedDaemonRecord(
          {
            ts: new Date().toISOString(),
            level: 'warn',
            ns: 'server:logs',
            msg: 'daemon dropped records before this batch',
            dropped,
          },
          machineId,
          batch.v,
        ),
        key,
      )
    }
    let accepted = 0
    for (const record of batch.records) {
      this.enqueue(name, taggedDaemonRecord(record, machineId, batch.v), key)
      accepted += 1
    }
    this.schedule()
    return { accepted, file, dropped }
  }

  /** Records waiting to be written. Zero once the drain has caught up. */
  pendingWrites(): number {
    return this.pending.length
  }

  /** Drops the DAEMON reported for this machine since the server booted. */
  droppedFor(machineId: MachineId): number {
    return this.daemonDropped.get(machineFileKey(machineId)) ?? 0
  }

  /** Drops THIS SERVER made under its own backpressure, for this machine. */
  serverDroppedFor(machineId: MachineId): number {
    return this.serverDropped.get(machineFileKey(machineId)) ?? 0
  }

  /**
   * Write everything queued, then release the per-machine file descriptors.
   *
   * THE FINAL DRAIN IS UNSLICED, deliberately. Slicing exists to keep a running
   * server's request latency flat; at shutdown there are no requests left to
   * protect and the alternative is losing the tail — which is the part of a log
   * that explains why the process is stopping. One bounded block (the queue is
   * bounded) is the right trade there and the wrong one anywhere else.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.scheduled !== undefined) {
      clearImmediate(this.scheduled)
      this.scheduled = undefined
    }
    while (this.pending.length > 0) this.drainSlice()
    const open = [...this.sinks.values()]
    this.sinks.clear()
    await Promise.all(open.map((sink) => sink.close().catch(() => undefined)))
  }
}
