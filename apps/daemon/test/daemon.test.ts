import { fileURLToPath } from 'node:url'
import { encode, parseDaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type AddressInfo, WebSocketServer } from 'ws'
import { startDaemon } from '../src/index'

const FIXTURE = fileURLToPath(
  new URL('../../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function decoded(raw: import('ws').RawData) {
  return parseDaemonMessage(raw.toString())
}

async function viWaitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('viWaitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('startDaemon', () => {
  it('binds to the server and forwards agent frames; applies control input', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const port = (wss.address() as AddressInfo).port

    const seen: ReturnType<typeof decoded>[] = []
    let serverWs: import('ws').WebSocket | undefined
    wss.on('connection', (ws) => {
      serverWs = ws
      ws.on('message', (raw) => {
        try {
          seen.push(decoded(raw))
        } catch {
          /* ignore */
        }
      })
    })

    const daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      sessionId: 's1',
      cmd: process.execPath,
      args: [FIXTURE],
      cols: 80,
      rows: 24,
    })

    try {
      await viWaitFor(() => seen.some((m) => m.type === 'bind'))
      expect(seen.find((m) => m.type === 'bind')).toMatchObject({
        type: 'bind',
        sessionId: 's1',
        geometry: { cols: 80, rows: 24 },
      })

      // send a control input down; the fixture echoes last-input=61 in a forwarded frame.
      // (Deterministic via input->frame; the spontaneous initial paint is not relied on.)
      serverWs?.send(encode({ type: 'input', data: Buffer.from('a', 'utf8').toString('base64') }))
      await viWaitFor(() =>
        seen.some(
          (m) =>
            m.type === 'agentFrame' &&
            Buffer.from(m.data, 'base64').toString('utf8').includes('last-input=61'),
        ),
      )
    } finally {
      await daemon.close()
      await new Promise<void>((res) => wss.close(() => res()))
    }
  })
})
