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
 * WARN+ FLOWS CONTINUOUSLY, AND THAT IS THE MAIN DECISION HERE (POD-3184)
 * ---------------------------------------------------------------------------
 * It did not. Nothing left a daemon until an operator raised it, on the grounds
 * that a remote daemon's records are a DIFFERENT HOST'S contents — repository
 * paths, worktree names, branch names — crossing a network.
 *
 * That reasoning was wrong for this hop. The machine those records cross to is
 * the user's OWN server; Podium never sees them. Whether anything at all should
 * leave a user's machines is the telemetry decision, and it is made elsewhere.
 * What was left here was a default that made a broken machine SILENT unless
 * somebody already knew to ask it a question — which is the one situation where
 * nobody knows to ask.
 *
 * So the daemon now matches the client family (`@podium/client-core/logging`):
 * `warn`+ ships continuously, low volume by construction, one hop, on by
 * default. Below `warn` still costs nothing on the wire.
 *
 * THE EXCEPTION IS A DAEMON CO-RESIDENT WITH ITS SERVER. Those records are
 * already on that machine's disk, written by the same process's own file sink,
 * and forwarding them files a second copy of them under `logs/fleet/`. So the
 * steady stream is OFF there and the caller says which case it is in
 * ({@link DaemonLogForwardOptions.coResident}). A RAISE still forwards on such a
 * daemon — that is today's behaviour, it is what makes a raise capture the whole
 * all-in-one process, and it stays correct because a raise is bounded.
 *
 * ---------------------------------------------------------------------------
 * AN ERROR SHIPS THE MINUTE THAT EXPLAINS IT
 * ---------------------------------------------------------------------------
 * The flight recorder below already runs at `trace` on every daemon, all the
 * time, costing memory and nothing else. Before POD-3184 a forwarded `error`
 * said THAT something broke and the minute saying WHY was discarded when the
 * ring rolled over. That was the largest thing being thrown away.
 *
 * So an `error` forwarded in the steady state carries the recorder's unsent tail
 * ahead of it — the same trade the client's crash path makes, where the buffer
 * rather than the message is the reason a crash report is worth having. The tail
 * is bounded ({@link DEFAULT_ERROR_CONTEXT}) and never sent twice: the module
 * remembers the last recorded record it shipped, so a burst of errors ships one
 * window and not one window each.
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
 * server it forwards to? It forwards NOTHING in the steady state and everything
 * under a raise, which is the {@link DaemonLogForwardOptions.coResident}
 * exception above. Under a raise the sinks are registered in the shared logger,
 * so the window captures the whole process — server records included — and files
 * it under that machine, keeping `logs/fleet/<machine>.ndjson` mean the same
 * thing on every machine in a fleet. It is a duplicate of records already on
 * that host's own disk, which is why it is bounded by the raise rather than
 * running continuously. The server-side store does NOT stamp `role: daemon` over
 * those records for exactly this reason.
 */

import {
  addSink,
  createLogger,
  createRingBufferSink,
  type LogLevel,
  type LogRecord,
  meetsThreshold,
  moreVerbose,
  namespaceFloor,
  type RingBufferSink,
  type Sink,
  setLogLevel,
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

/**
 * WHAT SHIPS WITHOUT ANYBODY ASKING. The client family's default, deliberately
 * the same word (`installClientLogging`'s `warn`): an operator holding one
 * threshold in their head for a phone and a daemon is the point of the parallel.
 *
 * Low volume BY CONSTRUCTION rather than by hope — a healthy daemon emits `warn`
 * rarely, and that is what makes this affordable across a fleet. A raise lifts
 * this floor entirely; see `forwardSink.write`.
 */
export const STEADY_FORWARD_LEVEL: LogLevel = 'warn'

/**
 * THE STEADY FLOOR IS PER-NAMESPACE, NOT ONE NUMBER (POD-3224).
 *
 * `warn` is the right default for a daemon's own chatter and the wrong one for
 * the handful of namespaces whose whole purpose is to be read later — the update
 * path above all. A grant that downloaded, verified, swapped and restarted
 * writes five `info` lines on the machine doing the work, and before this every
 * one of them stayed on that machine: the operator asking "what did ludovico
 * actually do?" was answered by silence unless they had already raised the
 * daemon before the update they wanted to understand.
 *
 * So the floor a composition root declares with `setNamespaceFloor` lifts the
 * steady stream too. That keeps the declaration in ONE place — the namespace is
 * either worth more than the default or it is not, and a second table here could
 * only disagree with the first.
 *
 * It stays bounded by construction, because the floor is `info` and the update
 * path's per-tick records are `debug`: what ships is the lifecycle, not the
 * progress.
 */
function steadyLevelFor(ns: string): LogLevel {
  const floor = namespaceFloor(ns)
  return floor === null ? STEADY_FORWARD_LEVEL : moreVerbose(STEADY_FORWARD_LEVEL, floor)
}

/**
 * The most recorder records one error drags along with it.
 *
 * The ring holds 500. Shipping all of them behind every error would put ten
 * frames on the wire for one failure, and the records furthest back are the
 * least likely to explain it. 100 is a few seconds of real traffic at `trace` —
 * two frames — which is the span that actually names a cause.
 */
export const DEFAULT_ERROR_CONTEXT = 100

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
  /** Whether records are being shipped at all — the steady `warn`+ stream, a
   *  raise, or both. False only on a co-resident daemon outside a raise. */
  forwarding: boolean
  /** Whether a raise is in force. Apart from {@link forwarding} because they
   *  stopped being the same fact in POD-3184: a daemon can be shipping `warn`+
   *  with nothing raised, and an operator asking "did my raise land?" must not
   *  be answered by the default. */
  raised: boolean
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
  /**
   * Does this daemon share a machine with the server it forwards to?
   *
   * `true` turns the steady `warn`+ stream OFF, and nothing else: a raise still
   * forwards. The records are already on that machine's disk, written by this
   * same process's file sink, so the steady stream would be a second copy of
   * them. Only the caller knows — the daemon composition root reads it off the
   * local link (`apps/daemon/src/daemon-options.ts`), which is the same fact its
   * boot record reports as `topology: 'local-link'`.
   *
   * Defaults to `false`, so a caller that has not thought about it gets the
   * remote posture: forwarding on. That is the safe direction — the cost of
   * being wrong is a duplicate on one machine's disk, not a silent daemon.
   */
  coResident?: boolean
  flushIntervalMs?: number
  batchSize?: number
  maxQueue?: number
  ringCapacity?: number
  /** Recorder records shipped ahead of a forwarded `error`. See
   *  {@link DEFAULT_ERROR_CONTEXT}. Zero disables the context window. */
  errorContext?: number
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
  /**
   * The steady `warn`+ stream — on everywhere except a daemon co-resident with
   * its server. A CONSTANT for the life of the installation: it is a property of
   * where this daemon runs, and nothing at runtime changes where that is.
   */
  const steady = options.coResident !== true
  const errorContext = options.errorContext ?? DEFAULT_ERROR_CONTEXT
  /** Whether a raise is open. Was the whole of `forwarding`; since POD-3184 it
   *  is only the half an operator turned on. */
  let raised = false
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

  /** Is anything leaving this daemon right now? The steady stream, a raise, or
   *  both — one predicate, so no path can consult half the answer. */
  const forwarding = (): boolean => !disposed && (steady || raised)

  const drop = (count: number): void => {
    dropped += count
    unreportedDrops += count
  }

  /**
   * Records the recorder holds that have NOT already been put on the wire.
   *
   * IDENTITY, not timestamps or an index: the ring hands out the same objects
   * the forwarding sink was given, so "already sent" is a fact about the object
   * rather than a cursor two paths could disagree about. It is what makes the
   * error window and the raise seed compose — an error that ships its context
   * and a raise a second later do not send the same minute twice, and neither
   * re-sends a `warn` that already went out under the steady stream.
   */
  const shipped = new WeakSet<LogRecord>()

  const unsent = (limit: number, exclude?: LogRecord): LogRecord[] => {
    if (limit <= 0) return []
    const tail = ring.snapshot().filter((record) => record !== exclude && !shipped.has(record))
    return tail.length > limit ? tail.slice(tail.length - limit) : tail
  }

  const enqueue = (record: LogRecord): void => {
    shipped.add(record)
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
    if (!forwarding() || sending || queue.length === 0) return
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
    // NO `minLevel`, so the sink SEES everything the logger emits and decides
    // here. That is what makes the raise ONE knob: under a raise the journal and
    // the forwarded stream move together on `setLogLevel` alone and cannot
    // disagree about what this daemon is reporting. The steady floor below is
    // not a second knob — it is what a daemon reports when nobody has touched
    // the one knob at all.
    write(record: LogRecord): void {
      if (!forwarding() || sending) {
        // A record emitted by the send path itself is COUNTED, never queued —
        // see the header. One that is simply not being forwarded is not a loss
        // and must not inflate the drop count that reports one.
        if (sending && forwarding()) drop(1)
        return
      }
      if (!raised && !meetsThreshold(record.level, steadyLevelFor(record.ns))) return
      // AN ERROR CARRIES THE MINUTE THAT EXPLAINS IT. Only outside a raise: a
      // raise is already shipping that minute record by record, and prepending
      // it again would duplicate the stream against itself. `exclude` is this
      // record, which the recorder has already taken — it is enqueued below, in
      // its own place, so the file reads in emission order.
      if (!raised && record.level === 'error' && errorContext > 0) {
        for (const past of unsent(errorContext, record)) enqueue(past)
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
    // BEFORE `raised` is cleared, and at `warn` so it survives any default this
    // ships with: this line is the explanation for why the detail in the central
    // file stops, and it has to be IN that file rather than only in the journal.
    log.warn('daemon log level restored', { from, to: options.boot, reason })
    flushNow()
    raised = false
    if (steady) {
      // The stream does not stop here — only the detail does. Whatever is still
      // queued describes the window the operator just closed and is still worth
      // delivering, so it stays and drains on the normal timer.
      if (queue.length > 0) arm()
      return
    }
    disarm()
    // A CO-RESIDENT DAEMON GOES SILENT AGAIN, and the tail that never made it
    // out is not carried into the next raise: it describes a window the operator
    // already closed, and holding it would make the next raise open with stale
    // records under a fresh timestamp.
    if (queue.length > 0) drop(queue.length)
    queue.length = 0
  }

  /** Push whatever is queued at the transport, one batch per attempt, until it
   *  refuses or runs out. Bounded by the queue, which is bounded. */
  const flushNow = (): void => {
    if (!forwarding()) return
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
      const wasRaised = raised
      level = command.level
      expiresAt = now() + ttlMs
      // THE ONE CALL. Journal and forwarded stream move together, because this
      // is the only threshold either of them consults once a raise is open.
      setLogLevel(command.level)
      // Seed with the flight recorder BEFORE the raise notice, so the central
      // file reads in emission order: the minute that led to the raise, then the
      // raise. Only on the transition — a re-raise inside an open window would
      // otherwise re-send a buffer the server already has — and only the part of
      // it that has not already gone out under the steady stream or behind an
      // error, which is why the whole ring is not simply replayed.
      raised = true
      if (!wasRaised) {
        for (const record of unsent(Number.POSITIVE_INFINITY)) enqueue(record)
      }
      // `to`, not `level`: the record shape OWNS `level` and DROPS a caller
      // field of that name, so this would otherwise report a raise without
      // saying what it raised to.
      log.warn('daemon log level raised', { to: command.level, ttlMs, seeded: !wasRaised })
      expiryTimer = setTimeout(() => toBoot('expired'), ttlMs)
      expiryTimer.unref?.()
      pump()
    },
    status: () => ({
      level,
      boot: options.boot,
      expiresAt,
      forwarding: forwarding(),
      raised,
      pending: queue.length,
      dropped,
    }),
    flush: flushNow,
    dispose() {
      if (disposed) return
      disposed = true
      clearExpiry()
      disarm()
      raised = false
      queue.length = 0
      disposeForward()
      disposeRing()
    },
  }
}
