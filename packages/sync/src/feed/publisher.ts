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
 * THE FEED IS SCOPED (POD-1077), AND THIS SIDE OWNS FRAMING, NOT DECIDING
 * ---------------------------------------------------------------------------
 *
 * A connection now stands for a PRINCIPAL, and `publish` takes the principal plus
 * an already-evaluated {@link ScopedDelivery} — the range and the rows that
 * survived it, inseparable in one type (see `authority/scoping.ts`). So this
 * module cannot filter, and cannot certify a range it did not receive: the
 * decision is the Authority's (Amendment 1 D12.7) and the framing is this one's.
 *
 * That split is what makes "filter and watermark land together" (D13) structural
 * rather than remembered. There is exactly ONE emit path here. It runs whether or
 * not any row survived, so a fully-suppressed range leaves as a watermark —
 * `changes: []` over a non-empty covered range — on the same ordered pipe, and
 * the connection's position advances. A suppressed row therefore cannot become
 * the invisible permanent gap that heal-loops forever (POD-351's warning, D2's
 * named failure mode).
 *
 * ---------------------------------------------------------------------------
 * WATERMARKS ARE FREE, WHICH IS D13.4 AND NOT AN OPTIMISATION
 * ---------------------------------------------------------------------------
 *
 * D13.4: *"watermark-only frames must not demote a replica"* — a replica must
 * never be forced to re-bootstrap because of activity it is not allowed to
 * observe. Here that is a property of where a watermark is HELD rather than of a
 * size calculation: a watermark never enters the bounded send queue at all. It
 * sits in a single per-connection coalescing slot, where a run of them collapses
 * to one certified range (D13.2, range-extension only, never a reorder) and where
 * the next frame carrying real changes absorbs it by extending its own range
 * downward. Under private-by-default a suppressed firehose is therefore bounded
 * by ONE pending frame per connection, and cannot overflow anything.
 */

import type { ScopedChange } from '../authority/change-lifecycle'
import type { ScopedDelivery } from '../authority/scoping'
import type {
  ChangeEnvelope,
  ChangeOp,
  DeltaFrame,
  RescopeFrame,
  ResyncRequiredFrame,
  ServerFrame,
} from '../replica/types'
import type { FeedIdentity, FeedIdentityRegistry } from './identity'
import { BoundedSendQueue, type SendQueueConfig } from './send-queue'
import { type FeedPrincipal, principalIdOf } from './visibility'

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
  /** WHO this connection stands for (ADR 3 D7 — authenticated transport only). */
  readonly principal: FeedPrincipal
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
  readonly principal: FeedPrincipal
  readonly queue: BoundedSendQueue
  /** The exclusive lower bound of the NEXT frame — this connection's certified position. */
  fromSeq: number
  pending: ServerFrame[]
  /**
   * The coalescing slot for watermark-only frames (D13.2/D13.4).
   *
   * OUTSIDE the bounded queue on purpose — see the file header. Holds the
   * certified UPPER bound only; the lower bound is always `fromSeq`, so the two
   * cannot drift apart and there is no way to hold a watermark that certifies a
   * range not contiguous with this connection's position.
   */
  watermarkThrough: number | null
}

/**
 * Map a durable change row onto the envelope the Replica applies.
 *
 * ONE mapping site, deliberately. A second copy of this would be byte-identical
 * on the wire and therefore invisible to every golden fixture — the composition
 * drift that only a single definition site or an identity assertion can catch.
 *
 * The op needs no cast and gets none: `ScopedChange.op` is the Replica's own
 * `ChangeOp` (`upsert | remove | evict`), and `CHANGE_OPS` is built by EXTENDING
 * `GLOBAL_CHANGE_OPS` rather than by restating it. A cast here would have compiled
 * either way and would have gone on compiling on the day someone added a fourth
 * global op the Replica cannot apply; assigning it plainly means that day is a
 * type error.
 *
 * `evict` reaches this function only from a SCOPED row (phase 4), never from a
 * stored global one (phase 3), because `SequencedChange` has nowhere to put one.
 * That is Amendment 1 D14.1's "per-principal, derived at the feed boundary" as a
 * type relation instead of a convention.
 */
function toEnvelope(change: ScopedChange): ChangeEnvelope {
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

/**
 * Amendment 1 D14.4 — the principal's RIGHTS changed; re-bootstrap scoped.
 *
 * A MODULE FUNCTION and not a method, which is the difference between "a caller
 * should not do this" and "there is nothing here to call". TypeScript's `private`
 * is compile-time only: a private method still sits on the prototype, so a
 * `rescope` a caller could reach by name would exist at runtime and the guard
 * asserting its absence would have to be written against the public TYPE, where a
 * cast defeats it. Keeping it off the class means the only route to a rescope is
 * the `rescope` ARM of a `ScopedDelivery`, chosen in `authority/scoping.ts` from
 * the size of the set the policy derived.
 *
 * Distinct from `resync-required` in TYPE as well as in telemetry, because
 * collapsing them makes an authz event look like a performance event, and a
 * re-bootstrap storm after a policy change would be misdiagnosed as backpressure.
 */
function rescopeTo(state: ConnectionState, identity: FeedIdentity, reason: string): void {
  const frame: RescopeFrame | null = state.queue.rescopeNow(identity.feedId, identity.epoch, reason)
  state.watermarkThrough = null
  if (frame !== null) state.pending.push(frame)
}

export class FeedPublisher {
  private readonly connections = new Map<string, ConnectionState>()
  /** The highest seq this publisher has certified to ANY connection. */
  private published = 0

  constructor(private readonly deps: FeedPublisherDeps) {}

  /**
   * Attach a replica at `fromSeq` — its current cursor position, or 0 for a
   * replica that has just installed a bootstrap at seq 0 — AS a principal.
   *
   * The principal is the third argument and is required. It comes from the
   * authenticated transport and never from the replica (ADR 3 D7): a connection
   * that could name its own principal is a connection that can name someone
   * else's. `publisher.scoped.test.ts` asserts this arity, replacing the
   * `publisher.unscoped.test.ts` assertion that it was 2.
   */
  connect(id: string, fromSeq: number, principal: FeedPrincipal): FeedConnection {
    const state: ConnectionState = {
      id,
      principal,
      queue: new BoundedSendQueue(this.deps.sendQueue),
      fromSeq,
      pending: [],
      watermarkThrough: null,
    }
    this.connections.set(id, state)
    return {
      id,
      principal,
      drain: () => {
        const control = state.pending.splice(0, state.pending.length)
        const queued = state.queue.drain()
        // The pending watermark leaves LAST and only now: it always certifies the
        // newest range, and holding it until the transport asks is what lets a run
        // of them collapse to one frame (D13.2).
        return [...control, ...queued, ...this.takeWatermark(state)]
      },
      isDemoted: () => state.queue.isDemoted(),
      queuedBytes: () => state.queue.queuedBytes(),
      rearm: (atSeq: number) => {
        state.queue.rearm()
        state.fromSeq = atSeq
        // A watermark held from before the demotion certifies a range against a
        // position that no longer exists. Dropping it is not a lost update: the
        // replica has just re-bootstrapped past it.
        state.watermarkThrough = null
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
   * Deliver ONE already-evaluated slice to every connection of ONE principal.
   *
   * Wire this to `Authority.subscribe`. It must run on the authority's ORDERED
   * pipe and after the durable append — `funnel.ts:54`'s pipe-before-bus rule —
   * because a reentrant subscriber that commits again would otherwise re-enter
   * here with LATER seqs before this batch had been framed, delivering
   * `[N-1, N+1, N]` and advancing cursors past a gap that can never heal.
   *
   * TWO PARAMETERS, AND NEITHER IS A FILTER. The principal names the audience;
   * the delivery carries the rows AND the range they were evaluated over. There
   * is no third argument by which a caller could name an op, an audience for a
   * single row, or a `rescope`: the terminal path is an ARM of the delivery,
   * chosen in `authority/scoping.ts` from the size of the set the policy derived.
   * That is why this class has no `rescope` method for anyone to call —
   * `publisher.scoped.test.ts` asserts its absence, because a caller-supplied
   * rescope is an oracle for what that caller cannot see.
   */
  publish(principal: FeedPrincipal, delivery: ScopedDelivery): void {
    this.publishTo([...this.connections.keys()], principal, delivery)
  }

  /**
   * Frame an evaluated slice only for the connection ids selected by the
   * gateway's shared subscription registry. The principal check remains as a
   * fail-closed assertion against a widened or stale target set; it is not an
   * audience selector.
   */
  publishTo(
    connectionIds: readonly string[],
    principal: FeedPrincipal,
    delivery: ScopedDelivery,
  ): void {
    const audience = principalIdOf(principal)
    this.published = Math.max(this.published, delivery.throughSeq)
    for (const id of connectionIds) {
      const state = this.connections.get(id)
      if (!state) continue
      if (principalIdOf(state.principal) !== audience) continue
      if (delivery.kind === 'rescope') {
        rescopeTo(state, this.identity(), delivery.reason)
        continue
      }
      this.emitTo(state, delivery.changes, delivery.throughSeq)
    }
  }

  private emitTo(
    state: ConnectionState,
    changes: readonly ScopedChange[],
    throughSeq: number,
  ): void {
    // Nothing to certify: this connection is already at or past the range. Not an
    // error — a connection that attached at the head legitimately sees this.
    if (throughSeq <= state.fromSeq) return
    // A demoted connection has no position to advance and no queue to hold this;
    // it is waiting on a re-bootstrap, and `rearm` is the only way back.
    if (state.queue.isDemoted()) return

    // Only the part of the slice above this connection's position. A connection
    // that attached mid-batch must not be certified a range it already had.
    const rows = changes.filter((c) => c.seq > state.fromSeq).map(toEnvelope)

    if (rows.length === 0) {
      // A WATERMARK. It does not enter the bounded queue (D13.4) and it does not
      // advance `fromSeq` yet: holding the lower bound is what lets the next frame
      // with real changes absorb this range by extending downward, so a watermark
      // is never delivered out of order and never costs a frame of its own when
      // something visible follows it (D13.2, range-extension only).
      state.watermarkThrough = Math.max(state.watermarkThrough ?? 0, throughSeq)
      return
    }

    const frame = this.frame(state.fromSeq, throughSeq, rows)
    const admission = state.queue.offer(frame)
    if (admission.kind === 'demoted') {
      // The connection's position is now MEANINGLESS, and leaving it advanced
      // would let a later re-arm resume from a cursor certifying frames that were
      // discarded. Only `rearm(atSeq)` may set it again, and only after the
      // replica has re-bootstrapped.
      state.watermarkThrough = null
      state.pending.push(admission.frame)
      return
    }
    if (admission.kind === 'suppressed') return
    // The pending watermark's range is inside this frame's, so it is spent.
    state.watermarkThrough = null
    state.fromSeq = throughSeq
  }

  /**
   * Flush the coalescing slot, at drain time.
   *
   * A run of watermarks collapses to ONE frame here, which is D13.2's coalescing
   * and D13.4's "a suppressed firehose cannot demote anyone" in the same two
   * lines: the slot holds a number, not a queue, so there is nothing to overflow.
   */
  private takeWatermark(state: ConnectionState): readonly ServerFrame[] {
    const through = state.watermarkThrough
    if (through === null || state.queue.isDemoted() || through <= state.fromSeq) return []
    const frame = this.frame(state.fromSeq, through, [])
    state.watermarkThrough = null
    state.fromSeq = through
    return [frame]
  }

  /** THE one frame constructor. A second one would be invisible to every golden fixture. */
  private frame(fromSeq: number, seq: number, changes: readonly ChangeEnvelope[]): DeltaFrame {
    const identity = this.identity()
    return {
      kind: 'delta',
      feedId: identity.feedId,
      epoch: identity.epoch,
      fromSeq,
      seq,
      minAvailableSeq: this.retentionFloor(),
      changes,
    }
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
