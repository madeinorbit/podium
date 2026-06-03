import type { Server } from 'node:http'
import { encode, parseClientMessage, parseDaemonMessage } from '@podium/protocol'
import { WebSocketServer } from 'ws'
import type { SessionRegistry } from './relay'

export interface WsHandle {
  close(): Promise<void>
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

  clientWss.on('connection', (ws) => {
    const id = registry.attachClient((msg) => ws.send(encode(msg)))
    ws.on('message', (raw: import('ws').RawData) => {
      try {
        registry.onClientMessage(id, parseClientMessage(raw.toString()))
      } catch {
        // ignore malformed client frames
      }
    })
    ws.on('close', () => registry.detachClient(id))
  })

  return {
    close() {
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
