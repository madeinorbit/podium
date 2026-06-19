// apps/server/src/file-asset-route.ts
import type { Hono } from 'hono'

export interface AssetReader {
  readAsset(a: { sessionId: string; path: string }): Promise<{
    ok: boolean
    dataBase64?: string
    contentType?: string
    tooLarge?: boolean
    error?: string
  }>
}

/** Serve a markdown-relative asset (image) as raw bytes. Auth model matches the rest
 *  of the HTTP surface: the session must exist (readAsset returns ok:false otherwise);
 *  the daemon enforces the path sandbox. */
export function registerAssetRoute(app: Hono, registry: AssetReader): void {
  app.get('/files/asset', async (c) => {
    const sessionId = c.req.query('sessionId')
    const path = c.req.query('path')
    if (!sessionId || !path) return c.text('bad request', 400)
    const r = await registry.readAsset({ sessionId, path })
    if (!r.ok || !r.dataBase64) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
    const bytes = Buffer.from(r.dataBase64, 'base64')
    return c.body(bytes, 200, {
      'content-type': r.contentType ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
  })
}
