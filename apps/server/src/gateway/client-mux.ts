/**
 * THE CLIENT SOCKET MUX (POD-390, under POD-317's gateway).
 *
 * `attachClient`, `detachClient` and `onClientMessage` used to be methods on the
 * SESSIONS SERVICE. That made one feature the multiplexer for every other
 * feature's client traffic — and, worse than on the daemon side, the owner of
 * the SOCKET SET that machines, hosts, issues, conversations and drafts all fan
 * out through. They live here now. The sessions service keeps the session half
 * (what a client is owed, what its frames mean) and holds no socket.
 *
 * WHAT THIS MODULE OWNS: the connection lifecycle, the connection's principal,
 * and the routing table. Nothing else. The daemon mirror is `daemon-mux.ts`;
 * where this file deviates from it, the deviation is called out below.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPAL
 * ---------------------------------------------------------------------------
 * Every routed frame carries a principal resolved from the AUTHENTICATED
 * TRANSPORT (ADR 3 D7 / ADR 5 D5), never from a payload. On this plane that
 * principal is `(user, device, capability)`: the accepted client-session cookie
 * supplies the user and role, the server-minted connection supplies the device,
 * and the capability remains opaque to this router. See `client-principal.ts`.
 *
 * The forgery vector this plane actually has is `hello.clientId`: a PAYLOAD
 * field naming another connection, used by the reconnect reclaim to move
 * controller roles. It is a real payload identity and it is deliberately NOT the
 * routing identity — `routeClientFrame` looks the connection up by the
 * SOCKET-derived id and hands the port that connection's principal, so a frame
 * claiming to be someone else is still delivered as itself. `client-mux.test.ts`
 * pins that with a forged frame.
 *
 * ---------------------------------------------------------------------------
 * FAN-OUT: THE ONE PLACE THIS IS NOT THE DAEMON MIRROR
 * ---------------------------------------------------------------------------
 * The daemon plane is 1:1. This one is 1:many, and WHO RECEIVES WHAT is decided
 * by the shared subscription registry. Durable feed delivery and lossy room
 * delivery share its routing keys; the plane ports own their differing policy.
 */

import type { UserId, UserRole } from '@podium/model'
import {
  CAP_METADATA_DELTA,
  type ClientMessage,
  type PresenceRoomClientMessage,
} from '@podium/protocol'
import type { ClientPublicationAuthority } from '../modules/sessions/session'
import {
  type ClientPortId,
  clientPlaneClassFor,
  clientPortsFor,
  type SessionsClientFrame,
} from './client-frame-routing'
import type { ClientFeaturePorts } from './client-ports'
import type { ClientPrincipal } from './client-principal'
import { feedPrincipalOf, userClientPrincipal } from './client-principal'
import type { ClientConn, ClientRegistry } from './client-registry'
import type { FeedServing } from './feed-serving'
import type { PresenceRouting } from './presence-routing'

/**
 * Per-frame dispatch, TOTAL over `ClientMessage` by construction: the value is a
 * function per type, and `satisfies` makes a missing type a compile error. There
 * is no string-built method name and no `any` — a reviewer reads the owner of
 * every frame off one table.
 */
type Dispatcher = {
  [K in ClientMessage['type']]: (
    mux: ClientMux,
    conn: ClientConn,
    msg: Extract<ClientMessage, { type: K }>,
  ) => void
}

const toSessions = (mux: ClientMux, conn: ClientConn, msg: SessionsClientFrame): void =>
  mux.ports.sessions.onSessionClientFrame(conn.principal, conn, msg)

const toPresence = (mux: ClientMux, conn: ClientConn, msg: PresenceRoomClientMessage): void =>
  mux.presence.route(conn, msg)

const DISPATCH: Dispatcher = {
  // ---- sessions ----
  hello: toSessions,
  attach: toSessions,
  detach: toSessions,
  input: toSessions,
  resize: toSessions,
  requestControl: toSessions,
  redrawRequest: toSessions,
  transcriptSubscribe: toSessions,
  transcriptUnsubscribe: toSessions,
  presence: (mux, conn, msg) => mux.presence.setVisible(conn, msg.visible),
  viewState: toSessions,
  setSessionDraft: toSessions,
  draftEdit: toSessions,
  sessionOpenUrlCallback: toSessions,
  sessionOpenUrlDismiss: toSessions,

  // ---- stream rooms ----
  presenceSubscribe: toPresence,
  presenceUnsubscribe: toPresence,
  presenceUpdate: toPresence,

  // ---- transport: the gateway answers its own liveness echo ----
  ping: (mux, conn) => mux.registry.deliver(conn, { type: 'pong' }),
}

/** What a socket hands the mux when it attaches. Transport facts only. */
export interface ClientTransport {
  /** Authenticated account stamped by the websocket upgrade. */
  userId?: UserId
  userRole?: UserRole
  /** Outbound sink for this socket (backpressure-guarded by the caller). */
  send: ClientConn['send']
  /** Lower-budget lossy sink for stream.live room fan-out. */
  sendStream?: ClientConn['sendStream']
  /** Prepared-bytes sink + the main authority's publication world, when one was
   *  resolved for this request. Absent = the unscoped legacy path. */
  publication?: ClientPublicationAuthority
}

/**
 * Either a transport record (the socket path) or a bare sink — the IN-PROCESS
 * form used by the oracle harness and the test fixtures, the client-plane mirror
 * of `DaemonPeer`'s bare machine id. A sink can carry no publication authority
 * and no socket, so nothing admitted through it can widen what a connection is.
 */
export type ClientPeer = ClientTransport | ClientConn['send']

const transportOf = (
  peer: ClientPeer,
  publication?: ClientPublicationAuthority,
): ClientTransport =>
  typeof peer === 'function' ? { send: peer, ...(publication ? { publication } : {}) } : peer

export interface ClientMuxDeps {
  readonly ports: ClientFeaturePorts
  readonly registry: ClientRegistry
  /**
   * THE SERVING EDGE (POD-1203) — where entity truth leaves this server.
   *
   * A gateway object and not a feature port: it owns the connection's WIRE
   * VERSION, which is a transport fact, and it is the mux that knows when a
   * connection appears, announces itself, and goes away. What the sessions port
   * still owns is how a message reaches one connection (`deliverEntityMessage`).
   */
  readonly feed: FeedServing
  readonly presence: PresenceRouting
  /** Non-session bootstrap assembled after every contributing feature exists. */
  readonly bootstrap: (conn: ClientConn) => void
}

export class ClientMux {
  constructor(private readonly deps: ClientMuxDeps) {}

  get ports(): ClientFeaturePorts {
    return this.deps.ports
  }

  get registry(): ClientRegistry {
    return this.deps.registry
  }

  get presence(): PresenceRouting {
    return this.deps.presence
  }

  /**
   * A client socket connected. Mint its id and principal, register it, tell it
   * its id, then hand it to the sessions port for the bootstrap it is owed.
   *
   * The ORDER is the pre-extraction order exactly: the connection is in the
   * registry BEFORE `welcome` and before the bootstrap sends, because the
   * bootstrap path re-enters the service (`schedulePreparedSessionPublications`
   * walks the connection set and must see this one).
   */
  attachClient(peer: ClientPeer, publication?: ClientPublicationAuthority): string {
    const transport = transportOf(peer, publication)
    const id = this.deps.registry.nextId()
    if (transport.userId === undefined || transport.userRole === undefined) {
      throw new Error('authenticated client identity is unavailable')
    }
    const principal = userClientPrincipal(id, transport.userId, transport.userRole)
    const conn: ClientConn = {
      id,
      // TRANSPORT-DERIVED, always. The connection id is minted above and is the
      // only input; nothing a client can send participates.
      principal,
      send: transport.send,
      sendStream:
        transport.sendStream ??
        ((message) => {
          transport.send(message)
          return true
        }),
      ...(transport.publication ? { publication: transport.publication } : {}),
      publicationBootstrapped: false,
      publicationPending: false,
      publicationRequestVersion: 0,
      publicationBufferedChanges: [],
      viewports: new Map(),
      attached: new Set(),
      // No caps until hello — the feature's bootstrap snapshots go to everyone
      // (a delta client uses them as its initial paint, then takes a cursor via
      // sync.changesSince and rides the metadataDelta stream).
      caps: new Set(),
      // Wire 1 until `hello` says otherwise — see `renegotiate`.
      wireVersion: 1,
      transcriptSubs: new Set(),
      // Fail-safe toward notifying: a client counts as NOT watching until it
      // tells us otherwise (every browser client sends `presence` right after
      // connecting). Defaulting to visible:true let one stale/non-browser client
      // silently suppress all mobile push forever.
      visible: false,
      // View-state defaults to "renders nothing, focuses nothing" until the client
      // sends its first `viewState`. A session reads as unwatched (tier 3) until then.
      viewVisible: new Set(),
      focused: null,
      // Rendered-mode map (native/chat) per session. Stored from viewState but NOT
      // consulted by scheduling — see ClientConn.viewModes.
      viewModes: {},
    }
    this.deps.registry.add(conn)
    // `welcome` is the gateway's frame: it carries the id THIS module minted, and
    // it is what makes the reconnect reclaim's `hello.clientId` a server-issued
    // value rather than a client-chosen one.
    this.deps.registry.deliver(conn, { type: 'welcome', clientId: id })
    this.deps.ports.sessions.onClientAttached(conn.principal, conn)
    this.deps.bootstrap(conn)
    // THE FEED, LAST, and at wire 1 without the delta capability — because that
    // is everything this server honestly knows about a socket that has not spoken
    // yet, and it is the same assumption the pre-cutover code stated ("a pre-hello
    // client is treated as legacy"). `hello` moves it (see `routeClientFrame`).
    // AFTER the port call, so the bootstrap lands after the non-feed world in the
    // same order a client saw before the cutover.
    // A scoped prepared-publication connection has its own filtered entity
    // authority. Enrolling it in the kernel feed as well would create two worlds
    // and, at wire v2, attempt to hand it an unprepared bootstrap.
    if (conn.publication?.global !== false) {
      this.deps.feed.attach(this.peerOf(conn), feedPrincipalOf(conn.principal), conn.principal)
    }
    return id
  }

  /**
   * That client's socket closed.
   *
   * The registry entry is removed BEFORE the port sweep, which is a deliberate
   * (and behaviour-identical) reordering of the pre-extraction body: the sweep
   * reads the CONNECTION's own `attached` / `transcriptSubs` sets and the
   * per-session client maps, never the registry, and everything the old code ran
   * after its `this.clients.delete(id)` — priority recompute, session broadcast —
   * runs inside the port call. Deleting first means no re-entrant fan-out can
   * reach a socket that is already gone.
   */
  detachClient(id: string): void {
    const conn = this.deps.registry.get(id)
    if (!conn) return
    this.deps.presence.disconnect(conn)
    this.deps.registry.delete(id)
    this.deps.feed.detach(id)
    this.deps.ports.sessions.onClientDetached(conn.principal, conn)
  }

  /**
   * Route ONE inbound client frame to the port that owns it.
   *
   * An unknown type is DROPPED, never guessed at: a gateway that cannot classify
   * a frame must refuse it (POD-317's no-local-reclassification rule). Both
   * lookups have to answer — the ADR 7 plane inventory AND the owner table — so a
   * frame classified in one and forgotten in the other cannot slip through as a
   * default. A frame for an unknown connection is likewise dropped: there is no
   * principal to route it under.
   */
  routeClientFrame(id: string, msg: ClientMessage): void {
    const conn = this.deps.registry.get(id)
    if (!conn) return
    if (clientPlaneClassFor(msg.type) === null || clientPortsFor(msg.type) === null) {
      console.warn(`[podium] refused unclassified client frame '${msg.type}'`)
      return
    }
    const dispatch = DISPATCH[msg.type] as (
      mux: ClientMux,
      conn: ClientConn,
      msg: ClientMessage,
    ) => void
    dispatch(this, conn, msg)
    if (msg.type === 'hello' && msg.clientId && msg.clientId !== conn.id) {
      this.reclaim(msg.clientId, conn)
    }
    // NEGOTIATION, AFTER THE PORT AND ONLY FOR `hello`. The port is what applies
    // `hello.caps` to the connection, so reading them before it ran would
    // renegotiate against the previous state. This is the ONLY frame the gateway
    // acts on for itself beyond the routing table, and it acts on the two
    // transport facts `hello` carries: the wire version and the delta capability.
    if (msg.type === 'hello' && conn.publication?.global !== false) {
      this.renegotiate(conn, msg.wireVersion)
    }
  }

  /**
   * Move a connection to the wire version its `hello` announced, or refuse it.
   *
   * REFUSAL IS SILENCE ON THE ENTITY PLANE, deliberately. There is no `426`
   * ServerMessage to send — the browser's own guard already polls `/version` and
   * hard-reloads a bundle outside the window (`apps/web/.../version-guard.ts`),
   * which is the working half of the backstop. What this must not do is serve a
   * peer frames it cannot parse, so a refused peer is left registered (its
   * control-plane traffic still works) and receives no entity frames at all
   * until it reloads into a supported build.
   */
  private renegotiate(conn: ClientConn, announced: number | undefined): void {
    // ABSENT MEANS 1. A pre-cutover client cannot send a field it was never built
    // with, so the absence is the advertisement.
    conn.wireVersion = announced ?? 1
    const refusal = this.deps.feed.renegotiate(
      this.peerOf(conn),
      feedPrincipalOf(conn.principal),
      conn.principal,
    )
    if (refusal === null) return
    // DROPPED FROM THE SERVING SET, not merely un-resolvable. Until `hello` a
    // socket is admitted at wire 1 — the only honest reading of silence — so a
    // beyond-window peer has already been served a v1 world and holds a framing
    // position. Leaving it there would keep the publisher certifying ranges for a
    // connection nothing can translate for, and the first adapter that DID cover
    // its version would start mid-stream.
    this.deps.feed.detach(conn.id)
    // The prepared-publication worker is a SEPARATE delivery path (it serves a
    // scoped connection its own filtered session view) and the edge cannot reach
    // it. Without this flag a refused peer keeps receiving the worker's v1
    // `sessionsChanged` — measured, as a flake in the wire-window test that
    // passed or failed on scheduling order alone.
    conn.entityServingRefused = true
    console.warn('[podium] client outside the supported wire window; not serving the feed', {
      client: conn.id,
      refusal,
    })
  }
  private reclaim(priorId: string, next: ClientConn): void {
    const prior = this.deps.registry.get(priorId)
    if (!prior || prior.id === next.id) return
    if (prior.principal.user !== next.principal.user) {
      console.warn('[podium] refused cross-user client reconnect reclaim', {
        prior: prior.id,
        next: next.id,
      })
      return
    }
    this.deps.ports.sessions.onClientReclaim(prior, next)
    this.detachClient(prior.id)
  }

  /**
   * The connection, as the serving edge sees it: an id, a version, whether it
   * takes deltas, and a sink.
   *
   * Built fresh per call rather than stored, because every field is read off the
   * connection — a cached peer is a second copy of a connection's negotiated
   * state, and the two would drift at exactly the moment one of them changed.
   */
  private peerOf(conn: ClientConn) {
    return {
      id: conn.id,
      wireVersion: conn.wireVersion,
      acceptsDelta: conn.caps.has(CAP_METADATA_DELTA),
      send: (msg: Parameters<typeof this.deps.ports.sessions.deliverEntityMessage>[1]) => {
        this.deps.ports.sessions.deliverEntityMessage(conn, msg)
      },
    }
  }

  /** The principal a connection routes under — exposed for the routing audit. */
  principalOf(id: string): ClientPrincipal | undefined {
    return this.deps.registry.get(id)?.principal
  }

  /** Which port(s) own a frame type — exposed for the routing audit. */
  static portsFor(type: string): readonly ClientPortId[] | null {
    return clientPortsFor(type)
  }
}
