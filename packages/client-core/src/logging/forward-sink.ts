import type { ForwardedLogRecord } from '@podium/commands'
import type { LogRecord, Sink } from '@podium/logger'

/**
 * THE FORWARDING SINK — the client half of `logs.forward`
 * [spec: docs/superpowers/specs/2026-08-11-logging-strategy-design.md,
 * "Client → server forwarding"].
 *
 * Records go to the user's OWN server, so there is no consent question on this
 * hop; the whole design problem is instead one of restraint. A sink that talks
 * to the network from inside `log.warn()` can break the app it is describing in
 * four ways, and each is closed here deliberately:
 *
 * - **It can throw at the call site.** `write` never does: it enqueues and
 *   returns, and every send lives in a promise chain whose rejections are
 *   handled here (the sink contract in `@podium/logger` says a sink OWNS its
 *   async errors, because `log.warn()` returned long before the POST failed).
 * - **It can grow without bound.** The queue is capped and drops OLDEST, which
 *   is the right end to drop from: when a client has been offline, the records
 *   describing the current failure matter more than the ones describing an
 *   incident that has already passed. The contract's `online-only` delivery
 *   class says the same thing from the server side.
 * - **It can hammer a server that is already down.** Failures back off
 *   exponentially with jitter, so a fleet of webviews that all lost the server
 *   at the same second do not return in lockstep.
 * - **It can log about logging.** Its own failures never touch the logger —
 *   that is a loop that feeds itself one record per failure per client — and
 *   are reported locally at most once per flush interval.
 *
 * One more failure mode is specific to this being the FIRST client of a
 * schema-validated ingestion endpoint: a single record the server refuses is a
 * batch the server refuses, forever, at the head of a FIFO queue. Two things
 * stop that becoming a wedge — oversized text is clamped on the way in
 * (see {@link toForwarded}) so a well-formed record cannot be refused for size,
 * and a batch that is refused `maxAttempts` times is dropped rather than
 * retried for the lifetime of the page.
 */

/** `MAX_TEXT` in packages/commands/src/logs/contracts.ts. */
const MAX_TEXT = 8192
/** `MAX_REPORTED_DROPS` in packages/commands/src/logs/contracts.ts — RESTATED
 *  rather than imported, for the reason the caps above are: this module is
 *  bundled into a browser and a phone, and a value import would drag the whole
 *  zod contract table in behind it. Restating is a drift risk, so it is CHECKED
 *  rather than trusted, by `forward-sink.test.ts`. */
export const REPORTED_DROPS_CAP = 1_000_000
const MAX_NS = 256
const MAX_NAME = 256
const MAX_STACK = MAX_TEXT * 4
const MAX_TS = 64

/** What a batch says about what did NOT make it into the batch. */
export interface ForwardMeta {
  /** Records this sink lost since the last batch the server accepted — overflow
   *  or an unsendable batch. Absent when there is nothing to report.
   *
   *  It travels WITH a batch rather than as its own call because the point of it
   *  is to mark a gap in the per-origin file at the place the gap is (POD-3167),
   *  and because a client that cannot reach the server must not answer that by
   *  making a second request. */
  dropped?: number
}

export interface ForwardingSinkOptions {
  /** Ship one batch. Rejecting is expected and handled; it must not throw at us
   *  in a way we do not catch, but a synchronous throw is handled too. */
  send(records: ForwardedLogRecord[], meta: ForwardMeta): Promise<void> | void
  /**
   * SHIP A BATCH THE DOCUMENT WILL NOT OUTLIVE (POD-3224 follow-up).
   *
   * The ordinary `send` is a promise, and a promise is worth nothing at
   * `pagehide`: the document is torn down, its fetches are cancelled, and the
   * five-second flush timer never fires. That lost precisely the records this
   * whole issue exists to deliver — on the two traced Reload clicks, the click,
   * the handshake outcome and the navigation itself were all written within
   * ~200 ms of a navigation that then cut them.
   *
   * So this one must HAND OFF rather than await: `fetch(..., {keepalive:true})`
   * or `navigator.sendBeacon`, both of which the browser promises to deliver
   * after the page is gone. It returns whether the browser ACCEPTED the payload,
   * not whether the server got it — nobody is left to find that out.
   *
   * Optional: a runtime with no unload (a test, the phone) supplies none, and
   * {@link ForwardingSink.flushOnUnload} then does nothing.
   */
  sendOnUnload?(records: ForwardedLogRecord[], meta: ForwardMeta): boolean
  /** Flush at most this often when the batch never fills up. Spec: 5 s. */
  flushIntervalMs?: number
  /** Flush as soon as this many records are queued. Spec: 50. */
  batchSize?: number
  /** Records held before drop-oldest begins. */
  maxQueue?: number
  /** First retry delay; doubles per consecutive failure up to `retryMaxMs`. */
  retryBaseMs?: number
  retryMaxMs?: number
  /** Attempts on ONE batch before it is dropped as unsendable. */
  maxAttempts?: number
  /** `[0, 1)`. Injectable so a test can pin the jitter it asserts on. */
  jitter?: () => number
  /** Where a degraded-forwarding notice goes. Never the logger. */
  onDegraded?: (message: string) => void
}

export interface ForwardingSink extends Sink {
  /** Records queued but not yet accepted by the server. */
  pending(): number
  /** Records dropped since boot — by overflow or by an unsendable batch. */
  dropped(): number
  flush(): Promise<void>
  /**
   * Hand the queue to the browser NOW, for a document that is about to go.
   *
   * Synchronous by contract — there is no later. Returns how many records were
   * handed off, which is what a test asserts on.
   */
  flushOnUnload(): number
  close(): Promise<void>
}

const DEFAULTS = {
  flushIntervalMs: 5000,
  batchSize: 50,
  maxQueue: 500,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
  maxAttempts: 5,
} as const

/**
 * How many bytes an unload hand-off may carry.
 *
 * `keepalive` fetch and `sendBeacon` are both capped at 64 KB by the browser,
 * and a payload over the cap is REFUSED WHOLE — which on this path means losing
 * everything rather than the excess. 48 KB leaves room for the tRPC envelope
 * and the origin around the records.
 */
const UNLOAD_BUDGET_BYTES = 48 * 1024

function clamp(value: string, max: number): { text: string; clamped: boolean } {
  if (value.length <= max) return { text: value, clamped: false }
  return { text: value.slice(0, max), clamped: true }
}

/**
 * A logger record as the ingestion contract wants it, clamped to the caps the
 * contract declares.
 *
 * The contract refuses an oversized batch rather than truncating it, on the
 * grounds that a truncated stack is a stack that lies about where it ends —
 * correct for the server, which cannot know what the client meant. The client
 * CAN know, so it clamps here and says so with `truncated: true`: an honest
 * marker on a record that arrived beats a whole batch refused at the head of a
 * FIFO queue, which is what an unclamped record would produce.
 *
 * The record is also proven JSON-encodable here, for the same reason. A
 * circular field would otherwise throw inside the transport, and the batch
 * carrying it would fail identically on every retry.
 */
export function toForwarded(record: LogRecord): ForwardedLogRecord {
  const msg = clamp(record.msg, MAX_TEXT)
  const ns = clamp(record.ns, MAX_NS)
  const ts = clamp(record.ts, MAX_TS)
  let clamped = msg.clamped || ns.clamped || ts.clamped
  const forwarded: ForwardedLogRecord = {
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
    forwarded.err = {
      name: name.text,
      message: message.text,
      ...(stack ? { stack: stack.text } : {}),
    }
  }
  if (clamped) forwarded.truncated = true
  try {
    JSON.stringify(forwarded)
    return forwarded
  } catch {
    // Free-form fields are the point of the record shape, so one that resists
    // encoding is dropped rather than the record that carries it.
    return {
      ts: forwarded.ts,
      level: forwarded.level,
      ns: forwarded.ns,
      msg: forwarded.msg,
      ...(forwarded.err ? { err: forwarded.err } : {}),
      fieldsDropped: 'record fields were not serializable',
    }
  }
}

export function createForwardingSink(options: ForwardingSinkOptions): ForwardingSink {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs
  const batchSize = options.batchSize ?? DEFAULTS.batchSize
  const maxQueue = options.maxQueue ?? DEFAULTS.maxQueue
  const retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs
  const retryMaxMs = options.retryMaxMs ?? DEFAULTS.retryMaxMs
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
  const jitter = options.jitter ?? Math.random
  const onDegraded = options.onDegraded ?? defaultDegradedNotice

  const queue: ForwardedLogRecord[] = []
  /** The batch currently being sent or awaiting retry — held OUT of the queue so
   *  its attempt count belongs to it and not to whatever is behind it. */
  let current: ForwardedLogRecord[] | null = null
  let attempts = 0
  let droppedCount = 0
  /** Drops not yet carried on a batch the server accepted. Reset only once such
   *  a batch has actually gone out, so a failed send does not lose the report —
   *  the same rule the daemon's forwarder follows at the other end of the same
   *  design. */
  let unreportedDrops = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let closed = false
  let lastNoticeAt = 0

  function arm(delayMs: number): void {
    if (timer !== null || closed) return
    timer = setTimeout(() => {
      timer = null
      void pump()
    }, delayMs)
  }

  function disarm(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function backoffMs(): number {
    const base = Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs)
    // 0.5x–1.5x. A fleet that lost the same server in the same second must not
    // come back in lockstep.
    return Math.round(base * (0.5 + jitter()))
  }

  function notice(message: string): void {
    const now = Date.now()
    if (now - lastNoticeAt < flushIntervalMs) return
    lastNoticeAt = now
    try {
      onDegraded(message)
    } catch {
      // Even the notice is best-effort; there is nowhere left to report to.
    }
  }

  function pump(): Promise<void> {
    if (inFlight) return inFlight
    const batch = current ?? queue.splice(0, batchSize)
    if (batch.length === 0) return Promise.resolve()
    current = batch
    // Clamped to the contract's ceiling: a report the server would refuse for
    // being too large is a batch refused at the head of a FIFO queue, which is
    // the one failure this sink is built to avoid.
    const reporting = Math.min(unreportedDrops, REPORTED_DROPS_CAP)
    const run = (async () => {
      try {
        await options.send(batch, reporting > 0 ? { dropped: reporting } : {})
        current = null
        attempts = 0
        unreportedDrops -= reporting
      } catch (err) {
        attempts += 1
        notice(
          `[podium] log forwarding degraded (attempt ${attempts}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        if (attempts >= maxAttempts) {
          // Unsendable — almost certainly refused rather than undeliverable.
          // Dropping it is what keeps the queue behind it moving.
          droppedCount += batch.length
          unreportedDrops += batch.length
          current = null
          attempts = 0
        }
      } finally {
        inFlight = null
      }
      if (current !== null) arm(backoffMs())
      else if (queue.length >= batchSize) void pump()
      else if (queue.length > 0) arm(flushIntervalMs)
    })()
    inFlight = run
    return run
  }

  return {
    name: 'forward',
    // No `minLevel`: the sink follows the namespace level, which is what makes
    // the spec's "default warn+, and raising the client to debug forwards debug
    // too" one knob rather than two that can disagree. Boot sets the default.
    write(record: LogRecord): void {
      if (closed) return
      queue.push(toForwarded(record))
      while (queue.length > maxQueue) {
        queue.shift()
        droppedCount += 1
        unreportedDrops += 1
      }
      // A retry is armed with a backoff this write must not preempt: arriving
      // records are not evidence the server came back.
      if (attempts > 0 || inFlight !== null) return
      if (queue.length >= batchSize) void pump()
      else arm(flushIntervalMs)
    },
    /**
     * THE DOCUMENT IS GOING. Hand over what matters, in one synchronous call.
     *
     * FROM THE TAIL, and that is the whole design. The queue is oldest-first and
     * the budget cannot hold all of it, but the records worth saving here are the
     * NEWEST ones: an unload flush exists because something happened in the last
     * few hundred milliseconds — a Reload click, its handshake outcome, the
     * navigation — and a head-first drain would spend the budget on records that
     * have already had five seconds of chances and lose exactly those.
     *
     * Whatever will not fit is COUNTED as dropped rather than silently left in a
     * queue that is about to cease to exist, so the gap is visible in the file.
     */
    flushOnUnload(): number {
      const beacon = options.sendOnUnload
      if (!beacon || closed) return 0
      // `current` is a batch already taken out of the queue for a send that has
      // not resolved. On unload it will never resolve, so it goes back — at the
      // front, where it belongs in emission order.
      const all = current === null ? queue : [...current, ...queue]
      if (all.length === 0) return 0

      let bytes = 0
      let firstKept = all.length
      for (let i = all.length - 1; i >= 0; i--) {
        const record = all[i]
        if (record === undefined) continue
        // Cheap and deliberately approximate: the exact envelope is the
        // transport's business, and being a little conservative costs one record.
        bytes += JSON.stringify(record).length + 2
        if (bytes > UNLOAD_BUDGET_BYTES) break
        firstKept = i
      }
      const batch = all.slice(firstKept)
      if (batch.length === 0) return 0
      const abandoned = all.length - batch.length
      const reporting = Math.min(unreportedDrops + abandoned, REPORTED_DROPS_CAP)

      let accepted = false
      try {
        accepted = beacon(batch, reporting > 0 ? { dropped: reporting } : {})
      } catch {
        // A refusing beacon is not a reason to throw out of `pagehide`.
        accepted = false
      }
      if (!accepted) return 0

      // Only now: a visibilitychange that does NOT end in a navigation leaves
      // this page alive, and a queue emptied on a hand-off the browser refused
      // would lose records for nothing.
      droppedCount += abandoned
      unreportedDrops = 0
      current = null
      queue.length = 0
      disarm()
      return batch.length
    },
    async flush(): Promise<void> {
      // Bounded rather than `while`: a send that keeps failing must not turn
      // an awaited flush (shutdown, crash-ship) into an unbounded loop.
      for (let i = 0; i <= maxAttempts && (current !== null || queue.length > 0); i++) {
        disarm()
        const failedBefore = attempts
        await pump()
        if (attempts > failedBefore) break
      }
    },
    async close(): Promise<void> {
      await this.flush()
      closed = true
      disarm()
    },
    pending(): number {
      return queue.length + (current?.length ?? 0)
    },
    dropped(): number {
      return droppedCount
    },
  }
}

/**
 * console, not the logger, and this is the one place in the client allowed to
 * say so: a forwarding failure reported THROUGH the logger is a record that
 * this sink then tries to forward.
 */
function defaultDegradedNotice(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Nowhere left to report to.
  }
}
