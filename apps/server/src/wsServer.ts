import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
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

  daemonWss.on('connection', (ws) => {
    hub.attachDaemon((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        hub.onDaemonMessage(parseDaemonMessage(raw.toString()))
      } catch {
        // ignore malformed daemon frames
      }
    })
    ws.on('close', () => hub.detachDaemon())
  })

  clientWss.on('connection', (ws) => {
    const id = hub.attachClient((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        hub.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => hub.detachClient(id))
  })

  return {
    close() {
      return new Promise<void>((resolve) => {
        daemonWss.close(() => clientWss.close(() => resolve()))
      })
    },
  }
}
