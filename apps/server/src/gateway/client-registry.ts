/**
 * THE CLIENT CONNECTION REGISTRY — the subscription set, and the one place a
 * byte reaches a browser socket (POD-390, under POD-317's gateway).
 *
 * `ClientConn` and the map holding them used to be `SessionsService.clients`:
 * one feature owned the socket set that machines, hosts, issues, conversations
 * and drafts all fan out through (`relay.ts` even hands `sessionsSvc.clients`
 * to the machines service). The record holds the SOCKET — `send` closes over a
 * `ws` — so under ADR 7 it belongs to the gateway plane, not to a feature.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED, AND WHAT DELIBERATELY DID NOT — read this before extending it
 * ---------------------------------------------------------------------------
 * The daemon plane is 1:1. This plane is 1:many, so it stores the transport
 * endpoints chosen by the shared subscription registry and by feature-owned
 * selectors for their existing vertical behavior.
 *
 * MECHANISM moved here. SELECTION did not, and moving it would have been a
 * rewrite of the publication pipeline rather than an extraction — the exact
 * "large surprise diff" this fan-out cannot afford. The split is deliberate and
 * it is the one a scoped feed wants:
 *
 *   - the gateway owns the connection set, its identity, its lifecycle, and
 *     `deliver` / `deliverPrepared` / `broadcast` — every write to a client
 *     socket goes through one of the three;
 *   - the feature decides WHICH connections a given message is for, and says so
 *     by calling those methods.
 *
 * Per-principal feed and per-room stream selection now share one external
 * registry. This object remains the final transport lookup and never evaluates
 * authorization itself.
 */

import type { Geometry, SessionId } from '@podium/model'
import type { MetadataChange, ServerMessage } from '@podium/protocol'
import type { ClientPublicationAuthority, Send } from '../modules/sessions/session'
import type { ClientPrincipal } from './client-principal'

/**
 * ONE `/client` connection: its transport, its authenticated principal, and the
 * subscription state that decides what it receives.
 *
 * Moved verbatim from `modules/sessions/session.ts` (POD-390) except for
 * `principal`, which is new and is the whole point — see `client-principal.ts`.
 * The publication AUTHORITY type stays in the sessions module: it is a policy
 * artifact that feature owns, and the gateway only carries it (POD-389 already
 * imports `PublicationAuthority` the same way in `ws-server.ts`).
 */
export interface ClientConn {
  id: string
  /**
   * The AUTHENTICATED principal for this socket. Device-grade today
   * ({@link ClientPrincipal}); resolved by `client-socket.ts` from transport
   * facts and NEVER from a frame body.
   */
  principal: ClientPrincipal
  send: Send<ServerMessage>
  /** Lossy stream sink. False means the frame was dropped under pressure. */
  sendStream?: (message: ServerMessage) => boolean
  publication?: ClientPublicationAuthority
  /** A current worker publication has reached this socket. */
  publicationBootstrapped?: boolean
  publicationPending?: boolean
  publicationRequestVersion?: number
  publicationAccepted?: {
    viewKey: string
    viewRevision: number
    allowedSignature: string
    cursor: number
    allowedSessionIds: readonly string[]
  }
  /** A revocation frame was emitted and must be followed by a replacement. */
  publicationReplacementRequired?: boolean
  /** Previously-visible ids already removed while a replacement is pending. */
  publicationRevokedSessionIds?: Set<string>
  /** Global-only funnel frames held behind an in-flight bootstrap/replacement. */
  publicationBufferedChanges?: MetadataChange[][]
  /** Last grid this client measured for each terminal it mounted. Geometry is
   * session-specific: split panes can have different widths, and the 80x24
   * viewport in `hello` is only a transport bootstrap default. Sharing one
   * viewport across sessions can resize the foreground PTY from another pane. */
  viewports: Map<string, Geometry>
  attached: Set<SessionId>
  /** Feature caps from the client's `hello` (e.g. CAP_METADATA_DELTA). Empty until
   *  hello arrives, so a pre-hello client is treated as legacy — it receives
   *  snapshot broadcasts, never deltas it hasn't asked for. */
  caps: Set<string>
  /**
   * The WIRE VERSION this connection negotiated (POD-1203).
   *
   * 1 until `hello` says otherwise, and the ABSENCE of the field in `hello` also
   * means 1: a pre-cutover client cannot be made to send a field it was never
   * built with, so the absence IS the advertisement. This is what the serving
   * edge resolves an adapter from; the connection itself never interprets it.
   */
  wireVersion: number
  /**
   * This connection announced a wire version outside the supported window, and
   * is served NO entity state at all (POD-1203).
   *
   * Not derivable from {@link wireVersion} here: the window is the gateway's
   * (`WireFeedEdge.support()`), and re-deriving "is this supported?" in the
   * feature that reads this flag would be a second answer to a question the edge
   * already answers. It is set once, by the mux, from the edge's own refusal.
   */
  entityServingRefused?: boolean
  /** Session ids this client subscribed to the structured transcript of. Lets
   *  detach sweep just this client's subscriptions instead of scanning every
   *  session on the host (audit P2-18). */
  transcriptSubs: Set<SessionId>
  /** Page-visibility presence — drives smart notification routing. */
  visible: boolean
  /** Sessions this client currently RENDERS on screen (from viewState). */
  viewVisible: Set<SessionId>
  /** The one session that has input focus on this client, or null. */
  focused: SessionId | null
  /** Per-session rendered mode (native terminal vs chat) this client reports for the
   *  sessions it renders (from viewState `modes`). AVAILABLE for inspection but
   *  deliberately UNUSED by output scheduling — computePriorities never reads it, so
   *  relay/coalescing stays mode-agnostic (the terminal stays warm for native bounce-back). */
  viewModes: Record<string, 'native' | 'chat'>
}

/** Live-only fan-out payload. Durable entity messages ride the write funnel's
 *  publish tail instead — the sessions service's `broadcastToClients` states
 *  that constraint in its own (narrower) type and this method inherits it. */
export type ClientBroadcastOptions = {
  /** Skip the originator (draft echo suppression). */
  exceptClientId?: string
}

/**
 * The connection set. Owned by the gateway, read by the features that select
 * recipients. Intentionally NOT a policy object: it has no notion of who may
 * see what, and adding one here would be a second authorization surface (ADR 9
 * D4 — the resolver belongs to the policy layer).
 */
export class ClientRegistry {
  private readonly conns = new Map<string, ClientConn>()
  private nextClientNum = 0

  /** Mint the next connection id. Server-side only; a client cannot choose it. */
  nextId(): string {
    return `c${this.nextClientNum++}`
  }

  add(conn: ClientConn): void {
    this.conns.set(conn.id, conn)
  }

  delete(id: string): boolean {
    return this.conns.delete(id)
  }

  get(id: string): ClientConn | undefined {
    return this.conns.get(id)
  }

  values(): IterableIterator<ClientConn> {
    return this.conns.values()
  }

  get size(): number {
    return this.conns.size
  }

  /** One message to ONE connection. The narrow waist every feature send goes
   *  through, so a later scoped feed has exactly one place to gate. */
  deliver(conn: ClientConn, msg: ServerMessage): void {
    conn.send(msg)
  }

  deliverStream(subscriberId: string, msg: ServerMessage): boolean {
    const conn = this.conns.get(subscriberId)
    if (!conn) return false
    if (conn.sendStream) return conn.sendStream(msg)
    conn.send(msg)
    return true
  }

  /** Pre-encoded bytes to one connection (the publication worker's output).
   *  Returns false when the connection has no prepared sink — the caller's
   *  existing `if (client.publication)` guards are unchanged by this. */
  deliverPrepared(conn: ClientConn, bytes: string): boolean {
    if (!conn.publication) return false
    conn.publication.sendPrepared(bytes)
    return true
  }

  /**
   * Raw fan-out to EVERY connected client, in insertion order — the mechanism
   * behind `SessionsService.broadcastToClients`, moved unchanged. No filtering
   * beyond `exceptClientId`, which is the pre-existing draft-echo suppression.
   */
  broadcast(msg: ServerMessage, opts: ClientBroadcastOptions = {}): void {
    for (const conn of this.conns.values()) {
      if (conn.id === opts.exceptClientId) continue
      this.deliver(conn, msg)
    }
  }
}
