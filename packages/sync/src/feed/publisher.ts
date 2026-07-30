/**
 * THE FEED PUBLISHER — the Authority's outbound half, and the seam POD-305 shaped
 * but deliberately did not build.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLOSES, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * Before this module, `Authority.subscribe()` handed out `SequencedChange[]` and
 * nothing else. Every property the Replica's ladder is built on — feed identity,
 * the covered range, the retention floor, backpressure demotion — existed ONLY
 * inside `../conformance/authority.ts`, a fixture written to exercise the
 * Replica. The conformance suite was therefore certifying a fixture's behaviour
 * as the kernel's, which is this run's dominant defect class (a suite that cannot
 * say NO) one layer above where the previous three instances were found.
 *
 * So this is not glue. It is the producing half of four of the five items POD-305
 * re-homed, and its whole reason to exist is that the suite must be able to run
 * against it and FAIL when it is wrong.
 *
 * ---------------------------------------------------------------------------
 * THE COVERED RANGE IS COMPUTED HERE, AND IT IS THE WHOLE CONTRACT
 * ---------------------------------------------------------------------------
 *
 * Amendment 1 D13's normative sentence — "I have evaluated every global seq in
 * `(fromSeq, seq]` and `changes` contains exactly those you may see" — is a claim
 * only the producer can make honestly. `fromSeq` is the previous frame's `seq`,
 * held per connection, so the frames one connection receives are contiguous and
 * non-overlapping BY CONSTRUCTION rather than by the transport being well
 * behaved. That is why `fromSeq` is not derived from the batch: a batch knows its
 * own first seq, and using it would emit a frame that certifies a range starting
 * where the data starts, silently skipping any seq the authority evaluated and
 * found empty — which is exactly the invisible-permanent-gap failure ADR 2 warns
 * POD-308 about.
 *
 * ---------------------------------------------------------------------------
 * THE FEED IS UNSCOPED, AND THAT IS PINNED AS A TEST
 * ---------------------------------------------------------------------------
 *
 * Every connection receives every change. `publish` takes no principal and
 * `connect` takes no filter; there is nowhere for a slice to be computed. That is
 * POD-1077's work, and Amendment 1 D13 requires the filter and the watermark to
 * land TOGETHER because a filter without a watermark turns every suppressed row
 * into a permanent gap. `publisher.unscoped.test.ts` asserts the absence, so a
 * green suite cannot be misread as privacy that does not exist.
 *
 * A watermark frame — `changes: []` over a non-empty range — is already
 * REPRESENTABLE here and is emitted whenever a batch dedupes away to nothing. It
 * is the frame shape POD-1077 needs; what is missing is the per-principal
 * evaluation that would make it mean "suppressed for you" rather than "nothing
 * happened".
 */

import type { SequencedChange } from '../authority/change-lifecycle'
import type {
  ChangeEnvelope,
  ChangeOp,
  DeltaFrame,
  ResyncRequiredFrame,
  ServerFrame,
} from '../replica/types'
import type { FeedIdentityRegistry } from './identity'
import { BoundedSendQueue, type SendQueueConfig } from './send-queue'

/**
 * The retention floor, read live (ADR 2 D5).
 *
 * A function rather than a number because pruning happens under the publisher's
 * feet: a cached floor would advertise a range the log no longer holds, and a
 * replica trusting it would heal into a `bootstrap-required` it was told it would
 * not get. Reading it per frame is the only shape that cannot go stale.
 */
export interface FeedRetentionPort {
  /** Lowest RETAINED seq, or `null` when the log is empty. */
  minAvailableSeq(): number | null
}

export interface FeedPublisherDeps {
  readonly identity: FeedIdentityRegistry
  readonly retention: FeedRetentionPort
  readonly sendQueue: SendQueueConfig
}

/** One connected replica, from the publisher's side. */
export interface FeedConnection {
  readonly id: string
  /** Frames ready to go out, oldest first. Empties the queue. */
  drain(): readonly ServerFrame[]
  /** ADR 2 D9 — demoted by backpressure and awaiting a re-bootstrap. */
  isDemoted(): boolean
  /** Bytes held for this connection. D9 bounds the authority by this, times N. */
  queuedBytes(): number
  /** After the replica has re-bootstrapped: resume deltas from `atSeq`. */
  rearm(atSeq: number): void
  disconnect(): void
}

interface ConnectionState {
  readonly id: string
  readonly queue: BoundedSendQueue
  /** The exclusive lower bound of the NEXT frame — this connection's certified position. */
  fromSeq: number
  pending: ServerFrame[]
}

/**
 * Map a durable change row onto the envelope the Replica applies.
 *
 * ONE mapping site, deliberately. A second copy of this would be byte-identical
 * on the wire and therefore invisible to every golden fixture — the composition
 * drift that only a single definition site or an identity assertion can catch.
 *
 * The op needs no cast and gets none: `SequencedChange.op` is
 * `GlobalChangeOp` (`upsert | remove`), which is a strict subset of the Replica's
 * `ChangeOp` (`… | evict`), because `CHANGE_OPS` is built by EXTENDING
 * `GLOBAL_CHANGE_OPS` rather than by restating it. A cast here would have
 * compiled either way and would have gone on compiling on the day someone added a
 * fourth global op the Replica cannot apply; assigning it plainly means that day
 * is a type error. `evict` is unreachable from a global row by construction — it
 * is derived per-principal at the feed boundary, which is POD-1077's.
 */
function toEnvelope(change: SequencedChange): ChangeEnvelope {
  const op: ChangeOp = change.op
  return {
    seq: change.seq,
    entity: change.entity,
    entityId: change.entityId,
    op,
    ...(op === 'upsert' ? { payload: change.value } : {}),
    ...(change.originId === undefined ? {} : { originId: change.originId }),
    ...(change.causationId === undefined ? {} : { causationId: change.causationId }),
    ...(change.mutationId === undefined ? {} : { mutationId: change.mutationId }),
  }
}

export class FeedPublisher {
  private readonly connections = new Map<string, ConnectionState>()
  /** The highest seq this publisher has certified to ANY connection. */
  private published = 0

  constructor(private readonly deps: FeedPublisherDeps) {}

  /**
   * Attach a replica at `fromSeq` — its current cursor position, or 0 for a
   * replica that has just installed a bootstrap at seq 0.
   *
   * ONE ARGUMENT BEYOND THE ID, AND NO PRINCIPAL. See the file header: the arity
   * of this method is asserted in `publisher.unscoped.test.ts`, so adding a
   * principal parameter without the watermark evaluation to go with it fails a
   * test rather than passing review.
   */
  connect(id: string, fromSeq: number): FeedConnection {
    const state: ConnectionState = {
      id,
      queue: new BoundedSendQueue(this.deps.sendQueue),
      fromSeq,
      pending: [],
    }
    this.connections.set(id, state)
    return {
      id,
      drain: () => {
        const control = state.pending.splice(0, state.pending.length)
        return [...control, ...state.queue.drain()]
      },
      isDemoted: () => state.queue.isDemoted(),
      queuedBytes: () => state.queue.queuedBytes(),
      rearm: (atSeq: number) => {
        state.queue.rearm()
        state.fromSeq = atSeq
      },
      disconnect: () => {
        this.connections.delete(id)
      },
    }
  }

  connectionCount(): number {
    return this.connections.size
  }

  /**
   * Publish one appended batch to every connection.
   *
   * Wire this to `Authority.subscribe`. It must run on the authority's ORDERED
   * pipe and after the durable append — `funnel.ts:54`'s pipe-before-bus rule —
   * because a reentrant subscriber that commits again would otherwise re-enter
   * here with LATER seqs before this batch had been framed, delivering
   * `[N-1, N+1, N]` and advancing cursors past a gap that can never heal.
   */
  publish(changes: readonly SequencedChange[]): void {
    if (changes.length === 0) return
    const highest = changes[changes.length - 1]?.seq ?? this.published
    this.published = Math.max(this.published, highest)
    for (const state of this.connections.values()) {
      this.emitTo(state, changes, highest)
    }
  }

  /**
   * Emit a WATERMARK: "I evaluated up to `seq` and there is nothing for you."
   *
   * Public because under a scoped feed this is the normal path rather than an
   * exception (Amendment 1 D13), and POD-1077 needs to reach it without going
   * through a batch that happens to be empty. Today it is reachable only when the
   * authority evaluated a range and produced no visible change — a compaction
   * sweep, a dedup that removed everything — which is the honest unscoped
   * meaning.
   */
  publishWatermark(throughSeq: number): void {
    this.published = Math.max(this.published, throughSeq)
    for (const state of this.connections.values()) {
      this.emitTo(state, [], throughSeq)
    }
  }

  private emitTo(
    state: ConnectionState,
    changes: readonly SequencedChange[],
    throughSeq: number,
  ): void {
    // Nothing to certify: this connection is already at or past the range. Not an
    // error — a connection that attached at the head legitimately sees this.
    if (throughSeq <= state.fromSeq) return

    const frame: DeltaFrame = {
      kind: 'delta',
      feedId: this.identity().feedId,
      epoch: this.identity().epoch,
      fromSeq: state.fromSeq,
      seq: throughSeq,
      minAvailableSeq: this.retentionFloor(),
      // Only the part of the batch above this connection's position. A connection
      // that attached mid-batch must not be certified a range it already had.
      changes: changes.filter((c) => c.seq > state.fromSeq).map(toEnvelope),
    }

    const admission = state.queue.offer(frame)
    if (admission.kind === 'demoted') {
      // The connection's position is now MEANINGLESS, and leaving it advanced
      // would let a later re-arm resume from a cursor certifying frames that were
      // discarded. Only `rearm(atSeq)` may set it again, and only after the
      // replica has re-bootstrapped.
      state.pending.push(admission.frame)
      return
    }
    if (admission.kind === 'suppressed') return
    state.fromSeq = throughSeq
  }

  /**
   * ADR 2 D5's floor as published on the wire.
   *
   * `null` — an empty log — publishes 0, and that is correct rather than a
   * fallback: an empty log has pruned nothing, so no cursor is below it. This is
   * the one place a 0 is legitimate, which is exactly why the FIELD is required
   * (see `DeltaFrame.minAvailableSeq`): the value 0 must mean "nothing pruned"
   * and never "nobody published it".
   */
  private retentionFloor(): number {
    return this.deps.retention.minAvailableSeq() ?? 0
  }

  private identity() {
    return this.deps.identity.current()
  }

  /**
   * Roll the epoch and tell every connection (ADR 2 D1 → D7 rung 4).
   *
   * Sent as `resync-required` rather than as a delta carrying the new epoch,
   * because a delta would be compared against the OLD cursor and take rung 4
   * anyway — via a path that discards the frame. Saying it directly is the same
   * outcome with the reason preserved in telemetry.
   */
  bumpEpoch(cause: Parameters<FeedIdentityRegistry['bump']>[0]): void {
    const next = this.deps.identity.bump(cause)
    for (const state of this.connections.values()) {
      const frame: ResyncRequiredFrame | null = state.queue.demoteNow(
        next.feedId,
        next.epoch,
        `epoch-bump:${cause}`,
      )
      if (frame !== null) state.pending.push(frame)
    }
  }
}
