/**
 * FLEET DAEMON LOG CAPTURE, DAEMON SIDE — the raise, the flight recorder, and
 * the bounded sink that ships a daemon's own records to the coordinating server
 * (POD-3156, under [spec:2026-08-11-logging-strategy-design]).
 *
 * ---------------------------------------------------------------------------
 * A DELIBERATE PARALLEL OF `@podium/client-core/logging`, NOT A REUSE
 * ---------------------------------------------------------------------------
 * The client family solves the same-shaped problem and this file borrows its
 * vocabulary on purpose, so an operator and a reviewer meet one design twice
 * rather than two designs once. It is not the same code, and the reasons are
 * structural rather than packaging:
 *
 *  - `client-core` is a layer-3 browser-safe package; `@podium/runtime` is what
 *    the daemon may import. The dependency cannot point that way.
 *  - The client sink RETRIES a failed HTTP POST with exponential backoff. This
 *    one has no request to retry: there is a socket, and it is either connected
 *    or it is not. So it GATES on connectivity and drains on reconnect, which is
 *    a different state machine wearing the same bounded-queue hat.
 *  - It ships on the socket it is describing. A client posting to `/trpc` cannot
 *    make its own transport log; a daemon can, and the guards for that
 *    (the `sending` re-entrancy gate) has no counterpart on the client side.
 *
 * ---------------------------------------------------------------------------
 * FORWARDING IS OFF UNTIL AN OPERATOR ASKS, AND THAT IS THE MAIN DECISION HERE
 * ---------------------------------------------------------------------------
 * A browser forwards `warn`+ continuously because its records are the user's
 * own, on the user's own server, one hop away. A remote daemon's records are a
 * DIFFERENT HOST'S contents crossing a network to a machine that is not it:
 * repository paths, worktree names, branch names, the shape of somebody's disk.
 * The default posture for that is closed.
 *
 * So nothing leaves a daemon until {@link DaemonLogForwarding.raise} enables it,
 * it lasts a bounded window, and it turns itself off. The daemon's own journal
 * or rotating file (`@podium/runtime/logging`) is unaffected throughout — this
 * adds a central COPY of a raised window, and removes nothing.
 *
 * ---------------------------------------------------------------------------
 * THE RAISE SHIPS THE PAST, WHICH IS THE HALF THAT IS USUALLY MISSING
 * ---------------------------------------------------------------------------
 * An operator raises a daemon BECAUSE something already went wrong, and a knob
 * that only captures the future asks them to reproduce it first. So a ring
 * buffer runs at all times in bounded memory (nothing leaves the host; it is the
 * same flight recorder the client keeps for crashes), and a raise seeds the send
 * queue with its contents before the first new record. What lands centrally is
 * therefore the minute BEFORE the raise as well as the window after it.
 *
 * AND IT IS THAT MINUTE AT `trace`, not at the boot level. The recorder pins
 * `trace` and the logger's emission gate is the most verbose registered sink, so
 * `debug` and `trace` records exist in memory on a daemon running at `info` —
 * costing memory and nothing else until somebody asks. That is what lets a raise
 * answer a question about the PAST at all: raising the level only changes what
 * happens next, and next is usually too late.
 *
 * ---------------------------------------------------------------------------
 * IT MUST NOT FEED ITSELF
 * ---------------------------------------------------------------------------
 * Sending a batch is socket traffic, and socket traffic logs. So a record
 * emitted DURING a send is COUNTED AS DROPPED rather than queued: a transport
 * that logs on every attempt would otherwise manufacture the backlog that
 * guarantees the next attempt, forever, at one record per flush.
 *
 * The guard is deliberately RE-ENTRANCY and not a namespace filter. This
 * module's own two records — the raise and its expiry — must reach the central
 * file: they are the explanation for why the stream starts and why it stops, and
 * a reader without them is left telling "this daemon had nothing to say" from
 * "this daemon was never turned up" by guessing. Both are emitted outside a
 * send, so the guard lets them through and still closes the loop.
 *
 * The guard hides nothing either: a record it refuses increments the drop
 * counter, and the counter rides the next batch.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS A READER USUALLY ASKS NEXT
 * ---------------------------------------------------------------------------
 * HOW BIG CAN ONE FRAME GET? One batch is `batchSize` records (50) of at most
 * ~8 KB each after clamping, so ~400 KB worst case against a 64 MB socket cap.
 * A daemon draining a backlog sends one batch per tick rather than the whole
 * queue, which is what keeps that bound true after a reconnect.
 *
 * WHAT ABOUT AN ALL-IN-ONE INSTALL, where the daemon shares a process with the
 * server it forwards to? It works and is left working: the sinks are registered
 * in the shared logger, so a raise there captures the whole process — server
 * records included — and files a copy of the raised window under that machine.
 * That is a duplicate of records already on that host's own disk, bounded by the
 * raise and by rotation, and it keeps `logs/fleet/<machine>.ndjson` meaning the
 * same thing on every machine in a fleet. The server-side store does NOT stamp
 * `role: daemon` over those records for exactly this reason.
 */

import {
  addSink,
  createLogger,
  createRingBufferSink,
  type LogLevel,
  type LogRecord,
  removeSink,
  type RingBufferSink,
  setLogLevel,
  type Sink,
} from '@podium/logger'

/**
 * The caps the wire schema declares (`packages/protocol/src/messages/fleet-logs.ts`).
 *
 * RESTATED RATHER THAN IMPORTED, and clamped on this side rather than trusted:
 * an oversized record is a record the server's `DaemonMessage.parse` REFUSES,
 * and it refuses the whole frame carrying it. On a FIFO queue that is a wedge —
 * the same batch fails identically every time it is retried, and everything
 * behind it waits forever. The client sink clamps for exactly this reason
 * (`toForwarded` in client-core); this is that decision, made again here because
 * the daemon's records are the ones with 40 KB git output in them.
 */
const MAX_TEXT = 8192
const MAX_NS = 256
const MAX_NAME = 256
const MAX_STACK = MAX_TEXT * 4
const MAX_TS = 64

/**
 * A record as the wire carries it: the logger's shape, clamped, and proven
 * JSON-encodable. Structurally the protocol's `DaemonLogRecord` — restated so
 * this module stays free of the wire schemas, and pinned against them by
 * `log-forward.test.ts`.
 */
export interface DaemonLogWireRecord {
  ts: string
  level: LogLevel
  ns: string
  msg: string
  err?: { name: string; message: string; stack?: string }
  [field: string]: unknown
}

const clamp = (value: string, max: number): { text: string; clamped: boolean } =>
  value.length <= max ? { text: value, clamped: false } : { text: value.slice(0, max), clamped: true }

/**
 * PURE: one logger record, clamped to the wire's caps and marked when anything
 * was cut.
 *
 * `truncated` is not decoration. A stack that was shortened is a stack that lies
 * about where it ends, and a reader who cannot tell a clamp from a short stack
 * will chase the wrong frame. The alternative — refusing the record — loses the
 * one that was interesting enough to be long.
 */
export function toWireRecord(record: LogRecord): DaemonLogWireRecord {
  const msg = clamp(record.msg, MAX_TEXT)
  const ns = clamp(record.ns, MAX_NS)
  const ts = clamp(record.ts, MAX_TS)
  let clamped = msg.clamped || ns.clamped || ts.clamped
  const wire: DaemonLogWireRecord = {
    ...record,
    ts: ts.text,
    level: record.level,
    ns: ns.text,
    msg: msg.text,
  }
  if (record.err) {
    const name = clamp(record.err.name, MAX_NAME)
    const message = clamp(record.err.message, MAX_TEXT)
    const stack = record.err.stack ? clamp(record.err.stack, MAX_STACK) : undefined
    clamped = clamped || name.clamped || message.clamped || (stack?.clamped ?? false)
    wire.err = {
      name: name.text,
      message: message.text,
      ...(stack ? { stack: stack.text } : {}),
    }
  }
  if (clamped) wire.truncated = true
  try {
    JSON.stringify(wire)
    return wire
  } catch {
    // Free-form fields are the point of the record shape, so one that resists
    // encoding is dropped rather than the record that carries it.
    return {
      ts: wire.ts,
      level: wire.level,
      ns: wire.ns,
      msg: wire.msg,
      ...(wire.err ? { err: wire.err } : {}),
      fieldsDropped: 'record fields were not serializable',
    }
  }
}

/** This module's own logger. Its records ARE forwarded — see the header on why
 *  the loop is closed by re-entrancy rather than by filtering them out. */
const log = createLogger('daemon:log-forward')

/**
 * Applied when a raise names no duration. Deliberately the client's
 * `DEFAULT_LEVEL_TTL_MS`: an operator raising a phone and a daemon in the same
 * investigation should not have to hold two defaults in their head.
 */
export const DEFAULT_DAEMON_LEVEL_TTL_MS = 30 * 60 * 1000

/** The wire caps this too (`MAX_LOG_LEVEL_TTL_MS`). Clamping again here is what
 *  makes the bound a property of the DAEMON rather than of the last schema that
 *  validated the frame — including on a daemon newer than the server. */
export const MAX_DAEMON_LEVEL_TTL_MS = 24 * 60 * 60 * 1000

/** Flush at most this often when the batch never fills up. The client's 5 s. */
const DEFAULT_FLUSH_INTERVAL_MS = 5000
/** Flush as soon as this many records are queued. The client's 50. */
const DEFAULT_BATCH_SIZE = 50
/** Records held before drop-oldest begins. Bigger than the client's 500 because
 *  a raise seeds the queue with a whole ring buffer and then keeps logging. */
const DEFAULT_MAX_QUEUE = 1000
/** The flight recorder's depth — a minute or so of real traffic, in memory. */
const DEFAULT_RING_CAPACITY = 500

/** What the server asks for. Structurally `SetDaemonLogLevelMessage` minus its
 *  `type`, restated so this module imports no wire schema. */
export interface DaemonLogLevelCommand {
  /** `null` restores the boot default AND stops forwarding. */
  level: LogLevel | null
  ttlMs?: number
}

/** What this daemon is doing right now, for the reply an operator reads. */
export interface DaemonLogForwardStatus {
  /** The level in force. */
  level: LogLevel
  /** What this daemon booted at, and what a reset returns it to. */
  boot: LogLevel
  /** Epoch ms at which the raise lifts, or `null` when nothing is raised. */
  expiresAt: number | null
  /** Whether records are being shipped at all. */
  forwarding: boolean
  /** Queued but not yet handed to the socket. */
  pending: number
  /** Records lost since boot — to the bounded queue, or to a send in progress. */
  dropped: number
}

/** One batch, as the caller puts it on the wire. */
export interface DaemonLogBatch {
  records: DaemonLogWireRecord[]
  /** Records lost since the last batch that reported some; omitted when none. */
  dropped?: number
}

export interface DaemonLogForwardOptions {
  /**
   * Hand one batch to the transport. Returns whether it actually went out.
   *
   * A BOOLEAN rather than a promise, because the daemon's `send` is a socket
   * write that drops silently when the link is down (`connection-state.ts`), and
   * a promise that resolved either way would make "sent" unobservable. `false`
   * puts the batch BACK at the head of the queue — see {@link flush}.
   */
  send(batch: DaemonLogBatch): boolean
  /** The level this daemon booted at — what a reset returns to. */
  boot: LogLevel
  flushIntervalMs?: number
  batchSize?: number
  maxQueue?: number
  ringCapacity?: number
  now?: () => number
}

export interface DaemonLogForwarding {
  /** Apply a server-pushed level command. */
  raise(command: DaemonLogLevelCommand): void
  status(): DaemonLogForwardStatus
  /** Try to hand everything queued to the transport. Called on reconnect. */
  flush(): void
  /** Unregister the sinks, cancel the timers, and stop forwarding. */
  dispose(): void
}

/**
 * Install the flight recorder and the (initially inert) forwarding sink.
 *
 * Called once at daemon boot, BEFORE the server connection exists — the ring
 * buffer's whole value is that it was already running when the thing an operator
 * later asks about happened.
 */
export function installDaemonLogForwarding(
  options: DaemonLogForwardOptions,
): DaemonLogForwarding {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
  const now = options.now ?? (() => Date.now())

  const ring: RingBufferSink = createRingBufferSink({
    capacity: options.ringCapacity ?? DEFAULT_RING_CAPACITY,
  })

  const queue: DaemonLogWireRecord[] = []
  let forwarding = false
  let dropped = 0
  /** Drops not yet reported on a batch. Reset only once a batch carrying the
   *  count actually goes out, so a failed send does not lose the report. */
  let unreportedDrops = 0
  let sending = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let expiresAt: number | null = null
  let level: LogLevel = options.boot
  let disposed = false

  const disarm = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const arm = (): void => {
    if (timer !== undefined || disposed) return
    timer = setTimeout(() => {
      timer = undefined
      pump()
    }, flushIntervalMs)
    timer.unref?.()
  }

  const drop = (count: number): void => {
    dropped += count
    unreportedDrops += count
  }

  const enqueue = (record: LogRecord): void => {
    queue.push(toWireRecord(record))
    if (queue.length > maxQueue) {
      // OLDEST, for the client sink's reason: when a link has been down, the
      // records describing what is happening now matter more than the ones
      // describing an incident that has already passed.
      drop(queue.length - maxQueue)
      queue.splice(0, queue.length - maxQueue)
    }
  }

  /**
   * Hand at most one batch to the transport.
   *
   * ONE batch per call, not a drain loop: a daemon that fell behind must not
   * turn a single timer tick into an unbounded run of socket writes competing
   * with the PTY traffic on the same connection. A queue still over the batch
   * size re-arms immediately, so it drains at one frame per tick.
   */
  const pump = (): void => {
    if (!forwarding || sending || queue.length === 0) return
    const batch = queue.slice(0, batchSize)
    const reporting = unreportedDrops
    sending = true
    let sent = false
    try {
      sent = options.send({ records: batch, ...(reporting > 0 ? { dropped: reporting } : {}) })
    } catch {
      // The transport owns its own failures; a throw here is a link that is
      // going away, and the batch stays queued for the reconnect that follows.
      sent = false
    } finally {
      sending = false
    }
    if (sent) {
      queue.splice(0, batch.length)
      unreportedDrops -= reporting
    }
    if (queue.length > 0) arm()
  }

  const forwardSink: Sink = {
    name: 'daemon-forward',
    // NO `minLevel`, so the sink follows the namespace's configured level. That
    // is what makes the raise ONE knob: the journal and the forwarded stream
    // move together and cannot disagree about what this daemon is reporting.
    write(record: LogRecord): void {
      if (!forwarding || disposed) return
      if (sending) {
        // Emitted by the send path itself. Counted, never queued — see header.
        drop(1)
        return
      }
      enqueue(record)
      if (queue.length >= batchSize) pump()
      else arm()
    },
  }

  const disposeRing = addSink(ring)
  const disposeForward = addSink(forwardSink)

  const clearExpiry = (): void => {
    if (expiryTimer === undefined) return
    clearTimeout(expiryTimer)
    expiryTimer = undefined
  }

  const toBoot = (reason: 'reset' | 'expired'): void => {
    clearExpiry()
    expiresAt = null
    const from = level
    level = options.boot
    setLogLevel(options.boot)
    // BEFORE forwarding is switched off, and at `warn` so it survives any
    // default this ships with: this line is the explanation for why the central
    // file stops, and it has to be IN that file rather than only in the journal.
    log.warn('daemon log level restored', { from, to: options.boot, reason })
    flushNow()
    forwarding = false
    disarm()
    // The tail that never made it out is not carried into the next raise: it
    // describes a window the operator already closed, and holding it would make
    // the next raise open with stale records under a fresh timestamp.
    if (queue.length > 0) drop(queue.length)
    queue.length = 0
  }

  /** Push whatever is queued at the transport, one batch per attempt, until it
   *  refuses or runs out. Bounded by the queue, which is bounded. */
  const flushNow = (): void => {
    if (!forwarding) return
    let guard = Math.ceil(maxQueue / batchSize) + 1
    while (queue.length > 0 && guard > 0) {
      const before = queue.length
      pump()
      if (queue.length === before) return
      guard -= 1
    }
  }

  return {
    raise(command) {
      if (disposed) return
      if (command.level === null) {
        toBoot('reset')
        return
      }
      const ttlMs = Math.min(command.ttlMs ?? DEFAULT_DAEMON_LEVEL_TTL_MS, MAX_DAEMON_LEVEL_TTL_MS)
      clearExpiry()
      const wasForwarding = forwarding
      level = command.level
      expiresAt = now() + ttlMs
      // THE ONE CALL. Journal and forwarded stream move together, because this
      // is the only threshold either of them consults.
      setLogLevel(command.level)
      // Seed with the flight recorder BEFORE the raise notice, so the central
      // file reads in emission order: the minute that led to the raise, then the
      // raise. Only on the transition — a re-raise inside an open window would
      // otherwise re-send a buffer the server already has.
      if (!wasForwarding) {
        forwarding = true
        for (const record of ring.snapshot()) enqueue(record)
      }
      // `to`, not `level`: the record shape OWNS `level` and DROPS a caller
      // field of that name, so this would otherwise report a raise without
      // saying what it raised to.
      log.warn('daemon log level raised', { to: command.level, ttlMs, seeded: !wasForwarding })
      expiryTimer = setTimeout(() => toBoot('expired'), ttlMs)
      expiryTimer.unref?.()
      pump()
    },
    status: () => ({
      level,
      boot: options.boot,
      expiresAt,
      forwarding,
      pending: queue.length,
      dropped,
    }),
    flush: flushNow,
    dispose() {
      if (disposed) return
      disposed = true
      clearExpiry()
      disarm()
      forwarding = false
      queue.length = 0
      disposeForward()
      disposeRing()
    },
  }
}
