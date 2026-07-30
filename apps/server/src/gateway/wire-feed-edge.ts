/**
 * THE WIRE FEED EDGE — the ONE place entity truth leaves this server (POD-308).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 * ---------------------------------------------------------------------------
 *
 * Before the cutover the server served entity state through TWO paths: an
 * ordered `metadataDelta` pipe fed by the Authority, and `funnel.publishComputed`
 * — a full-list snapshot fan-out that each feature drove by rebuilding its own
 * list (`sessionsChanged` from `listSessions()`, `issuesChanged` from
 * `allWire()`, and so on). Thirteen call sites, five features, one shared
 * assumption that the two paths agreed.
 *
 * That second path is gone. Everything now leaves through {@link publish}: the
 * Authority's feed is framed once, and each connection receives it through the
 * adapter for the wire version it negotiated. Legacy clients still get their
 * full-list snapshots — as a TRANSLATION of the feed, built inside
 * `legacy-wire-v1-adapter.ts`, which expires. A translation of one pipeline is
 * not a second pipeline: it cannot disagree with the feed, because it is the
 * feed folded up.
 *
 * ---------------------------------------------------------------------------
 * BOOTSTRAP IS A FEED FEATURE, NOT A PARALLEL MECHANISM
 * ---------------------------------------------------------------------------
 *
 * {@link publishBootstrap} sends a `feedBootstrap` frame carrying the cursor
 * triple it was read at. That is the difference from the snapshot fan-out it
 * replaces: the old bootstrap was a set of lists with no position in them, so a
 * client had to spend a `sync.changesSince` round trip to find out where it
 * stood, and the window between the two was covered by hope. A bootstrap that
 * carries `(feedId, epoch, seq)` makes the delta that follows contiguous by
 * construction.
 *
 * ---------------------------------------------------------------------------
 * THE COMPILE-TIME GATE STILL HOLDS
 * ---------------------------------------------------------------------------
 *
 * `LiveServerMessage` (protocol `message-class.ts`) is the type the raw fan-out
 * helpers accept, and control-plane messages fail it. Nothing here weakens that:
 * entity frames reach a socket only through this class, and this class is driven
 * only by the Authority's feed.
 */

import type { ConversationDiagnosticWire } from '@podium/model'
import type {
  FeedBootstrapMessage,
  FeedDeltaMessage,
  FeedRescopeMessage,
  FeedResyncRequiredMessage,
  ServerMessage,
} from '@podium/protocol'
import {
  MIN_SUPPORTED_VERSION,
  PeerVersionTelemetry,
  type UpgradeRequired,
  WIRE_VERSION,
  WireVersionAdapterRegistry,
  isUpgradeRequired,
  upgradeRequired,
} from '@podium/protocol'
import { LegacyWireV1Adapter } from './legacy-wire-v1-adapter'

/** The canonical frame. v2 IS the canonical shape — the current wire is never a
 *  translation of something else, or there would be two definitions of "now". */
export type FeedFrame =
  | FeedDeltaMessage
  | FeedBootstrapMessage
  | FeedRescopeMessage
  | FeedResyncRequiredMessage

/**
 * Advisory state a pre-cutover wire carried inside an entity message.
 *
 * One member, and the enum exists so adding a second is a deliberate act rather
 * than a string appearing at a call site. Every member of this type is a piece of
 * v1 debt and the type is deleted with the adapter.
 */
export type LegacyAdvisoryKind = 'conversation-diagnostics'

/** An adapter that can re-serve an advisory on demand. See {@link WireFeedEdge.publishAdvisory}. */
export interface LegacyAdvisorySource {
  advisory(kind: LegacyAdvisoryKind, peer: LegacyPeer): readonly ServerMessage[]
}

/** What an adapter may know about a connection. Deliberately tiny: an adapter
 *  that needed the connection object would be making routing decisions, and
 *  routing is the edge's. */
export interface LegacyPeer {
  /** The peer announced the v1 delta capability in its `hello`. A v1 peer that
   *  did not is a pre-delta client and is served full lists. */
  readonly acceptsDelta: boolean
}

/** The current wire needs no translation, and saying that explicitly is what
 *  keeps "v2 is canonical" from being an assumption spread across call sites. */
class IdentityWireAdapter {
  readonly version = WIRE_VERSION
  readonly name = `identity-v${WIRE_VERSION}`
  /** PERMANENT — the identity path is not a translation and outlives every one
   *  of them. The registry refuses this on any other version. */
  readonly expiry = null
  translate(frame: FeedFrame): readonly ServerMessage[] {
    return [frame]
  }
}

export interface WireFeedEdgeDeps {
  diagnostics(): ConversationDiagnosticWire[]
}

/** One connected peer, from the edge's side. */
export interface EdgePeer {
  readonly id: string
  readonly wireVersion: number
  readonly acceptsDelta: boolean
  send(message: ServerMessage): void
}

export class WireFeedEdge {
  private readonly registry: WireVersionAdapterRegistry<FeedFrame, ServerMessage, LegacyPeer>
  private readonly telemetry = new PeerVersionTelemetry()
  private readonly peers = new Map<string, EdgePeer>()

  constructor(deps: WireFeedEdgeDeps) {
    this.registry = new WireVersionAdapterRegistry<FeedFrame, ServerMessage, LegacyPeer>()
      .register(new IdentityWireAdapter())
      // TEMPORARY, and mechanically so — see `legacy-wire-v1-adapter.ts`. When
      // MIN_SUPPORTED_VERSION reaches 2, `scripts/audit-wire-adapters.ts` fails
      // while this registration exists.
      .register(new LegacyWireV1Adapter({ diagnostics: () => deps.diagnostics() }))
    // A window that advertises a version with no adapter is a boot failure, not
    // a surprise on the first old client to connect.
    this.registry.assertCoversWindow()
  }

  /**
   * Admit a peer at the version it announced, or refuse it with 426.
   *
   * An ABSENT `wireVersion` in `hello` means 1: a pre-cutover client cannot be
   * made to send a field it was never built with, so the absence IS the
   * advertisement, and every build since sends it.
   */
  attach(peer: EdgePeer): UpgradeRequired | null {
    const resolved = this.registry.resolve(peer.wireVersion)
    if (isUpgradeRequired(resolved)) return resolved
    this.peers.set(peer.id, peer)
    this.telemetry.connected(peer.id, peer.wireVersion)
    return null
  }

  detach(peerId: string): void {
    this.peers.delete(peerId)
    this.telemetry.disconnected(peerId)
  }

  /** Fan ONE frame out to every peer, each through its own version's adapter. */
  publish(frame: FeedFrame): void {
    for (const peer of this.peers.values()) this.publishTo(peer, frame)
  }

  /** Serve ONE peer — the bootstrap path, and the reconnect path. */
  publishTo(peer: EdgePeer, frame: FeedFrame): void {
    const adapter = this.registry.resolve(peer.wireVersion)
    if (isUpgradeRequired(adapter)) return
    let translated: readonly ServerMessage[]
    try {
      translated = adapter.translate(frame, { acceptsDelta: peer.acceptsDelta })
    } catch (error) {
      // An adapter refusing a frame it cannot honestly express (a v1 adapter
      // meeting an `evict`) is a LOUD failure by design — ADR 2 Am1 D14.5. It
      // must not take the process or the other peers down with it, and it must
      // not be swallowed either: the peer's view is now knowingly incomplete, so
      // it is dropped rather than left silently stale.
      console.error('[wire-edge] adapter refused a frame; dropping the peer', {
        peer: peer.id,
        wireVersion: peer.wireVersion,
        error,
      })
      this.detach(peer.id)
      return
    }
    for (const message of translated) peer.send(message)
  }

  /**
   * Re-serve an ADVISORY that is not feed content, to the peers whose wire
   * version requires it (POD-1203).
   *
   * There is exactly one today and it is a v1-only debt: `conversationsChanged`
   * carries the conversation SCAN DIAGNOSTICS as a required field. They were
   * never an entity, never had a change row, and v2 does not carry them at all —
   * so on the current wire this method has nothing to do, and that is the correct
   * resting state rather than a gap. Before the cutover the same refresh happened
   * by forcing a full-list snapshot at delta clients (`snapshotToCapClients`),
   * which is one of the thirteen call sites this issue deleted.
   *
   * Held to the adapter that needs it by DUCK TYPING rather than by widening
   * `WireVersionAdapter`: the mechanism is permanent and this is not, so the
   * permanent interface must not grow a member whose only implementor expires.
   */
  publishAdvisory(kind: LegacyAdvisoryKind): void {
    for (const peer of this.peers.values()) {
      const adapter = this.registry.resolve(peer.wireVersion)
      if (isUpgradeRequired(adapter)) continue
      const advisory = (adapter as Partial<LegacyAdvisorySource>).advisory
      if (typeof advisory !== 'function') continue
      for (const message of advisory.call(adapter, kind, { acceptsDelta: peer.acceptsDelta })) {
        peer.send(message)
      }
    }
  }

  /** Connected-peer version telemetry — the rollout's "may I raise the floor". */
  versions() {
    return this.telemetry.snapshot()
  }

  /** The window this server advertises, for the handshake and for /health. */
  support(): { wire: number; min: number } {
    return { wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION }
  }

  /** Adapters whose expiry condition has arrived. Asserted by the audit; exposed
   *  here so a running server can report it too. */
  expiredAdapters(): readonly string[] {
    return this.registry.expired().map((adapter) => adapter.name)
  }

  static refuse(offered: number): UpgradeRequired {
    return upgradeRequired(offered, { wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION })
  }
}
