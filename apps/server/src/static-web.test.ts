import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerWebStatic } from './static-web'

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
  it('returns 404 (not index.html) for a missing hashed asset', async () => {
    // A content-hashed asset from a superseded build no longer exists on disk.
    // It must 404 — serving index.html here would hand the browser HTML where a
    // JS module is expected ("MIME type text/html"), breaking the post-update load.
    const res = await app.request('/assets/index-DELETED123.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html')
  })
  it('still serves index.html for an extensionless deep route', async () => {
    const res = await app.request('/issues/podium-abc')
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
})
