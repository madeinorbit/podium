/**
 * THE GATEWAY'S WS TRANSPORT — the upgrade gate, the two peer sockets, and the
 * per-plane liveness sweeps (POD-389; moved here from `apps/server/src/wsServer.ts`).
 *
 * The gateway is now the ONLY place `ws` types are imported: no feature module
 * touches a socket. The `/daemon` half hands frames to the mux
 * (`daemon-socket.ts` → `daemon-mux.ts`); the `/client` half still calls the
 * sessions service's client methods directly, because the CLIENT fan-out
 * extraction is POD-390's deliverable and this issue deliberately does not
 * anticipate its shape.
 */

import type { IncomingMessage, Server } from 'node:http'
import { parseClientMessage, versionSupport, WIRE_VERSION } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { PublicationAuthority } from '../modules/sessions/session'
import type { SessionRegistry } from '../relay'
import { wireDaemonSocket } from './daemon-socket'
import {
  CLIENT_PLANE_LIVENESS,
  DAEMON_PLANE_LIVENESS,
  type HeartbeatSocket,
  sweepPlaneLiveness,
} from './plane-liveness'
import { safeSend, safeSendEncoded, warnDroppedFrame } from './ws-send'

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

export function attachWebSockets(
  server: Server,
  registry: SessionRegistry,
  auth: WsAuthOptions = {},
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
      if (auth.authorizeClient && !auth.authorizeClient(req)) {
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
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rawVersion = url.searchParams.get('v') ?? url.searchParams.get('pv')
    const protocolVersion = rawVersion === null ? WIRE_VERSION : Number(rawVersion)
    let authority: PublicationAuthority
    try {
      authority = auth.resolvePublicationAuthority?.(req) ?? {
        principal: auth.principal ?? 'operator',
        scope: auth.scope ?? 'all',
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
      return
    }
    const limit = CLIENT_PLANE_LIVENESS.sendBufferLimitBytes
    const id = registry.modules.sessions.attachClient((msg) => safeSend(ws, msg, limit), {
      ...authority,
      sendPrepared: (bytes) => safeSendEncoded(ws, bytes, limit),
    })
    aliveClients.add(ws)
    ws.on('pong', () => aliveClients.add(ws))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.modules.sessions.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch (err) {
        warnDroppedFrame('client', err)
      }
    })
    ws.on('close', () => registry.modules.sessions.detachClient(id))
  })

  const heartbeat = setInterval(
    () => sweepPlaneLiveness(clientWss.clients, aliveClients),
    CLIENT_PLANE_LIVENESS.heartbeatIntervalMs,
  )
  heartbeat.unref?.()
  // The daemon link gets the same dead-socket sweep the client link has always had;
  // terminating a wedged daemon fires its `close` → the gateway's detachDaemon.
  const daemonHeartbeat = setInterval(
    () => sweepPlaneLiveness(daemonWss.clients, aliveDaemons),
    DAEMON_PLANE_LIVENESS.heartbeatIntervalMs,
  )
  daemonHeartbeat.unref?.()

  return {
    close() {
      clearInterval(heartbeat)
      clearInterval(daemonHeartbeat)
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
