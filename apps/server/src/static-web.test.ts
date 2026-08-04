import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerMobileRouting, registerWebStatic } from './static-web'

/** Big and highly compressible, like a real JS chunk. */
const BIG_JS = 'export const x = "podium";\n'.repeat(400)
const PRE_BR = brotliCompressSync(Buffer.from('pre-compressed at build time'))

describe('registerWebStatic', () => {
  let dir: string
  const app = new Hono()
  app.get('/trpc/x', (c) => c.text('api')) // API route registered BEFORE static

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-web-'))
    // Padded past the 1 KB compression floor, like the real shell (~3 KB).
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><title>Podium</title>${'<!-- pad -->'.repeat(200)}`,
    )
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'assets', 'big.js'), BIG_JS)
    writeFileSync(join(dir, 'assets', 'index-RR9HhGf3.js'), BIG_JS)
    writeFileSync(join(dir, 'assets', 'pre.js'), 'pre-compressed at build time')
    writeFileSync(join(dir, 'assets', 'pre.js.br'), PRE_BR)
    writeFileSync(join(dir, 'assets', 'logo.png'), Buffer.alloc(4096, 7))
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
  it('gzips a large text asset when the client asks for it [POD-1655]', async () => {
    const res = await app.request('/assets/big.js', {
      headers: { 'accept-encoding': 'gzip, deflate' },
    })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBeLessThan(BIG_JS.length / 2)
    expect(gunzipSync(body).toString('utf8')).toBe(BIG_JS)
  })
  it('prefers brotli over gzip when both are offered', async () => {
    const res = await app.request('/assets/big.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    })
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(brotliDecompressSync(new Uint8Array(await res.arrayBuffer())).toString('utf8')).toBe(
      BIG_JS,
    )
  })
  it('serves identity bytes when the client offers no encoding', async () => {
    const res = await app.request('/assets/big.js')
    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(await res.text()).toBe(BIG_JS)
  })
  it('honours an explicit q=0 opt-out', async () => {
    const res = await app.request('/assets/big.js', {
      headers: { 'accept-encoding': 'gzip;q=0, br;q=0' },
    })
    expect(res.headers.get('content-encoding')).toBe(null)
  })
  it('serves a build-time .br sibling verbatim rather than recompressing', async () => {
    const res = await app.request('/assets/pre.js', { headers: { 'accept-encoding': 'br' } })
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(Buffer.from(await res.arrayBuffer()).equals(PRE_BR)).toBe(true)
  })
  it('does not compress already-compressed assets', async () => {
    const res = await app.request('/assets/logo.png', {
      headers: { 'accept-encoding': 'br, gzip' },
    })
    expect(res.headers.get('content-encoding')).toBe(null)
    expect(res.headers.get('vary')).toBe(null)
  })
  it('does not compress tiny assets', async () => {
    const res = await app.request('/assets/app.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe(null)
  })
  it('gzips the SPA shell', async () => {
    const res = await app.request('/settings/machines', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString('utf8')).toContain('Podium')
  })
  it('marks hashed assets immutable and the shell revalidating [POD-1655]', async () => {
    const asset = await app.request('/assets/index-RR9HhGf3.js')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const shell = await app.request('/')
    expect(shell.headers.get('cache-control')).toBe('no-cache')
    const unhashed = await app.request('/assets/app.js')
    expect(unhashed.headers.get('cache-control')).toBe('no-cache')
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
  it('redirects phone user agents at / to /mobile [POD-102]', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => true })
    app.get('/', (c) => c.text('web shell'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

    const root = await app.request('/?server=wss://x&e2e=1', {
      headers: { 'user-agent': iphone },
    })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/mobile?server=wss://x&e2e=1')
  })
  it('can serve Expo without redirecting the phone root (dual-client browser harness)', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => true, redirectPhoneRoot: false })
    app.get('/', (c) => c.text('web shell'))
    app.get('/mobile', (c) => c.text('mobile shell'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

    expect(await (await app.request('/', { headers: { 'user-agent': iphone } })).text()).toBe(
      'web shell',
    )
    expect(await (await app.request('/mobile', { headers: { 'user-agent': iphone } })).text()).toBe(
      'mobile shell',
    )
  })
  it('keeps the web shell at / for desktop UAs, ?desktop, and deep links', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => true })
    app.get('/', (c) => c.text('web shell'))
    app.get('/session/s1', (c) => c.text('deep link'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15'

    expect(await (await app.request('/', { headers: { 'user-agent': mac } })).text()).toBe(
      'web shell',
    )
    expect(
      await (await app.request('/?desktop=1', { headers: { 'user-agent': iphone } })).text(),
    ).toBe('web shell')
    expect(
      await (await app.request('/session/s1', { headers: { 'user-agent': iphone } })).text(),
    ).toBe('deep link')
  })
  it('redirects /desktop to /?desktop=1 preserving the query string', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => true })

    const res = await app.request('/desktop?server=wss://x&e2e=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?server=wss://x&e2e=1&desktop=1')
  })
  it('redirects /desktop to the marked root when the Expo build is absent', async () => {
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => false })

    const res = await app.request('/desktop?e2e=1')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?e2e=1&desktop=1')
  })
  it('bounces /mobile to the MARKED root when the Expo build is absent [POD-359]', async () => {
    // The ?desktop marker is what stops apps/web's browser-side redirect (which
    // cannot probe for the Expo build) from bouncing straight back to /mobile.
    const app = new Hono()
    registerMobileRouting(app, { expoMobilePresent: () => false })

    const root = await app.request('/mobile?server=wss://x')
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/?server=wss://x&desktop=1')

    const deep = await app.request('/mobile/session/s1?e2e=1')
    expect(deep.status).toBe(302)
    expect(deep.headers.get('location')).toBe('/?e2e=1&desktop=1')

    // And that landing must not be redirected onward by the phone rule, even
    // once the build reappears — otherwise the two ping-pong.
    const withMobile = new Hono()
    registerMobileRouting(withMobile, { expoMobilePresent: () => true })
    withMobile.get('/', (c) => c.text('web shell'))
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
    const landing = await withMobile.request('/?server=wss://x&desktop=1', {
      headers: { 'user-agent': iphone },
    })
    expect(await landing.text()).toBe('web shell')
  })
  it('leaves /mobile to the Expo static handler when the build is present', async () => {
    const mobile = mkdtempSync(join(tmpdir(), 'podium-mobile-'))
    try {
      writeFileSync(join(mobile, 'index.html'), '<!doctype html><title>Podium Mobile</title>')
      const app = new Hono()
      registerMobileRouting(app, { expoMobilePresent: () => true })
      registerWebStatic(app, mobile, { basePath: '/mobile', lazy: true })

      const res = await app.request('/mobile?server=wss://x')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Podium Mobile')
    } finally {
      rmSync(mobile, { recursive: true, force: true })
    }
  })
  it('starts serving /mobile and the phone redirect when the build appears after boot', async () => {
    const mobile = mkdtempSync(join(tmpdir(), 'podium-mobile-'))
    rmSync(mobile, { recursive: true, force: true })
    try {
      const index = join(mobile, 'index.html')
      const app = new Hono()
      registerMobileRouting(app, { expoMobilePresent: () => existsSync(index) })
      registerWebStatic(app, mobile, { basePath: '/mobile', lazy: true })
      app.get('/', (c) => c.text('web shell'))
      const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'

      // Absent: phones stay on /, /mobile bounces home.
      expect(await (await app.request('/', { headers: { 'user-agent': iphone } })).text()).toBe(
        'web shell',
      )
      expect((await app.request('/mobile')).status).toBe(302)

      mkdirSync(mobile, { recursive: true })
      writeFileSync(index, '<!doctype html><title>Podium Mobile</title>')

      const root = await app.request('/', { headers: { 'user-agent': iphone } })
      expect(root.status).toBe(302)
      expect(root.headers.get('location')).toBe('/mobile')
      expect(await (await app.request('/mobile')).text()).toContain('Podium Mobile')
    } finally {
      rmSync(mobile, { recursive: true, force: true })
    }
  })
})
