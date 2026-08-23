// apps/server/src/file-asset-route.ts
import { asMachineId, asSessionId, type MachineId, type SessionId } from '@podium/model'
import type { Hono } from 'hono'
import { parseByteRange, type ResolvedByteRange, resolveByteRange } from './http-byte-range'
import { rawFileHeaders } from './raw-file-headers'

export interface AssetReader {
  readAsset(
    a:
      | { sessionId: SessionId; path: string; offset?: number; length?: number }
      | { machineId?: MachineId; root: string; path: string; offset?: number; length?: number },
  ): Promise<{
    ok: boolean
    dataBase64?: string
    contentType?: string
    tooLarge?: boolean
    size?: number
    error?: string
  }>
}

const MAX_RANGE_BYTES = 10 * 1024 * 1024

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
    const requestedRange = parseByteRange(c.req.header('range'))
    if (requestedRange === 'invalid') return c.body(null, 416)
    const target = sessionId
      ? { sessionId: asSessionId(sessionId), path }
      : {
          root: root as string,
          ...(machineId ? { machineId: asMachineId(machineId) } : {}),
          path,
        }
    let range: ResolvedByteRange | null = null
    let r: Awaited<ReturnType<AssetReader['readAsset']>>
    if (requestedRange?.kind === 'suffix') {
      const probe = await registry.readAsset({ ...target, offset: 0, length: 1 })
      if (!probe.ok) return c.text(probe.error ?? 'not found', probe.tooLarge ? 413 : 404)
      if (probe.size === undefined) return c.text('asset size unavailable', 500)
      const resolved = resolveByteRange(requestedRange, probe.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        return c.body(null, 416, { 'content-range': `bytes */${probe.size}` })
      }
      range = resolved
      r = await registry.readAsset({
        ...target,
        offset: range.offset,
        length: range.length,
      })
    } else if (requestedRange) {
      const tentative = {
        offset: requestedRange.start,
        length:
          requestedRange.end === undefined
            ? MAX_RANGE_BYTES
            : Math.min(requestedRange.end - requestedRange.start, MAX_RANGE_BYTES - 1) + 1,
      }
      r = await registry.readAsset({ ...target, ...tentative })
      if (!r.ok) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
      if (r.size === undefined) return c.text('asset size unavailable', 500)
      const resolved = resolveByteRange(requestedRange, r.size, MAX_RANGE_BYTES)
      if (resolved === 'unsatisfiable') {
        return c.body(null, 416, { 'content-range': `bytes */${r.size}` })
      }
      range = resolved
    } else {
      r = await registry.readAsset(target)
    }
    if (!r.ok) return c.text(r.error ?? 'not found', r.tooLarge ? 413 : 404)
    if (r.dataBase64 == null) return c.text(r.error ?? 'not found', 404)
    const bytes = Buffer.from(r.dataBase64, 'base64')
    if (range && (bytes.length === 0 || (r.size !== undefined && range.offset >= r.size))) {
      return c.body(null, 416, { 'content-range': `bytes */${r.size ?? '*'}` })
    }
    const responseHeaders: Record<string, string> = {
      ...rawFileHeaders({
        contentType: r.contentType ?? 'application/octet-stream',
        cacheControl: 'no-cache',
        secFetchDest: c.req.header('sec-fetch-dest'),
      }),
      'accept-ranges': 'bytes',
      ...(range
        ? {
            'content-range': `bytes ${range.offset}-${range.offset + bytes.length - 1}/${r.size ?? '*'}`,
            'content-length': String(bytes.length),
          }
        : {}),
    }
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    return range ? c.body(body, 206, responseHeaders) : c.body(body, 200, responseHeaders)
  })
}
