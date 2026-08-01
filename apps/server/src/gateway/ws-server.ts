/**
 * THE GATEWAY'S WS TRANSPORT — the upgrade gate, the two peer sockets, and the
 * per-plane liveness sweeps (POD-389; moved here from `apps/server/src/wsServer.ts`).
 *
 * The gateway is now the ONLY place `ws` types are imported: no feature module
 * touches a socket. BOTH halves hand their frames to a mux and stop —
 * `daemon-socket.ts` → `daemon-mux.ts` (POD-389) and `client-socket.ts` →
 * `client-mux.ts` (POD-390). This file is the upgrade gate and the liveness
 * sweeps; it knows about no feature and no frame type.
 */

import type { IncomingMessage, Server } from 'node:http'
import type { UserId, UserRole } from '@podium/model'
import { versionSupport } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { PublicationAuthority } from '../modules/sessions/session'
import type { SessionRegistry } from '../relay'
import { wireClientSocket } from './client-socket'
import { wireDaemonSocket } from './daemon-socket'
import {
  CLIENT_PLANE_LIVENESS,
  DAEMON_PLANE_LIVENESS,
  type HeartbeatSocket,
  type SweepTimers,
} from './plane-liveness'

export interface WsHandle {
  close(): Promise<void>
}

export interface WsAuthOptions {
  /**
   * Gate for the human-client (/client) WS upgrade. Returns false to reject the upgrade
   * (the password is set and the request carries no valid session cookie). Absent =
   * surface is open (loopback/all-in-one, or the user opted out of login). The /daemon
   * link is unaffected — it has its own pre-auth handshake.
   */
  authorizeClient?: (req: IncomingMessage) => boolean
  /** Resolve the authenticated account for the client socket. Present in production. */
  userForClient?: (req: IncomingMessage) => UserId | undefined
  roleForClient?: (req: IncomingMessage) => UserRole | undefined
  /** Resolve a revocable, request-specific publication world on the real socket path. */
  resolvePublicationAuthority?: (req: IncomingMessage) => PublicationAuthority
  /** ViewKey identity supplied by the main authority (defaults to local operator). */
  principal?: string
  scope?: string
  serverRole?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The hostname portion of a `Host` header (drops the port; tolerates IPv6 brackets). */
function hostHeaderName(host: string | undefined): string | undefined {
  if (!host) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/**
 * Cross-Site-WebSocket-Hijacking defense for the WS upgrades. A browser sends an `Origin`
 * header it can't forge; a native client (the daemon, the `ws` lib) sends none. We allow:
 * no Origin (native), the desktop webview (`tauri:`), loopback origins, and same-origin
 * (Origin host == request Host).
 *
 * Crucially, we ALSO allow when the request's own `Host` is loopback. Behind a reverse proxy
 * (tailscale serve / nginx / caddy, which set `changeOrigin`) the backend's Host is rewritten
 * to its internal loopback address, so an Origin==Host comparison can never match a real
 * browser origin — the edge owns origin policy there. We therefore only *enforce* same-host
 * when the backend is bound to a real network host (direct exposure). The comparison is
 * hostname-only (port-insensitive): a TLS terminator forwards on a different port than the
 * public one, and same-host/different-port isn't the CSWSH threat. SameSite=Lax on the
 * session cookie is the primary CSWSH protection regardless; this is defense-in-depth.
 */
export function isAllowedWsOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'tauri:') return true
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true
  // Proxied or local backend → can't/needn't verify the public origin here.
  const reqHost = hostHeaderName(host)
  if (LOOPBACK_HOSTS.has(reqHost ?? '')) return true
  // Direct network exposure: require the Origin's hostname to match the request's, so a
  // foreign site (evil.example) is rejected while any port on our own host is allowed.
  return Boolean(reqHost) && parsed.hostname === reqHost
}

/**
 * Test seam for the two sweeps' clock (POD-391). Production passes nothing and
 * gets real timers. It exists because the ONE thing the policy objects cannot
 * enforce for themselves is which SOCKET SET each is handed here — pairing the
 * client set with the daemon plane's policy still compiles, and did survive a
 * mutation of exactly that line. Injecting the clock lets the pairing be asserted
 * without waiting 15 real seconds on a loaded host.
 */
export interface WsTransportDeps {
  timers?: SweepTimers
}

export function attachWebSockets(
  server: Server,
  registry: SessionRegistry,
  auth: WsAuthOptions = {},
  deps: WsTransportDeps = {},
): WsHandle {
  const daemonWss = new WebSocketServer({ noServer: true })
  const clientWss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // Reject a peer on an unsupported wire protocol with a clear 426 so it can tell the
    // user to update, rather than failing later on a malformed frame. A peer that sends
    // no `v` (older client) is allowed through unchanged.
    if (pathname === '/daemon' || pathname === '/client') {
      const raw = url.searchParams.get('v') ?? url.searchParams.get('pv') // 'pv' = deprecated alias
      if (raw !== null && versionSupport(Number(raw)) !== 'ok') {
        socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n')
        socket.destroy()
        return
      }
      // Cross-site WebSocket hijacking guard — reject a browser whose Origin isn't ours.
      if (!isAllowedWsOrigin(req.headers.origin, req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }
    if (pathname === '/daemon') {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit('connection', ws, req))
    } else if (pathname === '/client') {
      // Gate the human-client surface: if a login password is set, the upgrade must carry
      // a valid session cookie. Browsers send same-origin cookies on the WS handshake, so
      // the gate reads them off the upgrade request — mirroring the cookie the /trpc and
      // /files HTTP guards check, one shared definition of "authed".
      if (
        (auth.userForClient && auth.userForClient(req) === undefined) ||
        (auth.roleForClient && auth.roleForClient(req) === undefined) ||
        (auth.authorizeClient && !auth.authorizeClient(req))
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  // Liveness marks for the daemon socket: present = ponged since the last sweep.
  const aliveDaemons = new WeakSet<HeartbeatSocket>()
  daemonWss.on('connection', (ws) => {
    // Pre-auth handshake gate: drop non-handshake first frames; the first hello/pair →
    // the machine strategies → attach as the authenticated machine PRINCIPAL. UNIFIED
    // auth — the same-host daemon authenticates as the local machine through the SAME
    // hello path as any remote (the server pre-registered 'local' via ensureLocalMachine
    // + adopted its '__local__' rows at startup, so its data is attributed regardless).
    // No bootstrap special-case, and no extra trust for being local. The heartbeat
    // liveness mark is layered on so a wedged daemon is terminate()d within two sweeps →
    // fires `close` → detachDaemon.
    wireDaemonSocket(ws, registry)
    aliveDaemons.add(ws)
    ws.on('pong', () => aliveDaemons.add(ws))
  })

  // Liveness marks for client sockets: present = ponged since the last sweep.
  const aliveClients = new WeakSet<HeartbeatSocket>()
  clientWss.on('connection', (ws, req) => {
    // The connection, its principal and its frame switch belong to the client
    // mux (POD-390); this handler layers the liveness mark on top, exactly as the
    // daemon half above does.
    if (
      wireClientSocket(ws, req, registry, {
        ...auth,
        ...(auth.userForClient ? { userId: auth.userForClient(req) } : {}),
        ...(auth.roleForClient ? { userRole: auth.roleForClient(req) } : {}),
      }) === undefined
    )
      return
    aliveClients.add(ws)
    ws.on('pong', () => aliveClients.add(ws))
  })

  // Each plane schedules its OWN sweep at its OWN cadence (POD-391). This file
  // no longer builds the timers, so it cannot pair a socket set with the other
  // plane's interval — `wss.clients` is a live Set, re-iterated each tick.
  const clientHeartbeat = CLIENT_PLANE_LIVENESS.startHeartbeat(
    clientWss.clients,
    aliveClients,
    deps.timers,
  )
  // The daemon link gets the same dead-socket sweep the client link has always had;
  // terminating a wedged daemon fires its `close` → the gateway's detachDaemon.
  const daemonHeartbeat = DAEMON_PLANE_LIVENESS.startHeartbeat(
    daemonWss.clients,
    aliveDaemons,
    deps.timers,
  )

  return {
    close() {
      clientHeartbeat.stop()
      daemonHeartbeat.stop()
      return new Promise<void>((resolve) => {
        // Terminate existing connections so wss.close() resolves immediately rather
        // than waiting for clients to disconnect on their own.
        for (const ws of daemonWss.clients) ws.terminate()
        for (const ws of clientWss.clients) ws.terminate()
        daemonWss.close(() => clientWss.close(() => resolve()))
      })
    },
  }
}
