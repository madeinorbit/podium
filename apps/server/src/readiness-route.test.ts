import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerReadinessRoute } from './readiness-route'

describe('public readiness route', () => {
  it('returns only the server lifecycle projection', async () => {
    const app = new Hono()
    registerReadinessRoute(
      app,
      () => ({
        state: 'activation_pending',
        reason: 'restart_required',
        dataPlane: 'blocked',
      }),
      'inst-1',
    )
    const response = await app.request('/readiness')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
      // The one thing an instance probing its own public URL needs in order to
      // tell "my front door works" from "something else answers there" (PDM-26).
      instanceId: 'inst-1',
    })
  })

  it('serves a script-free host handoff instead of a remote setup form', async () => {
    const app = new Hono()
    registerReadinessRoute(
      app,
      () => ({
        state: 'unconfigured',
        reason: 'setup_required',
        dataPlane: 'blocked',
      }),
      'inst-1',
    )
    const response = await app.request('/setup/mobile')
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('Finish setup on the server')
    expect(html).toContain('<code>podium setup</code>')
    expect(html).not.toContain('<script')
  })

  it('gives activation-pending its restart-specific recovery copy', async () => {
    const app = new Hono()
    registerReadinessRoute(
      app,
      () => ({
        state: 'activation_pending',
        reason: 'restart_required',
        dataPlane: 'blocked',
      }),
      'inst-1',
    )
    expect(await (await app.request('/setup/mobile')).text()).toContain(
      'Setup is saved; Podium needs to restart',
    )
  })
})
