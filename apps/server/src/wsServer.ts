import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
import type { RawData } from 'ws'
import { WebSocketServer } from 'ws'
import type { RelayHub } from './relay'

export interface WsHandle {
  close(): Promise<void>
}

export function attachWebSockets(server: Server, hub: RelayHub): WsHandle {
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

  // Pending client WebSockets that connected before the daemon sent bind.
  // We queue them so we can call hub.attachClient only after sessionId is set.
  type PendingClient = { ws: import('ws').WebSocket; buffered: RawData[] }
  const pendingClients: PendingClient[] = []

  function flushPendingClients(): void {
    for (const { ws, buffered } of pendingClients) {
      attachClientWs(ws, buffered)
    }
    pendingClients.length = 0
  }

  function attachClientWs(ws: import('ws').WebSocket, buffered: RawData[] = []): void {
    const id = hub.attachClient((msg) => ws.send(encode(msg)))
    // Replay any messages that arrived before attachment
    for (const raw of buffered) {
      try {
        hub.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    }
    ws.on('message', (raw: RawData) => {
      try {
        hub.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => hub.detachClient(id))
  }

  daemonWss.on('connection', (ws) => {
    hub.attachDaemon((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: RawData) => {
      try {
        const msg = parseDaemonMessage(raw.toString())
        hub.onDaemonMessage(msg)
        // After a bind, flush any clients that connected before the daemon.
        if (msg.type === 'bind') flushPendingClients()
      } catch {
        // ignore malformed daemon frames
      }
    })
    ws.on('close', () => hub.detachDaemon())
  })

  clientWss.on('connection', (ws) => {
    if (hub.info().sessionId === '') {
      // No bind yet — buffer this client until bind arrives.
      const buffered: RawData[] = []
      const pending: PendingClient = { ws, buffered }
      pendingClients.push(pending)
      ws.on('message', (raw: RawData) => buffered.push(raw))
      ws.on('close', () => {
        const idx = pendingClients.indexOf(pending)
        if (idx !== -1) pendingClients.splice(idx, 1)
      })
    } else {
      attachClientWs(ws)
    }
  })

  return {
    close() {
      return new Promise<void>((resolve) => {
        daemonWss.close(() => clientWss.close(() => resolve()))
      })
    },
  }
}
