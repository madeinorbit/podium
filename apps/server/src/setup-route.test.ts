import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSetupRoute } from './setup-route'

const priorStateDir = process.env.PODIUM_STATE_DIR!
const unconfigured = () =>
  ({ state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' }) as const
const ready = () => ({ state: 'ready', reason: null, dataPlane: 'available' }) as const
const activationPending = () =>
  ({ state: 'activation_pending', reason: 'restart_required', dataPlane: 'blocked' }) as const

describe('setup route', () => {
  let dir: string
  let app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-setup-'))
    process.env.PODIUM_STATE_DIR = dir
    app = new Hono()
    registerSetupRoute(app, { readiness: unconfigured })
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('GET reports needsSetup true when unconfigured', async () => {
    const res = await app.request('/setup/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      needsSetup: true,
      mode: null,
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
    })
    expect(res.headers.get('X-Podium-Local-Setup')).toBeNull()
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
    const configuredApp = new Hono()
    registerSetupRoute(configuredApp, { readiness: ready })
    const res = await configuredApp.request('/setup/config')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain('SECRET-TOKEN')
    expect(raw).not.toContain('SECRET-CODE')
    expect(raw).not.toContain('hub.example')
    const body = JSON.parse(raw) as Record<string, unknown>
    // exactly the setup-gating fields, nothing else
    expect(Object.keys(body).sort()).toEqual(['dataPlane', 'mode', 'needsSetup', 'reason', 'state'])
    expect(body.mode).toBe('daemon')
    expect(body.needsSetup).toBe(false)
  })

  it('advertises the local default only when the trusted launcher opts in and setup is needed', async () => {
    const localApp = new Hono()
    registerSetupRoute(localApp, { readiness: unconfigured, localSetupDefault: true })
    const response = await localApp.request('/setup/config')
    expect(await response.json()).toEqual({
      needsSetup: true,
      mode: null,
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
    })
    expect(response.headers.get('X-Podium-Local-Setup')).toBe('all-in-one')
  })

  it('reports activation pending as setup-blocked without re-advertising the local default', async () => {
    const pendingApp = new Hono()
    registerSetupRoute(pendingApp, { readiness: activationPending, localSetupDefault: true })
    const response = await pendingApp.request('/setup/config')
    expect(await response.json()).toMatchObject({
      needsSetup: true,
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    })
    expect(response.headers.get('X-Podium-Local-Setup')).toBeNull()
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
