import { fileURLToPath } from 'node:url'
import { encode, parseServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'

const FIXTURE = fileURLToPath(
  new URL('../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function collect(ws: WebSocket) {
  let text = ''
  const seen: ReturnType<typeof parseServerMessage>[] = []
  ws.on('message', (raw: WebSocket.RawData) => {
    let msg: ReturnType<typeof parseServerMessage>
    try {
      msg = parseServerMessage(raw.toString())
    } catch {
      return
    }
    seen.push(msg)
    if (msg.type === 'outputFrame') text += Buffer.from(msg.data, 'base64').toString('utf8')
  })
  return {
    get text() {
      return text
    },
    get seen() {
      return seen
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('e2e: daemon -> server -> client', () => {
  it('streams real fixture output to a client, round-trips input, and bumps epoch on takeover', async () => {
    const srv = await startServer()
    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${srv.port}`,
      sessionId: 's1',
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })
    const client = await openWs(`ws://localhost:${srv.port}/client`)
    const c = collect(client)
    try {
      // 0) force a fresh repaint so the just-connected client sees current output —
      //    the fixture only paints spontaneously once, possibly before this client joined.
      client.send(encode({ type: 'redrawRequest' }))
      // 1) live fixture output reaches the client through the full chain
      await waitFor(() => c.text.includes('cols=80 rows=24'))

      // 2) input typed at the client round-trips to the agent and back
      client.send(encode({ type: 'input', data: Buffer.from('a', 'utf8').toString('base64') }))
      await waitFor(() => c.text.includes('last-input=61'))

      // 3) takeover bumps epoch (via the server's hub) and resizes the agent
      client.send(encode({ type: 'resize', cols: 100, rows: 30 }))
      client.send(encode({ type: 'requestControl' }))
      await waitFor(() => srv.hub.info().epoch === 1)
      expect(srv.hub.info().geometry).toEqual({ cols: 100, rows: 30 })
      await waitFor(() => c.text.includes('cols=100 rows=30'))
    } finally {
      client.close()
      await daemon.close()
      await srv.close()
    }
  })
})
