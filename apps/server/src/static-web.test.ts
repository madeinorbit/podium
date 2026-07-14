import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerMobileRouting, registerWebStatic } from './static-web'

describe('registerWebStatic', () => {
  let dir: string
  const app = new Hono()
  app.get('/trpc/x', (c) => c.text('api')) // API route registered BEFORE static

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-web-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Podium</title>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    registerWebStatic(app, dir)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('serves index.html at /', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Podium')
  })
  it('serves a hashed asset with the right content-type', async () => {
    const res = await app.request('/assets/app.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })
  it('falls back to index.html for an unknown SPA route', async () => {
    const res = await app.request('/settings/machines')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Podium')
  })
  it('does not shadow API routes', async () => {
    const res = await app.request('/trpc/x')
    expect(await res.text()).toBe('api')
  })
  it('returns false and registers nothing when no build is present', () => {
    const empty = mkdtempSync(join(tmpdir(), 'podium-empty-'))
    expect(registerWebStatic(new Hono(), empty)).toBe(false)
    rmSync(empty, { recursive: true, force: true })
  })
  it('deny-prefix guard returns notFound for backend routes without an explicit handler', async () => {
    const app2 = new Hono()
    registerWebStatic(app2, dir) // dir from the describe scope (has index.html)
    const res = await app2.request('/health')
    expect(res.status).toBe(404)
  })
  it('serves a second SPA under /mobile without shadowing APIs', async () => {
    const mobile = mkdtempSync(join(tmpdir(), 'podium-mobile-'))
    try {
      writeFileSync(join(mobile, 'index.html'), '<!doctype html><title>Podium Mobile</title>')
      mkdirSync(join(mobile, '_expo'))
      writeFileSync(join(mobile, '_expo', 'app.js'), 'console.log("mobile")')
      const app = new Hono()
      app.get('/trpc/x', (c) => c.text('api'))

      expect(registerWebStatic(app, mobile, { basePath: '/mobile' })).toBe(true)

      expect(await (await app.request('/mobile')).text()).toContain('Podium Mobile')
      expect(await (await app.request('/mobile/session/s1')).text()).toContain('Podium Mobile')
      expect(await (await app.request('/mobile/_expo/app.js')).text()).toContain('mobile')
      expect(await (await app.request('/trpc/x')).text()).toBe('api')
    } finally {
      rmSync(mobile, { recursive: true, force: true })
    }
  })
  it('serves the web shell at / to phone user agents (no redirect) [spec:SP-902c]', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobileServed: true })
    app.get('/', (c) => c.text('web shell'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

    const root = await app.request('/?server=wss://x&e2e=1', {
      headers: { 'user-agent': iphone },
    })
    expect(root.status).toBe(200)
    expect(await root.text()).toBe('web shell')
  })
  it('redirects /desktop to / preserving the query string', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobileServed: true })

    const res = await app.request('/desktop?server=wss://x&e2e=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?server=wss://x&e2e=1')
  })
  it('redirects /mobile to / with the query when the Expo build is absent', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobileServed: false })

    const root = await app.request('/mobile?server=wss://x')
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/?server=wss://x')

    const deep = await app.request('/mobile/session/s1?e2e=1')
    expect(deep.status).toBe(302)
    expect(deep.headers.get('location')).toBe('/?e2e=1')
  })
  it('leaves /mobile to the Expo static handler when the build is present', async () => {
    const mobile = mkdtempSync(join(tmpdir(), 'podium-mobile-'))
    try {
      writeFileSync(join(mobile, 'index.html'), '<!doctype html><title>Podium Mobile</title>')
      const app = new Hono()
      const expoMobileServed = registerWebStatic(app, mobile, { basePath: '/mobile' })
      registerMobileRouting(app, { expoMobileServed })

      const res = await app.request('/mobile?server=wss://x')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Podium Mobile')
    } finally {
      rmSync(mobile, { recursive: true, force: true })
    }
  })
})
