/**
 * THE QUEUED INGESTION WRITER — one bounded, sliced, per-key NDJSON writer,
 * shared by every path that accepts somebody else's log records (POD-3167).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS A THING, RATHER THAN TWICE
 * ---------------------------------------------------------------------------
 * There were two ingestion writers. The client one (`logs.forward`, reached over
 * `/trpc` from a browser, the desktop webview and the phone) wrote its batch
 * INLINE: up to 500 synchronous appends, plus the occasional rotation, inside
 * the request that carried them. The fleet one (POD-3156, reached from the
 * daemon socket's message callback) could not do that — a socket callback is the
 * event loop every request in the process shares — so it grew a queue, a slice
 * and a bound.
 *
 * The distinction the inline writer relied on does not survive contact with a
 * busy server. "It only costs the request that carried it" is true of the CPU
 * accounting and false of the latency: the write is synchronous, so a 500-record
 * batch blocks the loop for everybody, and the request that pays for it is
 * whichever one happened to arrive next. The right shape was the daemon's, and
 * the wrong outcome would have been to grow a second copy of it.
 *
 * So the MECHANISM lives here, once — slicing, drop-oldest backpressure,
 * rotation-safe lazy opening, close-time tail preservation, and the drop
 * accounting that keeps "the sender lost records" apart from "we lost records".
 * What stays with each caller is POLICY, stated out loud at its construction
 * site: which directory, how many files, how deep a queue, how records are
 * tagged, and who is allowed to send at all. Those genuinely differ, and the
 * split is the point — see `service.ts` and `fleet-store.ts` for both sets.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WRITES ARE SYNCHRONOUS WHEN THEY DO HAPPEN
 * ---------------------------------------------------------------------------
 * `Sink.write` may not reject and a buffered async sink loses precisely the
 * records worth having (see `@podium/logger/node`). Deferring changes WHEN the
 * cost is paid; slicing bounds HOW MUCH of it is paid in one turn. Neither
 * trades away durability. The quantity a waiting request actually cares about is
 * the longest uninterrupted block, and that is now a constant rather than a
 * function of how much somebody sent.
 *
 * NOTHING HERE THROWS. This is the logging layer: a full disk must not turn a
 * client's crash report or a daemon's diagnostic batch into a 500 or a dropped
 * socket. Failures degrade to one server-side line and a truthful count.
 */

import { join } from 'node:path'
import { createLogger, type LogRecord } from '@podium/logger'
import { createFileSink, type FileSink } from '@podium/logger/node'

const log = createLogger('server:logs')

/**
 * How many records a drain turn writes before yielding the event loop.
 *
 * THIS IS THE LATENCY KNOB, and it is the only one that matters. Sixteen ~1 KB
 * `writeSync` calls is tens of microseconds on a local disk. A rotation (five
 * renames plus an open) can land inside a slice and is the real worst case; it
 * is bounded, happens once per rotation budget, and is why the slice is small
 * rather than "one batch".
 */
export const WRITE_SLICE = 16

/** Where records from a key we have stopped opening files for go. */
export const OVERFLOW_NAME = 'other'

export interface QueuedWriterPolicy {
  /** Directory the `<name>.ndjson` files are created in. */
  dir: string
  /** Names this writer in its own degradation warnings (`client` / `fleet`). */
  kind: string
  /** How many distinct keys get their own file before the rest share one. */
  maxFiles: number
  /** Records held ACROSS ALL KEYS before drop-oldest begins. */
  maxPending: number
  /** Records written per event-loop turn. Defaults to {@link WRITE_SLICE}. */
  writeSlice?: number
  /** Injected by tests. Production uses the rotating file sink. */
  createSink?: (path: string) => FileSink
}

/** One record waiting to be written, with the key it belongs to and the file it
 *  was assigned. The KEY is carried alongside the name so a drop can be charged
 *  to whoever's record was dropped rather than to whoever's append noticed. */
interface PendingWrite {
  key: string
  name: string
  record: LogRecord
}

export class QueuedRecordWriter {
  private readonly dir: string
  private readonly kind: string
  private readonly maxFiles: number
  private readonly maxPending: number
  private readonly writeSlice: number
  private readonly makeSink: (path: string) => FileSink
  private readonly sinks = new Map<string, FileSink>()
  /**
   * Which FILE each key was assigned, decided at accept time.
   *
   * Separate from {@link sinks} because the two happen at different moments: a
   * sender has to be told which file its batch landed in while its request (or
   * socket callback) is still running, and the file itself is not opened until
   * the drain reaches it. Deriving the assignment from the open-sink count would
   * give a sender a different answer depending on how far the drain had got.
   */
  private readonly assigned = new Map<string, string>()
  /** Records THIS SERVER dropped under its own backpressure, per key, since
   *  boot. Kept apart from anything a SENDER reports about its own losses: a
   *  lossy link and a saturated server are different problems with different
   *  fixes, and one counter would say neither. */
  private readonly dropped = new Map<string, number>()
  private readonly pending: PendingWrite[] = []
  private scheduled: ReturnType<typeof setImmediate> | undefined
  private stopped = false

  constructor(policy: QueuedWriterPolicy) {
    this.dir = policy.dir
    this.kind = policy.kind
    this.maxFiles = policy.maxFiles
    this.maxPending = policy.maxPending
    this.writeSlice = policy.writeSlice ?? WRITE_SLICE
    this.makeSink =
      policy.createSink ??
      ((path) =>
        createFileSink({
          path,
          // ALL LEVELS. The sender already applied its own threshold before
          // forwarding, so a gate here would discard exactly the `debug` records
          // an operator raised a client or a daemon to get.
          minLevel: 'trace',
        }))
  }

  /** True once {@link close} has been called; a closed writer accepts nothing. */
  get closed(): boolean {
    return this.stopped
  }

  /**
   * Which file this key's records go in. Decided once, at first sight.
   *
   * Callers ask for this BEFORE enqueuing so they can report the destination
   * synchronously, and the answer never moves afterwards.
   */
  assign(key: string): string {
    const existing = this.assigned.get(key)
    if (existing !== undefined) return existing
    const name = this.assigned.size >= this.maxFiles ? OVERFLOW_NAME : key
    this.assigned.set(key, name)
    return name
  }

  /**
   * Queue one record for this key, dropping the OLDEST when the bound is met.
   *
   * Oldest, for the sending queues' reason at the other end of both pipes: when
   * a server has fallen behind, the records describing what is happening now
   * matter more than the ones describing what already passed.
   *
   * A dropped record's loss is charged to ITS OWN key, not to the key whose
   * append happened to overflow the queue — otherwise a chatty machine would
   * make a quiet one's file look complete while its records were the ones going
   * over the side.
   */
  enqueue(key: string, record: LogRecord): void {
    if (this.stopped) return
    this.pending.push({ key, name: this.assign(key), record })
    if (this.pending.length > this.maxPending) {
      const over = this.pending.length - this.maxPending
      for (const lost of this.pending.splice(0, over)) {
        this.dropped.set(lost.key, (this.dropped.get(lost.key) ?? 0) + 1)
      }
    }
    this.schedule()
  }

  /** Records waiting to be written. Zero once the drain has caught up. */
  pendingWrites(): number {
    return this.pending.length
  }

  /** Records THIS SERVER dropped under its own backpressure, for this key. */
  droppedFor(key: string): number {
    return this.dropped.get(key) ?? 0
  }

  /**
   * Write everything queued, then release the per-key file descriptors.
   *
   * THE FINAL DRAIN IS UNSLICED, deliberately. Slicing exists to keep a running
   * server's request latency flat; at shutdown there are no requests left to
   * protect and the alternative is losing the tail — which is the part of a log
   * that explains why the process is stopping. One bounded block (the queue is
   * bounded) is the right trade there and the wrong one anywhere else.
   */
  async close(): Promise<void> {
    this.stopped = true
    if (this.scheduled !== undefined) {
      clearImmediate(this.scheduled)
      this.scheduled = undefined
    }
    while (this.pending.length > 0) this.drainSlice()
    const open = [...this.sinks.values()]
    this.sinks.clear()
    await Promise.all(open.map((sink) => sink.close().catch(() => undefined)))
  }

  /** The rotating file for a name, opened on first WRITE — not on first batch.
   *  Lazy for rotation safety: the sink is created by the drain, on the turn it
   *  is first needed, rather than by whatever request arrived first. */
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
      log.warn('ingestion log sink unavailable', { kind: this.kind, file: name, err })
      return undefined
    }
  }

  private schedule(): void {
    if (this.scheduled !== undefined || this.stopped || this.pending.length === 0) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      this.drainSlice()
      this.schedule()
    })
    // A pending drain must not hold a shutting-down server open; `close()` does
    // the final flush, and it does it synchronously.
    this.scheduled.unref?.()
  }

  /** Write at most {@link writeSlice} records, then return to the event loop. */
  private drainSlice(): void {
    const slice = this.pending.splice(0, this.writeSlice)
    for (const { name, record } of slice) {
      // The sink owns its own failures and never throws (fail-open), so a
      // degraded sink still consumes its record: it went somewhere, and the sink
      // emitted its own one-time warning about where.
      this.sinkFor(name)?.write(record)
    }
  }
}
