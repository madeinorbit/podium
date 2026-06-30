import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSetupRoute } from './setup-route'

describe('setup route', () => {
  let dir: string
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
    app = new Hono()
    registerSetupRoute(app)
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET reports needsSetup true when unconfigured', async () => {
    const res = await app.request('/setup/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { needsSetup: boolean; config: unknown }
    expect(body.needsSetup).toBe(true)
    expect(body.config).toEqual({})
  })
  it('is read-only — writes go through the setup.* tRPC, so POST is not handled', async () => {
    const res = await app.request('/setup/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'daemon', serverUrl: 'ws://host:18787' }),
    })
    expect(res.status).toBe(404)
  })
})
