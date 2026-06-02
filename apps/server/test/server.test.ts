import { describe, expect, it } from 'vitest'
import { startServer } from '../src/server'

describe('startServer — http + tRPC', () => {
  it('serves /health and tRPC session.info reflecting the hub state', async () => {
    const srv = await startServer()
    try {
      const health = await fetch(`http://localhost:${srv.port}/health`)
      expect(health.status).toBe(200)
      expect(await health.text()).toBe('ok')

      const res = await fetch(`http://localhost:${srv.port}/trpc/session.info`)
      const json = (await res.json()) as {
        result: { data: { epoch: number; clientCount: number; controllerId: string | null } }
      }
      expect(json.result.data.epoch).toBe(0)
      expect(json.result.data.clientCount).toBe(0)
      expect(json.result.data.controllerId).toBeNull()
    } finally {
      await srv.close()
    }
  })
})
