import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSetupRoute } from './setup-route'

const priorStateDir = process.env.PODIUM_STATE_DIR!
const unconfigured = () =>
  ({
    state: 'unconfigured',
    reason: 'setup_required',
    dataPlane: 'blocked',
    controlPlane: 'blocked',
  }) as const
const ready = () =>
  ({ state: 'ready', reason: null, dataPlane: 'available', controlPlane: 'available' }) as const
const activationPending = () =>
  ({
    state: 'activation_pending',
    reason: 'restart_required',
    dataPlane: 'blocked',
    controlPlane: 'available',
    stale: ['persistence'],
  }) as const

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
      modeSource: 'default',
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
      controlPlane: 'blocked',
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
    expect(Object.keys(body).sort()).toEqual([
      'controlPlane',
      'dataPlane',
      'mode',
      // `modeSource` names WHICH LAYER answered for `mode` — one of 'env' |
      // 'file' | 'default' — and never the value, the variable or the path
      // behind it. It is admissible here because the value it describes is
      // already on this response, so provenance of an already-public fact
      // discloses strictly less than the fact; and the SetupGate has no
      // authenticated channel to ask on, since it runs before login exists.
      'modeSource',
      'needsSetup',
      'reason',
      'state',
    ])
    expect(body.mode).toBe('daemon')
    // A LAYER NAME, not the config content: this is the whole reason the field
    // is allowed above, so it is pinned rather than assumed.
    expect(body.modeSource).toBe('file')
    expect(body.needsSetup).toBe(false)
  })

  it('advertises the local default only when the trusted launcher opts in and setup is needed', async () => {
    const localApp = new Hono()
    registerSetupRoute(localApp, { readiness: unconfigured, localSetupDefault: true })
    const response = await localApp.request('/setup/config')
    expect(await response.json()).toEqual({
      needsSetup: true,
      mode: null,
      modeSource: 'default',
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
      controlPlane: 'blocked',
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

  it('tells the blocked browser WHICH setting is stale, by name [POD-2766]', async () => {
    // This route is the ONLY channel the restart-required screen has: the data
    // plane is blocked, so the browser cannot ask tRPC anything. If `stale` stops
    // riding here the screen silently falls back to "something changed, restart"
    // and the operator is back to guessing.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mode: 'all-in-one', publicUrl: 'https://sandbox.example.com' }),
    )
    const pendingApp = new Hono()
    registerSetupRoute(pendingApp, { readiness: activationPending })
    const body = (await (await pendingApp.request('/setup/config')).json()) as {
      stale?: unknown
      controlPlane?: unknown
    }
    expect(body.stale).toEqual(['persistence'])
    // The control plane is open, which is what lets the browser in front of this
    // screen log in and press the restart.
    expect(body.controlPlane).toBe('available')
  })

  it('publishes stale FIELD NAMES and never their values', async () => {
    // The route is unauthenticated, so what rides it is the standing question.
    // A key name is not a secret; the value behind it can be deployment identity.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mode: 'all-in-one', persistence: 'detached', pairCode: 'SECRET-CODE' }),
    )
    const pendingApp = new Hono()
    registerSetupRoute(pendingApp, { readiness: activationPending })
    const raw = await (await pendingApp.request('/setup/config')).text()
    expect(raw).toContain('persistence')
    expect(raw).not.toContain('detached')
    expect(raw).not.toContain('SECRET-CODE')
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
