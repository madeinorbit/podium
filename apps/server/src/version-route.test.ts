import { WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerVersionRoute } from './server'

describe('GET /version', () => {
  it('reports the wire + app version as JSON', async () => {
    const app = new Hono()
    registerVersionRoute(app)
    const res = await app.request('/version')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { wireVersion: number; appVersion: string }
    expect(body.wireVersion).toBe(WIRE_VERSION)
    expect(typeof body.appVersion).toBe('string')
  })
})
