// apps/server/src/file-asset-route.test.ts
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerAssetRoute, type AssetReader } from './file-asset-route'

const stub = (r: Awaited<ReturnType<AssetReader['readAsset']>>): AssetReader => ({
  readAsset: async () => r,
})

describe('GET /files/asset', () => {
  it('returns bytes with content-type for a valid asset', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true, dataBase64: Buffer.from('PNGDATA').toString('base64'), contentType: 'image/png' }))
    const res = await app.request('/files/asset?sessionId=s&path=/w/a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA')
  })
  it('404s when the read is not ok (e.g. outside sandbox)', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: false, error: 'outside workspace' }))
    const res = await app.request('/files/asset?sessionId=s&path=/etc/passwd')
    expect(res.status).toBe(404)
  })
  it('413s when the asset is too large', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: false, tooLarge: true }))
    const res = await app.request('/files/asset?sessionId=s&path=/w/big.png')
    expect(res.status).toBe(413)
  })
  it('400s on missing params', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true }))
    const res = await app.request('/files/asset')
    expect(res.status).toBe(400)
  })
})
