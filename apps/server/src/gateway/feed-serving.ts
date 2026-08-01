/**
 * THE SERVING PATH — one feed, framed once, translated per connection (POD-1203).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 *
 * POD-308 built the two ends and left the middle for this issue: the v2 frame
 * family and the version-adapter registry at the wire, the Authority's scoped
 * feed and `FeedPublisher` at the kernel. This module is the composition that
 * joins them, and joining them is what lets the SECOND serving path —
 * `funnel.publishComputed` and `SessionsService.fanOutSnapshot`, thirteen call
 * sites across five features, each rebuilding its own full list — be deleted
 * outright rather than kept "for legacy clients". Legacy clients still receive
 * `sessionsChanged` / `issuesChanged` / …; they are now a TRANSLATION of this
 * feed, built in `legacy-wire-v1-adapter.ts`, and they cease to exist when it
 * does.
 *
 * ---------------------------------------------------------------------------
 * THE THREE ROLES, AND WHY NONE OF THEM IS THIS FILE'S
 * ---------------------------------------------------------------------------
 *
 *   DECIDE   `@podium/sync` Authority — who may see which rows, and over what
 *            range (ADR 2 Am1 D12.7). Not here: a second filter would be a
 *            second answer to a question with one answer.
 *   FRAME    `@podium/sync` FeedPublisher — per-connection `fromSeq`, watermark
 *            coalescing, the bounded queue and demotion (D13/D9). Not here:
 *            re-deriving certified ranges at the transport is exactly the
 *            "two definitions of now" this run keeps paying for.
 *   TRANSLATE `WireFeedEdge` — the negotiated wire version's adapter.
 *
 * What IS this file's: holding those three together per connection, and the
 * ORDER in which a connection is admitted (below).
 *
 * ---------------------------------------------------------------------------
 * ATTACH ORDER IS THE CONTIGUITY ARGUMENT, AND IT IS SYNCHRONOUS
 * ---------------------------------------------------------------------------
 *
 * A connection is admitted in one synchronous pass: read the world at the head,
 * send it as `feedBootstrap`, then attach the publisher AT THAT SAME `seq`. The
 * Authority appends only inside `commit`, so nothing can land between the read
 * and the attach — the first delta a connection receives certifies from exactly
 * where its bootstrap stopped. The pre-cutover bootstrap could not make that
 * claim: it was a set of lists with no position in them, so a client had to spend
 * a `sync.changesSince` round trip to find out where it stood and the window
 * between the two was covered by hope.
 *
 * ---------------------------------------------------------------------------
 * A PEER'S VERSION IS KNOWN AT `hello`, NOT AT SOCKET ATTACH
 * ---------------------------------------------------------------------------
 *
 * `attachClient` runs before any client frame arrives, so at that moment the
 * server knows neither the peer's wire version nor its capabilities. That is not
 * new and the pre-cutover code stated the same rule ("no caps until hello — a
 * pre-hello client is treated as legacy"): a socket that has said nothing gets
 * the OLDEST thing that is certainly understood. So a peer is admitted at wire 1
 * without the delta capability, receives its world as v1 full lists exactly as
 * `onClientAttached` sent them, and {@link renegotiate} then moves it to the
 * version and capabilities its `hello` announced — WITHOUT re-bootstrapping,
 * because its position is already correct.
 *
 * The 426 therefore fires at `hello` and not before, which is the only place it
 * can: a version nobody announced cannot be refused.
 */

import type { ConversationDiagnosticWire } from '@podium/model'
import {
  asSubscriberId,
  type FeedBootstrapMessage,
  type FeedChange,
  type FeedDeltaMessage,
  type FeedRescopeMessage,
  type FeedResyncRequiredMessage,
  type Principal,
  principalRoutingKeyFromId,
  type RoutingKey,
  type SubscriptionRegistry,
  type UpgradeRequired,
} from '@podium/protocol'
import type {
  AuthorityPort,
  FeedConnection,
  FeedIdentityRegistry,
  FeedPrincipal,
  FeedRetentionPort,
  ScopedChange,
  ScopedDelivery,
  ServerFrame,
} from '@podium/sync'
import { FeedPublisher, principalIdOf } from '@podium/sync'
import { perfPrincipal } from '../modules/perf/principal'
import { perf } from '../modules/perf/registry'
import {
  type EdgePeer,
  type FeedFrame,
  type LegacyAdvisoryKind,
  WireFeedEdge,
} from './wire-feed-edge'

/**
 * The bound D9 holds the authority's memory to, per connection.
 *
 * Sized in serialized bytes and generous on purpose: overflow DEMOTES a
 * connection to a re-bootstrap, which is correct under real backpressure and
 * merely expensive under a burst. 8 MiB is well above the largest observed
 * full-list rebuild on this server and well below anything that threatens the
 * process with a hundred connections.
 */
export const FEED_SEND_QUEUE_MAX_BYTES = 8 * 1024 * 1024

/** One admitted client, as this module needs it. */
export interface FeedPeer extends EdgePeer {}

export interface FeedServingDeps {
  /** The kernel role. Both reads come from it, which is the whole point. */
  readonly authority: AuthorityPort
  /** Persisted `(feedId, epoch)` — ADR 2 D1. */
  readonly identity: FeedIdentityRegistry
  /** ADR 2 D5's floor, read live per frame. */
  readonly retention: FeedRetentionPort
  /** The gateway's ONE routing table, shared with room presence. */
  readonly subscriptions: SubscriptionRegistry
  /**
   * Conversation scan diagnostics — advisory, connection-scoped, never an entity
   * and never a change row. The v1 `conversationsChanged` message carries it as a
   * required field, so the v1 adapter is injected with it; v2 does not carry it
   * at all. See `legacy-wire-v1-adapter.ts`.
   */
  diagnostics(): ConversationDiagnosticWire[]
}

export class FeedServing {
  private readonly publisher: FeedPublisher
  private readonly edge: WireFeedEdge
  private readonly peers = new Map<string, FeedPeer>()
  private readonly connections = new Map<string, FeedConnection>()
  /** The wire version each connection's WORLD was expressed in. */
  private readonly servedVersion = new Map<string, number>()
  private readonly feedKeyByPeer = new Map<string, RoutingKey>()
  private readonly authoritySubscriptionByKey = new Map<RoutingKey, () => void>()
  private readonly pendingByPrincipal = new Map<
    string,
    { principal: FeedPrincipal; deliveries: ScopedDelivery[] }
  >()
  private flushScheduled = false

  constructor(private readonly deps: FeedServingDeps) {
    this.publisher = new FeedPublisher({
      identity: deps.identity,
      retention: deps.retention,
      sendQueue: {
        maxBytes: FEED_SEND_QUEUE_MAX_BYTES,
        sizeOf: (frame) => JSON.stringify(frame).length,
      },
    })
    this.edge = new WireFeedEdge({
      diagnostics: () => deps.diagnostics(),
      // Straight through to the Authority, which delegates to the policy object
      // it was constructed with. No value is stored anywhere on this path, so
      // there is nothing that can go stale (POD-376).
      visibilityGrade: () => deps.authority.visibilityGrade(),
    })
  }

  /**
   * Admit a connection and serve it its world. Returns a 426 instead when the
   * version it announced is outside the supported window.
   *
   * Idempotent per peer id: a re-attach at a NEW version keeps the connection's
   * position (see {@link renegotiate}); nothing here re-reads the world for a
   * connection that already has one.
   */
  attach(
    peer: FeedPeer,
    principal: FeedPrincipal,
    routingPrincipal: Principal,
  ): UpgradeRequired | null {
    const refusal = this.edge.attach(peer)
    if (refusal !== null) return refusal
    this.peers.set(peer.id, peer)
    if (this.connections.has(peer.id)) return null
    this.serveWorld(peer, principal, routingPrincipal)
    return null
  }

  /** Read the world, send it, and start framing from the position it was read
   *  at. The one place a connection acquires a position. */
  private serveWorld(peer: FeedPeer, principal: FeedPrincipal, routingPrincipal: Principal): void {
    // ONE synchronous pass: the world, and the position it was read at.
    const t0 = performance.now()
    const world = this.deps.authority.bootstrap(principal)
    const perfKey = perfPrincipal(principal)
    // THE SLICE SIZE, measured at the ONE point the whole visible world is
    // enumerated [POD-736]. A delta batch's `changes.length` is churn and would
    // read as a shrinking working set on a quiet server; a bootstrap is the
    // principal's world, which is the number an A/B has to control for.
    perf.observeSliceSize(perfKey, world.changes.length)
    perf.record('phase', 'feedBootstrap.read', performance.now() - t0, perfKey)
    const identity = this.deps.identity.current()
    const bootstrap: FeedBootstrapMessage = {
      type: 'feedBootstrap',
      feedId: identity.feedId,
      epoch: identity.epoch,
      // A bootstrap certifies `(0, seq]` — everything up to the snapshot point.
      // Spelling it the same way a delta does is what lets a replica hold ONE
      // acceptance rule instead of two.
      fromSeq: 0,
      seq: world.throughSeq,
      minAvailableSeq: this.deps.retention.minAvailableSeq() ?? 0,
      changes: world.changes.map(toFeedChange),
      // Single chunk today. `last` is not dropped from the shape for that
      // reason: chunking is D15's, the flag is what a replica installs on, and a
      // producer that never sets it false is not the same thing as a wire that
      // cannot express it.
      last: true,
    }
    this.edge.publishTo(peer, bootstrap)
    this.servedVersion.set(peer.id, peer.wireVersion)
    const existing = this.connections.get(peer.id)
    if (existing === undefined) {
      this.connections.set(peer.id, this.publisher.connect(peer.id, world.throughSeq, principal))
    } else {
      // A RE-SERVE. `rearm` is the publisher's own "this replica has just
      // re-bootstrapped, resume from here" — the same call a demoted connection
      // takes back. Reusing it keeps ONE way for a position to be set.
      existing.rearm(world.throughSeq)
    }
    this.retainPrincipal(peer.id, principal, routingPrincipal)
    perf.record('phase', 'feedBootstrap.total', performance.now() - t0, perfKey)
  }

  private retainPrincipal(
    peerId: string,
    principal: FeedPrincipal,
    routingPrincipal: Principal,
  ): void {
    const key = principalRoutingKeyFromId(principalIdOf(principal))
    if (this.feedKeyByPeer.get(peerId) === key) return
    this.releasePrincipal(peerId)
    const wasEmpty = this.deps.subscriptions.subscribers(key).length === 0
    this.deps.subscriptions.subscribe(key, {
      subscriberId: asSubscriberId(peerId),
      principal: routingPrincipal,
    })
    if (wasEmpty) {
      this.authoritySubscriptionByKey.set(
        key,
        this.deps.authority.subscribe(principal, (delivery) => this.queue(principal, delivery)),
      )
    }
    this.feedKeyByPeer.set(peerId, key)
  }

  private releasePrincipal(peerId: string): void {
    const key = this.feedKeyByPeer.get(peerId)
    if (!key) return
    this.feedKeyByPeer.delete(peerId)
    this.deps.subscriptions.unsubscribe(key, asSubscriberId(peerId))
    if (this.deps.subscriptions.subscribers(key).length !== 0) return
    this.authoritySubscriptionByKey.get(key)?.()
    this.authoritySubscriptionByKey.delete(key)
  }

  /**
   * The peer told us who it is (`hello`): move it to the version and capabilities
   * it announced.
   *
   * NO RE-BOOTSTRAP. Its position is already correct, and re-sending the world
   * would be the second serving path arriving through a side door — a client
   * would apply one world, then another, and the two could differ by anything
   * committed in between. What changes is only which adapter frames the NEXT
   * frame, which is a translation decision and nothing else.
   */
  renegotiate(
    peer: FeedPeer,
    principal: FeedPrincipal,
    routingPrincipal: Principal,
  ): UpgradeRequired | null {
    const refusal = this.edge.attach(peer)
    if (refusal !== null) return refusal
    this.peers.set(peer.id, peer)
    if (!this.connections.has(peer.id)) {
      this.serveWorld(peer, principal, routingPrincipal)
      return null
    }
    // THE VERSION IT ACTUALLY SPEAKS, OR NOTHING. A connection is admitted at
    // wire 1 before it says anything, so its world went out as v1 full lists. If
    // `hello` then announces a different version, that world was expressed in a
    // dialect this peer never advertised — so it is served again, in the version
    // it named, and the publisher is re-armed at the new position.
    //
    // The cost is one duplicated world per non-v1 connection, for the length of
    // the rollout window, and it is bounded and self-cancelling: the day
    // MIN_SUPPORTED_VERSION reaches 2 the pre-hello default rises with it and no
    // supported peer changes version at hello any more. The alternative —
    // bootstrapping only at `hello` — withholds the world from every peer that
    // never sends one, which is what the pre-cutover code deliberately served.
    if (this.servedVersion.get(peer.id) === peer.wireVersion) return null
    this.serveWorld(peer, principal, routingPrincipal)
    return null
  }

  detach(peerId: string): void {
    this.releasePrincipal(peerId)
    this.edge.detach(peerId)
    this.peers.delete(peerId)
    this.servedVersion.delete(peerId)
    this.connections.get(peerId)?.disconnect()
    this.connections.delete(peerId)
  }

  private queue(principal: FeedPrincipal, delivery: ScopedDelivery): void {
    const key = principalIdOf(principal)
    const pending = this.pendingByPrincipal.get(key) ?? { principal, deliveries: [] }
    pending.deliveries.push(delivery)
    this.pendingByPrincipal.set(key, pending)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flushPending())
  }

  /** Flush every principal independently, preserving certified range order. */
  flushPending(): void {
    this.flushScheduled = false
    const pending = [...this.pendingByPrincipal.values()]
    this.pendingByPrincipal.clear()
    for (const { principal, deliveries } of pending) {
      for (const delivery of coalesceScopedDeliveries(deliveries)) this.publish(principal, delivery)
    }
  }

  /**
   * ONE evaluated slice → every connection of that principal.
   *
   * Framing and delivery are one call because the publisher's queue is a hold,
   * not a schedule: a frame left in it is a frame a connection has not been told
   * about, and there is no other tick in this server that would come back for it.
   */
  publish(principal: FeedPrincipal, delivery: ScopedDelivery): void {
    const totalStartedAt = performance.now()
    const perfKey = perfPrincipal(principal)
    // Scoping has already been evaluated by Authority for this principal. Record
    // the handoff under that same principal so bootstrap and publication remain
    // comparable after per-user transport authentication.
    perf.record('phase', 'feedPublish.scope', 0, perfKey)
    // THE RE-POINTED SWITCH PHASES [POD-736]. `sessionsBroadcast.stringify` and
    // `.fanout` named the two halves of the deleted snapshot pipeline —
    // serialize the payload, then walk the connections. The same two halves are
    // here, doing the same work over the feed: FRAME (per-connection `fromSeq`,
    // watermark coalescing, the bounded queue) and FANOUT (drain each
    // connection's certified frames through its version adapter). The names
    // changed because the pipeline they named is gone; `PHASE_MIGRATION` in
    // `@podium/protocol` is the map a recorded baseline resolves through.
    const t0 = performance.now()
    const key = principalRoutingKeyFromId(principalIdOf(principal))
    const targets = this.deps.subscriptions.subscribers(key).map((sub) => String(sub.subscriberId))
    this.publisher.publishTo(targets, principal, delivery)
    const tFramed = performance.now()
    perf.record('phase', 'feedPublish.frame', tFramed - t0, perfKey)
    this.flush(delivery.throughSeq, targets)
    perf.record('phase', 'feedPublish.fanout', performance.now() - tFramed, perfKey)
    perf.record('phase', 'feedPublish.total', performance.now() - totalStartedAt, perfKey)
  }

  /** Roll the epoch and demote every connection to a re-bootstrap (D1 → D7 r4). */
  bumpEpoch(cause: Parameters<FeedPublisher['bumpEpoch']>[0]): void {
    this.publisher.bumpEpoch(cause)
    this.flush(this.deps.authority.cursor())
  }

  /**
   * Re-serve an advisory that is not feed content, to the wire versions that
   * still carry it inside an entity message. See `WireFeedEdge.publishAdvisory`;
   * on the current wire this is a no-op, which is the resting state a mechanism
   * for expiring debt is supposed to have.
   */
  publishAdvisory(kind: LegacyAdvisoryKind): void {
    // AFTER the pending feed flush, never before it. An advisory is not feed
    // content and must not overtake it: the write that moved the diagnostics has
    // usually just committed rows too, those rows are still in the funnel's
    // microtask-coalesced batch, and a v1 peer served the advisory first would
    // see a list built from the projection as it was BEFORE them — a momentary
    // empty or stale render, corrected a tick later. Deferring by one microtask
    // puts it behind a flush that is already scheduled.
    queueMicrotask(() => this.edge.publishAdvisory(kind))
  }

  /** Connected-peer version telemetry — the rollout's "may I raise the floor". */
  versions() {
    return this.edge.versions()
  }

  /** The window this server advertises, for the handshake and for /health. */
  support() {
    return this.edge.support()
  }

  /** Adapters whose expiry condition has arrived (the audit asserts this is empty). */
  expiredAdapters(): readonly string[] {
    return this.edge.expiredAdapters()
  }

  /**
   * The persisted `(feedId, epoch)` this server is serving (ADR 2 D1).
   *
   * Exposed because the wire-v2 CATCH-UP read is an HTTP query rather than a
   * frame, and a cursor without feed identity is the bare integer D1 forbids. The
   * push path gets identity for free — every frame carries it — and this is the
   * one place the pull path can obtain the same triple from the same registry,
   * rather than a second source of "which feed is this".
   */
  identity(): { readonly feedId: string; readonly epoch: string } {
    return this.deps.identity.current()
  }

  /** ADR 2 D5's retention floor, read live. 0 means nothing has been pruned —
   *  the same value and the same source every published frame carries, so a
   *  catch-up reply cannot advertise a different floor than a delta. */
  retentionFloor(): number {
    return this.deps.retention.minAvailableSeq() ?? 0
  }

  /** Connections the publisher is framing for. Telemetry and tests. */
  connectionCount(): number {
    return this.connections.size
  }

  private flush(atSeq: number, targetIds: Iterable<string> = this.connections.keys()): void {
    for (const id of targetIds) {
      const connection = this.connections.get(id)
      if (!connection) continue
      const peer = this.peers.get(id)
      if (peer === undefined) continue
      for (const frame of connection.drain() as readonly ServerFrame[]) {
        this.edge.publishTo(peer, toWireFrame(frame, atSeq))
      }
    }
  }
}

function coalesceScopedDeliveries(deliveries: readonly ScopedDelivery[]): ScopedDelivery[] {
  const coalesced: ScopedDelivery[] = []
  for (const delivery of deliveries) {
    const previous = coalesced.at(-1)
    if (delivery.kind === 'batch' && previous?.kind === 'batch') {
      coalesced[coalesced.length - 1] = {
        kind: 'batch',
        throughSeq: delivery.throughSeq,
        changes: [...previous.changes, ...delivery.changes],
      }
    } else {
      coalesced.push(delivery)
    }
  }
  return coalesced
}

/**
 * Kernel frame → wire frame.
 *
 * A MAPPING and not a re-statement: every field comes from the frame the
 * publisher certified, so this cannot widen a range, drop a floor, or invent an
 * identity. The one value it supplies is `seq` on the two control frames, which
 * the kernel's shapes do not carry and the wire requires — see below.
 */
function toWireFrame(frame: ServerFrame, atSeq: number): FeedFrame {
  if (frame.kind === 'delta') {
    const delta: FeedDeltaMessage = {
      type: 'feedDelta',
      feedId: frame.feedId,
      epoch: frame.epoch,
      fromSeq: frame.fromSeq,
      seq: frame.seq,
      minAvailableSeq: frame.minAvailableSeq,
      changes: frame.changes.map((change) => ({
        seq: change.seq,
        entity: change.entity,
        entityId: change.entityId,
        op: change.op,
        ...(change.op === 'upsert' ? { value: change.payload } : {}),
      })) as FeedDeltaMessage['changes'],
    }
    return delta
  }
  // `feedRescope` carries the seq the rights change occupies (D14.3); the kernel's
  // control frames carry no seq of their own, so it comes from the head of the
  // batch being delivered, which is what the caller passes. Taking it from the
  // connection's own position would name a cursor the frame is telling the
  // replica to abandon. `feedResyncRequired` has no seq FIELD at all, and that is
  // right: "I shed load" says nothing about where you are.
  if (frame.kind === 'rescope') {
    const rescope: FeedRescopeMessage = {
      type: 'feedRescope',
      feedId: frame.feedId,
      epoch: frame.epoch,
      seq: atSeq,
      cause: 'rights-changed',
      ...(frame.reason === undefined ? {} : { reason: frame.reason }),
    }
    return rescope
  }
  const resync: FeedResyncRequiredMessage = {
    type: 'feedResyncRequired',
    feedId: frame.feedId,
    epoch: frame.epoch,
    cause: 'authority-shed-load',
    ...(frame.reason === undefined ? {} : { reason: frame.reason }),
  }
  return resync
}

/**
 * A bootstrap row, in the wire's spelling.
 *
 * SHARED WITH THE CATCH-UP READ (POD-376). `WriteFunnel.feedChangesSince` maps
 * its rows through this same function, so a row served over HTTP and the same row
 * pushed as a frame cannot differ — which is not hypothetical: the first draft of
 * that read used the V1 mapper and shipped every healed row with an undefined
 * target id.
 *
 * BOTH SIDES DERIVED, never restated: the input is the kernel's `ScopedChange`
 * and the output is one element of the frame's own `changes` array. A hand-written
 * field list here would be a third definition of a change row — invisible to
 * every golden fixture, because a restatement is byte-identical on the wire — and
 * `rearch-audit`'s `change-row-typings` item counts exactly that mistake.
 */
export function toFeedChange(change: ScopedChange): FeedChange {
  const base = { seq: change.seq, entity: change.entity, entityId: change.entityId }
  return (
    change.op === 'upsert'
      ? { ...base, op: 'upsert', value: change.value }
      : { ...base, op: change.op }
  ) as FeedChange
}
