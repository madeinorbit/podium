/**
 * THE ORDERED, PRESSURE-AWARE CLIENT SEND PUMP (POD-3931).
 *
 * Every application frame to one client socket goes through this one owner, in
 * the order it was offered. Protocol ping/pong bypasses it.
 *
 * WHAT BUN'S `send` ACTUALLY SAYS, measured on Bun 1.3.14 against a client that
 * stopped reading: results go positive (written), then `-1` once the kernel
 * buffer is full (accepted into Bun's own buffer), then `0` once that buffer
 * passes `backpressureLimit` — and a `0` frame is DROPPED, silently. `drain`
 * fires on every writable event that reduced Bun's buffer, not only when it is
 * empty. The previous sender ignored all three results and terminated the socket
 * the moment `bufferedAmount` passed 16 MB, so a healthy phone reading a 50 MB
 * bootstrap at its own pace was cut off mid-world and reconnected forever.
 *
 * THE PUMP HAS TWO WAITS AND THEY ARE MODELLED SEPARATELY:
 *
 *   - `paused`      — waiting for the SOCKET: set on `-1`, or when Bun's buffer
 *                     is already above the high-water mark. Cleared only by a
 *                     native `drain` that leaves the buffer under the mark.
 *                     Nothing is written while paused; a `-1` frame is never
 *                     resent.
 *   - `compressing` / `budgetWait` — waiting for PREPARATION: one native Zstd
 *                     job per socket, and the shared admission budget when it is
 *                     full. Preparation may continue while paused, up to the
 *                     prepare-ahead bounds, so the socket never idles waiting
 *                     for a compressor once it drains.
 *
 * A SEQUENCE IS PULLED, NOT PUSHED. `sendSequence` takes a source the pump asks
 * for the next message only when it has room to prepare it — at most
 * `prepareAheadCount` frames and `prepareAheadBytes` of prepared output ahead of
 * the socket. A 50 MB bootstrap therefore never exists as a 50 MB JavaScript
 * FIFO; what is retained is the snapshot the producer already holds, plus a
 * bounded window of serialized chunks. Frames offered with `send` after a
 * sequence wait behind it, which is what keeps bootstrap-before-delta.
 *
 * FAILURE IS EXPLICIT AND NAMED. `0` from `send`, a throwing `send`, a reliable
 * frame over the application queue limit, an input larger than the whole
 * shared budget, or no transfer progress for `noProgressTimeoutMs` while
 * reliable work is pending all terminate the socket with a
 * {@link SendFailureReason} and a diagnostic line carrying the counters — never
 * the payload. Lossy traffic is dropped within its own budget and never
 * terminates anything.
 */

import { createLogger } from '@podium/logger'
import { encodeDaemonMessage } from '@podium/protocol/daemon'
import type { PlaneSink } from './plane-liveness'
import { type SendSocket, shouldCompressWebSocketFrame } from './ws-send'

const log = createLogger('server:gateway')
type Message = Parameters<PlaneSink['send']>[0]

/** Shared queued-byte accounting for all client traffic, without compression jobs. */
export class OrderedSendBudget {
  bytes = 0
  private readonly listeners = new Set<() => void>()
  constructor(readonly maxBytes = 256 * 1024 * 1024) {}
  reserve(bytes: number): boolean {
    if (this.bytes + bytes > this.maxBytes) return false
    this.bytes += bytes
    return true
  }
  release(bytes: number): void {
    this.bytes -= bytes
    for (const listener of [...this.listeners]) listener()
  }
  onRelease(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
const sharedBudget = new OrderedSendBudget()

export type SendFailureReason =
  | 'send-not-accepted'
  | 'send-error'
  | 'socket-closed'
  | 'application-queue-limit'
  | 'shared-memory-limit'
  | 'no-progress-timeout'
  | 'serialization-failed'
  | 'frame-too-large'
  | 'binary-unsupported'

export type SendOutcome = { ok: true } | { ok: false; reason: SendFailureReason }

/** A lazy producer of ordered messages: asked for the next one only when the
 * pump has room to prepare it. `undefined` ends the sequence. */
export interface SendSequenceSource<M extends Message = Message> {
  next(): M | undefined
}

export interface OrderedSendTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Continue after the rest of this event-loop turn has had its go. */
  yield(fn: () => void): void
}

export interface OrderedSendOptions {
  /** Reliable frames offered with `send` may hold at most this much; over it is a
   * failure, not a wait, because the caller is synchronous. */
  maxQueuedBytes?: number
  maxQueuedFrames?: number
  /** How far a sequence is prepared ahead of the socket. */
  prepareAheadCount?: number
  prepareAheadBytes?: number
  /** Bytes serialized or written per event-loop turn before yielding. */
  turnBudgetBytes?: number
  /** No transfer progress for this long, with reliable work pending, terminates. */
  noProgressTimeoutMs?: number
  timers?: OrderedSendTimers
}

export interface OrderedSendStats {
  readonly label: string | undefined
  readonly paused: boolean
  /** Charge of everything admitted and not yet handed to the socket. */
  readonly queuedBytes: number
  readonly queuedFrames: number
  /** Prepared (encoded, compressed) output waiting for the socket. */
  readonly readyBytes: number
  readonly socketBufferedBytes: number
  readonly sharedBudgetBytes: number
  readonly sentFrames: number
  readonly sentBytes: number
  readonly pauses: number
  readonly peakSocketBufferedBytes: number
  readonly peakQueuedBytes: number
  readonly failure: SendFailureReason | undefined
}

const REAL_TIMERS: OrderedSendTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  yield: (fn) => setImmediate(fn),
}

function defaultNoProgressTimeoutMs(): number {
  const raw = process.env.PODIUM_WS_NO_PROGRESS_MS
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000
}

interface Frame {
  kind: 'frame'
  data: string | Uint8Array
  /** Reserved against the shared budget and the queue limit; JS-side cost. */
  charge: number
  compress: boolean
  lossy: boolean
  sequence?: Sequence
  /** Set when the frame leaves the pump: written, or dropped as lossy. */
  sent?: boolean
}

interface Sequence {
  kind: 'sequence'
  source: SendSequenceSource
  /** Frames pulled from it that the socket has not accepted yet. */
  outstanding: number
  exhausted: boolean
  settled: boolean
  settle: (outcome: SendOutcome) => void
}

type Item = Frame | Sequence

/** All application frames share this FIFO. Protocol ping/pong bypasses it.
 * Lossy sends return false for immediate rejection; true means admitted, and a
 * queued stream frame may still be dropped if the socket stops draining. */
export class OrderedClientSend implements PlaneSink {
  /** Admitted, in application order, not yet prepared. A sequence stays at the
   * head until its source is exhausted. */
  private readonly queue: Item[] = []
  /** Prepared, in application order, waiting for the socket. */
  private readonly ready: Frame[] = []
  private readonly sequences = new Set<Sequence>()
  private readonly opts: Required<Omit<OrderedSendOptions, 'timers'>> & {
    timers: OrderedSendTimers
  }
  private queuedBytes = 0
  private queuedFrames = 0
  private readyBytes = 0
  /** A sequence frame pulled but not yet admitted to the shared budget. */
  private stalled: Frame | undefined
  private budgetWait: (() => void) | undefined
  private drainOff: (() => void) | undefined
  private progressTimer: unknown
  private yieldScheduled = false
  private drainScheduled = false
  private turnBytes = 0
  private paused = false
  private pumping = false
  private rerun = false
  private stopped = false
  private failure: SendFailureReason | undefined
  private label: string | undefined
  private sentFrames = 0
  private sentBytes = 0
  private pauses = 0
  private peakSocketBufferedBytes = 0
  private peakQueuedBytes = 0

  constructor(
    private readonly ws: SendSocket,
    private readonly limits: { sendBufferLimitBytes: number; lossySendBufferLimitBytes: number },
    private readonly budget = sharedBudget,
    options: OrderedSendOptions = {},
  ) {
    this.opts = {
      maxQueuedBytes: options.maxQueuedBytes ?? 128 * 1024 * 1024,
      maxQueuedFrames: options.maxQueuedFrames ?? 8192,
      prepareAheadCount: options.prepareAheadCount ?? 2,
      prepareAheadBytes: options.prepareAheadBytes ?? 8 * 1024 * 1024,
      turnBudgetBytes: options.turnBudgetBytes ?? 4 * 1024 * 1024,
      noProgressTimeoutMs: options.noProgressTimeoutMs ?? defaultNoProgressTimeoutMs(),
      timers: options.timers ?? REAL_TIMERS,
    }
    this.drainOff = ws.onDrain?.(() => this.onDrain())
  }

  /** A safe identifier for diagnostics (the minted connection id). */
  describe(label: string): void {
    this.label = label
  }

  stats(): OrderedSendStats {
    return {
      label: this.label,
      paused: this.paused,
      queuedBytes: this.queuedBytes,
      queuedFrames: this.queuedFrames,
      readyBytes: this.readyBytes,
      socketBufferedBytes: this.stopped ? 0 : this.ws.bufferedAmount,
      sharedBudgetBytes: this.budget.bytes,
      sentFrames: this.sentFrames,
      sentBytes: this.sentBytes,
      pauses: this.pauses,
      peakSocketBufferedBytes: this.peakSocketBufferedBytes,
      peakQueuedBytes: this.peakQueuedBytes,
      failure: this.failure,
    }
  }

  send: PlaneSink['send'] = (msg) => {
    const frame = this.encode(msg, false)
    if (frame) this.enqueue(frame)
  }
  sendLossy: PlaneSink['sendLossy'] = (msg) => {
    if (!this.admitLossy()) return false
    const frame = this.encode(msg, true)
    return frame !== undefined && this.enqueue(frame)
  }
  sendBinary: PlaneSink['sendBinary'] = (bytes) => {
    this.binary(bytes, false)
  }
  sendBinaryLossy: PlaneSink['sendBinaryLossy'] = (bytes) => this.binary(bytes, true)

  /**
   * Send an ordered sequence lazily. Resolves once every message the source
   * produced has been accepted by the socket, or with the reason it could not be.
   * Never rejects: a closed socket is an outcome, not an exception.
   */
  sendSequence: NonNullable<PlaneSink['sendSequence']> = (source) => {
    if (this.stopped) {
      return Promise.resolve({ ok: false, reason: this.failure ?? 'socket-closed' })
    }
    return new Promise<SendOutcome>((resolve) => {
      const sequence: Sequence = {
        kind: 'sequence',
        source,
        outstanding: 0,
        exhausted: false,
        settled: false,
        settle: (outcome) => {
          if (sequence.settled) return
          sequence.settled = true
          this.sequences.delete(sequence)
          resolve(outcome)
        },
      }
      this.sequences.add(sequence)
      this.queue.push(sequence)
      this.pump()
    })
  }

  // ---- admission -----------------------------------------------------------

  private encode(msg: Message, lossy: boolean): Frame | undefined {
    try {
      const data = encodeDaemonMessage(msg)
      return {
        kind: 'frame',
        data,
        charge: Math.max(data.length * 2, Buffer.byteLength(data)),
        compress: shouldCompressWebSocketFrame(data, msg),
        lossy,
      }
    } catch {
      // Serialization failure cannot leave a hole in the feed.
      if (!lossy) this.fail('serialization-failed')
      return undefined
    }
  }

  private binary(bytes: Uint8Array, lossy: boolean): boolean {
    if (lossy && !this.admitLossy()) return false
    if (!this.ws.sendBinary) {
      if (!lossy) this.fail('binary-unsupported')
      return false
    }
    // A queued producer may reuse its buffer after this call returns.
    const queued = this.queue.length > 0 || this.ready.length > 0
    return this.enqueue({
      kind: 'frame',
      data: queued ? bytes.slice() : bytes,
      charge: bytes.byteLength,
      compress: shouldCompressWebSocketFrame(bytes),
      lossy,
    })
  }

  private admitLossy(): boolean {
    if (this.stopped || this.ws.readyState !== 1 || this.paused) return false
    return this.ws.bufferedAmount + this.queuedBytes <= this.limits.lossySendBufferLimitBytes
  }

  /** An immediate frame: reserved now, because its caller cannot wait. */
  private enqueue(frame: Frame): boolean {
    if (this.stopped) return false
    if (this.ws.readyState !== 1) {
      this.dispose()
      return false
    }
    const limit = frame.lossy ? this.limits.lossySendBufferLimitBytes : this.opts.maxQueuedBytes
    if (
      this.queuedBytes + frame.charge > limit ||
      this.queuedFrames >= this.opts.maxQueuedFrames
    ) {
      if (!frame.lossy) this.fail('application-queue-limit')
      return false
    }
    if (!this.budget.reserve(frame.charge)) {
      if (!frame.lossy) this.fail('shared-memory-limit')
      return false
    }
    this.charge(frame)
    this.queue.push(frame)
    this.pump()
    return !this.stopped && frame.sent !== false
  }

  private charge(frame: Frame): void {
    this.queuedBytes += frame.charge
    this.queuedFrames += 1
    if (this.queuedBytes > this.peakQueuedBytes) this.peakQueuedBytes = this.queuedBytes
  }

  private release(frame: Frame): void {
    this.queuedBytes -= frame.charge
    this.queuedFrames -= 1
    this.budget.release(frame.charge)
  }

  // ---- the pump ------------------------------------------------------------

  /** Reentrant-safe: a call while running schedules one more pass. */
  private pump(): void {
    if (this.pumping) {
      this.rerun = true
      return
    }
    this.pumping = true
    try {
      let moved = true
      while ((moved || this.rerun) && !this.stopped) {
        this.rerun = false
        const before = this.sentFrames + this.readyBytes + this.queue.length + this.ready.length
        this.prepare()
        this.write()
        const after = this.sentFrames + this.readyBytes + this.queue.length + this.ready.length
        moved = after !== before
      }
      if (!this.stopped) this.armProgressTimer()
    } finally {
      this.pumping = false
    }
  }

  private hasTurnBudget(): boolean {
    if (this.turnBytes < this.opts.turnBudgetBytes) return true
    if (!this.yieldScheduled) {
      this.yieldScheduled = true
      this.opts.timers.yield(() => {
        this.yieldScheduled = false
        this.turnBytes = 0
        if (!this.stopped) this.pump()
      })
    }
    return false
  }

  private canPrepare(): boolean {
    return (
      !this.stopped &&
      this.budgetWait === undefined &&
      this.ready.length < this.opts.prepareAheadCount &&
      this.readyBytes < this.opts.prepareAheadBytes
    )
  }

  /** Move frames from the queue into `ready`, pulling sequences lazily. */
  private prepare(): void {
    while (this.canPrepare() && this.hasTurnBudget()) {
      if (this.stalled) {
        if (!this.reserveSequenceFrame(this.stalled)) return
        const frame = this.stalled
        this.stalled = undefined
        this.stage(frame)
        continue
      }
      const head = this.queue[0]
      if (head === undefined) return
      if (head.kind === 'frame') {
        this.queue.shift()
        this.stage(head)
        continue
      }
      let msg: Message | undefined
      try {
        msg = head.source.next()
      } catch (error) {
        log.warn('a send sequence source failed', { label: this.label, error })
        this.fail('serialization-failed')
        return
      }
      if (msg === undefined) {
        head.exhausted = true
        this.queue.shift()
        if (head.outstanding === 0) head.settle({ ok: true })
        continue
      }
      const frame = this.encode(msg, false)
      if (frame === undefined) return
      frame.sequence = head
      head.outstanding += 1
      if (!this.reserveSequenceFrame(frame)) {
        this.stalled = frame
        return
      }
      this.stage(frame)
    }
  }

  /**
   * A sequence frame is bounded by the prepare-ahead window, not the queue
   * limit; what it must clear is the shared budget. A full budget is
   * saturation — wait for a release — unless the frame alone can never fit.
   */
  private reserveSequenceFrame(frame: Frame): boolean {
    if (frame.charge > this.budget.maxBytes) {
      this.fail('shared-memory-limit')
      return false
    }
    if (this.budget.reserve(frame.charge)) {
      this.charge(frame)
      this.turnBytes += frame.charge
      return true
    }
    if (this.budgetWait === undefined) {
      this.budgetWait = this.budget.onRelease(() => {
        this.budgetWait?.()
        this.budgetWait = undefined
        this.pump()
      })
    }
    return false
  }

  private stage(frame: Frame): void {
    this.ready.push(frame)
    this.readyBytes += frame.charge
  }

  /** Hand prepared frames to the socket until it pushes back. */
  private write(): void {
    while (!this.stopped && !this.paused && this.ready.length > 0 && this.hasTurnBudget()) {
      if (this.ws.readyState !== 1) {
        this.dispose()
        return
      }
      const frame = this.ready[0] as Frame
      const buffered = this.ws.bufferedAmount
      if (buffered > this.peakSocketBufferedBytes) this.peakSocketBufferedBytes = buffered
      if (frame.lossy && buffered > this.limits.lossySendBufferLimitBytes) {
        this.drop(frame, false)
        continue
      }
      if (buffered >= this.limits.sendBufferLimitBytes) {
        // Native backlog already at the mark: `drain` will fire as it flushes.
        this.pause()
        return
      }
      let result: number
      try {
        result =
          typeof frame.data === 'string'
            ? this.ws.send(frame.data, frame.compress)
            : (this.ws.sendBinary as NonNullable<SendSocket['sendBinary']>)(
                frame.data,
                frame.compress,
              )
      } catch (error) {
        if (frame.lossy) {
          this.drop(frame, false)
          continue
        }
        log.warn('client send threw', { label: this.label, error })
        this.fail('send-error')
        return
      }
      if (result === 0) {
        if (frame.lossy) {
          this.drop(frame, false)
          continue
        }
        this.fail('send-not-accepted')
        return
      }
      const bytes =
        typeof frame.data === 'string' ? Buffer.byteLength(frame.data) : frame.data.byteLength
      this.drop(frame, true)
      this.sentFrames += 1
      this.sentBytes += bytes
      this.turnBytes += bytes
      this.progress()
      if (result === -1) {
        // The honest peak: what Bun holds right after it said "buffered".
        const held = this.ws.bufferedAmount
        if (held > this.peakSocketBufferedBytes) this.peakSocketBufferedBytes = held
        this.pause()
      }
    }
  }

  /** The head of `ready` leaves the pump, sent or dropped. */
  private drop(frame: Frame, sent: boolean): void {
    frame.sent = sent
    this.ready.shift()
    this.readyBytes -= frame.charge
    this.release(frame)
    const sequence = frame.sequence
    if (sequence) {
      sequence.outstanding -= 1
      if (sequence.exhausted && sequence.outstanding === 0) sequence.settle({ ok: true })
    }
  }

  private pause(): void {
    if (this.paused) return
    this.paused = true
    this.pauses += 1
  }

  /**
   * NEVER WRITE FROM INSIDE THE NATIVE DRAIN CALLBACK. Bun calls `drain` from
   * its writable handler; a send made there that is itself buffered (`-1`)
   * was observed to stay in Bun's buffer with the kernel empty and no further
   * drain — a transfer wedged with one frame in hand. Resuming one macrotask
   * later means every send happens from a plain turn, where a partial write
   * registers writable interest the ordinary way. The drain still counts as
   * progress immediately.
   */
  private onDrain(): void {
    if (this.stopped) return
    this.progress()
    const buffered = this.ws.bufferedAmount
    if (buffered > this.peakSocketBufferedBytes) this.peakSocketBufferedBytes = buffered
    if (this.drainScheduled) return
    this.drainScheduled = true
    this.opts.timers.yield(() => {
      this.drainScheduled = false
      if (this.stopped) return
      if (this.paused && this.ws.bufferedAmount < this.limits.sendBufferLimitBytes) {
        this.paused = false
      }
      this.pump()
    })
  }

  // ---- progress ------------------------------------------------------------

  private reliablePending(): boolean {
    return (
      this.queue.length > 0 ||
      this.stalled !== undefined ||
      this.ready.some((frame) => !frame.lossy)
    )
  }

  private progress(): void {
    if (this.progressTimer === undefined) return
    this.opts.timers.clearTimeout(this.progressTimer)
    this.progressTimer = undefined
  }

  /** Only while reliable work waits on the socket or the shared budget. */
  private armProgressTimer(): void {
    const waiting = (this.paused || this.budgetWait !== undefined) && this.reliablePending()
    if (!waiting) {
      this.progress()
      return
    }
    if (this.progressTimer !== undefined) return
    this.progressTimer = this.opts.timers.setTimeout(() => {
      this.progressTimer = undefined
      if (this.stopped) return
      this.fail('no-progress-timeout')
    }, this.opts.noProgressTimeoutMs)
  }

  // ---- teardown ------------------------------------------------------------

  private fail(reason: SendFailureReason): void {
    if (this.stopped) return
    this.failure = reason
    log.warn('client send stream failed', { reason, ...this.stats() })
    this.dispose()
    try {
      this.ws.terminate()
    } catch {
      // Already gone; the close handler disposes again harmlessly.
    }
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.progress()
    this.drainOff?.()
    this.drainOff = undefined
    this.budgetWait?.()
    this.budgetWait = undefined
    for (const frame of this.ready.splice(0)) this.release(frame)
    this.readyBytes = 0
    if (this.stalled) {
      // Pulled but never reserved: nothing to give back.
      this.stalled = undefined
    }
    for (const item of this.queue.splice(0)) if (item.kind === 'frame') this.release(item)
    // Active input is accounted until the native job actually releases it.
    const reason = this.failure ?? 'socket-closed'
    for (const sequence of [...this.sequences]) sequence.settle({ ok: false, reason })
  }
}
