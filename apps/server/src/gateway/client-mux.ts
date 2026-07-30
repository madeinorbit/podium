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
 * THE PRINCIPAL — AND WHY IT IS WEAKER THAN THE DAEMON'S, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * Every routed frame carries a principal resolved from the AUTHENTICATED
 * TRANSPORT (ADR 3 D7 / ADR 5 D5), never from a payload. On this plane that
 * principal is DEVICE-GRADE: one shared password, no user column on
 * `client_sessions` (POD-351, `docs/multi-user-readiness.md` §3.2). The full
 * reasoning — and why it is still a `UserPrincipal` object rather than a
 * bespoke kind — is in `client-principal.ts`.
 *
 * The forgery vector this plane actually has is `hello.clientId`: a PAYLOAD
 * field naming another connection, used by the reconnect reclaim to move
 * controller roles. It is a real payload identity and it is deliberately NOT the
 * routing identity — `routeClientFrame` looks the connection up by the
 * SOCKET-derived id and hands the port that connection's principal, so a frame
 * claiming to be someone else is still delivered as itself. `client-mux.test.ts`
 * pins that with a forged frame.
 *
 * What that does NOT do is make the reclaim a guarded capability. Under today's
 * device-grade principal it cannot be one: two connections holding the same
 * shared password are indistinguishable as persons, so "may this principal
 * reclaim that client" has no answer better than the existing single-user trust
 * note. Behaviour is therefore preserved exactly, the gap is recorded here and
 * reported, and the enforcement point is ready — the port receives a principal.
 *
 * ---------------------------------------------------------------------------
 * FAN-OUT: THE ONE PLACE THIS IS NOT THE DAEMON MIRROR
 * ---------------------------------------------------------------------------
 * The daemon plane is 1:1. This one is 1:many, and WHO RECEIVES WHAT is decided
 * by per-connection subscription state. That state, and the selectors reading
 * it, are unchanged by this extraction — see `client-registry.ts` for the exact
 * mechanism/selection split and for what POD-1077 still has to build.
 */

import type { ClientMessage } from '@podium/protocol'
import {
  type ClientPortId,
  clientPlaneClassFor,
  clientPortsFor,
  type SessionsClientFrame,
} from './client-frame-routing'
import type { ClientFeaturePorts } from './client-ports'
import type { ClientPrincipal } from './client-principal'
import { deviceClientPrincipal } from './client-principal'
import type { ClientConn, ClientRegistry } from './client-registry'
import type { ClientPublicationAuthority } from '../modules/sessions/session'

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
  presence: toSessions,
  viewState: toSessions,
  setSessionDraft: toSessions,
  draftEdit: toSessions,
  sessionOpenUrlCallback: toSessions,
  sessionOpenUrlDismiss: toSessions,

  // ---- transport: the gateway answers its own liveness echo ----
  ping: (mux, conn) => mux.registry.deliver(conn, { type: 'pong' }),
}

/** What a socket hands the mux when it attaches. Transport facts only. */
export interface ClientTransport {
  /** Outbound sink for this socket (backpressure-guarded by the caller). */
  send: ClientConn['send']
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
  typeof peer === 'function'
    ? { send: peer, ...(publication ? { publication } : {}) }
    : peer

export interface ClientMuxDeps {
  readonly ports: ClientFeaturePorts
  readonly registry: ClientRegistry
}

export class ClientMux {
  constructor(private readonly deps: ClientMuxDeps) {}

  get ports(): ClientFeaturePorts {
    return this.deps.ports
  }

  get registry(): ClientRegistry {
    return this.deps.registry
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
    const conn: ClientConn = {
      id,
      // TRANSPORT-DERIVED, always. The connection id is minted above and is the
      // only input; nothing a client can send participates.
      principal: deviceClientPrincipal(id),
      send: transport.send,
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
    this.deps.registry.delete(id)
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
