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
import type {
  FeedBootstrapMessage,
  FeedDeltaMessage,
  FeedRescopeMessage,
  FeedResyncRequiredMessage,
  UpgradeRequired,
} from '@podium/protocol'
import type {
  AuthorityPort,
  FeedIdentityRegistry,
  FeedConnection,
  FeedPrincipal,
  FeedRetentionPort,
  ScopedDelivery,
  ServerFrame,
} from '@podium/sync'
import { FeedPublisher } from '@podium/sync'
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

  constructor(private readonly deps: FeedServingDeps) {
    this.publisher = new FeedPublisher({
      identity: deps.identity,
      retention: deps.retention,
      sendQueue: {
        maxBytes: FEED_SEND_QUEUE_MAX_BYTES,
        sizeOf: (frame) => JSON.stringify(frame).length,
      },
    })
    this.edge = new WireFeedEdge({ diagnostics: () => deps.diagnostics() })
  }

  /**
   * Admit a connection and serve it its world. Returns a 426 instead when the
   * version it announced is outside the supported window.
   *
   * Idempotent per peer id: a re-attach at a NEW version keeps the connection's
   * position (see {@link renegotiate}); nothing here re-reads the world for a
   * connection that already has one.
   */
  attach(peer: FeedPeer, principal: FeedPrincipal): UpgradeRequired | null {
    const refusal = this.edge.attach(peer)
    if (refusal !== null) return refusal
    this.peers.set(peer.id, peer)
    if (this.connections.has(peer.id)) return null

    // ONE synchronous pass: the world, and the position it was read at.
    const world = this.deps.authority.bootstrap(principal)
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
      changes: world.changes.map(toFeedChange) as FeedBootstrapMessage['changes'],
      // Single chunk today. `last` is not dropped from the shape for that
      // reason: chunking is D15's, the flag is what a replica installs on, and a
      // producer that never sets it false is not the same thing as a wire that
      // cannot express it.
      last: true,
    }
    this.edge.publishTo(peer, bootstrap)
    this.connections.set(
      peer.id,
      this.publisher.connect(peer.id, world.throughSeq, principal),
    )
    return null
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
  renegotiate(peer: FeedPeer): UpgradeRequired | null {
    if (!this.connections.has(peer.id)) return this.edge.attach(peer)
    const refusal = this.edge.attach(peer)
    if (refusal !== null) return refusal
    this.peers.set(peer.id, peer)
    return null
  }

  detach(peerId: string): void {
    this.edge.detach(peerId)
    this.peers.delete(peerId)
    this.connections.get(peerId)?.disconnect()
    this.connections.delete(peerId)
  }

  /**
   * ONE evaluated slice → every connection of that principal.
   *
   * Framing and delivery are one call because the publisher's queue is a hold,
   * not a schedule: a frame left in it is a frame a connection has not been told
   * about, and there is no other tick in this server that would come back for it.
   */
  publish(principal: FeedPrincipal, delivery: ScopedDelivery): void {
    this.publisher.publish(principal, delivery)
    this.flush(delivery.throughSeq)
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
    this.edge.publishAdvisory(kind)
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

  /** Connections the publisher is framing for. Telemetry and tests. */
  connectionCount(): number {
    return this.connections.size
  }

  private flush(atSeq: number): void {
    for (const [id, connection] of this.connections) {
      const peer = this.peers.get(id)
      if (peer === undefined) continue
      for (const frame of connection.drain() as readonly ServerFrame[]) {
        this.edge.publishTo(peer, toWireFrame(frame, atSeq))
      }
    }
  }
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

/** A bootstrap row, in the wire's spelling. */
function toFeedChange(change: {
  seq: number
  entity: string
  entityId: string
  op: string
  value?: unknown
}): { seq: number; entity: string; entityId: string; op: string; value?: unknown } {
  return {
    seq: change.seq,
    entity: change.entity,
    entityId: change.entityId,
    op: change.op,
    ...(change.op === 'upsert' ? { value: change.value } : {}),
  }
}
