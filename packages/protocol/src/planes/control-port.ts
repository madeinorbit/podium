import type { PlaneClass } from './plane'
import type { Principal, VisibilityResolver } from './principal'
import {
  type EntityRef,
  entityRoutingKey,
  type PlaneRouter,
  principalRoutingKey,
  type RouteOutcome,
  type SubscriberId,
  type SubscriptionRegistry,
} from './routing'
import type { FeedDeltaMessage } from '../messages/feed'
import type { RescopeFrame } from './scoped-feed'

/**
 * THE CONTROL PORT — ADR 7 D1: the durable + directed-RPC port. It carries
 * THREE classes and no more:
 *
 *   control · entity     entity truth (snapshots / deltas / oplog), funnelled,
 *                        routed per principal, healed through ADR 2 D7
 *   control · command    directed request/reply with a correlated requestId and
 *                        requires-live-peer semantics — a CLASS INSIDE THIS
 *                        PORT, never a fourth plane
 *   control · handshake  once per connection: version + role auth (ADR 5)
 *
 * The port carries a PRINCIPAL on every delivery path and evaluates NO policy:
 * it consults an injected {@link VisibilityResolver} (owned by the policy layer)
 * and treats the answer as final. Authorization stays with the command layer and
 * ADR 3 D8's apply-time re-authorization.
 *
 * Nothing here forecloses a document `op-stream` (ADR 1 amendment, reserved and
 * deliberately not built): an ordered, contiguity-checked, per-entity op feed is
 * an entity-class channel on this port, which is why entity delivery is keyed by
 * an entity reference rather than by a fixed set of aggregate kinds.
 */

/** Where a directed frame goes: one authenticated connection and its principal. */
export interface PlaneTarget {
  readonly subscriberId: SubscriberId
  readonly principal: Principal
}

export type CorrelationId = string & { readonly __brand: 'CorrelationId' }
export const asCorrelationId = (s: string): CorrelationId => s as CorrelationId

/**
 * The command class's distinct delivery semantics, as data. Every field here is
 * what makes command different from entity ON THE SAME PORT, which is the whole
 * content of ADR 7 D1's "command is not a plane".
 */
export interface CommandDeliverySemantics {
  /** Correlated request/reply — `requestId` (or equivalent) is mandatory. */
  readonly correlated: true
  /** Requires a live peer unless the command is offline-class under ADR 3 D4. */
  readonly requiresLivePeer: boolean
  /** Point-to-point / one daemon. Never fanned out. */
  readonly fanOut: false
  /** Nothing to catch up as entity truth; no oplog row, no `seq` movement. */
  readonly oplogged: false
}

export interface CommandFrame<P = unknown> {
  readonly requestId: CorrelationId
  readonly type: string
  readonly payload: P
  /**
   * ADR 3 D4's offline class: may be queued in the outbox and applied later,
   * with apply-time re-authorization (ADR 3 D8). Everything else disables its
   * UI affordance while the peer is not live.
   */
  readonly offlineClass?: boolean
}

export type CommandDisposition =
  | { readonly status: 'sent'; readonly requestId: CorrelationId }
  | { readonly status: 'queued'; readonly requestId: CorrelationId }
  | { readonly status: 'no-live-peer'; readonly requestId: CorrelationId }

export interface ControlPortDeps {
  readonly visibility: VisibilityResolver
  /** Is this connection live right now? Liveness is the transport's fact. */
  readonly isLive: (subscriberId: SubscriberId) => boolean
  /** Hand a frame to the transport. POD-317 supplies the socket. */
  readonly emit: (subscriberId: SubscriberId, frame: unknown) => void
}

export interface ControlPort {
  readonly planeClasses: readonly PlaneClass[]
  admitEntity(target: PlaneTarget, ref: EntityRef): boolean
  revokeEntity(target: PlaneTarget, ref: EntityRef): boolean
  publishEntity(ref: EntityRef, frame: FeedDeltaMessage): RouteOutcome
  sendCertified(target: PlaneTarget, frame: FeedDeltaMessage): RouteOutcome
  rescope(target: PlaneTarget, frame: RescopeFrame): RouteOutcome
  sendCommand<P>(target: PlaneTarget, frame: CommandFrame<P>): CommandDisposition
  commandSemantics(frame: CommandFrame): CommandDeliverySemantics
}

/**
 * Reference implementation over the ONE routing primitive. `router` must be a
 * {@link PlaneRouter} parameterized `control.entity` / durable; the router's own
 * constructor refuses any other combination.
 */
export class ControlPlanePort implements ControlPort {
  readonly planeClasses = ['control.entity', 'control.command', 'control.handshake'] as const

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly router: PlaneRouter<FeedDeltaMessage | RescopeFrame>,
    private readonly deps: ControlPortDeps,
  ) {
    if (router.registry !== registry) {
      // One routing table (ADR 7 Amendment 1 D13). A port handed a router over
      // a different registry is a second registry with extra steps.
      throw new Error('control port router must share the one subscription registry')
    }
    if (router.policy.planeClass !== 'control.entity') {
      throw new Error(`control port needs a control.entity router, got ${router.policy.planeClass}`)
    }
  }

  /**
   * Subscribe a connection to one entity's rows. Default-closed: anything other
   * than an explicit `true` from the resolver is a refusal, and a refusal is
   * silent — the caller learns nothing it did not already know.
   */
  admitEntity(target: PlaneTarget, ref: EntityRef): boolean {
    if (this.deps.visibility.canSee(target.principal, ref) !== true) return false
    this.registry.subscribe(entityRoutingKey(ref), {
      subscriberId: target.subscriberId,
      principal: target.principal,
    })
    return true
  }

  /**
   * Visibility lost. The port stops routing the entity; telling the replica is
   * `evict` (an OP inside the next certified frame — ADR 2 D14.1) or `rescope`
   * (D14.4), never `remove`, and never this call's return value.
   */
  revokeEntity(target: PlaneTarget, ref: EntityRef): boolean {
    return this.registry.unsubscribe(entityRoutingKey(ref), target.subscriberId)
  }

  /** Fan out one certified frame to every principal admitted to `ref`. */
  publishEntity(ref: EntityRef, frame: FeedDeltaMessage): RouteOutcome {
    assertCertified(frame)
    return this.router.publish(entityRoutingKey(ref), frame)
  }

  /**
   * Directed certified frame — the watermark path (ADR 2 D13): the same frame
   * shape with an empty change list, on the same ordered pipe. Under
   * private-by-default this is the NORMAL path, not an exception, which is why
   * it is not a distinct message class.
   */
  sendCertified(target: PlaneTarget, frame: FeedDeltaMessage): RouteOutcome {
    assertCertified(frame)
    this.registry.subscribe(principalRoutingKey(target.principal), {
      subscriberId: target.subscriberId,
      principal: target.principal,
    })
    return this.router.publish(principalRoutingKey(target.principal), frame)
  }

  /** Per-principal visibility change resolving to D7 rung 2. Control · entity. */
  rescope(target: PlaneTarget, frame: RescopeFrame): RouteOutcome {
    this.registry.subscribe(principalRoutingKey(target.principal), {
      subscriberId: target.subscriberId,
      principal: target.principal,
    })
    return this.router.publish(principalRoutingKey(target.principal), frame)
  }

  commandSemantics(frame: CommandFrame): CommandDeliverySemantics {
    return {
      correlated: true,
      requiresLivePeer: frame.offlineClass !== true,
      fanOut: false,
      oplogged: false,
    }
  }

  /**
   * Command class: point-to-point, correlated, requires a live peer unless
   * offline-class. It does NOT go through the entity router — a command has no
   * routing set, no contiguity and nothing to heal.
   */
  sendCommand<P>(target: PlaneTarget, frame: CommandFrame<P>): CommandDisposition {
    if (!this.deps.isLive(target.subscriberId)) {
      return frame.offlineClass === true
        ? { status: 'queued', requestId: frame.requestId }
        : { status: 'no-live-peer', requestId: frame.requestId }
    }
    this.deps.emit(target.subscriberId, frame)
    return { status: 'sent', requestId: frame.requestId }
  }
}

/**
 * A frame that does not certify a well-formed range cannot be sent at all: the
 * authority cannot filter without also certifying, because there is only one way
 * to send a frame (ADR 2 D13's rationale).
 */
export function assertCertified(frame: FeedDeltaMessage): void {
  if (frame.seq < frame.fromSeq) {
    throw new Error(`uncertified frame: seq ${frame.seq} below fromSeq ${frame.fromSeq}`)
  }
  let prev = frame.fromSeq
  for (const change of frame.changes) {
    if (change.seq <= frame.fromSeq || change.seq > frame.seq) {
      throw new Error(
        `change seq ${change.seq} outside covered range (${frame.fromSeq}, ${frame.seq}]`,
      )
    }
    // Non-decreasing, not adjacent: contiguity is certified by the range, and
    // anchored rows may SHARE a seq (ADR 2 D14.3).
    if (change.seq < prev) throw new Error('changes must be in non-decreasing seq order')
    prev = change.seq
  }
}
