/**
 * THE `/client` SOCKET — transport only (POD-390, the mirror of `daemon-socket.ts`).
 *
 * This file holds the connection: the publication authority resolved off the
 * upgrade request, the frames in, the backpressure, the close. It holds NO
 * routing table and NO feature logic — it hands the connection to
 * {@link ClientMux} and stops. Before this extraction the equivalent code called
 * `registry.modules.sessions.attachClient/onClientMessage/detachClient`, which
 * made one feature the multiplexer — and the socket owner — for every other
 * feature's client traffic.
 *
 * WHERE THE COOKIE GATE IS. NOT here: the `/client` upgrade is refused in
 * `ws-server.ts` (`auth.authorizeClient`) before a socket exists, which is the
 * pre-extraction placement and the correct one — a rejected upgrade must never
 * become a connection this module can see. This file is only reached by an
 * upgrade that already passed it.
 *
 * THE PRINCIPAL IS MINTED FROM TRANSPORT FACTS. This module never reads an
 * identity out of a frame; it does not construct a principal at all. The mux
 * derives it from the connection id it mints (`client-principal.ts`), so there
 * is no path here through which a payload value could become a routing identity.
 */

import type { IncomingMessage } from 'node:http'
import type { UserId, UserRole } from '@podium/model'
import { parseClientMessage, WIRE_VERSION } from '@podium/protocol'
import type { PublicationAuthority } from '../modules/sessions/session'
import type { SessionRegistry } from '../relay'
import { CLIENT_PLANE_LIVENESS } from './plane-liveness'
import { warnDroppedFrame } from './ws-send'

/** How the main authority is resolved for one upgrade, plus its fallbacks. */
export interface ClientAuthorityOptions {
  /** Account resolved from the authenticated upgrade cookie. */
  userId?: UserId
  userRole?: UserRole
  /** Resolve a revocable, request-specific publication world on the real socket path. */
  resolvePublicationAuthority?: (req: IncomingMessage) => PublicationAuthority
  serverRole?: string
}

/**
 * Per-client-socket lifecycle. Resolve the publication world, register the
 * connection with the gateway mux under a transport-derived principal, and route
 * every later frame through it.
 *
 * A connection whose authority cannot be resolved is TERMINATED rather than
 * admitted with a default world — fail closed, unchanged from the pre-extraction
 * behaviour.
 *
 * Returns the connection id, or `undefined` when the socket was refused.
 * Outbound frames go through {@link safeSend} (backpressure + never-throws); the
 * caller layers the heartbeat sweep on top.
 */
export function wireClientSocket(
  ws: import('ws').WebSocket,
  req: IncomingMessage,
  registry: SessionRegistry,
  auth: ClientAuthorityOptions = {},
): string | undefined {
  if (auth.userId === undefined || auth.userRole === undefined) {
    console.warn('[podium] rejected client with incomplete authenticated account')
    ws.terminate()
    return undefined
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rawVersion = url.searchParams.get('v') ?? url.searchParams.get('pv')
  const protocolVersion = rawVersion === null ? WIRE_VERSION : Number(rawVersion)
  let authority: PublicationAuthority
  try {
    authority = auth.resolvePublicationAuthority?.(req) ?? {
      principal: 'user:' + auth.userId,
      scope: 'principal:user:' + auth.userId,
      serverRole: auth.serverRole ?? 'standalone',
      protocolVersion,
      global: true,
      snapshot: () => ({
        revision: 0,
        allowedSignature: 'global',
        allowedSessionIds: [],
      }),
    }
  } catch (error) {
    console.warn('[podium] rejected client with invalid publication authority', error)
    ws.terminate()
    return undefined
  }
  // The plane applies its own budget: this file never names a byte count, so it
  // cannot name the daemon plane's (POD-391).
  const sink = CLIENT_PLANE_LIVENESS.sink(ws)
  const id = registry.clientGateway.attachClient({
    send: sink.send,
    sendStream: sink.sendLossy,
    userId: auth.userId,
    userRole: auth.userRole,
    publication: { ...authority, sendPrepared: sink.sendPrepared },
  })
  ws.on('message', (raw: import('ws').RawData) => {
    try {
      // The frame is parsed here and CLASSIFIED in the mux. The connection id
      // passed is this socket's own — a `clientId` in the payload (`hello` has
      // one, for the reconnect reclaim) can never become the routing identity.
      registry.clientGateway.routeClientFrame(id, parseClientMessage(raw.toString()))
    } catch (err) {
      // Drop the malformed frame (don't let it tear down the connection) — but
      // never silently: a silent drop here hides protocol drift / poison frames.
      warnDroppedFrame('client', err)
    }
  })
  ws.on('close', () => registry.clientGateway.detachClient(id))
  return id
}
