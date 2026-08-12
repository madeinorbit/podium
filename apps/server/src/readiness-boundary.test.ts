import type { ServerReadiness } from '@podium/model'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  authReadinessBoundary,
  isHostLocalRequest,
  isHostSetupBootstrap,
  readinessBoundary,
} from './readiness-boundary'

const blocked: ServerReadiness = {
  state: 'unconfigured',
  reason: 'setup_required',
  dataPlane: 'blocked',
}

function appFor(isHostLocal: boolean, readiness: ServerReadiness = blocked) {
  const app = new Hono()
  app.use(
    '/trpc/*',
    readinessBoundary({ readiness: () => readiness, isHostLocal: () => isHostLocal }),
  )
  app.use(
    '/files/*',
    readinessBoundary({ readiness: () => readiness, isHostLocal: () => isHostLocal }),
  )
  app.all('*', (c) => c.json({ ok: true }))
  return app
}

describe('server readiness boundary', () => {
  it('blocks ordinary data-plane paths before setup', async () => {
    const app = appFor(true)
    for (const path of ['/trpc/issues.list', '/files/asset/a']) {
      const response = await app.request(path)
      expect(response.status, path).toBe(503)
      expect(await response.json()).toEqual({ error: 'server_not_ready', readiness: blocked })
    }
  })

  it('allows only the narrow setup bootstrap from the host', async () => {
    const local = appFor(true)
    expect((await local.request('/trpc/setup.options')).status).toBe(200)
    expect((await local.request('/trpc/setup.complete', { method: 'POST' })).status).toBe(200)
    expect((await local.request('/trpc/auth.status,telemetry.state')).status).toBe(200)
    expect((await local.request('/trpc/setup.options,issues.list')).status).toBe(503)

    const remote = appFor(false)
    expect((await remote.request('/trpc/setup.options')).status).toBe(503)
  })

  it('opens the whole data plane only when the server says it is available', async () => {
    const app = appFor(false, {
      state: 'degraded',
      reason: 'agent_unavailable',
      dataPlane: 'available',
    })
    expect((await app.request('/trpc/issues.list')).status).toBe(200)
    expect((await app.request('/files/asset/a')).status).toBe(200)
  })

  it('keeps auth status public but blocks login/session mutation before activation', async () => {
    const app = new Hono()
    app.use(
      '/auth/*',
      authReadinessBoundary(() => blocked),
    )
    app.all('*', (c) => c.json({ ok: true }))
    expect((await app.request('/auth/status')).status).toBe(200)
    expect((await app.request('/auth/login', { method: 'POST' })).status).toBe(503)
    expect((await app.request('/auth/logout', { method: 'POST' })).status).toBe(503)
  })

  it('recognizes direct host-local bootstrap but rejects proxy and public origins', () => {
    const local = (headers: Record<string, string> = {}) =>
      new Request('http://127.0.0.1:18787/trpc/setup.complete', {
        headers: { 'x-podium-peer-address': '127.0.0.1', ...headers },
      })
    expect(isHostLocalRequest(local())).toBe(true)
    expect(isHostLocalRequest(local({ origin: 'tauri://localhost' }))).toBe(true)
    expect(isHostLocalRequest(local({ origin: 'https://podium.example' }))).toBe(false)
    expect(isHostLocalRequest(local({ 'x-forwarded-host': 'podium.example' }))).toBe(false)
    expect(isHostLocalRequest(local({ 'x-forwarded-for': '203.0.113.8' }))).toBe(false)
    expect(
      isHostLocalRequest(
        new Request('https://podium.example/trpc/setup.complete', {
          headers: { 'x-podium-peer-address': '127.0.0.1' },
        }),
      ),
    ).toBe(false)
  })

  it('bypasses login only for a host setup call while the data plane is blocked', () => {
    const request = new Request('http://127.0.0.1/trpc/setup.complete')
    expect(isHostSetupBootstrap(blocked, '/trpc/setup.complete', request, () => true)).toBe(true)
    expect(isHostSetupBootstrap(blocked, '/trpc/issues.list', request, () => true)).toBe(false)
    expect(isHostSetupBootstrap(blocked, '/trpc/setup.complete', request, () => false)).toBe(false)
    expect(
      isHostSetupBootstrap(
        { state: 'ready', reason: null, dataPlane: 'available' },
        '/trpc/setup.complete',
        request,
        () => true,
      ),
    ).toBe(false)
  })
})
