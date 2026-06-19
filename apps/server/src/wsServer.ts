import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { SessionRegistry } from './relay'

export interface WsHandle {
  close(): Promise<void>
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

export function attachWebSockets(server: Server, registry: SessionRegistry): WsHandle {
  const daemonWss = new WebSocketServer({ noServer: true })
  const clientWss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname === '/daemon') {
      daemonWss.handleUpgrade(req, socket, head, (ws) => daemonWss.emit('connection', ws, req))
    } else if (pathname === '/client') {
      clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  // Liveness marks for the daemon socket: present = ponged since the last sweep.
  const aliveDaemons = new WeakSet<HeartbeatSocket>()
  daemonWss.on('connection', (ws) => {
    registry.attachDaemon((msg) => safeSend(ws, msg, SEND_BUFFER_LIMIT_BYTES))
    aliveDaemons.add(ws)
    ws.on('pong', () => aliveDaemons.add(ws))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.onDaemonMessage(parseDaemonMessage(raw.toString()))
      } catch {
        // ignore malformed daemon frames
      }
    })
    ws.on('close', () => registry.detachDaemon())
  })

  // Liveness marks for client sockets: present = ponged since the last sweep.
  const aliveClients = new WeakSet<HeartbeatSocket>()
  clientWss.on('connection', (ws) => {
    const id = registry.attachClient((msg) => safeSend(ws, msg, SEND_BUFFER_LIMIT_BYTES))
    aliveClients.add(ws)
    ws.on('pong', () => aliveClients.add(ws))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => registry.detachClient(id))
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
