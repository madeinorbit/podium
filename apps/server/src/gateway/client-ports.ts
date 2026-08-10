/**
 * THE FEATURE PORTS THE CLIENT MUX ROUTES TO (POD-390).
 *
 * Declared here — not imported from the services — so the dependency points the
 * right way: the gateway names what it needs and a feature satisfies it
 * structurally. Nothing here interprets a frame; every method body lives in the
 * owning module. The daemon mirror is `daemon-ports.ts`.
 *
 * WHERE THE PRINCIPAL APPEARS: on every method. A client frame's principal is
 * device-grade today (`client-principal.ts` says exactly what that means and
 * why), but it is on the DELIVERY PATH regardless — which is the property
 * POD-1077's scoped feed and ADR 7 Amendment 1 D9's identity-carrying presence
 * record both need, and the property that is impossible to retrofit into a port
 * whose signature never had it.
 */

import type { RoomRef } from '@podium/protocol'
import type { SessionsClientFrame } from './client-frame-routing'
import type { ClientPrincipal } from './client-principal'
import type { ClientConn } from './client-registry'

/**
 * SESSIONS. The client-facing session world: the bootstrap a fresh connection is
 * owed, the teardown its disconnect triggers, and every session-owned frame.
 * The SOCKET is not here — the connection object is handed in, and the service
 * reaches its transport only through the registry's delivery methods.
 */
export interface SessionsClientPort {
  /**
   * A client connection was admitted and registered: send it the world it is
   * owed (session list or prepared publication, issues, automations, drafts,
   * conversations, machines, approvals and host snapshot). Parked browser-open
   * requests wait for a successful session-room join. Runs AFTER `welcome`,
   * which the gateway owns.
   */
  onClientAttached(principal: ClientPrincipal, conn: ClientConn): void
  /** Move controller roles from a reconnecting user's stale connection before
   * the gateway evicts it. Both principals were authenticated by the gateway. */
  onClientReclaim(prior: ClientConn, next: ClientConn): void
  /**
   * That connection is gone. Sweep the session views and transcript subscriptions
   * it held, then recompute priorities. The registry entry is ALREADY removed
   * when this runs — see `client-mux.ts` for why that ordering is safe.
   */
  onClientDetached(principal: ClientPrincipal, conn: ClientConn): void
  /** A stream room join succeeded; apply feature-owned join consequences. */
  onRoomJoined(conn: ClientConn, room: RoomRef): void
  /** One session-owned frame, attributed to the connection it arrived on. */
  onSessionClientFrame(principal: ClientPrincipal, conn: ClientConn, msg: SessionsClientFrame): void
}

/** Everything the client mux is given. */
export interface ClientFeaturePorts {
  sessions: SessionsClientPort
}
