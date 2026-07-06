import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerMobileRedirect, registerWebStatic } from './static-web'

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
  it('redirects mobile browsers from / to /mobile unless desktop is requested', async () => {
    const app = new Hono()
    registerMobileRedirect(app)
    app.get('/', (c) => c.text('desktop'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

    const mobileRoot = await app.request('/', { headers: { 'user-agent': iphone } })
    expect(mobileRoot.status).toBe(302)
    expect(mobileRoot.headers.get('location')).toBe('/mobile')

    expect(
      await (
        await app.request('/', {
          headers: { 'user-agent': iphone, cookie: 'podium_desktop=1' },
        })
      ).text(),
    ).toBe('desktop')

    const desktopHatch = await app.request('/desktop', { headers: { 'user-agent': iphone } })
    expect(desktopHatch.status).toBe(302)
    expect(desktopHatch.headers.get('location')).toBe('/')
    expect(desktopHatch.headers.get('set-cookie')).toContain('podium_desktop=1')
  })
})
