// apps/server/src/file-asset-route.test.ts
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { type AssetReader, registerAssetRoute } from './file-asset-route'

const stub = (r: Awaited<ReturnType<AssetReader['readAsset']>>): AssetReader => ({
  allowsRoot: () => true,
  readAsset: async () => r,
})

describe('GET /files/asset', () => {
  it('returns bytes with content-type for a valid asset', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('PNGDATA').toString('base64'),
        contentType: 'image/png',
      }),
    )
    const res = await app.request('/files/asset?sessionId=s&path=/w/a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA')
  })
  it('forwards byte ranges and returns partial-content headers for media viewers', async () => {
    const readAsset = vi.fn(async () => ({
      ok: true,
      dataBase64: Buffer.from('456').toString('base64'),
      contentType: 'video/mp4',
      size: 10,
    }))
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot: () => true, readAsset })
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: 'bytes=4-6' },
    })

    expect(readAsset).toHaveBeenCalledWith({
      sessionId: 's',
      path: '/w/demo.mp4',
      offset: 4,
      length: 3,
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 4-6/10')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('456')
  })
  it.each([
    ['bytes=4-', 4, 10 * 1024 * 1024, '456789', 'bytes 4-9/10'],
    ['bytes=8-99', 8, 92, '89', 'bytes 8-9/10'],
    ['bytes=-3', 7, 3, '789', 'bytes 7-9/10'],
  ])('resolves %s against the total file size', async (header, offset, readLength, body, contentRange) => {
    const source = Buffer.from('0123456789')
    const readAsset = vi.fn(async (request: { offset?: number; length?: number }) => ({
      ok: true,
      dataBase64: source
        .subarray(request.offset ?? 0, (request.offset ?? 0) + (request.length ?? source.length))
        .toString('base64'),
      contentType: 'video/mp4',
      size: source.length,
    }))
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot: () => true, readAsset } as AssetReader)
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: header },
    })

    expect(readAsset).toHaveBeenLastCalledWith({
      sessionId: 's',
      path: '/w/demo.mp4',
      offset,
      length: readLength,
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(contentRange)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(body)
  })
  it('returns the total size for an unsatisfiable range', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({ ok: true, dataBase64: Buffer.from('0').toString('base64'), size: 10 }),
    )
    const res = await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', {
      headers: { range: 'bytes=10-' },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })
  it('rejects malformed and multipart ranges', async () => {
    const app = new Hono()
    registerAssetRoute(app, stub({ ok: true }))
    for (const range of ['items=1-2', 'bytes=4-2', 'bytes=0-1,3-4', 'bytes=-0']) {
      expect(
        (await app.request('/files/asset?sessionId=s&path=/w/demo.mp4', { headers: { range } }))
          .status,
      ).toBe(416)
    }
  })
  it('sandboxes HTML so a repo page cannot ride the session cookie', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('<h1>hi</h1>').toString('base64'),
        contentType: 'text/html; charset=utf-8',
      }),
    )
    const res = await app.request('/files/asset?root=/w&path=/w/mock.html')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('leaves an embedded image unsandboxed', async () => {
    const app = new Hono()
    registerAssetRoute(
      app,
      stub({
        ok: true,
        dataBase64: Buffer.from('PNG').toString('base64'),
        contentType: 'image/png',
      }),
    )
    const res = await app.request('/files/asset?root=/w&path=/w/a.png', {
      headers: { 'sec-fetch-dest': 'image' },
    })
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
  it('rejects an unregistered worktree root before reading from the daemon', async () => {
    const readAsset = vi.fn(async () => ({ ok: true }))
    const allowsRoot = vi.fn(() => false)
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot, readAsset })

    const res = await app.request(
      '/files/asset?root=%2F&machineId=machine-2&path=%2Fetc%2Fpasswd',
      { headers: { range: 'bytes=0-9' } },
    )

    expect(res.status).toBe(403)
    expect(allowsRoot).toHaveBeenCalledWith('/', 'machine-2')
    expect(readAsset).not.toHaveBeenCalled()
  })
  it('collapses .. in the root BEFORE authorizing it, so a crafted prefix cannot escape', async () => {
    // The registry prefix-matches lexically, exactly like the real one: a root that
    // textually starts with a registered root is allowed. Without collapsing `..`
    // first, `/repo/../../etc` passes that check and the daemon resolves it to /etc.
    const readAsset = vi.fn(async () => ({ ok: true }))
    const allowsRoot = vi.fn((root: string) => root === '/repo' || root.startsWith('/repo/'))
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot, readAsset })

    const res = await app.request(
      `/files/asset?root=${encodeURIComponent('/repo/../../etc')}&path=${encodeURIComponent('/etc/passwd')}`,
    )

    expect(res.status).toBe(403)
    expect(allowsRoot).toHaveBeenCalledWith('/etc', undefined)
    expect(readAsset).not.toHaveBeenCalled()
  })
  it('forwards the collapsed root, so the authorized root is the one that is read', async () => {
    const readAsset = vi.fn(async () => ({
      ok: true,
      dataBase64: Buffer.from('A').toString('base64'),
      contentType: 'text/plain; charset=utf-8',
      size: 1,
    }))
    const allowsRoot = vi.fn(() => true)
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot, readAsset })

    const res = await app.request(
      `/files/asset?root=${encodeURIComponent('/repo/sub/..')}&path=${encodeURIComponent('/repo/a.txt')}`,
    )

    expect(res.status).toBe(200)
    expect(allowsRoot).toHaveBeenCalledWith('/repo', undefined)
    expect(readAsset).toHaveBeenCalledWith(expect.objectContaining({ root: '/repo' }))
  })
  it('rejects a relative worktree root outright', async () => {
    const readAsset = vi.fn(async () => ({ ok: true }))
    const allowsRoot = vi.fn(() => true)
    const app = new Hono()
    registerAssetRoute(app, { allowsRoot, readAsset })

    const res = await app.request('/files/asset?root=repo&path=%2Frepo%2Fa.txt')

    expect(res.status).toBe(403)
    expect(allowsRoot).not.toHaveBeenCalled()
    expect(readAsset).not.toHaveBeenCalled()
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
