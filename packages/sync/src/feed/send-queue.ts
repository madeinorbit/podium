/**
 * THE BOUNDED OUTBOUND QUEUE, and the `resync-required` demotion (ADR 2 D9).
 *
 * RE-HOMED ONTO POD-306 BY POD-305, and built here. Same reason as feed identity:
 * until this exists, `resync-required` is a frame only a fixture can produce, so
 * the conformance gate `adr/slow-consumer-demoted-converges` certifies that the
 * Replica tolerates a frame nothing in the system emits.
 *
 * ---------------------------------------------------------------------------
 * THE THREE OPTIONS, AND WHY ONLY THE THIRD IS ON THE LIST
 * ---------------------------------------------------------------------------
 *
 * D9 enumerates them: buffer forever (one slow phone on a train OOMs the server
 * for everyone), drop frames silently (permanent divergence — "the worst
 * outcome"), or deliberately invalidate the cursor. Only the third is both safe
 * and bounded.
 *
 * "Just skip a frame" is not a fourth option and the reason is worth keeping in
 * front of whoever next edits this file. A dropped frame is not a lost update; it
 * is a permanent LIE, because the replica's next cursor advance certifies a range
 * containing data it never received. Order is the correctness property, and the
 * covered-range certificate (Amendment 1 D13) makes a skipped frame
 * unrecoverable rather than merely stale — the replica has no way left to notice.
 *
 * So overflow here does exactly one thing: it discards the queue AND the
 * connection's right to receive deltas, and says so. Demotion is cheap precisely
 * because re-bootstrap is the most-travelled path in the protocol (every cold
 * start, every quota clear, every epoch bump), which is D9's own argument for why
 * this is a shrug rather than an emergency.
 *
 * ---------------------------------------------------------------------------
 * BYTES, NOT FRAMES
 * ---------------------------------------------------------------------------
 *
 * D9's consequences say bytes, "since one `IssueWire` batch dwarfs one
 * `SessionMeta`". A frame bound would let a hundred fat frames through while
 * refusing a hundred thin ones, so the authority's memory would still be bounded
 * by the widest payload rather than by a number anyone chose.
 *
 * The SIZER IS INJECTED, because the kernel cannot know the wire encoding — that
 * is POD-308's, and `JSON.stringify().length` here would be a second, wrong
 * definition of a frame's size that happened to compile. An injected sizer also
 * lets a test drive the bound with exact arithmetic instead of guessing how big a
 * fixture serialises to, which is the difference between a test that asserts the
 * bound and a test that asserts a number it discovered by running the code.
 */

import type {
  DeltaFrame,
  RescopeFrame,
  ResyncRequiredFrame,
  ServerFrame,
} from '../replica/types'

/** How big is this frame on the wire? Injected — see the file header. */
export type FrameSizer = (frame: ServerFrame) => number

export interface SendQueueConfig {
  /**
   * The bound, in whatever unit `sizeOf` returns. Overflow is `> maxBytes` on the
   * TOTAL after admitting the frame, so a queue holding exactly the bound is
   * still healthy — a bound you cannot reach is a bound one lower.
   */
  readonly maxBytes: number
  readonly sizeOf: FrameSizer
}

/** What `offer` did. Three outcomes, none of them "dropped". */
export type SendQueueAdmission =
  /** Admitted and queued for delivery. */
  | { readonly kind: 'queued' }
  /**
   * The frame did not fit. The queue is now empty, the connection is demoted, and
   * `frame` is the control frame to send INSTEAD of everything discarded.
   */
  | { readonly kind: 'demoted'; readonly frame: ResyncRequiredFrame }
  /**
   * Already demoted; this delta was not queued and no new control frame is owed
   * (the replica has been told once and is re-bootstrapping).
   *
   * A distinct outcome from `demoted` so a caller cannot send the control frame
   * twice, and so a test can assert that a demoted connection stops accumulating
   * rather than merely stops growing.
   */
  | { readonly kind: 'suppressed' }

/**
 * One connection's outbound queue.
 *
 * Holds frames rather than bytes: this is the kernel's state machine for
 * admission and demotion, not a transport buffer. Whoever owns the socket drains
 * it and decides when a write has actually left.
 */
export class BoundedSendQueue {
  private readonly frames: ServerFrame[] = []
  private bytes = 0
  private demoted = false
  private overflows = 0

  constructor(private readonly config: SendQueueConfig) {}

  /** Bytes currently held. The number D9 bounds the authority's memory by. */
  queuedBytes(): number {
    return this.bytes
  }

  queuedFrames(): number {
    return this.frames.length
  }

  /** Has this connection been demoted and not yet re-armed? */
  isDemoted(): boolean {
    return this.demoted
  }

  /** How many times this connection has overflowed. Telemetry's slow-client signal. */
  overflowCount(): number {
    return this.overflows
  }

  /**
   * Offer a delta frame.
   *
   * Note what does NOT happen on overflow: the frame is not queued, and neither
   * is anything that was already there. Keeping the tail and dropping the head —
   * or the reverse — is the silent-divergence option wearing a plausible coat,
   * because either way the replica receives a range it cannot tell is incomplete.
   */
  offer(frame: DeltaFrame): SendQueueAdmission {
    if (this.demoted) return { kind: 'suppressed' }

    const size = this.config.sizeOf(frame)
    if (this.bytes + size > this.config.maxBytes) {
      this.overflows += 1
      return { kind: 'demoted', frame: this.demote(frame.feedId, frame.epoch, 'send-queue-overflow') }
    }

    this.frames.push(frame)
    this.bytes += size
    return { kind: 'queued' }
  }

  /**
   * Take everything queued, in order, and leave the queue empty.
   *
   * Returns frames rather than sending them: the kernel does not own a socket,
   * and a `send` callback here would make this module the thing that decides when
   * a write has left — which is the transport's fact, not the feed's.
   */
  drain(): readonly ServerFrame[] {
    const drained = this.frames.splice(0, this.frames.length)
    this.bytes = 0
    return drained
  }

  /**
   * Re-arm after the replica has re-bootstrapped past the demotion.
   *
   * Explicit, and never automatic on the next `offer`. An automatic re-arm would
   * resume deltas from wherever the feed happens to be, onto a replica that may
   * still be walking its bootstrap — which reintroduces the gap the demotion was
   * called to avoid, at the one moment the replica is least able to notice.
   */
  rearm(): void {
    this.demoted = false
    this.frames.length = 0
    this.bytes = 0
  }

  /**
   * Demote for a reason other than overflow — the authority shedding load
   * deliberately, or a connection the operator is resetting.
   */
  demoteNow(feedId: string, epoch: string, reason: string): ResyncRequiredFrame | null {
    if (this.demoted) return null
    return this.demote(feedId, epoch, reason)
  }

  /**
   * Amendment 1 D14.4 — demote because the principal's RIGHTS changed.
   *
   * Same invalidation as {@link demoteNow} and a DIFFERENT frame kind, which is
   * the decision rather than duplication: D14.4 requires the two to be
   * distinguishable in telemetry, because `resync-required` means the authority
   * shed load and `rescope` means an authorization event. Collapsing them would
   * make a re-bootstrap storm after a policy change read as backpressure, and the
   * operator would go tuning queue sizes.
   *
   * The queue-side effect is identical on purpose: the discarded frames are
   * discarded for the same reason (the position is now meaningless), and the
   * replica's response is the same rung 2. One recovery path, two causes.
   */
  rescopeNow(feedId: string, epoch: string, reason: string): RescopeFrame | null {
    if (this.demoted) return null
    this.invalidate()
    return { kind: 'rescope', feedId, epoch, reason }
  }

  private demote(feedId: string, epoch: string, reason: string): ResyncRequiredFrame {
    this.invalidate()
    return { kind: 'resync-required', feedId, epoch, reason }
  }

  private invalidate(): void {
    this.frames.length = 0
    this.bytes = 0
    this.demoted = true
  }
}
