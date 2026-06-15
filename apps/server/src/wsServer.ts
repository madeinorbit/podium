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

  daemonWss.on('connection', (ws) => {
    registry.attachDaemon((msg) => ws.send(encode(msg)))
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
    const id = registry.attachClient((msg) => ws.send(encode(msg)))
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

  return {
    close() {
      clearInterval(heartbeat)
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
