// apps/server/src/file-asset-route.ts
import { asSessionId, type SessionId } from '@podium/model'
import type { Hono } from 'hono'
import { rawFileHeaders } from './raw-file-headers'

export interface AssetReader {
  readAsset(
    a: { sessionId: SessionId; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<{
    ok: boolean
    dataBase64?: string
    contentType?: string
    tooLarge?: boolean
    error?: string
  }>
}

/** Serve a checkout file as raw bytes: the markdown preview's images, and the file
 *  viewer's Open in browser, which points a real browser tab here. Auth model matches the rest
 *  of the HTTP surface: the session must exist (readAsset returns ok:false otherwise);
 *  the daemon enforces the path sandbox. Worktree variant (`root` [+ `machineId`]
 *  instead of `sessionId`) serves issue-panel artifacts from a worktree checkout. */
export function registerAssetRoute(app: Hono, registry: AssetReader): void {
  app.get('/files/asset', async (c) => {
    const sessionId = c.req.query('sessionId')
    const root = c.req.query('root')
    const machineId = c.req.query('machineId')
    const path = c.req.query('path')
    if ((!sessionId && !root) || !path) return c.text('bad request', 400)
    const r = await registry.readAsset(
      sessionId
        ? { sessionId: asSessionId(sessionId), path }
        : { root: root as string, ...(machineId ? { machineId } : {}), path },
    )
    if (!r.ok || !r.dataBase64) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
    const bytes = Buffer.from(r.dataBase64, 'base64')
    return c.body(
      bytes,
      200,
      rawFileHeaders({
        contentType: r.contentType ?? 'application/octet-stream',
        cacheControl: 'no-cache',
        secFetchDest: c.req.header('sec-fetch-dest'),
      }),
    )
  })
}
