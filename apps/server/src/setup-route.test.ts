import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    const body = (await res.json()) as { needsSetup: boolean; mode: string | null }
    expect(body.needsSetup).toBe(true)
    expect(body.mode).toBeNull()
  })

  it('never leaks the config over the unauthenticated route — no token/pairCode/URLs', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        mode: 'daemon',
        serverUrl: 'wss://hub.example',
        pairCode: 'SECRET-CODE',
        upstream: { url: 'wss://hub.example', token: 'SECRET-TOKEN' },
      }),
    )
    const res = await app.request('/setup/config')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain('SECRET-TOKEN')
    expect(raw).not.toContain('SECRET-CODE')
    expect(raw).not.toContain('hub.example')
    const body = JSON.parse(raw) as Record<string, unknown>
    // exactly the setup-gating fields, nothing else
    expect(Object.keys(body).sort()).toEqual(['mode', 'needsSetup'])
    expect(body.mode).toBe('daemon')
    expect(body.needsSetup).toBe(false)
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
