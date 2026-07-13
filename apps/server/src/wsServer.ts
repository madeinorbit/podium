import type { IncomingMessage, Server } from 'node:http'
import {
  type ControlMessage,
  type DaemonHandshake,
  type DaemonHandshakeReply,
  encode,
  parseClientMessage,
  parseDaemonHandshake,
  parseDaemonMessage,
  versionSupport,
} from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { SessionRegistry } from './relay'
import type { Send } from './modules/sessions/session'

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

// Server-side liveness. The browser answers protocol-level pings with pongs at the
// network layer (no app code), so this catches a client whose socket died without a
// close frame — laptop sleep, a dropped proxy hop, a phone that walked out of range
// — well before the OS TCP timeout (minutes). Reaping it promptly stops us
// broadcasting frames into a dead socket and, crucially, frees the controller role
// so the user's reconnecting tab can reclaim it.
const CLIENT_HEARTBEAT_INTERVAL_MS = 15_000
// Same sweep, applied to the single /daemon socket. A daemon whose message loop is
// wedged (a huge inbound frame, a sync block) leaves its TCP socket OPEN, so `close`
// never fires and detachDaemon() never runs — every daemon-routed tRPC then hangs to
// timeout and the UI shows the empty new-install screen, with no self-heal (the
// documented wedge). A daemon too wedged to answer a protocol ping stops being marked
// alive and is terminate()d within two intervals, which fires `close` → detachDaemon,
// re-queues pending control messages, and frees its sessions for the next daemon.
const DAEMON_HEARTBEAT_INTERVAL_MS = 10_000

// Drop/terminate a client whose outbound buffer grows past this. A runaway agent
// (`yes`, a huge paste echo) emits frames faster than a slow or backgrounded client
// can drain; without a cap, `ws` queues the unsent bytes in *this* process's memory
// without limit — GBs in seconds — and OOMs the shared server, killing every session.
// 16 MB is far above a healthy client's transient backlog; a client this far behind
// is effectively dead, so terminating it (it reconnects and full-replays off the
// bounded 256 KB ring) protects everyone else.
const SEND_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024

// A malformed frame is dropped so it can't wedge the connection — but the drop is
// logged (never silent), throttled so a misbehaving peer can't flood the journal.
const FRAME_WARN_THROTTLE_MS = 1_000
const lastFrameWarnAt: Record<'client' | 'daemon', number> = { client: 0, daemon: 0 }
function warnDroppedFrame(kind: 'client' | 'daemon', err: unknown): void {
  const now = Date.now()
  if (now - lastFrameWarnAt[kind] < FRAME_WARN_THROTTLE_MS) return
  lastFrameWarnAt[kind] = now
  console.warn(`[podium] dropped malformed ${kind} frame:`, err)
}

/** Minimal slice of a `ws` socket {@link safeSend} needs (kept tiny for tests). */
export interface SendSocket {
  readyState: number
  bufferedAmount: number
  send(data: string): void
  terminate(): void
}

/**
 * The one chokepoint every server→client and server→daemon frame funnels through.
 * It (a) never throws — a dead/closing socket's `send` raising must not abort a
 * broadcast loop or, from a timer/microtask context, take down the whole process
 * (there is no uncaughtException net); and (b) applies backpressure — a socket whose
 * buffered bytes exceed `limit` isn't draining, so we terminate it rather than grow
 * this process's memory unbounded. Exported for deterministic unit testing.
 */
export function safeSend(ws: SendSocket, msg: Parameters<typeof encode>[0], limit: number): void {
  if (ws.readyState !== 1 /* OPEN */) return
  if (ws.bufferedAmount > limit) {
    ws.terminate()
    return
  }
  try {
    ws.send(encode(msg))
  } catch {
    // Socket went away between the readyState check and the send — drop the frame;
    // the heartbeat sweep (or this same gate next time) reaps it.
  }
}

/** Minimal slice of a `ws` socket the heartbeat sweep needs (kept tiny for tests). */
export interface HeartbeatSocket {
  readyState: number
  ping(): void
  terminate(): void
}

/**
 * One heartbeat sweep: terminate any socket that hasn't ponged since the last
 * sweep (absent from `alive`), and ping the rest — clearing their liveness mark so
 * the next sweep terminates them unless a pong re-marks them first. A dead socket
 * is thus reaped within two intervals. Exported for deterministic unit testing.
 */
export function sweepClientLiveness(
  clients: Iterable<HeartbeatSocket>,
  alive: WeakSet<HeartbeatSocket>,
): void {
  for (const ws of clients) {
    if (!alive.has(ws)) {
      ws.terminate()
      continue
    }
    alive.delete(ws)
    if (ws.readyState !== 1 /* OPEN */) continue
    try {
      ws.ping()
    } catch {
      // Socket went away between iterations — the next sweep terminates it.
    }
  }
}

/**
 * Per-daemon-socket lifecycle: hold the connection unauthenticated until the FIRST
 * frame proves identity, then route everything after as control messages.
 *
 * The first frame MUST parse as a `DaemonHandshake` (pair/hello) — anything else
 * (junk, or a stray control frame from a buggy/hostile client) is dropped on the
 * floor, never reaching the registry. One auth path for every daemon, local or remote:
 *  - `hello` (token in the store): `authenticateDaemon` verifies it. The local machine
 *    is pre-registered at server startup (ensureLocalMachine) with a server-owned
 *    credential, so its same-host daemon comes through here too — no special bootstrap.
 *  - `pair` (one-time code): `authenticateDaemon` redeems it and mints a token, which
 *    we hand back once via `paired` (the daemon persists it).
 * Only after a successful handshake do we `attachDaemon`; subsequent frames route to
 * `onDaemonMessageFrom(machineId, …)`. Close detaches the machine.
 *
 * Outbound frames go through {@link safeSend} (backpressure + never-throws), the same
 * chokepoint client frames use. The caller (attachWebSockets) layers the heartbeat
 * sweep on top — terminating a wedged daemon fires this socket's `close` → detachDaemon.
 *
 * Extracted from the connection handler so the auth logic is unit-testable against a
 * fake socket (see wsServer.daemon.test.ts).
 */
export function wireDaemonSocket(ws: import('ws').WebSocket, registry: SessionRegistry): void {
  let machineId: string | undefined
  // The send fn registered for THIS socket — the identity `close` detaches against.
  let send: Send<ControlMessage> | undefined
  // Reply helper. The reply `type` literals (helloOk/paired/…) collide with members
  // of other encode() unions, so annotate the value as a DaemonHandshakeReply to
  // pin it to the handshake schema.
  const reply = (msg: DaemonHandshakeReply): void => ws.send(encode(msg))
  ws.on('message', (raw: import('ws').RawData) => {
    if (machineId === undefined) {
      let frame: DaemonHandshake
      try {
        frame = parseDaemonHandshake(raw.toString())
      } catch {
        return // first frame must be a handshake; ignore anything else (pre-auth)
      }
      // One auth path for every daemon, local or remote: a `hello` is verified against
      // the machine's stored credential, a `pair` redeems a code + mints one. The local
      // machine is pre-registered at startup (ensureLocalMachine) with a server-owned
      // credential, so its same-host daemon authenticates here too.
      const auth = registry.modules.machines.authenticateDaemon(frame)
      if (!auth.ok) {
        reply({
          type: frame.type === 'pair' ? 'pairRejected' : 'helloRejected',
          reason: auth.reason,
        })
        return
      }
      machineId = auth.machineId
      // A fresh pair hands the minted token back exactly once (the daemon persists
      // it). `authenticateDaemon` only returns a token on the pair branch.
      if (frame.type === 'pair' && auth.token !== undefined) {
        reply({ type: 'paired', token: auth.token, machineId, name: auth.name })
      }
      // Send the handshake reply BEFORE attaching. attachDaemon synchronously flushes
      // any buffered control frames and calls pushPriorities(), which would otherwise
      // reach the daemon ahead of helloOk — on a server with live sessions to prioritize
      // the daemon's first-frame handshake parse then sees a sessionPriority frame, fails
      // ("malformed reply"), and refuses, looping forever. helloOk must be the first frame.
      reply({ type: 'helloOk', name: auth.name })
      send = (msg) => safeSend(ws, msg, SEND_BUFFER_LIMIT_BYTES)
      registry.modules.sessions.attachDaemon(machineId, send)
      return
    }
    try {
      const msg = parseDaemonMessage(raw.toString())
      // inventoryReport is machine metadata, not session traffic (#222): persist it
      // on the machine row instead of feeding the session pipeline.
      if (msg.type === 'inventoryReport') {
        registry.modules.machines.recordInventory(machineId, msg.inventory)
      } else {
        registry.modules.sessions.onDaemonMessageFrom(machineId, msg)
      }
    } catch (err) {
      // Drop the malformed frame (don't let it tear down the connection) — but
      // never silently: a silent drop here hides protocol drift / poison frames.
      warnDroppedFrame('daemon', err)
    }
  })
  ws.on('close', () => {
    // Pass THIS socket's send fn: if the daemon already reconnected, the registry
    // holds the new socket and this close must not evict it.
    if (machineId && send) registry.modules.sessions.detachDaemon(machineId, send)
  })
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
    // authenticateDaemon → attach as the authenticated machineId. UNIFIED auth — the
    // same-host daemon authenticates as the local machine through the SAME hello path as
    // any remote (the server pre-registered 'local' via ensureLocalMachine + adopted its
    // '__local__' rows at startup, so its data is attributed regardless). No bootstrap
    // special-case. The heartbeat liveness mark is layered on so a wedged daemon is
    // terminate()d within two sweeps → fires `close` → detachDaemon.
    wireDaemonSocket(ws, registry)
    aliveDaemons.add(ws)
    ws.on('pong', () => aliveDaemons.add(ws))
  })

  // Liveness marks for client sockets: present = ponged since the last sweep.
  const aliveClients = new WeakSet<HeartbeatSocket>()
  clientWss.on('connection', (ws) => {
    const id = registry.modules.sessions.attachClient((msg) => safeSend(ws, msg, SEND_BUFFER_LIMIT_BYTES))
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
    () => sweepClientLiveness(clientWss.clients, aliveClients),
    CLIENT_HEARTBEAT_INTERVAL_MS,
  )
  heartbeat.unref?.()
  // The daemon link gets the same dead-socket sweep the client link has always had;
  // terminating a wedged daemon fires its `close` → registry.detachDaemon().
  const daemonHeartbeat = setInterval(
    () => sweepClientLiveness(daemonWss.clients, aliveDaemons),
    DAEMON_HEARTBEAT_INTERVAL_MS,
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
