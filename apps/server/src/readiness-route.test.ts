import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerReadinessRoute } from './readiness-route'

describe('public readiness route', () => {
  it('returns only the server lifecycle projection', async () => {
    const app = new Hono()
    registerReadinessRoute(app, () => ({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    }))
    const response = await app.request('/readiness')
    // 503 while the data plane is blocked, so a status-code-only health check
    // sees what the body has always said (PDM-26).
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    })
  })

  it('answers 200 with the same shape once the data plane is available', async () => {
    const app = new Hono()
    registerReadinessRoute(app, () => ({
      state: 'degraded',
      reason: 'agent_unavailable',
      dataPlane: 'available',
    }))
    const response = await app.request('/readiness')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      state: 'degraded',
      reason: 'agent_unavailable',
      dataPlane: 'available',
    })
  })

  it('serves a script-free host handoff instead of a remote setup form', async () => {
    const app = new Hono()
    registerReadinessRoute(app, () => ({
      state: 'unconfigured',
      reason: 'setup_required',
      dataPlane: 'blocked',
    }))
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
    registerReadinessRoute(app, () => ({
      state: 'activation_pending',
      reason: 'restart_required',
      dataPlane: 'blocked',
    }))
    expect(await (await app.request('/setup/mobile')).text()).toContain(
      'Setup is saved; Podium needs to restart',
    )
  })
})
