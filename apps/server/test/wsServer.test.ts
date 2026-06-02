import { encode, parseControlMessage, parseServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { startServer } from '../src/server'
import { openWs, waitMessage } from './wsTestUtil'

describe('server WebSocket relay', () => {
  it('relays a daemon agentFrame to a client as an epoch-stamped outputFrame', async () => {
    const srv = await startServer()
    const base = `ws://localhost:${srv.port}`
    const daemon = await openWs(`${base}/daemon`)
    const client = await openWs(`${base}/client`)
    try {
      daemon.send(
        encode({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } }),
      )
      const welcome = await waitMessage(client, parseServerMessage, (m) => m.type === 'welcome')
      expect(welcome).toMatchObject({ type: 'welcome', sessionId: 's1' })

      daemon.send(encode({ type: 'agentFrame', seq: 1, data: 'Zm9v' }))
      const frame = await waitMessage(client, parseServerMessage, (m) => m.type === 'outputFrame')
      expect(frame).toEqual({ type: 'outputFrame', seq: 1, epoch: 0, data: 'Zm9v' })
    } finally {
      daemon.close()
      client.close()
      await srv.close()
    }
  })

  it('forwards controller input from a client down to the daemon', async () => {
    const srv = await startServer()
    const base = `ws://localhost:${srv.port}`
    const daemon = await openWs(`${base}/daemon`)
    const client = await openWs(`${base}/client`)
    try {
      daemon.send(
        encode({ type: 'bind', sessionId: 's1', cmd: 'fixture', geometry: { cols: 80, rows: 24 } }),
      )
      await waitMessage(client, parseServerMessage, (m) => m.type === 'welcome')

      client.send(encode({ type: 'input', data: 'YQ==' }))
      const control = await waitMessage(daemon, parseControlMessage, (m) => m.type === 'input')
      expect(control).toEqual({ type: 'input', data: 'YQ==' })
    } finally {
      daemon.close()
      client.close()
      await srv.close()
    }
  })

  it('ignores upgrades on unknown paths', async () => {
    const srv = await startServer()
    try {
      await expect(openWs(`ws://localhost:${srv.port}/nope`)).rejects.toBeDefined()
    } finally {
      await srv.close()
    }
  })
})
